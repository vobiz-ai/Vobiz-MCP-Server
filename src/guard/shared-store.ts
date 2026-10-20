/**
 * Cross-replica state for money-spending tools: idempotency records, fixed-window rate counters and
 * concurrency reservations. Without a backend each process keeps its own (src/idempotency.ts, the
 * SlidingWindowLimiter instances and the in-process ReservationSet); with one, every replica of the hosted
 * server sees the same records, so a retry on another instance cannot place a second call.
 *
 *   MemorySharedBackend     tests and single-process deployments
 *   FirestoreSharedBackend  hosted (Cloud Run): collections `idempotency` and `counters`
 *
 * Document IDs start with tenantScope(authId) (first 16 hex chars of sha256(authId)), never the Auth ID.
 * Every document carries `expiresAt` (a timestamp) so a Firestore TTL policy can delete old rows.
 */
import { createHash } from "node:crypto";

type Rec = Record<string, unknown>;

export type IdempotencyState = "in_flight" | "done" | "unknown";

export interface IdempotencyRecord {
  state: IdempotencyState;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  result?: Rec;
}

export type BeginOutcome = { kind: "new" } | { kind: "existing"; record: IdempotencyRecord };

export interface LimitSpec {
  /** Counter name, e.g. calls_min. */
  name: string;
  windowMs: number;
  max: number;
  /** Hits to add (default 1). */
  n?: number;
}

export type AcquireOutcome = { ok: true } | { ok: false; limit: string };

export interface Reservation {
  id: string;
  /** Set once the call was accepted: the request_uuid Vobiz returned. */
  uuid?: string;
  expiresAt: number;
  /** When the reservation was made (ms); with the id as tie-break it orders competing attempts. */
  createdAt: number;
}

export interface SharedStoreBackend {
  /**
   * Atomically reserves `key` as in_flight unless a live record exists, in which case that record is returned.
   * A `done` record older than `replaceDoneOlderThanMs` is treated as absent (duplicate windows).
   */
  idempotencyBegin(scope: string, key: string, fingerprint: string, ttlMs: number, opts?: { replaceDoneOlderThanMs?: number }): Promise<BeginOutcome>;
  idempotencySucceed(scope: string, key: string, result: Rec): Promise<void>;
  idempotencyMarkUnknown(scope: string, key: string): Promise<void>;
  /** Definitive failure: the key may be used again. */
  idempotencyRelease(scope: string, key: string): Promise<void>;
  /** All-or-nothing: adds n to every fixed-window counter if each stays within its max. */
  tryAcquire(scope: string, limits: LimitSpec[]): Promise<AcquireOutcome>;
  /** Adds (or refreshes) reservation `id` in the named set and returns every unexpired reservation. */
  reserve(scope: string, name: string, id: string, ttlMs: number): Promise<Reservation[]>;
  /** Records the accepted call's uuid and shortens the reservation to `ttlMs` from now. */
  settle(scope: string, name: string, id: string, uuid: string, ttlMs: number): Promise<void>;
  release(scope: string, name: string, id: string): Promise<void>;
}

/** First 16 hex chars of sha256(authId): partitions shared records per account without storing the Auth ID. */
export function tenantScope(authId: string): string {
  return createHash("sha256").update(authId).digest("hex").slice(0, 16);
}

/** Firestore document IDs may not contain "/" and may not be "." or ".."; our keys never do, but be safe. */
const docKey = (scope: string, key: string) => `${scope}_${key.replace(/\//g, "%2F")}`;
const windowStart = (now: number, windowMs: number) => Math.floor(now / windowMs) * windowMs;

/** An in_flight record this old belongs to a request whose replica died: its outcome is unknown. */
export const STALE_IN_FLIGHT_MS = 5 * 60_000;

