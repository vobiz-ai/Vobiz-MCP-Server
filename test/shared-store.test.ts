import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { silentLogger } from "../src/logger.js";
import { createServer, createSharedState, type ServerOptions } from "../src/server.js";
import { IdempotencyStore, withIdempotency } from "../src/idempotency.js";
import { ReservationSet, othersInFlight } from "../src/guard/capacity.js";
import {
  FirestoreSharedBackend,
  MemorySharedBackend,
  STALE_IN_FLIGHT_MS,
  createFirestoreSharedBackend,
  tenantScope,
  type SharedFirestoreLike,
  type SharedStoreBackend,
} from "../src/guard/shared-store.js";
import { VobizError } from "../src/errors.js";
import { OWN_NUMBER, acct, capacityRoutes, json, mockFetch, ownNumberRoute, testConfig, type Route } from "./helpers.js";

const DEST = "+919812345678";
const UUID = "5a9fd4a0-3d4c-11ef-bef9-0242ac110005";
const args = { to: DEST, from: OWN_NUMBER, confirm: true };

/** One "replica": its own server, SharedState and fetch log, optionally sharing a backend with others. */
async function replica(routes: Route[], env: Record<string, string> = {}, opts: ServerOptions = {}) {
  const m = mockFetch([...routes, ...capacityRoutes]);
  const server = createServer(testConfig(env), silentLogger, m.impl, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, a2: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: a2 })) as { isError?: boolean; structuredContent?: Record<string, any> };
    return { isError: !!r.isError, data: r.structuredContent ?? {} };
  };
  return { call, calls: m.calls };
}
const posts = (calls: { method: string; url: URL }[]) => calls.filter((c) => c.method === "POST" && c.url.pathname === acct("/Call/"));
const placeRoute = (uuid = UUID): Route => ({ method: "POST", path: acct("/Call/"), respond: () => json(201, { message: "call queued", request_uuid: uuid }) });

/** Serialised in-memory Firestore: enough of the API for the shared backend, transactions run one at a time. */
function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  let chain = Promise.resolve();
  const ref = (col: string, id: string) => ({
    path: `${col}/${id}`,
    async get() {
      const d = docs.get(`${col}/${id}`);
      return { exists: !!d, data: () => (d ? structuredClone(d) : undefined) };
    },
  });
  const db: SharedFirestoreLike = {
    collection: (col) => ({ doc: (id) => ref(col, id) }),
    runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const run = chain.then(() =>
        fn({
          get: (r: any) => r.get(),
          set: (r: any, data: Record<string, unknown>) => docs.set(r.path, structuredClone(data)),
          delete: (r: any) => docs.delete(r.path),
        }),
      );
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return { db, docs };
}

