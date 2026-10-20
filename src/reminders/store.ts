/**
 * Durable reminder records. Neither store ever sees an auth token: Reminder has no such field and the
 * stores copy only Reminder fields (plus the account hash used for listing).
 *
 *   MemoryStore     tests and single-process deployments (lost on restart)
 *   FirestoreStore  hosted (Cloud Run): collection `reminders`, document `${accountHash}_${rid}`
 */
import { createHash } from "node:crypto";
import type { LimitSnapshot, Reminder, ReminderStatus, ReminderStore } from "./types.js";

type Patch = Partial<Reminder> | ((current: Reminder) => Partial<Reminder> | undefined);

/** First 16 hex chars of sha256(authId): groups an account's reminders without storing the Auth ID as a key. */
export function accountHash(authId: string): string {
  return createHash("sha256").update(authId).digest("hex").slice(0, 16);
}

/** Fields that belong to a Reminder; anything else (account, tokens) is dropped on read and write. */
const FIELDS: (keyof Reminder)[] = [
  "id", "authId", "clientId", "status", "createdAt", "updatedAt", "nextAt", "attempts", "idempotencyKey",
  "kind", "message", "at", "timezone", "to", "from", "language", "voice", "snoozeMinutes", "maxAttempts",
  "retryMinutes", "audioUrl", "audioId", "toDigits",
];

/** Statuses that count against ReminderLimits.maxActive. */
export const ACTIVE_STATUSES: ReminderStatus[] = ["scheduled", "snoozed", "calling"];

const digits = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");

function clean(r: Partial<Reminder> & Record<string, unknown>): Reminder {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (r[k] !== undefined) out[k] = r[k];
  out.attempts = Array.isArray(r.attempts) ? r.attempts.map((a) => ({ ...a })) : [];
  // Derived, never trusted from input: every write (Firestore rewrites the whole document) backfills it on old records.
  if (typeof r.to === "string") out.toDigits = digits(r.to);
  return out as unknown as Reminder;
}

function applyPatch(cur: Reminder, patch: Patch): Reminder | undefined {
  const p = typeof patch === "function" ? patch(clean({ ...cur })) : patch;
  if (!p) return undefined;
  return clean({ ...cur, ...p, id: cur.id, authId: cur.authId });
}

const newestFirst = (a: Reminder, b: Reminder) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

export class MemoryStore implements ReminderStore {
  private readonly rows = new Map<string, Reminder>();
  private key = (authId: string, id: string) => `${accountHash(authId)}_${id}`;

  async create(r: Reminder): Promise<void> {
    const k = this.key(r.authId, r.id);
    if (this.rows.has(k)) throw new Error("reminder already exists");
    this.rows.set(k, clean({ ...r }));
  }
  async get(authId: string, id: string): Promise<Reminder | undefined> {
    const r = this.rows.get(this.key(authId, id));
    return r ? clean({ ...r }) : undefined;
  }
  async list(authId: string, opts: { status?: ReminderStatus[]; limit?: number } = {}): Promise<Reminder[]> {
    return [...this.rows.values()]
      .filter((r) => r.authId === authId && (!opts.status?.length || opts.status.includes(r.status)))
      .sort(newestFirst)
      .slice(0, opts.limit ?? 50)
      .map((r) => clean({ ...r }));
  }
  async update(authId: string, id: string, patch: Patch): Promise<Reminder | undefined> {
    const k = this.key(authId, id);
    const cur = this.rows.get(k);
    if (!cur) return undefined;
    // Synchronous between read and write, so a function patch is atomic within this process.
    const next = applyPatch(cur, patch);
    if (!next) return undefined;
    this.rows.set(k, next);
    return clean({ ...next });
  }
  async findByIdempotencyKey(authId: string, key: string): Promise<Reminder | undefined> {
    const r = [...this.rows.values()].find((x) => x.authId === authId && x.idempotencyKey === key);
    return r ? clean({ ...r }) : undefined;
  }
  private snapshot(authId: string, toDigits: string): LimitSnapshot {
    const mine = [...this.rows.values()].filter((r) => r.authId === authId);
    return {
      active: mine.filter((r) => ACTIVE_STATUSES.includes(r.status)).length,
      destination: mine.filter((r) => r.toDigits === toDigits).map((r) => clean({ ...r })),
    };
  }
  async countActive(authId: string): Promise<number> {
    return this.snapshot(authId, "").active;
  }
  async listByDestination(authId: string, toDigits: string): Promise<Reminder[]> {
    return this.snapshot(authId, digits(toDigits)).destination;
  }
  async createGuarded(r: Reminder, guard: (s: LimitSnapshot) => void): Promise<void> {
    // No await between the guard and the write: atomic within this process.
    guard(this.snapshot(r.authId, digits(r.to)));
    const k = this.key(r.authId, r.id);
    if (this.rows.has(k)) throw new Error("reminder already exists");
    this.rows.set(k, clean({ ...r }));
  }
  async listByStatus(status: ReminderStatus, limit = 500): Promise<Reminder[]> {
    return [...this.rows.values()].filter((r) => r.status === status).slice(0, limit).map((r) => clean({ ...r }));
  }
}