function beginDecision(cur: IdempotencyRecord | undefined, now: number, replaceDoneOlderThanMs?: number): IdempotencyRecord | undefined {
  if (!cur || cur.expiresAt <= now) return undefined;
  if (cur.state === "done" && replaceDoneOlderThanMs !== undefined && now - cur.createdAt >= replaceDoneOlderThanMs) return undefined;
  if (cur.state === "in_flight" && now - cur.createdAt > STALE_IN_FLIGHT_MS) return { ...cur, state: "unknown" };
  return cur;
}

// ── Memory ────────────────────────────────────────────────────────

export class MemorySharedBackend implements SharedStoreBackend {
  private readonly idem = new Map<string, IdempotencyRecord>();
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();
  private readonly sets = new Map<string, Map<string, Reservation>>();

  constructor(private readonly now: () => number = Date.now) {}

  async idempotencyBegin(scope: string, key: string, fingerprint: string, ttlMs: number, opts: { replaceDoneOlderThanMs?: number } = {}): Promise<BeginOutcome> {
    const k = docKey(scope, key);
    const t = this.now();
    const cur = beginDecision(this.idem.get(k), t, opts.replaceDoneOlderThanMs);
    if (cur) return { kind: "existing", record: { ...cur, ...(cur.result ? { result: { ...cur.result } } : {}) } };
    this.idem.set(k, { state: "in_flight", fingerprint, createdAt: t, expiresAt: t + ttlMs });
    return { kind: "new" };
  }
  async idempotencySucceed(scope: string, key: string, result: Rec): Promise<void> {
    const e = this.idem.get(docKey(scope, key));
    if (e) Object.assign(e, { state: "done", result: JSON.parse(JSON.stringify(result)) as Rec });
  }
  async idempotencyMarkUnknown(scope: string, key: string): Promise<void> {
    const e = this.idem.get(docKey(scope, key));
    if (e) e.state = "unknown";
  }
  async idempotencyRelease(scope: string, key: string): Promise<void> {
    this.idem.delete(docKey(scope, key));
  }

  async tryAcquire(scope: string, limits: LimitSpec[]): Promise<AcquireOutcome> {
    const t = this.now();
    for (const [k, c] of this.counters) if (c.expiresAt <= t) this.counters.delete(k);
    const keys = limits.map((l) => docKey(scope, `${l.name}-${windowStart(t, l.windowMs)}`));
    const over = limits.find((l, i) => (this.counters.get(keys[i])?.count ?? 0) + (l.n ?? 1) > l.max);
    if (over) return { ok: false, limit: over.name };
    limits.forEach((l, i) => {
      const c = this.counters.get(keys[i]) ?? { count: 0, expiresAt: windowStart(t, l.windowMs) + l.windowMs };
      c.count += l.n ?? 1;
      this.counters.set(keys[i], c);
    });
    return { ok: true };
  }

  private set(scope: string, name: string): Map<string, Reservation> {
    const k = docKey(scope, `inflight-${name}`);
    let s = this.sets.get(k);
    if (!s) this.sets.set(k, (s = new Map()));
    const t = this.now();
    for (const [id, r] of s) if (r.expiresAt <= t) s.delete(id);
    return s;
  }
  async reserve(scope: string, name: string, id: string, ttlMs: number): Promise<Reservation[]> {
    const s = this.set(scope, name);
    const t = this.now();
    s.set(id, { id, expiresAt: t + ttlMs, createdAt: s.get(id)?.createdAt ?? t });
    return [...s.values()].map((r) => ({ ...r }));
  }
  async settle(scope: string, name: string, id: string, uuid: string, ttlMs: number): Promise<void> {
    const r = this.set(scope, name).get(id);
    if (r) Object.assign(r, { uuid, expiresAt: this.now() + ttlMs });
  }
  async release(scope: string, name: string, id: string): Promise<void> {
    this.set(scope, name).delete(id);
  }
}

// ── Firestore ─────────────────────────────────────────────────────
// Minimal structural view of the Firestore client (same approach as src/reminders/store.ts), so the module
// is imported only when this backend is used and tests can pass a fake.

