import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS, createDashboardHandler, type ToolCaller } from "../src/dashboard/server.js";
import { connect, mockFetch, testConfig } from "./helpers.js";

const TOKEN = "t".repeat(48);
const calls: { name: string; args: Record<string, unknown> }[] = [];
const caller: ToolCaller = {
  async callTool(name, args) {
    calls.push({ name, args });
    return name === "get_concurrency"
      ? { isError: true, data: { ok: false, error: "timeout", message: "slow" } }
      : { isError: false, data: { ok: true, echo: args } };
  },
  info: () => ({ connected: true, server: "vobiz", version: "1.0.0" }),
};

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  handler = createDashboardHandler({ caller, token: TOKEN, port, authId: "MA_<b>X" });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
let handler: http.RequestListener = () => {};

function req(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}
const api = (name: string, body = "{}", headers: Record<string, string> = {}) =>
  req("POST", `/api/tools/${name}`, { headers: { "Content-Type": "application/json", "X-Dashboard-Token": TOKEN, ...headers }, body });

describe("dashboard server", () => {
  it("serves the page with the token injected, auth ID escaped, and a strict CSP", async () => {
    const r = await req("GET", "/");
    expect(r.status).toBe(200);
    expect(r.body).toContain(`content="${TOKEN}"`);
    expect(r.body).toContain("MA_&lt;b&gt;X");
    expect(r.headers["content-security-policy"]).toContain("script-src 'self'");
    expect((await req("GET", "/app.js")).status).toBe(200);
    expect((await req("GET", "/styles.css")).headers["content-type"]).toContain("text/css");
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const r = await req("GET", "/", { headers: { Host: "evil.example:80" } });
    expect(r.status).toBe(421);
  });

  it("requires the per-run token for API calls", async () => {
    expect((await api("list_sip_trunks", "{}", { "X-Dashboard-Token": "wrong" })).status).toBe(403);
    expect((await req("GET", "/api/health")).status).toBe(403);
    const h = await req("GET", "/api/health", { headers: { "X-Dashboard-Token": TOKEN } });
    expect(JSON.parse(h.body)).toMatchObject({ connected: true, server: "vobiz" });
  });

  it("only exposes read-only tools", async () => {
    for (const t of ["make_call", "end_call", "send_dtmf"]) {
      const r = await api(t, JSON.stringify({ to: "+919812345678", confirm: true }));
      expect(r.status).toBe(403);
    }
    expect(calls.some((c) => ["make_call", "end_call", "send_dtmf"].includes(c.name))).toBe(false);
  });

  it("passes args to the tool and returns structured results and tool errors", async () => {
    const ok = await api("list_sip_trunks", JSON.stringify({ limit: 5, offset: 10 }));
    expect(JSON.parse(ok.body)).toEqual({ isError: false, data: { ok: true, echo: { limit: 5, offset: 10 } } });
    const err = await api("get_concurrency");
    expect(err.status).toBe(200);
    expect(JSON.parse(err.body)).toMatchObject({ isError: true, data: { error: "timeout" } });
  });

  it("validates request bodies", async () => {
    expect((await api("list_sip_trunks", "not json")).status).toBe(400);
    expect((await api("list_sip_trunks", "[1]")).status).toBe(400);
    expect((await api("list_sip_trunks", "{}", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await api("list_sip_trunks", JSON.stringify({ x: "y".repeat(20000) }))).status).toBe(413);
  });

  it("allowlist matches real, read-only Vobiz MCP tools", async () => {
    const { client } = await connect(testConfig(), mockFetch([]).impl);
    const tools = (await client.listTools()).tools;
    for (const name of READ_ONLY_TOOLS) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.annotations?.readOnlyHint, name).toBe(true);
    }
  });
});
