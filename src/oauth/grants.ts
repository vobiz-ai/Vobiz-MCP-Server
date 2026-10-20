/**
 * Refresh-token families and used authorization codes (OAuth 2.1 §4.3.1 rotation with reuse detection, §4.1.3
 * single-use codes). No credentials are stored: a family holds only ids, timestamps and a hash of the Auth ID.
 *
 * One authorization-code exchange starts a family. Every refresh token carries the family id (`fam`) and a token id
 * (`jti`); only the family's `currentJti` may be redeemed, which rotates it. The previous jti is still accepted for
 * GRACE_MS after a rotation (clients refresh proactively and replicas race), returning the current generation again.
 * Any other jti is a replay: the whole family is revoked. A family lives at most FAMILY_MAX_AGE_MS.
 *
 *   MemoryGrantStore     tests and single-process deployments (lost on restart: everyone signs in again)
 *   FirestoreGrantStore  hosted: collections `oauth_grants` (doc id = family id) and `oauth_codes` (doc id = code jti)
 *                        Both carry an `expireAt` timestamp for a Firestore TTL policy.
 */
import { createHash } from "node:crypto";

export const GRACE_MS = 60_000;
export const FAMILY_MAX_AGE_MS = 90 * 24 * 3600 * 1000;

export interface GrantFamily {
  id: string;
  authIdHash: string;
  clientId: string;
  currentJti: string;
  prevJti: string | null;
  rotatedAt: number | null;
  createdAt: number;
  revokedAt: number | null;
  /** Set when a refresh was allowed although Vobiz could not be reached to re-check the credentials. */
  unverifiedAt?: number | null;
}

export type RotateOutcome =
  | { kind: "rotated"; family: GrantFamily }
  | { kind: "grace"; family: GrantFamily }
  | { kind: "reuse" }
  | { kind: "revoked" }
  | { kind: "expired" }
  | { kind: "missing" };

export interface GrantStore {
  readonly kind: "memory" | "firestore";
  /** Creates the family; false when one with this id already exists. */
  create(f: GrantFamily): Promise<boolean>;
  get(id: string): Promise<GrantFamily | undefined>;
  /** Atomically redeems `jti` in family `id`, rotating to `newJti` (see decide()). */
  rotate(id: string, jti: string, newJti: string, now?: number): Promise<RotateOutcome>;
  /** Marks the family revoked; when it does not exist and `seed` is given, stores the seed already revoked. */
  revoke(id: string, now?: number, seed?: GrantFamily): Promise<void>;
  setUnverified(id: string, at: number | null): Promise<void>;
  /** Records a used authorization code; false when it was used before (on any replica). */
  consumeCode(jti: string, expiresAtMs: number): Promise<boolean>;
}

export function authIdHash(authId: string): string {
  return createHash("sha256").update(authId).digest("hex").slice(0, 16);
}

/** Family age limit check. */
export const familyExpired = (f: GrantFamily, now = Date.now()) => now - f.createdAt > FAMILY_MAX_AGE_MS;

/** The rotation rule, shared by both stores so they cannot drift: the outcome and the record to write, if any. */
export function decide(f: GrantFamily | undefined, jti: string, newJti: string, now: number): { outcome: RotateOutcome; next?: GrantFamily } {
  if (!f) return { outcome: { kind: "missing" } };
  if (f.revokedAt) return { outcome: { kind: "revoked" } };
  if (familyExpired(f, now)) return { outcome: { kind: "expired" }, next: { ...f, revokedAt: now } };
  if (jti === f.currentJti) {
    const next = { ...f, currentJti: newJti, prevJti: jti, rotatedAt: now };
    return { outcome: { kind: "rotated", family: next }, next };
  }
  if (f.prevJti && jti === f.prevJti && f.rotatedAt && now - f.rotatedAt <= GRACE_MS) return { outcome: { kind: "grace", family: f } };
  return { outcome: { kind: "reuse" }, next: { ...f, revokedAt: now } };
}

const copy = (f: GrantFamily): GrantFamily => ({ ...f });

export class MemoryGrantStore implements GrantStore {
  readonly kind = "memory" as const;
  private readonly families = new Map<string, GrantFamily>();
  private readonly codes = new Map<string, number>();

  async create(f: GrantFamily): Promise<boolean> {
    if (this.families.has(f.id)) return false;
    this.families.set(f.id, copy(f));
    return true;
  }
  async get(id: string): Promise<GrantFamily | undefined> {
    const f = this.families.get(id);
    return f ? copy(f) : undefined;
  }
  async rotate(id: string, jti: string, newJti: string, now = Date.now()): Promise<RotateOutcome> {
    // Synchronous between read and write, so atomic within this process.
    const d = decide(this.families.get(id), jti, newJti, now);
    if (d.next) this.families.set(id, copy(d.next));
    return d.outcome;
  }
  async revoke(id: string, now = Date.now(), seed?: GrantFamily): Promise<void> {
    const f = this.families.get(id) ?? (seed ? copy(seed) : undefined);
    if (f && !f.revokedAt) this.families.set(id, { ...f, revokedAt: now });
  }
  async setUnverified(id: string, at: number | null): Promise<void> {
    const f = this.families.get(id);
    if (f) this.families.set(id, { ...f, unverifiedAt: at });
  }
  async consumeCode(jti: string, expiresAtMs: number): Promise<boolean> {
    const now = Date.now();
    for (const [k, exp] of this.codes) if (exp < now) this.codes.delete(k);
    if (this.codes.has(jti)) return false;
    this.codes.set(jti, expiresAtMs);
    return true;
  }
}

