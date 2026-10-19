/**
 * End-to-end over the real stdio transport: spawns dist/index.js as a child process and points it at
 * a local fake Vobiz API (http://127.0.0.1) that mimics the verified response shapes. Exercises a full
 * operational workflow and checks that stderr logs never contain the token or phone numbers.
 * Requires `npm run build` first (the `test` script does not build; `npm run test:all` does).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "..", "dist", "index.js");
const AUTH = "MA_E2ETEST1";
const TOKEN = "e2e-token-should-never-be-logged";
const FROM = "+919000000001";
const TO = "+919812345678";
const UUID = "5a9fd4a0-3d4c-11ef-bef9-0242ac110005";

let state: "none" | "live" | "done" = "none";
const seen: string[] = [];
let api: http.Server;
let port = 0;

function fakeVobiz(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname.replace(`/api/v1/Account/${AUTH}`, "");
  const send = (s: number, b?: unknown) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(b === undefined ? "" : JSON.stringify(b));
  };
  if (req.headers["x-auth-id"] !== AUTH || req.headers["x-auth-token"] !== TOKEN) return send(401, { error: { code: 401, message: "Invalid API key" } });
  seen.push(`${req.method} ${p}${url.search}`);
  req.resume();
  const st = url.searchParams.get("status");
  if (req.method === "GET" && p === "") return send(200, { status: "success", data: { auth_id: AUTH, name: "E2E", auth_secret: TOKEN } });
  if (p === "/balance") return send(200, { balances: [{ available_balance: 500, balance: 500, currency: "INR", is_postpaid: false }] });
  if (p === "/concurrency") return send(200, { concurrent_calls: state === "live" ? 1 : 0, max_concurrent: 10 });
  if (p === "/numbers") return send(200, { items: [{ e164: FROM, status: "active", voice_enabled: true }], page: 1, per_page: 25, total: 1 });
  if (req.method === "GET" && p === "/Call/") return send(200, { calls: st === "live" && state === "live" ? [UUID] : [] });
  if (req.method === "POST" && p === "/Call/") {
    state = "live";
    return send(201, { api_id: "a1", message: "call queued", request_uuid: UUID });
  }
  if (req.method === "GET" && p === `/Call/${UUID}/`) {
    return st === "live" && state === "live" ? send(200, { call_uuid: UUID, call_status: "in-progress", direction: "outbound" }) : send(404, { error: "call not found" });
  }
  if (p.startsWith(`/Call/${UUID}/`) && state !== "live") return send(404, { error: "call not found" });
  if (req.method === "POST" && p === `/Call/${UUID}/DTMF/`) return send(202, { message: "digits sent" });
  if (req.method === "POST" && p === `/Call/${UUID}/Speak/`) return send(202, { message: "speak started" });
  if (req.method === "POST" && p === `/Call/${UUID}/Record/`) return send(202, { message: "recording started", recording_id: "rec-1", url: "https://media.example/rec-1.mp3" });
  if (req.method === "DELETE" && p === `/Call/${UUID}/`) {
    state = "done";
    return send(204);
  }
  if (p === `/cdr/${UUID}`) {
    return state === "done"
      ? send(200, { success: true, data: { uuid: UUID, hangup_cause: "NORMAL_CLEARING", billsec: 12, duration: 15 } })
      : send(404, { success: false, error: "CDR not found" });
  }
  if (p === "/cdr") return send(200, { success: true, data: state === "done" ? [{ uuid: UUID }] : [], pagination: { total: state === "done" ? 1 : 0 } });
  if (p === "/Recording/") return send(200, { objects: [{ recording_id: "rec-1", call_uuid: UUID, recording_url: "https://media.example/rec-1.mp3" }], meta: { total_count: 1 } });
  return send(404, { error: "not found" });
}

let client: Client;
let stderr = "";

beforeAll(async () => {
  if (!existsSync(entry)) throw new Error("dist/index.js missing: run `npm run build` first");
  api = http.createServer(fakeVobiz);
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  port = (api.address() as AddressInfo).port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      PATH: process.env.PATH ?? "",
      VOBIZ_AUTH_ID: AUTH,
      VOBIZ_AUTH_TOKEN: TOKEN,
      VOBIZ_BASE_URL: `http://127.0.0.1:${port}`,
      VOBIZ_ENABLE_CALLS: "true",
      VOBIZ_DEFAULT_ANSWER_URL: "https://example.com/answer.xml",
      VOBIZ_LOG_LEVEL: "info",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => (stderr += String(d)));
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((r) => api?.close(() => r()));
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent: any };
  return { isError: !!r.isError, data: r.structuredContent };
};

describe("end-to-end workflow over stdio (fake Vobiz API)", () => {
  it("starts and lists every tool with valid schemas", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBe(106);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  it("runs account → call → in-call controls → hangup → records", async () => {
    expect((await call("get_account_details")).data.account).toMatchObject({ name: "E2E", auth_secret: "[redacted]" });
    expect((await call("get_account_balance")).data.balance.available_balance).toBe(500);
    expect((await call("get_concurrency")).data.concurrency.concurrent_calls).toBe(0);

    const placed = await call("make_call", { to: TO, from: FROM, confirm: true, idempotency_key: "e2e-call-0001" });
    expect(placed.data).toMatchObject({ accepted: true, connected: false, request_uuid: UUID });
    expect((await call("get_call_status", { call_uuid: UUID })).data).toMatchObject({ state: "live", call_status: "in-progress" });
    expect((await call("send_dtmf", { call_uuid: UUID, digits: "1#" })).data.sent).toBe(true);
    expect((await call("speak_text", { call_uuid: UUID, text: "Hello" })).data.speaking).toBe(true);
    expect((await call("start_recording", { call_uuid: UUID, confirm: true })).data.recording_id).toBe("rec-1");
    expect((await call("end_call", { call_uuid: UUID, confirm: true })).data.terminated).toBe(true);
    expect((await call("end_call", { call_uuid: UUID, confirm: true })).data.error).toBe("call_not_active");
    expect((await call("get_call_details", { call_uuid: UUID })).data).toMatchObject({ outcome: "answered" });
    expect((await call("list_call_records")).data.count).toBe(1);
    expect((await call("get_call_recording", { call_uuid: UUID })).data.count).toBe(1);

    // retrying the same intent does not dial again
    const again = await call("make_call", { to: TO, from: FROM, confirm: true, idempotency_key: "e2e-call-0001" });
    expect(again.data.replayed).toBe(true);
    expect(seen.filter((s) => s === "POST /Call/")).toHaveLength(1);
  });

  it("survives invalid input and keeps serving", async () => {
    expect((await call("get_call_status", { call_uuid: "../../etc" })).isError).toBe(true);
    expect((await call("make_call", { to: "abc" })).isError).toBe(true);
    expect((await call("get_account_balance")).isError).toBe(false);
  });

  it("logs routes and statuses without secrets or phone numbers", () => {
    expect(stderr).toContain("POST Call/ -> 201");
    expect(stderr).not.toContain(TOKEN);
    expect(stderr).not.toContain("9812345678");
    expect(stderr).not.toContain("9000000001");
  });
});
