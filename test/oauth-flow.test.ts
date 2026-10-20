import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";
import { Sealer, createHostedApp, type HostedOptions } from "../src/hosted.js";
import { VOBIZ_FAVICON_SVG } from "../src/brand.js";
import { json, mockFetch, testConfig } from "./helpers.js";

const GOOD_ID = "MA_GOOD1234";
const GOOD_TOKEN = "good-token-value";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const ISSUER = "https://mcp.example.test/";

let upstreamStatus = 200;
const vobiz = mockFetch([
  {
    method: "GET",
    path: `/api/v1/Account/${GOOD_ID}/numbers`,
    respond: (r) => (upstreamStatus !== 200 ? json(upstreamStatus, { error: "x" }) : r.headers["X-Auth-Token"] === GOOD_TOKEN ? json(200, { items: [], total: 0 }) : json(401, { error: "auth" })),
  },
  { method: "GET", path: "/api/v1/Account/MA_GONE4040/numbers", respond: () => json(404, { error: "not found" }) },
]);

const servers: (() => void)[] = [];
afterAll(() => servers.forEach((c) => c()));

async function start(extra: Partial<HostedOptions> = {}, env: Record<string, string> = {}) {
  const app = createHostedApp({
    cfg: testConfig({ VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined, VOBIZ_TRUSTED_CLIENTS: "app.example.com=Example App", ...env }),
    log: silentLogger,
    baseUrl: "https://mcp.example.test",
    secret: "s".repeat(40),
    fetchImpl: vobiz.impl,
    loginLimits: { perIp: 1000, perAuthId: 1000 },
    ...extra,
  });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  servers.push(() => srv.close());
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(base: string, redirect_uris: string[], client_name = "Acme Dialer") {
  const r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name, redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  return { status: r.status, body: (await r.json()) as { client_id: string; error?: string } };
}

function authorizeUrl(base: string, clientId: string, redirect: string, over: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams();
  const all = { response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "st-1", resource: "https://mcp.example.test/mcp", ...over };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, v);
  return `${base}/authorize?${q}`;
}

const txnOf = (html: string) => /name="txn" value="([^"]+)"/.exec(html)![1]!;

