import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";
import { Sealer, createHostedApp } from "../src/hosted.js";
import { FAMILY_MAX_AGE_MS, FirestoreGrantStore, MemoryGrantStore, decide, type GrantFamily, type GrantFirestoreLike, type GrantStore } from "../src/oauth/grants.js";
import { json, mockFetch, testConfig } from "./helpers.js";

const GOOD_ID = "MA_GOOD1234";
const GOOD_TOKEN = "good-token-value";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const SECRET = "s".repeat(40);

/** In-memory imitation of the Firestore surface the grant store uses (transactions run one at a time). */
function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (col: string, id: string) => ({
    key: `${col}/${id}`,
    async get() {
      const d = docs.get(`${col}/${id}`);
      return { exists: !!d, data: () => (d ? structuredClone(d) : undefined) };
    },
  });
  let chain = Promise.resolve();
  const db: GrantFirestoreLike & { docs: typeof docs } = {
    docs,
    collection: (name: string) => ({ doc: (id: string) => ref(name, id) }),
    runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const run = chain.then(async () => {
        const writes: [string, Record<string, unknown>][] = [];
        const out = await fn({ get: (r: { get(): Promise<unknown> }) => r.get(), set: (r: { key: string }, data: Record<string, unknown>) => writes.push([r.key, structuredClone(data)]) });
        for (const [k, v] of writes) docs.set(k, v);
        return out;
      });
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return db;
}

let upstream: number | "network" = 200;
const vobiz = mockFetch([
  {
    method: "GET",
    path: `/api/v1/Account/${GOOD_ID}/numbers`,
    respond: (r) => (upstream === "network" ? "network" : upstream !== 200 ? json(upstream, {}) : r.headers["X-Auth-Token"] === GOOD_TOKEN ? json(200, { items: [] }) : json(401, {})),
  },
]);

const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function start(grants: GrantStore) {
  const app = createHostedApp({
    cfg: testConfig({ VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined }),
    log: silentLogger,
    baseUrl: "https://mcp.example.test",
    secret: SECRET,
    fetchImpl: vobiz.impl,
    loginLimits: { perIp: 1000, perAuthId: 1000 },
    grants,
  });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  closers.push(() => srv.close());
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

async function signIn(base: string) {
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
  const html = await (await fetch(`${base}/authorize?${q}`)).text();
  const txn = /name="txn" value="([^"]+)"/.exec(html)![1]!;
  const login = await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn, auth_id: GOOD_ID, auth_token: GOOD_TOKEN, scope: "read" }), redirect: "manual" });
  const code = new URL(login.headers.get("location")!).searchParams.get("code")!;
  return { client_id, verifier, code };
}

