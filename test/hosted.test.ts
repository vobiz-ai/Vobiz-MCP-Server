import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { silentLogger } from "../src/logger.js";
import { ASSISTANT_TOOLS, HOSTED_EXCLUDED_TOOLS, Sealer, createHostedApp } from "../src/hosted.js";
import { FakeReminders } from "./fake-reminders.js";
import { FakeMedia } from "./fake-media.js";
import { createMediaRouter } from "../src/media/router.js";
import { BASE, json, mockFetch, testConfig } from "./helpers.js";

const GOOD_ID = "MA_GOOD1234";
const GOOD_TOKEN = "good-token-value";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const MY_PHONE = "+919811112222";
const MY_DID = "+918012345678";
const reminders = new FakeReminders();
const media = new FakeMedia();

const vobiz = mockFetch([
  {
    method: "GET",
    path: `/api/v1/Account/${GOOD_ID}/numbers`,
    query: { search: MY_DID },
    respond: () => json(200, { items: [{ e164: MY_DID, status: "active", voice_enabled: true }], total: 1 }),
  },
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
    cfg: testConfig({ VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined, VOBIZ_OPENAI_APPS_CHALLENGE: "challenge-token-123" }),
    log: silentLogger,
    baseUrl: "https://mcp.example.test",
    secret: "s".repeat(40),
    fetchImpl: vobiz.impl,
    reminders,
    remindersRouter: express.Router().post("/jobs/fire", (_req, res) => res.json({ fired: false, reason: "router-mounted" })),
    media,
    mediaRouter: createMediaRouter(media, { baseUrl: "https://mcp.example.test", sealer: new Sealer("s".repeat(40)), log: silentLogger, links: testConfig().links }),
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

type Consent = { id: string; token: string; readOnly?: boolean; scope?: string; callMeOn?: string; callFrom?: string; tz?: string };

async function authorize(clientId: string, challenge: string, creds: Consent) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: "https://mcp.example.test/mcp" });
  const page = await fetch(`${base}/authorize?${q}`);
  expect(page.status).toBe(200);
  // Browsers apply form-action to the post-submit redirect: the client's callback origin must be allowed.
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai;");
  const html = await page.text();
  expect(html).toContain("Connect your Vobiz account");
  for (const f of ['name="scope" type="radio" value="read"', 'value="assistant"', 'value="full" checked', 'name="call_me_on"', 'name="call_from"', 'name="timezone"', 'value="Asia/Kolkata"', '<datalist id="tz_list">']) expect(html).toContain(f);
  expect(html).not.toContain("<script");
  const txn = /name="txn" value="([^"]+)"/.exec(html)![1];
  const form = new URLSearchParams({
    txn,
    auth_id: creds.id,
    auth_token: creds.token,
    ...(creds.readOnly ? { read_only: "1" } : {}),
    ...(creds.scope ? { scope: creds.scope } : {}),
    ...(creds.callMeOn !== undefined ? { call_me_on: creds.callMeOn } : {}),
    ...(creds.callFrom !== undefined ? { call_from: creds.callFrom } : {}),
    ...(creds.tz !== undefined ? { timezone: creds.tz } : {}),
  });
  return fetch(`${base}/oauth/login`, { method: "POST", body: form, redirect: "manual" });
}

async function token(body: Record<string, string>) {
  const r = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams(body) });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