// ── Firestore ─────────────────────────────────────────────────────
// Minimal structural view of the Firestore client, so the module is only imported when this store is used
// (and so tests can pass a fake).

interface DocSnap {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface QuerySnap {
  docs: DocSnap[];
}
interface Query {
  where(field: string, op: string, value: unknown): Query;
  orderBy(field: string, dir?: "asc" | "desc"): Query;
  limit(n: number): Query;
  get(): Promise<QuerySnap>;
  /** Aggregate count (server-side; reads no documents). Optional so a minimal fake can omit it. */
  count?(): { get(): Promise<{ data(): { count: number } }> };
}
interface DocRef {
  get(): Promise<DocSnap>;
  create(data: Record<string, unknown>): Promise<unknown>;
}
interface Collection extends Query {
  doc(id: string): DocRef;
}
interface Tx {
  get(ref: DocRef): Promise<DocSnap>;
  get(query: Query): Promise<QuerySnap>;
  set(ref: DocRef, data: Record<string, unknown>): unknown;
  create(ref: DocRef, data: Record<string, unknown>): unknown;
}
export interface FirestoreLike {
  collection(name: string): Collection;
  runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface FirestoreStoreOptions {
  projectId?: string;
  /** Firestore database id, default "(default)". */
  databaseId?: string;
  /** Collection name, default "reminders". */
  collection?: string;
  /** Injected client (tests). Otherwise @google-cloud/firestore is imported on first use. */
  db?: FirestoreLike;
}

/** Status filtering happens in memory over the newest records, so only one composite index is needed: (account ASC, createdAt DESC). */
const LIST_SCAN = 500;
/**
 * Ceiling for the equality queries behind the limits (account + status, account + toDigits). They run on the
 * automatic single-field indexes, so no composite index is needed. Far above any cap: an account cannot hold
 * this many active reminders, and a destination gets at most VOBIZ_MAX_REMINDER_CALLS_PER_DAY a day.
 */
const LIMIT_SCAN = 2000;

export class FirestoreStore implements ReminderStore {
  private readonly collection: string;
  private dbPromise?: Promise<FirestoreLike>;

  constructor(private readonly o: FirestoreStoreOptions = {}) {
    this.collection = o.collection || "reminders";
    if (o.db) this.dbPromise = Promise.resolve(o.db);
  }

  private db(): Promise<FirestoreLike> {
    this.dbPromise ??= import("@google-cloud/firestore").then(
      ({ Firestore }) =>
        new Firestore({
          projectId: this.o.projectId,
          databaseId: this.o.databaseId || "(default)",
          ignoreUndefinedProperties: true,
        }) as unknown as FirestoreLike,
    );
    return this.dbPromise;
  }

  private async col(): Promise<Collection> {
    return (await this.db()).collection(this.collection);
  }

  static docId(authId: string, id: string): string {
    return `${accountHash(authId)}_${id}`;
  }

  private toDoc(r: Reminder): Record<string, unknown> {
    // JSON round trip drops undefined members (Firestore rejects them) and any non-plain value.
    return { ...JSON.parse(JSON.stringify(clean({ ...r }))), account: accountHash(r.authId) };
  }

  async create(r: Reminder): Promise<void> {
    await (await this.col()).doc(FirestoreStore.docId(r.authId, r.id)).create(this.toDoc(r));
  }

  async get(authId: string, id: string): Promise<Reminder | undefined> {
    const snap = await (await this.col()).doc(FirestoreStore.docId(authId, id)).get();
    const d = snap.exists ? snap.data() : undefined;
    return d && d.authId === authId ? clean(d) : undefined;
  }

  async list(authId: string, opts: { status?: ReminderStatus[]; limit?: number } = {}): Promise<Reminder[]> {
    const limit = opts.limit ?? 50;
    // Equality-only query: it runs on the automatic single-field index, so no composite index has to be
    // created per deployment. The account's newest LIST_SCAN records are sorted here instead.
    const snap = await (await this.col()).where("account", "==", accountHash(authId)).limit(LIST_SCAN).get();
    return snap.docs
      .map((d) => d.data())
      .filter((d): d is Record<string, unknown> => !!d && d.authId === authId)
      .map((d) => clean(d))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .filter((r) => !opts.status?.length || opts.status.includes(r.status))
      .slice(0, limit);
  }

