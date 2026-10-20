import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { supportsFormElicitation } from "../src/guard/confirm.js";
import { OWN_NUMBER, acct, capacityRoutes, json, mockFetch, ownNumberRoute, testConfig, type Route } from "./helpers.js";

const DEST = "+919812345678";
const UUID = "5a9fd4a0-3d4c-11ef-bef9-0242ac110005";
const CALL = "abcd1234-call";
type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } | "error";

/** A fake MCP client that does (or does not) advertise elicitation and answers prompts as told. */
async function setup(o: { caps?: ClientCapabilities; answer?: Answer; env?: Record<string, string>; routes?: Route[] } = {}) {
  const m = mockFetch([...(o.routes ?? []), ownNumberRoute, ...capacityRoutes]);
  const server = createServer(testConfig({ VOBIZ_ENABLE_PROVISIONING: "true", VOBIZ_ENABLE_MESSAGING: "true", VOBIZ_ALLOWED_URL_HOSTS: "ops.example.net", ...o.env }), silentLogger, m.impl);
  const client = new Client({ name: "fake", version: "0" }, { capabilities: o.caps ?? {} });
  const prompts: string[] = [];
  if (o.caps?.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(String((req.params as { message: string }).message));
      const a = o.answer ?? { action: "accept", content: { approve: true } };
      if (a === "error") throw new Error("client could not show the prompt");
      return a;
    });
  }
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(x), client.connect(y)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
    return { isError: !!r.isError, data: r.structuredContent ?? {} };
  };
  return { call, prompts, calls: m.calls };
}
const place: Route = { method: "POST", path: acct("/Call/"), respond: () => json(201, { request_uuid: UUID }) };
const posts = (calls: { method: string; url: URL }[]) => calls.filter((c) => c.method === "POST" && c.url.pathname === acct("/Call/"));
const ELICIT = { elicitation: {} } as ClientCapabilities;

describe("supportsFormElicitation", () => {
  it("treats an empty capability as form, and url-only as unsupported", () => {
    expect(supportsFormElicitation(undefined)).toBe(false);
    expect(supportsFormElicitation({})).toBe(false);
    expect(supportsFormElicitation({ elicitation: {} } as ClientCapabilities)).toBe(true);
    expect(supportsFormElicitation({ elicitation: { form: {} } } as ClientCapabilities)).toBe(true);
    expect(supportsFormElicitation({ elicitation: { url: {} } } as ClientCapabilities)).toBe(false);
  });
});

describe("make_call confirmation", () => {
  it("asks the human through elicitation (destination, caller ID, URL host) and places the call on approve", async () => {
    const s = await setup({ caps: ELICIT, routes: [place] });
    const r = await s.call("make_call", { to: DEST, from: OWN_NUMBER, confirm: false });
    expect(r.isError).toBe(false);
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain(DEST);
    expect(s.prompts[0]).toContain(OWN_NUMBER);
    expect(s.prompts[0]).toContain("example.com");
    expect(posts(s.calls)).toHaveLength(1);
  });

  it.each([
    ["decline", { action: "decline" } as Answer, "not_allowed"],
    ["cancel", { action: "cancel" } as Answer, "not_allowed"],
    ["accept without approval", { action: "accept", content: { approve: false } } as Answer, "not_allowed"],
    ["a failed prompt", "error" as Answer, "confirmation_required"],
  ])("never dials on %s, even with confirm: true", async (_l, answer, kind) => {
    const s = await setup({ caps: ELICIT, answer, routes: [place] });
    const r = await s.call("make_call", { to: DEST, from: OWN_NUMBER, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe(kind);
    expect(s.calls).toHaveLength(0);
  });

  it("does not prompt for a call the policy refuses", async () => {
    const s = await setup({ caps: ELICIT, routes: [place] });
    const r = await s.call("make_call", { to: "+14155550123", from: OWN_NUMBER, confirm: true });
    expect(r.data.error).toBe("not_allowed");
    expect(s.prompts).toHaveLength(0);
  });

  it("without elicitation keeps the model-attested confirm flag", async () => {
    const s = await setup({ routes: [place] });
    expect((await s.call("make_call", { to: DEST, from: OWN_NUMBER, confirm: false })).data.error).toBe("confirmation_required");
    expect(s.calls).toHaveLength(0);
    expect((await s.call("make_call", { to: DEST, from: OWN_NUMBER, confirm: true })).isError).toBe(false);
    expect(s.prompts).toHaveLength(0);
  });

  it("a url-only elicitation client falls back to the confirm flag", async () => {
    const s = await setup({ caps: { elicitation: { url: {} } } as ClientCapabilities, routes: [place] });
    expect((await s.call("make_call", { to: DEST, from: OWN_NUMBER, confirm: false })).data.error).toBe("confirmation_required");
  });
});

describe("other money-spending and routing tools use the same prompt", () => {
  it("send_message shows the sender, recipients and text", async () => {
    const s = await setup({
      caps: ELICIT,
      answer: { action: "decline" },
      routes: [{ method: "POST", path: "/api/v1/sms/messages", respond: () => json(201, { id: "m-1", status: "sent" }) }],
    });
    const r = await s.call("send_message", { from: "+14155550100", to: ["+14155550123"], text: "Your code is 1234", idempotency_key: "msg-key-0001", confirm: true });
    expect(r.data.error).toBe("not_allowed");
    expect(s.prompts[0]).toContain("+14155550123");
    expect(s.prompts[0]).toContain("Your code is 1234");
    expect(s.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("transfer_call shows the target host", async () => {
    const s = await setup({ caps: ELICIT, routes: [{ method: "POST", path: acct(`/Call/${CALL}/`), respond: () => json(202, { message: "transferred" }) }] });
    const r = await s.call("transfer_call", { call_uuid: CALL, aleg_url: "https://ops.example.net/x.xml", confirm: false });
    expect(r.isError).toBe(false);
    expect(s.prompts[0]).toContain("ops.example.net");
  });

  it("start_audio_stream shows the WebSocket host and a decline sends nothing", async () => {
    const s = await setup({ caps: ELICIT, answer: { action: "decline" } });
    const r = await s.call("start_audio_stream", { call_uuid: CALL, service_url: "wss://ops.example.net/ws", confirm: true });
    expect(r.data.error).toBe("not_allowed");
    expect(s.prompts[0]).toContain("ops.example.net");
    expect(s.calls).toHaveLength(0);
  });

  it("update_application shows the new answer_url host", async () => {
    const s = await setup({
      caps: ELICIT,
      routes: [
        { method: "GET", path: acct("/Application/12345678/"), respond: () => json(200, { default_endpoint_app: false }) },
        { method: "POST", path: acct("/Application/12345678/"), respond: () => json(202, { message: "changed" }) },
      ],
    });
    const r = await s.call("update_application", { app_id: "12345678", answer_url: "https://ops.example.net/answer", confirm: false });
    expect(r.isError).toBe(false);
    expect(s.prompts[0]).toMatch(/application 12345678.*ops\.example\.net/);
  });

  it("release_phone_number mentions the fee, and a decline releases nothing", async () => {
    const s = await setup({ caps: ELICIT, answer: { action: "decline" } });
    const r = await s.call("release_phone_number", { phone_number: OWN_NUMBER, confirm: true });
    expect(r.data.error).toBe("not_allowed");
    expect(s.prompts[0]).toMatch(/release.*fee/);
    expect(s.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
});
