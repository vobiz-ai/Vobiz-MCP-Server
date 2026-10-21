import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler } from "../src/http.js";
import { silentLogger } from "../src/logger.js";
import { signV3 } from "../src/webhooks.js";
import { acct, json, mockFetch, testConfig } from "./helpers.js";

const SECRET = "s".repeat(40);
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

const PUBLIC = "https://ops.test.invalid";
const TOKEN = "test-token-not-real";

async function start(readOnly = true, env: Record<string, string | undefined> = {}) {
  const m = mockFetch([{ method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [{ e164: "+919000000001", status: "active" }], total: 1 }) }]);
  const srv = http.createServer(
    createHttpHandler({ cfg: testConfig({ VOBIZ_PUBLIC_URL: PUBLIC, ...env }), log: silentLogger, secret: SECRET, readOnly, answerText: "Hello & welcome <test>", fetchImpl: m.impl }),
  );
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

describe("HTTP transport", () => {
  it("serves tools over Streamable HTTP behind the path secret, read-only by default", async () => {
    const base = await start();
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${SECRET}`)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_phone_numbers");
    for (const n of ["make_call", "end_call", "send_dtmf"]) expect(names).not.toContain(n);
    const r = (await client.callTool({ name: "list_phone_numbers", arguments: {} })) as { structuredContent: any };
    expect(r.structuredContent.numbers[0].e164).toBe("+919000000001");
    await client.close();
  });

  it("exposes call tools only when explicitly allowed", async () => {
    const base = await start(false);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${SECRET}`)));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("make_call");
    await client.close();
  });

  it("serves the legacy SSE transport", async () => {
    const base = await start();
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new SSEClientTransport(new URL(`${base}/sse/${SECRET}`)));
    expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    await client.close();
  });

  it("returns 404 without the right secret", async () => {
    const base = await start();
    for (const p of ["/mcp", "/sse", `/mcp/${"x".repeat(40)}`, `/sse/${SECRET}x`, `/message/${SECRET}`]) {
      const r = await fetch(base + p, { method: p.startsWith("/message") ? "POST" : "GET" });
      expect([404, 405]).toContain(r.status);
      expect(r.status).not.toBe(200);
    }
    const r = await fetch(`${base}/mcp/wrong`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(404);
  });

  it("serves escaped answer XML for Vobiz on GET and POST", async () => {
    const base = await start();
    for (const method of ["GET", "POST"]) {
      const r = await fetch(`${base}/answer`, { method, body: method === "POST" ? "CallUUID=abc" : undefined });
      expect(r.headers.get("content-type")).toContain("text/xml");
      const body = await r.text();
      expect(body).toContain("<Response>");
      expect(body).toContain("<Speak>Hello &amp; welcome &lt;test&gt;</Speak>");
    }
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

let nonceSeq = 10000000000000000000n;
function signed(path: string, nonce = String(nonceSeq++)) {
  return { "X-Vobiz-Signature-V3": signV3(TOKEN, PUBLIC + path, nonce), "X-Vobiz-Signature-V3-Nonce": nonce };
}
const form = (o: Record<string, string>) => ({ "Content-Type": "application/x-www-form-urlencoded" as const, body: new URLSearchParams(o).toString() });

async function mcp(base: string) {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${SECRET}`)));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent: any };
  return { client, call };
}

describe("read-only HTTP mode", () => {
  it("exposes only tools annotated readOnlyHint", async () => {
    const base = await start(true);
    const { client } = await mcp(base);
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(15);
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    for (const n of ["make_call", "transfer_call", "buy_phone_number", "delete_sip_trunk", "start_recording", "gather_dtmf"]) {
      expect(tools.map((t) => t.name)).not.toContain(n);
    }
    await client.close();
  });
});

describe("hosted flows and signed callbacks", () => {
  it("serves a hosted flow only with a valid, fresh signature", async () => {
    const base = await start(true);
    const { client, call } = await mcp(base);
    const r = await call("generate_answer_xml", { actions: [{ type: "speak", text: "Hi & bye" }, { type: "hangup" }], host: true });
    const { flow_id, url } = r.structuredContent;
    expect(url).toBe(`${PUBLIC}/xml/flow/${flow_id}`);
    const path = `/xml/flow/${flow_id}`;

    expect((await fetch(base + path, { method: "POST" })).status).toBe(401);
    const bad = { "X-Vobiz-Signature-V3": "AAAA", "X-Vobiz-Signature-V3-Nonce": "1" };
    expect((await fetch(base + path, { method: "POST", headers: bad })).status).toBe(401);
    const h = signed(path);
    const good = await fetch(base + path, { method: "POST", headers: h });
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toContain("text/xml");
    expect(await good.text()).toContain("<Speak>Hi &amp; bye</Speak>");
    expect((await fetch(base + path, { method: "POST", headers: h })).status).toBe(409);
    const missing = `/xml/flow/${"0".repeat(32)}`;
    expect((await fetch(base + missing, { method: "POST", headers: signed(missing) })).status).toBe(404);
    await client.close();
  });

  it("collects Gather digits once and continues with the follow-up XML", async () => {
    const base = await start(false);
    const { client, call } = await mcp(base);
    const g = (await call("gather_dtmf", { prompt_text: "Press 1", num_digits: 1, then: [{ type: "speak", text: "Got it" }, { type: "hangup" }] })).structuredContent;
    expect(g.xml).toContain(`action="${PUBLIC}/xml/gather/${g.flow_id}"`);
    expect((await call("get_gather_result", { flow_id: g.flow_id })).structuredContent.status).toBe("waiting");

    const path = `/xml/gather/${g.flow_id}`;
    const f = form({ Digits: "1", CallUUID: "call-uuid-0001", InputType: "dtmf", AuthID: "SHOULD_BE_DROPPED" });
    const r1 = await fetch(base + path, { method: "POST", headers: { ...signed(path), "Content-Type": f["Content-Type"] }, body: f.body });
    expect(await r1.text()).toContain("<Speak>Got it</Speak>");
    await fetch(base + path, { method: "POST", headers: { ...signed(path), "Content-Type": f["Content-Type"] }, body: f.body });
    const res = (await call("get_gather_result", { flow_id: g.flow_id })).structuredContent;
    expect(res).toMatchObject({ status: "input_received", results: [{ digits: "1", call_uuid: "call-uuid-0001", signature_verified: true }] });
    expect(res.results).toHaveLength(1);
    await client.close();
  });

  it("stores verified webhooks, de-duplicates them and drops unknown fields", async () => {
    const base = await start(true);
    const { client, call } = await mcp(base);
    const f = form({ Event: "Hangup", CallUUID: "call-uuid-0002", HangupCause: "USER_BUSY", auth_token: "leak" });
    const send = () =>
      fetch(`${base}/webhooks/vobiz`, { method: "POST", headers: { ...signed("/webhooks/vobiz"), "Content-Type": f["Content-Type"] }, body: f.body }).then((r) => r.json());
    expect(await send()).toMatchObject({ ok: true, duplicate: false });
    expect(await send()).toMatchObject({ ok: true, duplicate: true });
    const ev = (await call("list_webhook_events", { call_uuid: "call-uuid-0002" })).structuredContent;
    expect(ev.count).toBe(1);
    expect(ev.events[0].fields).toEqual({ Event: "Hangup", CallUUID: "call-uuid-0002", HangupCause: "USER_BUSY" });
    const unsigned = form({ Event: "Hangup" });
    expect((await fetch(`${base}/webhooks/vobiz`, { method: "POST", headers: { "Content-Type": unsigned["Content-Type"] }, body: unsigned.body })).status).toBe(401);
    await client.close();
  });

  it("verify_if_present accepts unsigned callbacks but still rejects bad signatures", async () => {
    const base = await start(true, { VOBIZ_WEBHOOK_SIGNATURE: "verify_if_present" });
    const f = form({ Event: "Hangup", CallUUID: "x1" });
    expect((await fetch(`${base}/webhooks/vobiz`, { method: "POST", headers: { "Content-Type": f["Content-Type"] }, body: f.body })).status).toBe(200);
    expect((await fetch(`${base}/webhooks/vobiz`, { method: "POST", headers: { "X-Vobiz-Signature-V3": "bad", "X-Vobiz-Signature-V3-Nonce": "1" } })).status).toBe(401);
  });

  it("transfer to a number and hold use hosted Dial / hold flows", async () => {
    const UUID = "5a9fd4a0-3d4c-11ef-bef9-0242ac110005";
    const m = mockFetch([{ method: "POST", path: acct(`/Call/${UUID}/`), respond: () => json(202, { message: "call transferred" }) }]);
    const srv = http.createServer(
      createHttpHandler({ cfg: testConfig({ VOBIZ_PUBLIC_URL: PUBLIC }), log: silentLogger, secret: SECRET, readOnly: false, answerText: "x", fetchImpl: m.impl }),
    );
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const { client, call } = await mcp(base);
    expect((await call("transfer_call", { call_uuid: UUID, destination: "+919812345678", confirm: true })).structuredContent.transferred).toBe(true);
    const path = new URL((m.calls[0].body as { aleg_url: string }).aleg_url).pathname;
    expect(await (await fetch(base + path, { method: "POST", headers: signed(path) })).text()).toContain("<Number>+919812345678</Number>");
    expect((await call("transfer_call", { call_uuid: UUID, destination: "+14155550123", confirm: true })).structuredContent.error).toBe("not_allowed");
    expect((await call("hold_call", { call_uuid: UUID, confirm: true })).structuredContent.on_hold).toBe(true);
    const resumed = await call("unhold_call", { call_uuid: UUID, resume_url: `${PUBLIC}/resume.xml`, confirm: true });
    expect(resumed.structuredContent).toMatchObject({ ok: true, on_hold: false, legs: "aleg", emulated: true, http_status: 202 });
    expect((m.calls.at(-1)?.body as { aleg_url: string }).aleg_url).toBe(`${PUBLIC}/resume.xml`);
    await client.close();
  });
});