async function post(base: string, path: string, body: Record<string, string>) {
  const r = await fetch(`${base}${path}`, { method: "POST", body: new URLSearchParams(body) });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

const exchange = (base: string, s: { client_id: string; verifier: string; code: string }) =>
  post(base, "/token", { grant_type: "authorization_code", code: s.code, code_verifier: s.verifier, client_id: s.client_id, redirect_uri: CLAUDE_CB });
const refresh = (base: string, client_id: string, refresh_token: string) => post(base, "/token", { grant_type: "refresh_token", refresh_token, client_id });
const mcpStatus = async (base: string, access: string) =>
  (await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;
const famOf = (refreshToken: string) => new Sealer(SECRET).open<{ fam: string; jti: string }>("refresh", refreshToken)!;

describe("rotation rule", () => {
  const f: GrantFamily = { id: "f", authIdHash: "h", clientId: "c", currentJti: "j1", prevJti: null, rotatedAt: null, createdAt: 1_000, revokedAt: null };
  it("rotates the current jti, allows the previous one for 60 s, revokes on any other", () => {
    const r = decide(f, "j1", "j2", 2_000);
    expect(r.outcome.kind).toBe("rotated");
    const g = r.next!;
    expect(g).toMatchObject({ currentJti: "j2", prevJti: "j1", rotatedAt: 2_000 });
    expect(decide(g, "j1", "x", 2_000 + 60_000).outcome.kind).toBe("grace");
    expect(decide(g, "j1", "x", 2_000 + 60_001).outcome.kind).toBe("reuse");
    expect(decide(g, "j0", "x", 2_001).next!.revokedAt).toBe(2_001);
    expect(decide({ ...g, revokedAt: 5 }, "j2", "x", 3_000).outcome.kind).toBe("revoked");
    expect(decide(g, "j2", "x", 1_000 + FAMILY_MAX_AGE_MS + 1).outcome.kind).toBe("expired");
    expect(decide(undefined, "j2", "x", 1).outcome.kind).toBe("missing");
  });
});

describe("refresh rotation end to end", async () => {
  const db = fakeFirestore();
  const store = new FirestoreGrantStore({ db });
  const base = await start(store);

  it("stores a family per sign-in without credentials, and rotates refresh tokens", async () => {
    const s = await signIn(base);
    const t = await exchange(base, s);
    expect(t.status).toBe(200);
    const fam = famOf(t.body.refresh_token!).fam;
    const doc = db.docs.get(`oauth_grants/${fam}`)!;
    expect(doc).toMatchObject({ id: fam, clientId: s.client_id, revokedAt: null });
    expect(JSON.stringify(doc)).not.toContain(GOOD_TOKEN);
    expect(JSON.stringify(doc)).not.toContain(GOOD_ID);
    expect(doc.expireAt).toBeInstanceOf(Date);

    const r1 = await refresh(base, s.client_id, t.body.refresh_token!);
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.body.refresh_token);
    expect(famOf(r1.body.refresh_token!).fam).toBe(fam);
    // Concurrent-refresh grace: the previous token, within 60 s, returns the current generation again.
    const again = await refresh(base, s.client_id, t.body.refresh_token!);
    expect(again.status).toBe(200);
    expect(famOf(again.body.refresh_token!).jti).toBe(famOf(r1.body.refresh_token!).jti);
    expect(await mcpStatus(base, again.body.access_token!)).toBe(200);
  });

  it("revokes the whole family when an old refresh token is replayed after the grace window", async () => {
    const s = await signIn(base);
    const t = await exchange(base, s);
    const r1 = await refresh(base, s.client_id, t.body.refresh_token!);
    const fam = famOf(t.body.refresh_token!).fam;
    const key = `oauth_grants/${fam}`;
    db.docs.set(key, { ...db.docs.get(key)!, rotatedAt: Date.now() - 61_000 });
    const replay = await refresh(base, s.client_id, t.body.refresh_token!);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(db.docs.get(key)!.revokedAt).toBeTypeOf("number");
    // The legitimate holder is cut off too: refresh and access tokens of the family stop working.
    expect((await refresh(base, s.client_id, r1.body.refresh_token!)).body.error).toBe("invalid_grant");
    expect(await mcpStatus(base, r1.body.access_token!)).toBe(401);
  });

  it("ends a family after 90 days", async () => {
    const s = await signIn(base);
    const t = await exchange(base, s);
    const key = `oauth_grants/${famOf(t.body.refresh_token!).fam}`;
    db.docs.set(key, { ...db.docs.get(key)!, createdAt: Date.now() - FAMILY_MAX_AGE_MS - 1000 });
    const r = await refresh(base, s.client_id, t.body.refresh_token!);
    expect(r.body.error).toBe("invalid_grant");
    expect(r.body.error_description).toContain("90 days");
  });

  it("re-checks the credentials with Vobiz on refresh: rejected ends the session, unreachable is allowed once", async () => {
    const s = await signIn(base);
    const t = await exchange(base, s);
    let rt = t.body.refresh_token!;
    try {
      upstream = "network";
      const once = await refresh(base, s.client_id, rt);
      expect(once.status).toBe(200);
      rt = once.body.refresh_token!;
      const twice = await refresh(base, s.client_id, rt);
      expect(twice.status).toBe(500);
      upstream = 200;
      const back = await refresh(base, s.client_id, rt);
      expect(back.status).toBe(200);
      rt = back.body.refresh_token!;
      upstream = 401;
      const gone = await refresh(base, s.client_id, rt);
      expect(gone.body.error).toBe("invalid_grant");
      upstream = 200;
      expect((await refresh(base, s.client_id, rt)).body.error).toBe("invalid_grant");
    } finally {
      upstream = 200;
    }
  });

  it("revokes a session through /revoke", async () => {
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.revocation_endpoint).toBe("https://mcp.example.test/revoke");
    expect(as.revocation_endpoint_auth_methods_supported).toContain("none");
    const s = await signIn(base);
    const t = await exchange(base, s);
    expect(await mcpStatus(base, t.body.access_token!)).toBe(200);
    const rv = await post(base, "/revoke", { token: t.body.access_token!, token_type_hint: "access_token", client_id: s.client_id });
    expect(rv.status).toBe(200);
    expect(await mcpStatus(base, t.body.access_token!)).toBe(401);
    expect((await refresh(base, s.client_id, t.body.refresh_token!)).body.error).toBe("invalid_grant");
    // Unknown tokens succeed silently (RFC 7009).
    expect((await post(base, "/revoke", { token: "garbage", client_id: s.client_id })).status).toBe(200);
  });

  it("migrates a refresh token from before families once, and can revoke it", async () => {
    const sealer = new Sealer(SECRET);
    const s = await signIn(base);
    const legacy = sealer.seal("refresh", { authId: GOOD_ID, authToken: GOOD_TOKEN, clientId: s.client_id, resource: "https://mcp.example.test/mcp", readOnly: true, scope: "read" }, 3600);
    const r = await refresh(base, s.client_id, legacy);
    expect(r.status).toBe(200);
    expect(famOf(r.body.refresh_token!).fam).toMatch(/^l[0-9a-f]{40}$/);
    const legacy2 = sealer.seal("refresh", { authId: GOOD_ID, authToken: GOOD_TOKEN, clientId: s.client_id, resource: "https://mcp.example.test/mcp", scope: "read" }, 3600);
    expect((await post(base, "/revoke", { token: legacy2, client_id: s.client_id })).status).toBe(200);
    expect((await refresh(base, s.client_id, legacy2)).body.error).toBe("invalid_grant");
  });

  it("rejects a foreign resource at /token with invalid_target", async () => {
    const s = await signIn(base);
    const r = await post(base, "/token", { grant_type: "authorization_code", code: s.code, code_verifier: s.verifier, client_id: s.client_id, redirect_uri: CLAUDE_CB, resource: "https://evil.example/mcp" });
    expect(r.body.error).toBe("invalid_target");
  });
});

describe("single-use authorization codes across replicas", () => {
  it("a code redeemed on one replica is refused on another sharing the store", async () => {
    const db = fakeFirestore();
    const a = await start(new FirestoreGrantStore({ db }));
    const b = await start(new FirestoreGrantStore({ db }));
    const s = await signIn(a);
    expect((await exchange(a, s)).status).toBe(200);
    const reuse = await exchange(b, s);
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
    expect([...db.docs.keys()].some((k) => k.startsWith("oauth_codes/"))).toBe(true);
  });

  it("two store instances on one database agree on code use", async () => {
    const db = fakeFirestore();
    const [x, y] = [new FirestoreGrantStore({ db }), new FirestoreGrantStore({ db })];
    const results = await Promise.all([x.consumeCode("j", Date.now() + 1000), y.consumeCode("j", Date.now() + 1000)]);
    expect(results.sort()).toEqual([false, true]);
  });

  it("the memory store keeps single use within one process", async () => {
    const m = new MemoryGrantStore();
    expect(await m.consumeCode("k", Date.now() + 1000)).toBe(true);
    expect(await m.consumeCode("k", Date.now() + 1000)).toBe(false);
  });
});