interface DocSnap {
  exists: boolean;
  data(): Rec | undefined;
}
export interface SharedDocRef {
  get(): Promise<DocSnap>;
}
interface Tx {
  get(ref: SharedDocRef): Promise<DocSnap>;
  set(ref: SharedDocRef, data: Rec): unknown;
  delete(ref: SharedDocRef): unknown;
}
export interface SharedFirestoreLike {
  collection(name: string): { doc(id: string): SharedDocRef };
  runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface FirestoreSharedBackendOptions {
  projectId?: string;
  /** Firestore database id, default "(default)". */
  databaseId?: string;
  /** Collection names (defaults `idempotency` and `counters`). */
  idempotencyCollection?: string;
  countersCollection?: string;
  /** Injected client (tests). Otherwise @google-cloud/firestore is imported on first use. */
  db?: SharedFirestoreLike;
  now?: () => number;
}

const toMillis = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (v && typeof (v as { toMillis?: () => number }).toMillis === "function") return (v as { toMillis: () => number }).toMillis();
  return 0;
};

function readRecord(d: Rec | undefined): IdempotencyRecord | undefined {
  if (!d || typeof d.fingerprint !== "string") return undefined;
  const state = d.state === "done" || d.state === "unknown" ? d.state : "in_flight";
  let result: Rec | undefined;
  if (typeof d.resultJson === "string") {
    try {
      result = JSON.parse(d.resultJson) as Rec;
    } catch {
      result = undefined;
    }
  }
  return { state, fingerprint: d.fingerprint, createdAt: toMillis(d.createdAt), expiresAt: toMillis(d.expiresAt), ...(result ? { result } : {}) };
}

function readHolders(d: Rec | undefined, now: number): Reservation[] {
  const h = d?.holders;
  if (!h || typeof h !== "object") return [];
  return Object.entries(h as Record<string, Rec>)
    .map(([id, v]) => ({ id, expiresAt: toMillis(v?.expiresAt), createdAt: toMillis(v?.createdAt), ...(typeof v?.uuid === "string" ? { uuid: v.uuid } : {}) }))
    .filter((r) => r.expiresAt > now);
}

const holdersDoc = (rs: Reservation[]): Rec => ({
  holders: Object.fromEntries(rs.map((r) => [r.id, { expiresAt: r.expiresAt, createdAt: r.createdAt, ...(r.uuid ? { uuid: r.uuid } : {}) }])),
  expiresAt: new Date(Math.max(0, ...rs.map((r) => r.expiresAt))),
});

export class FirestoreSharedBackend implements SharedStoreBackend {
  private dbPromise?: Promise<SharedFirestoreLike>;
  private readonly idemCol: string;
  private readonly counterCol: string;
  private readonly now: () => number;

  constructor(private readonly o: FirestoreSharedBackendOptions = {}) {
    this.idemCol = o.idempotencyCollection || "idempotency";
    this.counterCol = o.countersCollection || "counters";
    this.now = o.now ?? Date.now;
    if (o.db) this.dbPromise = Promise.resolve(o.db);
  }

  private db(): Promise<SharedFirestoreLike> {
    this.dbPromise ??= import("@google-cloud/firestore").then(
      ({ Firestore }) =>
        new Firestore({ projectId: this.o.projectId, databaseId: this.o.databaseId || "(default)", ignoreUndefinedProperties: true }) as unknown as SharedFirestoreLike,
    );
    return this.dbPromise;
  }

  private async idemRef(scope: string, key: string) {
    const db = await this.db();
    return { db, ref: db.collection(this.idemCol).doc(docKey(scope, key)) };
  }