  async update(authId: string, id: string, patch: Patch): Promise<Reminder | undefined> {
    const db = await this.db();
    const ref = db.collection(this.collection).doc(FirestoreStore.docId(authId, id));
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : undefined;
      if (!d || d.authId !== authId) return undefined;
      const next = applyPatch(clean(d), patch);
      if (!next) return undefined;
      tx.set(ref, this.toDoc(next));
      return next;
    });
  }

  async findByIdempotencyKey(authId: string, key: string): Promise<Reminder | undefined> {
    const snap = await (await this.col()).where("account", "==", accountHash(authId)).where("idempotencyKey", "==", key).limit(5).get();
    const d = snap.docs.map((x) => x.data()).find((x) => !!x && x.authId === authId);
    return d ? clean(d) : undefined;
  }

  private rows(snap: QuerySnap, authId: string): Reminder[] {
    return snap.docs
      .map((d) => d.data())
      .filter((d): d is Record<string, unknown> => !!d && d.authId === authId)
      .map((d) => clean(d));
  }

  /** account == h AND status == s, one equality query per active status. */
  private activeQueries(col: Collection, authId: string): Query[] {
    const h = accountHash(authId);
    return ACTIVE_STATUSES.map((s) => col.where("account", "==", h).where("status", "==", s));
  }

  /** account == h AND toDigits == d, plus account == h AND to == +d for records written before toDigits existed. */
  private destinationQueries(col: Collection, authId: string, toDigits: string): Query[] {
    const h = accountHash(authId);
    const d = digits(toDigits);
    return [col.where("account", "==", h).where("toDigits", "==", d).limit(LIMIT_SCAN), col.where("account", "==", h).where("to", "==", `+${d}`).limit(LIMIT_SCAN)];
  }

  private dedupe(lists: Reminder[][]): Reminder[] {
    const seen = new Map<string, Reminder>();
    for (const r of lists.flat()) if (!seen.has(r.id)) seen.set(r.id, r);
    return [...seen.values()];
  }

  async countActive(authId: string): Promise<number> {
    const col = await this.col();
    const counts = await Promise.all(
      this.activeQueries(col, authId).map(async (q) =>
        q.count ? (await q.count().get()).data().count : this.rows(await q.limit(LIMIT_SCAN).get(), authId).length,
      ),
    );
    return counts.reduce((a, b) => a + b, 0);
  }

  async listByDestination(authId: string, toDigits: string): Promise<Reminder[]> {
    const col = await this.col();
    const snaps = await Promise.all(this.destinationQueries(col, authId, toDigits).map((q) => q.get()));
    return this.dedupe(snaps.map((s) => this.rows(s, authId)));
  }

  async createGuarded(r: Reminder, guard: (s: LimitSnapshot) => void): Promise<void> {
    const db = await this.db();
    const col = db.collection(this.collection);
    // Per-account lock document (no account/status fields, so no query ever returns it). Every guarded create reads
    // and rewrites it, so two schedules on one account conflict and Firestore retries the later one, which then sees
    // the earlier insert. Without it, the queries' pessimistic locks cover only documents that already exist.
    const lock = col.doc(`${accountHash(r.authId)}__limits`);
    await db.runTransaction(async (tx) => {
      await tx.get(lock);
      const active = await Promise.all(this.activeQueries(col, r.authId).map((q) => tx.get(q.limit(LIMIT_SCAN))));
      const dest = await Promise.all(this.destinationQueries(col, r.authId, digits(r.to)).map((q) => tx.get(q)));
      guard({
        active: active.reduce((n, s) => n + this.rows(s, r.authId).length, 0),
        destination: this.dedupe(dest.map((s) => this.rows(s, r.authId))),
      });
      tx.set(lock, { updatedAt: new Date().toISOString() });
      tx.create(col.doc(FirestoreStore.docId(r.authId, r.id)), this.toDoc(r));
    });
  }

  async listByStatus(status: ReminderStatus, limit = 500): Promise<Reminder[]> {
    const snap = await (await this.col()).where("status", "==", status).limit(limit).get();
    return snap.docs
      .map((d) => d.data())
      .filter((d): d is Record<string, unknown> => !!d && typeof d.authId === "string")
      .map((d) => clean(d));
  }
}
