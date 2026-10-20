import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";
import { createHostedApp, type HostedOptions } from "../src/hosted.js";
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
