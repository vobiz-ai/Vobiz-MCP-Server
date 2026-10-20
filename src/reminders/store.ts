/**
 * Durable reminder records. Neither store ever sees an auth token: Reminder has no such field and the
 * stores copy only Reminder fields (plus the account hash used for listing).
 *
 *   MemoryStore     tests and single-process deployments (lost on restart)
 *   FirestoreStore  hosted (Cloud Run): collection `reminders`, document `${accountHash}_${rid}`
 */
import { createHash } from "node:crypto";
import type { Reminder, ReminderStatus, ReminderStore } from "./types.js";

type Patch = Partial<Reminder> | ((current: Reminder) => Partial<Reminder> | undefined);

/** First 16 hex chars of sha256(authId): groups an account's reminders without storing the Auth ID as a key. */
export function accountHash(authId: string): string {
  return createHash("sha256").update(authId).digest("hex").slice(0, 16);
}

/** Fields that belong to a Reminder; anything else (account, tokens) is dropped on read and write. */
const FIELDS: (keyof Reminder)[] = [
  "id", "authId", "clientId", "status", "createdAt", "updatedAt", "nextAt", "attempts", "idempotencyKey",
  "kind", "message", "at", "timezone", "to", "from", "language", "voice", "snoozeMinutes", "maxAttempts",
  "retryMinutes", "audioUrl",
];

function clean(r: Partial<Reminder> & Record<string, unknown>): Reminder {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (r[k] !== undefined) out[k] = r[k];
  out.attempts = Array.isArray(r.attempts) ? r.attempts.map((a) => ({ ...a })) : [];
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
  set(ref: DocRef, data: Record<string, unknown>): unknown;
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
}
