import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { silentLogger } from "../src/logger.js";
import { HOSTED_EXCLUDED_TOOLS, Sealer, createHostedApp } from "../src/hosted.js";
import { BASE, json, mockFetch, testConfig } from "./helpers.js";

const GOOD_ID = "MA_GOOD1234";
const GOOD_TOKEN = "good-token-value";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

const vobiz = mockFetch([
  {
    method: "GET",
    path: `/api/v1/Account/${GOOD_ID}/numbers`,
    respond: (r) => (r.headers["X-Auth-Token"] === GOOD_TOKEN ? json(200, { items: [], total: 0 }) : json(401, { error: "auth" })),
  },
  { method: "GET", path: "/api/v1/Account/MA_WRONG999/numbers", respond: () => json(401, { error: "auth" }) },
  { method: "GET", path: `/api/v1/Account/${GOOD_ID}/balance`, respond: () => json(200, { balances: [{ available_balance: 10, currency: "USD" }] }) },
]);

let base = "";
let close: () => void;

beforeAll(async () => {
  const app = createHostedApp({
    cfg: testConfig({ VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined }),
    log: silentLogger,
    baseUrl: "https://mcp.example.test",
    secret: "s".repeat(40),
    fetchImpl: vobiz.impl,
  });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => srv.close();
});
afterAll(() => close());

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register() {
  const r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string };
}

async function authorize(clientId: string, challenge: string, creds: { id: string; token: string; readOnly?: boolean }) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: "https://mcp.example.test/mcp" });
  const page = await fetch(`${base}/authorize?${q}`);
  expect(page.status).toBe(200);
  // Browsers apply form-action to the post-submit redirect: the client's callback origin must be allowed.
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai;");
  const html = await page.text();
  expect(html).toContain("Connect your Vobiz account");
  const txn = /name="txn" value="([^"]+)"/.exec(html)![1];
  const form = new URLSearchParams({ txn, auth_id: creds.id, auth_token: creds.token, ...(creds.readOnly ? { read_only: "1" } : {}) });
  return fetch(`${base}/oauth/login`, { method: "POST", body: form, redirect: "manual" });
}

async function token(body: Record<string, string>) {
  const r = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams(body) });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

async function fullFlow(readOnly = false) {
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const login = await authorize(client_id, challenge, { id: GOOD_ID, token: GOOD_TOKEN, readOnly });
  expect(login.status).toBe(302);
  const cb = new URL(login.headers.get("location")!);
  expect(cb.origin + cb.pathname).toBe(CLAUDE_CB);
  expect(cb.searchParams.get("state")).toBe("st-1");
  const t = await token({ grant_type: "authorization_code", code: cb.searchParams.get("code")!, code_verifier: verifier, client_id, redirect_uri: CLAUDE_CB });
  expect(t.status).toBe(200);
  return { client_id, verifier, code: cb.searchParams.get("code")!, tokens: t.body };
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

describe("hosted connector OAuth", () => {
  it("publishes protected-resource and authorization-server metadata Claude can use", async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe("https://mcp.example.test/mcp");
    expect(prm.authorization_servers[0]).toMatch(/^https:\/\/mcp\.example\.test\/?$/);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(as.registration_endpoint).toBe("https://mcp.example.test/register");
  });

  it("answers an unauthenticated MCP request with 401 and a resource_metadata challenge", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"');
  });

  it("rejects wrong Vobiz credentials on the consent page", async () => {
    const { client_id } = await register();
    const r = await authorize(client_id, pkce().challenge, { id: "MA_WRONG999", token: "nope-nope-nope" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("did not accept");
  });

  it("runs the full flow: register, consent, code, token, MCP tools on the signed-in account, refresh", async () => {
    const { client_id, verifier, code, tokens } = await fullFlow();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).not.toContain(GOOD_TOKEN);

    // Codes are single use.
    const reuse = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: CLAUDE_CB });
    expect(reuse.status).toBe(400);

    const client = await mcpClient(tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("make_call");
    expect(names).toContain("send_message");
    for (const x of HOSTED_EXCLUDED_TOOLS) expect(names).not.toContain(x);
    const bal = await client.callTool({ name: "get_account_balance", arguments: {} });
    expect(bal.isError).toBeFalsy();
    const hit = vobiz.calls.find((c) => c.url.pathname.endsWith("/balance"))!;
    expect(hit.headers["X-Auth-ID"]).toBe(GOOD_ID);
    expect(hit.headers["X-Auth-Token"]).toBe(GOOD_TOKEN);
    expect(hit.url.origin).toBe(BASE);
    await client.close();

    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
  });

  it("read-only consent exposes only read-only tools", async () => {
    const { tokens } = await fullFlow(true);
    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("make_call");
    await client.close();
  });

  it("refuses tokens that are forged, expired or for another kind", async () => {
    const forged = new Sealer("x".repeat(40)).seal("access", { authId: GOOD_ID, authToken: GOOD_TOKEN, clientId: "c", resource: "https://mcp.example.test/mcp" }, 60);
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${forged}`, "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    const s = new Sealer("s".repeat(40));
    expect(s.open("access", s.seal("refresh", { a: 1 }, 60).replace(/^vbzr_/, "vbza_"))).toBeUndefined();
    expect(s.open("access", s.seal("access", { a: 1 }, -1))).toBeUndefined();
  });

  it("blocks browser origins that are not allowed", async () => {
    const { tokens } = await fullFlow();
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
  });
});