describe("consent page by client kind", async () => {
  const base = await start();

  it("verified client: fixed name, redirect host, Full access preselected", async () => {
    const { body } = await register(base, [CLAUDE_CB], "Definitely Not Claude");
    const page = await fetch(authorizeUrl(base, body.client_id, CLAUDE_CB));
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain("<strong><bdi>Claude</bdi></strong> wants to use your Vobiz account.");
    expect(html).toContain("Returns to <bdi>claude.ai</bdi>");
    expect(html).not.toContain("Definitely Not Claude");
    expect(html).not.toContain("Unverified app");
    expect(html).toContain('value="full" checked');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  });

  it("operator-trusted host shows the configured name", async () => {
    const { body } = await register(base, ["https://app.example.com/oauth/cb"], "Claude Impostor");
    const html = await (await fetch(authorizeUrl(base, body.client_id, "https://app.example.com/oauth/cb"))).text();
    expect(html).toContain("<bdi>Example App</bdi></strong> wants to use your Vobiz account.");
    expect(html).toContain('value="full" checked');
  });

  it("local client: 'on this computer', callback host:port note, Read-only preselected", async () => {
    const { body } = await register(base, ["http://127.0.0.1/callback"], "My CLI");
    const html = await (await fetch(authorizeUrl(base, body.client_id, "http://127.0.0.1:49152/callback"))).text();
    expect(html).toContain("<strong><bdi>My CLI</bdi></strong> on this computer wants to use your Vobiz account.");
    expect(html).toContain("callback <bdi>127.0.0.1:49152</bdi>");
    expect(html).toContain("Only continue if you started it yourself.");
    expect(html).toContain('value="read" checked');
    expect(html).not.toContain('value="full" checked');
  });

  it("unverified client: amber banner with the full redirect URI, sanitised name, Read-only preselected", async () => {
    const redirect = "https://tools.evil.example/cb?x=<b>";
    const { body } = await register(base, [redirect], 'Acme <img src=x> \u202Etool');
    const html = await (await fetch(authorizeUrl(base, body.client_id, redirect))).text();
    expect(html).toContain("Unverified app");
    expect(html).toContain("Redirect URL: <code><bdi>https://tools.evil.example/cb?x=&lt;b&gt;</bdi></code>");
    expect(html).toContain("Vobiz has not verified this app. Only continue if you built or trust it.");
    expect(html).toContain("support@vobiz.ai");
    expect(html).toContain("<bdi>Acme &lt;img src=x&gt; tool</bdi>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("\u202E");
    expect(html).toContain('value="read" checked');
  });

  it("unverified client cannot borrow a brand name", async () => {
    const { body } = await register(base, ["https://tools.evil.example/cb"], "ChatGPT Official");
    const html = await (await fetch(authorizeUrl(base, body.client_id, "https://tools.evil.example/cb"))).text();
    expect(html).toContain("<bdi>An MCP client</bdi>");
    expect(html).not.toContain("ChatGPT Official");
  });

  it("keeps the unverified layout when the form is shown again with an error", async () => {
    const { body } = await register(base, ["https://tools.evil.example/cb"]);
    const html = await (await fetch(authorizeUrl(base, body.client_id, "https://tools.evil.example/cb"))).text();
    const r = await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn: txnOf(html), auth_id: "bad", auth_token: "x", scope: "read" }), redirect: "manual" });
    const again = await r.text();
    expect(again).toContain("Unverified app");
    expect(again).toContain("Enter a valid Auth ID");
  });

  it("serves the favicon and redirects /favicon.ico", async () => {
    const r = await fetch(`${base}/favicon.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(r.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await r.text()).toBe(VOBIZ_FAVICON_SVG);
    expect(VOBIZ_FAVICON_SVG).toContain("#E83C00");
    const ico = await fetch(`${base}/favicon.ico`, { redirect: "manual" });
    expect(ico.status).toBe(301);
    expect(ico.headers.get("location")).toBe("/favicon.svg");
  });
});


describe("dynamic client registration rules", async () => {
  const base = await start();

  it("accepts Claude's https callback and loopback with a port", async () => {
    for (const uris of [[CLAUDE_CB], ["http://localhost:8765/callback"], ["http://127.0.0.1/callback", "http://[::1]:3000/cb"], ["https://app.example.com/cb?a=1"]]) {
      const r = await register(base, uris);
      expect(r.status).toBe(201);
      expect(r.body.client_id).toMatch(/^vbzc_/);
    }
  });

  it("rejects http off loopback, fragments, wildcards and custom schemes with invalid_client_metadata", async () => {
    for (const uri of ["http://evil.example/cb", "https://a.example/cb#frag", "https://*.example.com/cb", "https://a.example/*", "myapp://callback", "com.example.app:/oauth"]) {
      const r = await register(base, [uri]);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_client_metadata");
    }
    const mixed = await register(base, [CLAUDE_CB, "http://evil.example/cb"]);
    expect(mixed.body.error).toBe("invalid_client_metadata");
  });

  it("caps client_name at 256 characters", async () => {
    const r = await register(base, [CLAUDE_CB], "n".repeat(1000));
    expect(r.status).toBe(201);
    expect((r.body as unknown as { client_name: string }).client_name).toHaveLength(256);
  });
});

describe("authorize errors", async () => {
  const base = await start();
  const claude = (await register(base, [CLAUDE_CB])).body.client_id;
  const unverified = (await register(base, ["https://tools.evil.example/cb"])).body.client_id;
  const local = (await register(base, ["http://localhost/callback"])).body.client_id;

  const bad: [Record<string, string | undefined>, string][] = [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ response_type: undefined }, "invalid_request"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: undefined }, "invalid_request"],
    [{ resource: "https://evil.example/mcp" }, "invalid_target"],
    [{ resource: "https://mcp.example.test/other" }, "invalid_target"],
  ];

  it("verified clients get an error redirect carrying error, state and iss", async () => {
    for (const [over, code] of bad) {
      const r = await fetch(authorizeUrl(base, claude, CLAUDE_CB, over), { redirect: "manual" });
      expect(r.status).toBe(302);
      const to = new URL(r.headers.get("location")!);
      expect(to.origin + to.pathname).toBe(CLAUDE_CB);
      expect(to.searchParams.get("error")).toBe(code);
      expect(to.searchParams.get("state")).toBe("st-1");
      expect(to.searchParams.get("iss")).toBe(ISSUER);
    }
  });

  it("unverified and local clients get a plain error page, never a redirect", async () => {
    for (const [id, cb] of [[unverified, "https://tools.evil.example/cb"], [local, "http://localhost:5555/callback"]] as const) {
      for (const [over, code] of bad) {
        const r = await fetch(authorizeUrl(base, id, cb, over), { redirect: "manual" });
        expect(r.status).toBe(400);
        expect(r.headers.get("location")).toBeNull();
        expect(r.headers.get("content-type")).toContain("text/html");
        expect(r.headers.get("content-security-policy")).toContain("form-action 'none'");
        expect(await r.text()).toContain(code);
      }
    }
  });

  it("tolerates a missing resource and accepts the origin or a different case", async () => {
    for (const resource of [undefined, "https://mcp.example.test", "https://MCP.EXAMPLE.TEST/mcp", "HTTPS://mcp.example.test/"]) {
      const r = await fetch(authorizeUrl(base, claude, CLAUDE_CB, { resource }), { redirect: "manual" });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("Connect your Vobiz account");
    }
  });

  it("leaves unknown clients and unregistered redirects to the SDK's 400", async () => {
    const r1 = await fetch(authorizeUrl(base, "vbzc_bogus", CLAUDE_CB), { redirect: "manual" });
    expect(r1.status).toBe(400);
    const r2 = await fetch(authorizeUrl(base, claude, "https://evil.example/cb"), { redirect: "manual" });
    expect(r2.status).toBe(400);
    expect(r2.headers.get("location")).toBeNull();
  });

  it("refuses CIMD client_ids outside the verified list", async () => {
    const r = await fetch(authorizeUrl(base, "https://claude.ai/oauth/some-other-client", CLAUDE_CB), { redirect: "manual" });
    expect(r.status).toBe(400);
    expect(vobiz.calls.some((c) => c.url.href.includes("some-other-client"))).toBe(false);
  });
});

describe("sign-in checks", async () => {
  const base = await start();
  const claude = (await register(base, [CLAUDE_CB])).body.client_id;
  const consentTxn = async () => txnOf(await (await fetch(authorizeUrl(base, claude, CLAUDE_CB))).text());
  const login = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams(form), headers, redirect: "manual" });

  it("fails closed on 404 and 429 from Vobiz", async () => {
    const r404 = await login({ txn: await consentTxn(), auth_id: "MA_GONE4040", auth_token: "whatever-token", scope: "read" });
    expect(r404.status).toBe(200);
    expect(await r404.text()).toContain("did not accept");
    for (const [code, msg] of [[429, "too many requests"], [503, "status 503"], [302, "status 302"]] as const) {
      upstreamStatus = code;
      try {
        const r = await login({ txn: await consentTxn(), auth_id: GOOD_ID, auth_token: GOOD_TOKEN, scope: "read" });
        expect(r.status).toBe(200);
        expect(r.headers.get("location")).toBeNull();
        expect(await r.text()).toContain(msg);
      } finally {
        upstreamStatus = 200;
      }
    }
    const ok = await login({ txn: await consentTxn(), auth_id: GOOD_ID, auth_token: GOOD_TOKEN, scope: "read" });
    expect(ok.status).toBe(302);
  });

  it("caps failed attempts per sign-in transaction at 5", async () => {
    let txn = await consentTxn();
    const original = txn;
    for (let i = 1; i <= 4; i++) {
      const r = await login({ txn, auth_id: GOOD_ID, auth_token: "wrong-token-x", scope: "read" });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain("did not accept");
      txn = txnOf(html);
      expect(txn).not.toBe(original);
    }
    const fifth = await login({ txn, auth_id: GOOD_ID, auth_token: "wrong-token-x", scope: "read" });
    expect(fifth.status).toBe(429);
    // A transaction whose counter is spent is refused even with correct credentials.
    const sealer = new Sealer("s".repeat(40));
    const spent = sealer.seal("txn", { ...sealer.open<Record<string, unknown>>("txn", txn)!, exp: undefined, n: 5 }, 600);
    const r = await login({ txn: spent, auth_id: GOOD_ID, auth_token: GOOD_TOKEN, scope: "read" });
    expect(r.status).toBe(429);
    expect(r.headers.get("location")).toBeNull();
  });

  it("refuses cross-site form posts", async () => {
    const txn = await consentTxn();
    const form = { txn, auth_id: GOOD_ID, auth_token: GOOD_TOKEN, scope: "read" };
    expect((await login(form, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await login(form, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await login(form, { Origin: "null" })).status).toBe(403);
    expect((await login(form, { "Sec-Fetch-Site": "same-origin", Origin: "https://mcp.example.test" })).status).toBe(302);
  });

  it("the consent page sends Referrer-Policy same-origin so the form post keeps its Origin", async () => {
    const page = await fetch(authorizeUrl(base, claude, CLAUDE_CB));
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
  });
});

describe("sign-in rate limits", () => {
  it("returns 429 after 10 attempts from one IP in 15 minutes", async () => {
    const base = await start({ loginLimits: undefined });
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn: "x", auth_id: `MA_IP${i}0000` }) });
      expect(r.status).toBe(400);
    }
    const r = await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn: "x", auth_id: "MA_IPX0000" }) });
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("Too many sign-in attempts");
  });

  it("returns 429 after 10 attempts for one Auth ID, whatever the IP budget", async () => {
    const base = await start({ loginLimits: { perIp: 1000 } });
    for (let i = 0; i < 10; i++) {
      expect((await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn: "x", auth_id: "MA_TARGET1" }) })).status).toBe(400);
    }
    expect((await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn: "x", auth_id: " ma_target1 " }) })).status).toBe(429);
    expect((await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn: "x", auth_id: "MA_OTHER22" }) })).status).toBe(400);
  });
});
