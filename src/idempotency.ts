/**
 * Application-level idempotency for operations that cost money (calls, number purchases).
 *
 * Vobiz's make-call and purchase APIs accept no idempotency key, so this server keeps its own record:
 *  - same key + same parameters  → the original result is replayed, nothing is sent again
 *  - same key + different params → idempotency_conflict
 *  - key still in flight          → in_progress (concurrent duplicate)
 *  - key whose outcome is unknown → outcome_unknown is replayed (never re-sent blindly)
 *  - key that failed definitively → may be retried (the record is dropped)
 *
 * Without an explicit key, a fingerprint of the parameters blocks identical requests inside a
 * short window. Limits: records live in this process (and optionally a JSON file); several server
 * processes do not share them, and Vobiz itself does not deduplicate.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { VobizError } from "./errors.js";

type State = "in_flight" | "done" | "unknown";

interface Entry {
  state: State;
  fingerprint: string;
  createdAt: number;
  result?: Record<string, unknown>;
}

export class IdempotencyStore {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 24 * 3600_000,
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (file) this.load();
  }

  static fingerprint(parts: Record<string, unknown>): string {
    return createHash("sha256").update(JSON.stringify(parts, Object.keys(parts).sort())).digest("hex");
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (t - e.createdAt > this.ttlMs) this.entries.delete(k);
  }

  /**
   * Starts an operation under `key`. Returns a replayable result if one exists, otherwise
   * reserves the key (state in_flight) and returns undefined.
   */
  begin(key: string, fingerprint: string): Record<string, unknown> | undefined {
    this.prune();
    const e = this.entries.get(key);
    if (!e) {
      this.entries.set(key, { state: "in_flight", fingerprint, createdAt: this.now() });
      return undefined;
    }
    if (e.fingerprint !== fingerprint) {
      throw new VobizError(
        "idempotency_conflict",
        "This idempotency_key was already used with different parameters. Use a new key for a different operation.",
      );
    }
    if (e.state === "in_flight") {
      throw new VobizError("in_progress", "An identical request with this key is still running. Wait for it instead of sending another.");
    }
    if (e.state === "unknown") {
      throw new VobizError(
        "outcome_unknown",
        "A previous attempt with this key ended with an unknown outcome, so it is not being sent again. Check list_live_calls / list_call_records (or list_phone_numbers) first.",
      );
    }
    return { ...(e.result ?? {}), replayed: true };
  }

  /** Forgets a finished record older than `ms` (unknown outcomes are kept). */
  dropIfOlder(key: string, ms: number): void {
    const e = this.entries.get(key);
    if (e && e.state === "done" && this.now() - e.createdAt >= ms) this.entries.delete(key);
  }

  succeed(key: string, result: Record<string, unknown>): void {
    const e = this.entries.get(key);
    if (e) {
      e.state = "done";
      e.result = result;
      this.save();
    }
  }

  /** Definitive failure (the provider rejected it): the key may be used again. */
  fail(key: string): void {
    this.entries.delete(key);
    this.save();
  }

  /** The request may or may not have taken effect: keep the key blocked. */
  markUnknown(key: string): void {
    const e = this.entries.get(key);
    if (e) {
      e.state = "unknown";
      this.save();
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file as string, "utf8")) as Record<string, Entry>;
      for (const [k, e] of Object.entries(raw)) {
        // A request that was in flight when the process died has an unknown outcome.
        this.entries.set(k, e.state === "in_flight" ? { ...e, state: "unknown" } : e);
      }
      this.prune();
    } catch {
      /* no file yet */
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      /* persistence is best effort; the in-memory record still protects this process */
    }
  }
}

/**
 * Runs `op` under idempotency protection. Errors marked as "maybe applied" (outcome_unknown) keep
 * the key blocked; other errors release it.
 */
export async function withIdempotency(
  store: IdempotencyStore,
  key: string,
  fingerprint: string,
  op: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const replay = store.begin(key, fingerprint);
  if (replay) return replay;
  try {
    const result = await op();
    store.succeed(key, result);
    return result;
  } catch (err) {
    if (err instanceof VobizError && err.kind === "outcome_unknown") store.markUnknown(key);
    else store.fail(key);
    throw err;
  }
}