async function fullFlow(readOnly = false, consent: Partial<Consent> = {}) {
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const login = await authorize(client_id, challenge, { id: GOOD_ID, token: GOOD_TOKEN, readOnly, ...consent });
  expect(login.status).toBe(302);
  const cb = new URL(login.headers.get("location")!);
  expect(cb.origin + cb.pathname).toBe(CLAUDE_CB);
  expect(cb.searchParams.get("state")).toBe("st-1");
  // RFC 9207: iss equals the advertised issuer.
  expect(cb.searchParams.get("iss")).toMatch(/^https:\/\/mcp\.example\.test\/?$/);
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
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
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

  it("allows ChatGPT browser origins", async () => {
    const { tokens } = await fullFlow();
    for (const origin of ["https://chatgpt.com", "https://chat.openai.com"]) {
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}`, Origin: origin } } }));
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await client.close();
    }
  });

  it("serves the OpenAI Apps challenge and mounts the reminders router", async () => {
    const r = await fetch(`${base}/.well-known/openai-apps-challenge`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(await r.text()).toBe("challenge-token-123");
    const fire = await fetch(`${base}/jobs/fire`, { method: "POST", body: "x" });
    expect(await fire.json()).toEqual({ fired: false, reason: "router-mounted" });

    const bare = createHostedApp({ cfg: testConfig({ VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined }), log: silentLogger, baseUrl: "https://mcp.example.test", secret: "s".repeat(40), fetchImpl: vobiz.impl });
    const srv = bare.listen(0, "127.0.0.1");
    await new Promise((res) => srv.once("listening", res));
    const u = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    expect((await fetch(`${u}/.well-known/openai-apps-challenge`)).status).toBe(404);
    expect((await fetch(`${u}/jobs/fire`, { method: "POST", body: "x" })).status).toBe(404);
    expect((await fetch(`${u}/upload/vbzu_x`)).status).toBe(404);
    expect((await fetch(`${u}/media/vbzm_x`)).status).toBe(404);
    srv.close();
  });
});

describe("hosted connector scopes and reminder calls", () => {
  it("validates the consent fields server-side", async () => {
    const { client_id } = await register();
    const cases: [Partial<Consent>, string][] = [
      [{ scope: "assistant", callMeOn: "" }, "needs your number"],
      [{ scope: "full", callMeOn: "98111" }, "E.164"],
      [{ scope: "full", callMeOn: MY_PHONE, callFrom: "<+1>" }, "Call from"],
      [{ scope: "full", tz: "Mars/Olympus" }, "timezone"],
    ];
    for (const [consent, msg] of cases) {
      const r = await authorize(client_id, pkce().challenge, { id: GOOD_ID, token: GOOD_TOKEN, ...consent });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(msg);
      // The choice is kept when the form is shown again.
      expect(html).toContain(`value="${consent.scope}" checked`);
    }
  });

  it("full scope offers the reminder tools; `to` defaults to the user's number", async () => {
    const { tokens } = await fullFlow(false, { scope: "full", callMeOn: "+91 98111-12222", callFrom: MY_DID, tz: "Asia/Kolkata" });
    const client = await mcpClient(tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["make_call", "schedule_reminder_call", "cancel_reminder_call"]));
    const before = reminders.scheduled.length;
    const r = await client.callTool({ name: "schedule_reminder_call", arguments: { at: "now", message: "Stand-up", confirm: true } });
    expect(r.isError).toBeFalsy();
    const s = reminders.scheduled[before]!;
    expect(s.input).toMatchObject({ to: MY_PHONE, from: MY_DID, timezone: "Asia/Kolkata" });
    expect(s.account).toEqual({ authId: GOOD_ID, authToken: GOOD_TOKEN });
    const other = await client.callTool({ name: "schedule_reminder_call", arguments: { at: "now", message: "x", to: "+919900000000", confirm: true } });
    expect(other.isError).toBeFalsy();
    await client.close();
  });

  it("assistant scope exposes exactly the allowlist and forces `to`", async () => {
    const { tokens, client_id } = await fullFlow(false, { scope: "assistant", callMeOn: MY_PHONE, callFrom: MY_DID, tz: "America/New_York" });
    const client = await mcpClient(tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...ASSISTANT_TOOLS].sort());
    const denied = await client.callTool({ name: "schedule_reminder_call", arguments: { at: "now", message: "x", to: "+919900000000", confirm: true } });
    expect(denied.isError).toBe(true);
    expect((denied.structuredContent as Record<string, unknown>).error).toBe("not_allowed");
    const before = reminders.scheduled.length;
    const okCall = await client.callTool({ name: "schedule_reminder_call", arguments: { at: "now", message: "Meds", confirm: true } });
    expect(okCall.isError).toBeFalsy();
    expect(reminders.scheduled[before]!.input).toMatchObject({ to: MY_PHONE, timezone: "America/New_York" });
    await client.close();

    // The scope and profile survive a refresh.
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id });
    const c2 = await mcpClient(refreshed.body.access_token!);
    expect((await c2.listTools()).tools.map((t) => t.name).sort()).toEqual([...ASSISTANT_TOOLS].sort());
    await c2.close();
  });

  it("read scope keeps read-only reminder tools only", async () => {
    const { tokens } = await fullFlow(false, { scope: "read" });
    const client = await mcpClient(tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_reminder_calls", "get_reminder_call"]));
    expect(names).not.toContain("schedule_reminder_call");
    expect(names).not.toContain("make_call");
    await client.close();
  });

  it("assistant scope adds audio end to end: upload link, PUT, list, schedule with audio", async () => {
    const { tokens } = await fullFlow(false, { scope: "assistant", callMeOn: MY_PHONE, callFrom: MY_DID, tz: "Asia/Kolkata" });
    const client = await mcpClient(tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["create_audio_upload_link", "import_audio_from_url", "list_audio", "delete_audio"]) expect(names).toContain(n);

    const link = (await client.callTool({ name: "create_audio_upload_link", arguments: { name: "Wake tune" } })).structuredContent as Record<string, any>;
    expect(link).toMatchObject({ ok: true, expires_in_minutes: 15 });
    const url = new URL(link.upload_url as string);
    expect(url.origin).toBe("https://mcp.example.test");
    expect(url.pathname).toMatch(/^\/upload\/vbzu_/);
    expect(link.how_to[1]).toContain(`-H "X-Audio-Name: Wake tune" --data-binary @<file> ${link.upload_url}`);

    // The link is served by the mounted media router, and the upload lands in the signed-in account's library.
    const page = await fetch(`${base}${url.pathname}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('value="Wake tune"');
    const up = await fetch(`${base}${url.pathname}`, { method: "PUT", body: Buffer.from("ID3 tune"), headers: { "Content-Type": "audio/mpeg", "X-Audio-Name": "Wake tune" } });
    expect(up.status).toBe(201);
    expect((await media.list(GOOD_ID)).map((m) => m.name)).toEqual(["Wake tune"]);

    const list = (await client.callTool({ name: "list_audio", arguments: {} })).structuredContent as Record<string, any>;
    expect(list.audio.map((a: { name: string }) => a.name)).toEqual(["Wake tune"]);

    const before = reminders.scheduled.length;
    const r = await client.callTool({ name: "schedule_reminder_call", arguments: { at: "now", message: "Up!", audio: "wake TUNE", confirm: true } });
    expect(r.isError).toBeFalsy();
    const id = (await media.list(GOOD_ID))[0]!.id;
    expect(reminders.scheduled[before]!.input).toMatchObject({ audioId: id, to: MY_PHONE });
    expect((r.structuredContent as Record<string, any>).audio).toEqual({ id, name: "Wake tune", duration_sec: 0.8 });
    await client.close();
  });
});