describe("IdempotencyStore.fingerprint", () => {
  it("includes nested objects and ignores key order at every depth", () => {
    const a = IdempotencyStore.fingerprint({ op: "x", body: { to: "1", meta: { a: 1, b: 2 } } });
    const b = IdempotencyStore.fingerprint({ body: { meta: { b: 2, a: 1 }, to: "1" }, op: "x" });
    const c = IdempotencyStore.fingerprint({ op: "x", body: { to: "1", meta: { a: 1, b: 3 } } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(IdempotencyStore.fingerprint({ op: "x", body: { to: "2" } })).not.toBe(IdempotencyStore.fingerprint({ op: "x", body: { to: "3" } }));
  });

  it("matches the previous hash for flat parameters (existing idempotency files stay valid)", () => {
    const parts = { op: "make_call", from: "9190", to: "9198", answerUrl: "https://a", timeLimit: 600, list: ["b", "a"] };
    const legacy = createHash("sha256").update(JSON.stringify(parts, Object.keys(parts).sort())).digest("hex");
    expect(IdempotencyStore.fingerprint(parts)).toBe(legacy);
  });
});

describe("make_call concurrency reservation (no check-then-dial race)", () => {
  it("two concurrent calls with one free slot place exactly one call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let liveChecks = 0;
    const slowLive: Route = {
      method: "GET",
      path: acct("/Call/"),
      query: { status: "live" },
      respond: async () => {
        liveChecks++;
        if (liveChecks === 2) release();
        await gate; // both requests are past the reservation before either sees the live list
        return json(200, { calls: [] });
      },
    };
    const r = await replica([slowLive, ownNumberRoute, placeRoute()], { VOBIZ_MAX_CONCURRENT_CALLS: "1" });
    const [a, b] = await Promise.all([
      r.call("make_call", { ...args, idempotency_key: "conc-key-0001" }),
      r.call("make_call", { ...args, idempotency_key: "conc-key-0002" }),
    ]);
    expect([a.data, b.data].map((d) => d.error ?? "ok").sort()).toEqual(["ok", "rate_limited"]);
    expect(posts(r.calls)).toHaveLength(1);
    expect([a, b].filter((x) => x.isError).map((x) => x.data.error)).toEqual(["rate_limited"]);
  });

  it("releases the slot when the attempt fails, so the next call can use it", async () => {
    let ownsNumber = false;
    const numbers: Route = {
      method: "GET",
      path: acct("/numbers"),
      respond: () => json(200, { items: ownsNumber ? [{ e164: OWN_NUMBER, status: "active", voice_enabled: true }] : [] }),
    };
    const r = await replica([numbers, placeRoute()], { VOBIZ_MAX_CONCURRENT_CALLS: "1" });
    expect((await r.call("make_call", { ...args, idempotency_key: "fail-key-0001" })).data.error).toBe("not_allowed");
    ownsNumber = true;
    const ok = await r.call("make_call", { ...args, idempotency_key: "fail-key-0002" });
    expect(ok.isError).toBe(false);
  });

  it("does not double-count an accepted call once Vobiz lists it", () => {
    const set = new ReservationSet();
    const mine = set.reserve();
    const placed = set.reserve();
    set.settle(placed, UUID);
    expect(othersInFlight(set.list(), mine, new Set())).toBe(1);
    expect(othersInFlight(set.list(), mine, new Set([UUID]))).toBe(0);
    set.release(placed);
    expect(set.list().map((r) => r.id)).toEqual([mine]);
  });
});

describe.each([
  ["memory", () => new MemorySharedBackend()],
  ["firestore (fake)", () => new FirestoreSharedBackend({ db: fakeFirestore().db })],
])("shared backend across replicas (%s)", (_l, make: () => SharedStoreBackend) => {
  it("the same idempotency_key on another replica replays instead of dialling again", async () => {
    const backend = make();
    const a = await replica([ownNumberRoute, placeRoute()], {}, { backend, multiTenant: true });
    const b = await replica([ownNumberRoute, placeRoute()], {}, { backend, multiTenant: true });
    const first = await a.call("make_call", { ...args, idempotency_key: "shared-key-0001" });
    expect(first.isError).toBe(false);
    const again = await b.call("make_call", { ...args, idempotency_key: "shared-key-0001" });
    expect(again.isError).toBe(false);
    expect(again.data).toMatchObject({ request_uuid: UUID, replayed: true });
    expect(posts(a.calls)).toHaveLength(1);
    expect(posts(b.calls)).toHaveLength(0);
    const conflict = await b.call("make_call", { ...args, to: "+919812345679", idempotency_key: "shared-key-0001" });
    expect(conflict.data.error).toBe("idempotency_conflict");
  });

  it("an automatic duplicate on another replica is blocked", async () => {
    const backend = make();
    const a = await replica([ownNumberRoute, placeRoute()], {}, { backend });
    const b = await replica([ownNumberRoute, placeRoute()], {}, { backend });
    expect((await a.call("make_call", args)).isError).toBe(false);
    expect((await b.call("make_call", args)).data.error).toBe("duplicate_blocked");
    expect(posts(b.calls)).toHaveLength(0);
  });

  it("the per-minute cap is shared by replicas", async () => {
    const backend = make();
    const env = { VOBIZ_MAX_CALLS_PER_MINUTE: "1" };
    const a = await replica([ownNumberRoute, placeRoute()], env, { backend });
    const b = await replica([ownNumberRoute, placeRoute()], env, { backend });
    expect((await a.call("make_call", { ...args, idempotency_key: "rate-key-0001" })).isError).toBe(false);
    const r = await b.call("make_call", { ...args, idempotency_key: "rate-key-0002" });
    expect(r.data.error).toBe("rate_limited");
    expect(r.data.message).toMatch(/per minute/);
    expect(posts(b.calls)).toHaveLength(0);
  });

  it("an accepted call on one replica counts against the concurrency cap on another until Vobiz lists it", async () => {
    const backend = make();
    const env = { VOBIZ_MAX_CONCURRENT_CALLS: "1" };
    const a = await replica([ownNumberRoute, placeRoute()], env, { backend });
    const b = await replica([ownNumberRoute, placeRoute("6b0fd4a0-3d4c-11ef-bef9-0242ac110006")], env, { backend });
    expect((await a.call("make_call", { ...args, idempotency_key: "cap-key-0001" })).isError).toBe(false);
    const r = await b.call("make_call", { ...args, idempotency_key: "cap-key-0002" });
    expect(r.data.error).toBe("rate_limited");
    expect(r.data.message).toMatch(/being placed/);
  });

  it("send_message idempotency and message caps are shared", async () => {
    const backend = make();
    const sms: Route[] = [
      { method: "GET", path: "/api/v1/sms/numbers", respond: () => json(200, { numbers: [{ e164: "+14155550100" }] }) },
      { method: "POST", path: "/api/v1/sms/messages", respond: () => json(201, { id: "m-0001", status: "sent" }) },
    ];
    const env = { VOBIZ_ENABLE_MESSAGING: "true", VOBIZ_MAX_MESSAGES_PER_MINUTE: "1" };
    const a = await replica(sms, env, { backend });
    const b = await replica(sms, env, { backend });
    const msg = { from: "+14155550100", to: ["+14155550123"], text: "hi", confirm: true };
    expect((await a.call("send_message", { ...msg, idempotency_key: "msg-key-0001" })).isError).toBe(false);
    expect((await b.call("send_message", { ...msg, idempotency_key: "msg-key-0001" })).data.replayed).toBe(true);
    expect((await b.call("send_message", { ...msg, idempotency_key: "msg-key-0002" })).data.error).toBe("rate_limited");
  });
});

describe("FirestoreSharedBackend documents", () => {
  it("keys documents by tenant hash, stores fingerprint/result/expiresAt and never the Auth ID", async () => {
    const f = fakeFirestore();
    let now = 1_000_000;
    const backend = new FirestoreSharedBackend({ db: f.db, now: () => now });
    const scope = tenantScope("MA_TEST123");
    expect(scope).toMatch(/^[0-9a-f]{16}$/);
    const store = new IdempotencyStore();
    const out = await withIdempotency(store, "key:k-0001", "fp1", async () => ({ ok: true, request_uuid: UUID }), { shared: { backend, scope } });
    expect(out.request_uuid).toBe(UUID);
    const doc = f.docs.get(`idempotency/${scope}_key:k-0001`)!;
    expect(doc).toMatchObject({ state: "done", fingerprint: "fp1" });
    expect(doc.expiresAt).toBeInstanceOf(Date);
    expect(JSON.parse(String(doc.resultJson))).toMatchObject({ request_uuid: UUID });
    expect(JSON.stringify([...f.docs.entries()])).not.toContain("MA_TEST123");

    expect((await backend.tryAcquire(scope, [{ name: "calls_min", windowMs: 60_000, max: 2 }])).ok).toBe(true);
    expect((await backend.tryAcquire(scope, [{ name: "calls_min", windowMs: 60_000, max: 2 }, { name: "calls_hour", windowMs: 3_600_000, max: 1 }])).ok).toBe(true);
    // All-or-nothing: the hour cap refuses, so the minute counter is not consumed either.
    expect(await backend.tryAcquire(scope, [{ name: "calls_min", windowMs: 60_000, max: 3 }, { name: "calls_hour", windowMs: 3_600_000, max: 1 }])).toEqual({ ok: false, limit: "calls_hour" });
    const minuteDoc = [...f.docs.entries()].find(([k]) => k.startsWith(`counters/${scope}_calls_min-`))!;
    expect(minuteDoc[1].count).toBe(2);
    now += 60_000; // next window
    expect((await backend.tryAcquire(scope, [{ name: "calls_min", windowMs: 60_000, max: 2 }])).ok).toBe(true);
  });

  it("treats a stale in_flight record (dead replica) as an unknown outcome", async () => {
    let now = 5_000_000;
    const backend = new FirestoreSharedBackend({ db: fakeFirestore().db, now: () => now });
    expect((await backend.idempotencyBegin("s", "k", "fp", 3600_000)).kind).toBe("new");
    const live = await backend.idempotencyBegin("s", "k", "fp", 3600_000);
    expect(live.kind === "existing" && live.record.state).toBe("in_flight");
    now += STALE_IN_FLIGHT_MS + 1;
    const stale = await backend.idempotencyBegin("s", "k", "fp", 3600_000);
    expect(stale.kind === "existing" && stale.record.state).toBe("unknown");
  });

  it("refuses (fails closed) when the shared store is unreachable", async () => {
    const broken: SharedFirestoreLike = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }), runTransaction: async () => { throw new Error("unavailable"); } };
    const backend = new FirestoreSharedBackend({ db: broken });
    let ran = false;
    const err = await withIdempotency(new IdempotencyStore(), "k", "fp", async () => ((ran = true), {}), { shared: { backend, scope: "s" } }).catch((e) => e);
    expect(err).toBeInstanceOf(VobizError);
    expect(err.kind).toBe("service_unavailable");
    expect(ran).toBe(false);
  });

  it("createFirestoreSharedBackend builds a lazy backend without contacting Firestore", () => {
    expect(createFirestoreSharedBackend("project-x", "(default)")).toBeInstanceOf(FirestoreSharedBackend);
  });
});

describe("multi-tenant mode never uses VOBIZ_IDEMPOTENCY_FILE", () => {
  it("ignores the file with a warning when multiTenant is set", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "vobiz-idem-")), "idem.json");
    const cfg = testConfig({ VOBIZ_IDEMPOTENCY_FILE: file });
    const lines: string[] = [];
    const shared = createSharedState(cfg, false, { multiTenant: true, log: { info: (m) => lines.push(m), debug: () => {} } });
    shared.idempotency.begin("k", "fp");
    shared.idempotency.succeed("k", { ok: true });
    expect(existsSync(file)).toBe(false);
    expect(lines.join("\n")).toMatch(/VOBIZ_IDEMPOTENCY_FILE is ignored in multi-tenant mode/);

    const single = createSharedState(cfg);
    single.idempotency.begin("k", "fp");
    single.idempotency.succeed("k", { ok: true });
    expect(existsSync(file)).toBe(true);
  });
});
