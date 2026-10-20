import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MAX_BACKEND_MESSAGE, extractBackendMessage } from "../src/errors.js";
import type { Logger } from "../src/logger.js";
import { silentLogger } from "../src/logger.js";
import { createServer, type ServerOptions } from "../src/server.js";
import { safeErrorText } from "../src/util.js";
import { OWN_NUMBER, mockFetch, ownNumberRoute, testConfig } from "./helpers.js";
import { FakeMedia } from "./fake-media.js";
import { FakeReminders } from "./fake-reminders.js";

async function connectWith(opts: ServerOptions, log: Logger = silentLogger) {
  const fetch = mockFetch([ownNumberRoute]);
  const server = createServer(testConfig(), log, fetch.impl, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, fetch };
}

const makeCall = { to: "+919812345678", from: OWN_NUMBER, confirm: true, idempotency_key: "call-key-0001" };

describe("tool gating by server options", () => {
  it("a readOnly server refuses make_call by name with Tool not found and never calls fetch", async () => {
    const { client, fetch } = await connectWith({ readOnly: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("make_call");
    const res = await client.callTool({ name: "make_call", arguments: makeCall }).then(
      (r) => JSON.stringify(r),
      (e: Error) => e.message,
    );
    expect(res).toMatch(/Tool make_call not found/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("an includeTools (assistant-style) server refuses a tool outside the list", async () => {
    const { client, fetch } = await connectWith({ includeTools: ["get_account_balance", "list_reminder_calls"], reminders: new FakeReminders() });
    const res = await client.callTool({ name: "send_message", arguments: { from: OWN_NUMBER, to: ["+919812345678"], text: "x", idempotency_key: "msg-key-0001", confirm: true } }).then(
      (r) => JSON.stringify(r),
      (e: Error) => e.message,
    );
    expect(res).toMatch(/Tool send_message not found/);
    const mc = await client.callTool({ name: "make_call", arguments: makeCall }).then(
      (r) => JSON.stringify(r),
      (e: Error) => e.message,
    );
    expect(mc).toMatch(/Tool make_call not found/);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("extractBackendMessage", () => {
  const long = "x".repeat(5000);
  it.each([
    ["plain string", long],
    ["error string", { error: long }],
    ["error + message", { error: "HTTPError", message: long }],
    ["gateway object", { error: { code: 1, message: long } }],
    ["errors array", { errors: [long, long] }],
    ["message", { message: long }],
    ["detail", { detail: long }],
  ])("never returns more than 300 characters (%s)", (_l, body) => {
    const m = extractBackendMessage(body) ?? "";
    expect(m.length).toBeLessThanOrEqual(MAX_BACKEND_MESSAGE);
    expect(MAX_BACKEND_MESSAGE).toBe(300);
  });

  it("never passes headers or tokens", () => {
    expect(extractBackendMessage({ headers: { "X-Auth-Token": "tok-secret-123" }, token: "tok-secret-123" })).toBeUndefined();
    for (const body of [
      { error: "invalid X-Auth-Token: tok-secret-123 for MA_X" },
      { message: "request failed: Authorization: Bearer abcdefghijklmnop.qrs" },
      { error: "bad auth_token=tok-secret-123&x=1" },
      'upstream said {"password":"tok-secret-123"}',
    ]) {
      const m = extractBackendMessage(body) ?? "";
      expect(m).not.toContain("tok-secret-123");
      expect(m).not.toContain("abcdefghijklmnop");
    }
    expect(extractBackendMessage({ error: "number not found" })).toBe("number not found");
  });
});

describe("safeErrorText and the logged() helpers", () => {
  const secretUrl = "https://storage.googleapis.com/bucket/file.mp3?X-Goog-Signature=SECRETSIG&X-Goog-Credential=CRED";

  it("keeps the name, strips URL query strings and truncates to 120 characters", () => {
    const t = safeErrorText(new TypeError(`fetch ${secretUrl} failed ${"y".repeat(500)}`));
    expect(t.startsWith("TypeError: ")).toBe(true);
    expect(t).toContain("https://storage.googleapis.com/bucket/file.mp3");
    expect(t).not.toMatch(/SECRETSIG|CRED|X-Goog/);
    expect(t.length).toBeLessThanOrEqual("TypeError: ".length + 120);
    expect(safeErrorText("boom")).toBe("string: boom");
    expect(safeErrorText(undefined)).toBe("undefined");
  });

  const capture = () => {
    const lines: string[] = [];
    return { lines, log: { info: (m: string) => lines.push(m), debug: (m: string) => lines.push(m) } };
  };
  const failure = () => new Error(`store down ${secretUrl} ${"z".repeat(400)}`);

  it("reminder tools log only the error name and a short, query-free message", async () => {
    const reminders = new FakeReminders();
    reminders.list = async () => {
      throw failure();
    };
    const c = capture();
    const { client } = await connectWith({ reminders, profile: { scope: "full", callMeOn: "+919811112222" } }, c.log);
    const r = (await client.callTool({ name: "list_reminder_calls", arguments: {} })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    const line = c.lines.find((l) => l.startsWith("reminders: list failed"));
    expect(line).toBeDefined();
    expect(line).toMatch(/^reminders: list failed: Error: store down https:\/\/storage\.googleapis\.com\/bucket\/file\.mp3 /);
    expect(line).not.toMatch(/SECRETSIG|CRED/);
    expect(line!.length).toBeLessThanOrEqual("reminders: list failed: Error: ".length + 120);
  });

  it("audio tools log only the error name and a short, query-free message", async () => {
    const media = new FakeMedia();
    media.list = async () => {
      throw failure();
    };
    const c = capture();
    const { client } = await connectWith({ reminders: new FakeReminders(), media, mediaUploads: { url: () => "https://x.test/upload/t" } }, c.log);
    const r = (await client.callTool({ name: "list_audio", arguments: {} })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    const line = c.lines.find((l) => l.startsWith("audio: list failed"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/SECRETSIG|CRED/);
    expect(line!.length).toBeLessThanOrEqual("audio: list failed: Error: ".length + 120);
  });
});