// ── Firestore ─────────────────────────────────────────────────────
// Minimal structural view of the client, so @google-cloud/firestore is imported only when used (and tests pass a fake).

interface DocSnap {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
export interface GrantDocRef {
  get(): Promise<DocSnap>;
}
interface Tx {
  get(ref: GrantDocRef): Promise<DocSnap>;
  set(ref: GrantDocRef, data: Record<string, unknown>): unknown;
}
export interface GrantFirestoreLike {
  collection(name: string): { doc(id: string): GrantDocRef };
  runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface FirestoreGrantStoreOptions {
  projectId?: string;
  databaseId?: string;
  /** Collection names, default oauth_grants / oauth_codes. */
  grantsCollection?: string;
  codesCollection?: string;
  db?: GrantFirestoreLike;
}

const FIELDS: (keyof GrantFamily)[] = ["id", "authIdHash", "clientId", "currentJti", "prevJti", "rotatedAt", "createdAt", "revokedAt", "unverifiedAt"];

function fromDoc(d: Record<string, unknown> | undefined): GrantFamily | undefined {
  if (!d || typeof d.id !== "string" || typeof d.currentJti !== "string" || typeof d.createdAt !== "number") return undefined;
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = d[k] ?? null;
  return out as unknown as GrantFamily;
}

function toDoc(f: GrantFamily): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = f[k] ?? null;
  // TTL policy field: a day after the family can no longer be used.
  out.expireAt = new Date(f.createdAt + FAMILY_MAX_AGE_MS + 24 * 3600 * 1000);
  return out;
}

export class FirestoreGrantStore implements GrantStore {
  readonly kind = "firestore" as const;
  private dbPromise?: Promise<GrantFirestoreLike>;
  private readonly grants: string;
  private readonly codes: string;

  constructor(private readonly o: FirestoreGrantStoreOptions = {}) {
    this.grants = o.grantsCollection || "oauth_grants";
    this.codes = o.codesCollection || "oauth_codes";
    if (o.db) this.dbPromise = Promise.resolve(o.db);
  }

  private db(): Promise<GrantFirestoreLike> {
    this.dbPromise ??= import("@google-cloud/firestore").then(
      ({ Firestore }) => new Firestore({ projectId: this.o.projectId, databaseId: this.o.databaseId || "(default)", ignoreUndefinedProperties: true }) as unknown as GrantFirestoreLike,
    );
    return this.dbPromise;
  }

  /** Read-modify-write of one family in a transaction. */
  private async tx<T>(id: string, fn: (cur: GrantFamily | undefined) => { result: T; write?: GrantFamily }): Promise<T> {
    const db = await this.db();
    const ref = db.collection(this.grants).doc(id);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const { result, write } = fn(snap.exists ? fromDoc(snap.data()) : undefined);
      if (write) tx.set(ref, toDoc(write));
      return result;
    });
  }

  create(f: GrantFamily): Promise<boolean> {
    return this.tx(f.id, (cur) => (cur ? { result: false } : { result: true, write: f }));
  }
  async get(id: string): Promise<GrantFamily | undefined> {
    const snap = await (await this.db()).collection(this.grants).doc(id).get();
    return snap.exists ? fromDoc(snap.data()) : undefined;
  }
  rotate(id: string, jti: string, newJti: string, now = Date.now()): Promise<RotateOutcome> {
    return this.tx(id, (cur) => {
      const d = decide(cur, jti, newJti, now);
      return { result: d.outcome, write: d.next };
    });
  }
  revoke(id: string, now = Date.now(), seed?: GrantFamily): Promise<void> {
    return this.tx(id, (cur) => {
      const f = cur ?? seed;
      return { result: undefined, write: f && !f.revokedAt ? { ...f, revokedAt: now } : undefined };
    });
  }
  setUnverified(id: string, at: number | null): Promise<void> {
    return this.tx(id, (cur) => ({ result: undefined, write: cur ? { ...cur, unverifiedAt: at } : undefined }));
  }
  async consumeCode(jti: string, expiresAtMs: number): Promise<boolean> {
    const db = await this.db();
    const ref = db.collection(this.codes).doc(jti);
    // Create-if-absent in a transaction, so two replicas redeeming the same code cannot both succeed.
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { usedAt: Date.now(), expireAt: new Date(expiresAtMs) });
      return true;
    });
  }
}