  async idempotencyBegin(scope: string, key: string, fingerprint: string, ttlMs: number, opts: { replaceDoneOlderThanMs?: number } = {}): Promise<BeginOutcome> {
    const { db, ref } = await this.idemRef(scope, key);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const t = this.now();
      const cur = beginDecision(snap.exists ? readRecord(snap.data()) : undefined, t, opts.replaceDoneOlderThanMs);
      if (cur) return { kind: "existing", record: cur } as BeginOutcome;
      tx.set(ref, { scope, state: "in_flight", fingerprint, createdAt: t, expiresAt: new Date(t + ttlMs) });
      return { kind: "new" } as BeginOutcome;
    });
  }

  private async patch(scope: string, key: string, fields: Rec): Promise<void> {
    const { db, ref } = await this.idemRef(scope, key);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : undefined;
      if (d) tx.set(ref, { ...d, ...fields });
    });
  }
  async idempotencySucceed(scope: string, key: string, result: Rec): Promise<void> {
    await this.patch(scope, key, { state: "done", resultJson: JSON.stringify(result) });
  }
  async idempotencyMarkUnknown(scope: string, key: string): Promise<void> {
    await this.patch(scope, key, { state: "unknown" });
  }
  async idempotencyRelease(scope: string, key: string): Promise<void> {
    const { db, ref } = await this.idemRef(scope, key);
    await db.runTransaction(async (tx) => {
      tx.delete(ref);
    });
  }

  async tryAcquire(scope: string, limits: LimitSpec[]): Promise<AcquireOutcome> {
    const db = await this.db();
    const col = db.collection(this.counterCol);
    return db.runTransaction(async (tx) => {
      const t = this.now();
      const refs = limits.map((l) => col.doc(docKey(scope, `${l.name}-${windowStart(t, l.windowMs)}`)));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      const counts = snaps.map((s) => Number((s.exists ? s.data()?.count : 0) ?? 0) || 0);
      const over = limits.find((l, i) => counts[i] + (l.n ?? 1) > l.max);
      if (over) return { ok: false, limit: over.name } as AcquireOutcome;
      limits.forEach((l, i) => {
        tx.set(refs[i], { scope, name: l.name, count: counts[i] + (l.n ?? 1), expiresAt: new Date(windowStart(t, l.windowMs) + l.windowMs) });
      });
      return { ok: true } as AcquireOutcome;
    });
  }

  private async holders<T>(scope: string, name: string, fn: (rs: Reservation[], t: number) => { next: Reservation[]; out: T }): Promise<T> {
    const db = await this.db();
    const ref = db.collection(this.counterCol).doc(docKey(scope, `inflight-${name}`));
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const t = this.now();
      const { next, out } = fn(readHolders(snap.exists ? snap.data() : undefined, t), t);
      if (next.length) tx.set(ref, { scope, name, ...holdersDoc(next) });
      else if (snap.exists) tx.delete(ref);
      return out;
    });
  }
  async reserve(scope: string, name: string, id: string, ttlMs: number): Promise<Reservation[]> {
    return this.holders(scope, name, (rs, t) => {
      const prev = rs.find((r) => r.id === id);
      const next = [...rs.filter((r) => r.id !== id), { id, expiresAt: t + ttlMs, createdAt: prev?.createdAt ?? t }];
      return { next, out: next.map((r) => ({ ...r })) };
    });
  }
  async settle(scope: string, name: string, id: string, uuid: string, ttlMs: number): Promise<void> {
    await this.holders(scope, name, (rs, t) => ({ next: rs.map((r) => (r.id === id ? { ...r, uuid, expiresAt: t + ttlMs } : r)), out: undefined }));
  }
  async release(scope: string, name: string, id: string): Promise<void> {
    await this.holders(scope, name, (rs) => ({ next: rs.filter((r) => r.id !== id), out: undefined }));
  }
}

/** For the hosted wiring: a Firestore-backed shared store (collections `idempotency` and `counters`). */
export function createFirestoreSharedBackend(projectId?: string, databaseId?: string): SharedStoreBackend {
  return new FirestoreSharedBackend({ projectId, databaseId });
}
