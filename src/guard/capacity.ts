/**
 * Call capacity guards for make_call: concurrency reservations and the per-minute / per-hour call caps.
 *
 * A slot is reserved synchronously before any network check, so two concurrent make_call requests in one
 * process can never both see "2 of 3 calls live" and both dial (the time-of-check/time-of-use gap). With a
 * SharedStoreBackend the reservation and the rate counters are also recorded there, so replicas of the
 * hosted server share them. A reservation is released when the attempt fails, and kept for a short grace
 * period after Vobiz accepts the call, until the call shows up in Vobiz's own live/queued lists.
 */
import { randomBytes } from "node:crypto";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { tenantScope, type Reservation, type SharedStoreBackend } from "./shared-store.js";

/** Lifetime of a reservation while the attempt is running (longer than any request timeout). */
export const RESERVATION_TTL_MS = 120_000;
/** How long an accepted call keeps counting if Vobiz has not listed it as live/queued yet. */
export const SETTLED_GRACE_MS = 60_000;

/** In-process concurrency reservations (one set per account's SharedState). */
export class ReservationSet {
  private readonly held = new Map<string, Reservation>();
  private last = 0;
  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const t = this.now();
    for (const [id, r] of this.held) if (r.expiresAt <= t) this.held.delete(id);
  }
  /** Synchronous: the slot exists as soon as this returns. */
  reserve(ttlMs = RESERVATION_TTL_MS): string {
    this.prune();
    const id = randomBytes(8).toString("hex");
    // A strictly increasing createdAt orders attempts within this process.
    this.held.set(id, { id, expiresAt: this.now() + ttlMs, createdAt: (this.last = Math.max(this.now(), this.last + 1)) });
    return id;
  }
  settle(id: string, uuid: string, ttlMs = SETTLED_GRACE_MS): void {
    const r = this.held.get(id);
    if (r) Object.assign(r, { uuid, expiresAt: this.now() + ttlMs });
  }
  release(id: string): void {
    this.held.delete(id);
  }
  list(): Reservation[] {
    this.prune();
    return [...this.held.values()].map((r) => ({ ...r }));
  }
}

/** The account's shared backend and its scope, or undefined (single process / no credentials yet). */
export function sharedOf(ctx: ToolContext): { backend: SharedStoreBackend; scope: string } | undefined {
  return ctx.backend && ctx.cfg.authId ? { backend: ctx.backend, scope: tenantScope(ctx.cfg.authId) } : undefined;
}

/**
 * Other attempts that count against the cap for reservation `id`: accepted calls Vobiz does not list yet, and
 * attempts still running that reserved before this one (the earlier attempt wins, so two simultaneous
 * attempts for the last slot place exactly one call instead of both refusing).
 */
export function othersInFlight(reservations: Reservation[], id: string, listed: Set<string>): number {
  const mine = reservations.find((r) => r.id === id);
  const before = (r: Reservation) => !mine || r.createdAt < mine.createdAt || (r.createdAt === mine.createdAt && r.id < mine.id);
  return reservations.filter((r) => r.id !== id && (r.uuid ? !listed.has(r.uuid) : before(r))).length;
}

export interface CallSlot {
  id: string;
  /** Other in-flight attempts (shared when a backend is configured), for the capacity check. */
  others(listed: Set<string>): Promise<number>;
  /** The call was accepted: keep counting it briefly, until Vobiz lists it. */
  settle(uuid: string): Promise<void>;
  /** The attempt failed: free the slot now. */
  release(): Promise<void>;
}

/** Reserves a concurrency slot. The in-process reservation is made synchronously, before the first await. */
export function reserveCallSlot(ctx: ToolContext): CallSlot {
  const id = ctx.callReservations.reserve();
  const shared = sharedOf(ctx);
  let sharedReservations: Promise<Reservation[]> | undefined;
  if (shared) {
    sharedReservations = shared.backend.reserve(shared.scope, "calls", id, RESERVATION_TTL_MS);
    // Surfaced by others(); never an unhandled rejection.
    sharedReservations.catch(() => {});
  }
  return {
    id,
    async others(listed) {
      if (!sharedReservations) return othersInFlight(ctx.callReservations.list(), id, listed);
      const all = await sharedReservations.catch(() => {
        throw new VobizError("service_unavailable", "The server's shared call-capacity store is not reachable, so the call was not placed. Try again shortly.");
      });
      return othersInFlight(all, id, listed);
    },
    async settle(uuid) {
      ctx.callReservations.settle(id, uuid);
      if (shared) await shared.backend.settle(shared.scope, "calls", id, uuid, SETTLED_GRACE_MS).catch(() => {});
    },
    async release() {
      ctx.callReservations.release(id);
      if (shared) await shared.backend.release(shared.scope, "calls", id).catch(() => {});
    },
  };
}

/** Applies the per-minute and per-hour call caps (shared counters when a backend is configured). */
export async function acquireCallRate(ctx: ToolContext): Promise<void> {
  const { cfg } = ctx;
  const perMinute = `This MCP server allows at most ${cfg.maxCallsPerMinute} call initiations per minute.`;
  const perHour = `This MCP server allows at most ${cfg.policy.maxCallsPerHour} call initiations per hour.`;
  const shared = sharedOf(ctx);
  if (shared) {
    const r = await shared.backend
      .tryAcquire(shared.scope, [
        { name: "calls_min", windowMs: 60_000, max: cfg.maxCallsPerMinute },
        { name: "calls_hour", windowMs: 3_600_000, max: cfg.policy.maxCallsPerHour },
      ])
      .catch(() => {
        throw new VobizError("service_unavailable", "The server's shared rate-limit store is not reachable, so the call was not placed. Try again shortly.");
      });
    if (!r.ok) throw new VobizError("rate_limited", r.limit === "calls_min" ? perMinute : perHour);
    return;
  }
  if (!ctx.callLimiter.wouldAllow()) throw new VobizError("rate_limited", perMinute);
  if (!ctx.hourlyCallLimiter.wouldAllow()) throw new VobizError("rate_limited", perHour);
  ctx.callLimiter.tryAcquire();
  ctx.hourlyCallLimiter.tryAcquire();
}

/** Applies the per-minute and per-hour message caps for `n` recipients (shared counters with a backend). */
export async function acquireMessageRate(ctx: ToolContext, n: number): Promise<void> {
  const { messaging } = ctx.cfg;
  const msg = `This MCP server sends at most ${messaging.maxMessagesPerMinute} messages per minute and ${messaging.maxMessagesPerHour} per hour.`;
  const shared = sharedOf(ctx);
  if (shared) {
    const r = await shared.backend
      .tryAcquire(shared.scope, [
        { name: "msgs_min", windowMs: 60_000, max: messaging.maxMessagesPerMinute, n },
        { name: "msgs_hour", windowMs: 3_600_000, max: messaging.maxMessagesPerHour, n },
      ])
      .catch(() => {
        throw new VobizError("service_unavailable", "The server's shared rate-limit store is not reachable, so nothing was sent. Try again shortly.");
      });
    if (!r.ok) throw new VobizError("rate_limited", msg);
    return;
  }
  if (!ctx.messageLimiter.wouldAllow(n) || !ctx.hourlyMessageLimiter.wouldAllow(n)) throw new VobizError("rate_limited", msg);
  ctx.messageLimiter.tryAcquireMany(n);
  ctx.hourlyMessageLimiter.tryAcquireMany(n);
}
