import { describe, expect, it } from "vitest";
import { connect, json, mockFetch, testConfig, type Route } from "./helpers.js";

const FROM = "+14155550100";
const sms = (p: string) => `/api/v1/sms${p}`;
const numbersRoute: Route = { method: "GET", path: sms("/numbers"), respond: () => json(200, { numbers: [{ e164: FROM, capabilities: { sms: true } }] }) };
const msg = (to: string, extra: Record<string, unknown> = {}) => ({
  id: `m-${to.slice(-4)}-0001`,
  accountId: "MA_TEST123",
  direction: "out",
  channel: "sms",
  from: FROM,
  to,
  text: "hi",
  status: "sent",
  provider: "internal",
  createdAt: "0001-01-01T00:00:00Z",
  ...extra,
});

function setup(routes: Route[], env: Record<string, string | undefined> = {}) {
  const m = mockFetch(routes);
  return connect(testConfig({ VOBIZ_ENABLE_MESSAGING: "true", ...env }), m.impl).then((c) => ({ ...c, calls: m.calls }));
}

const sendRoute: Route = {
  method: "POST",
  path: sms("/messages"),
  respond: (r) => {
    const to = (r.body as { to: string[] }).to[0];
    if (to === "+14155550199") return json(422, { error: `recipient has opted out: ${to}` });
    return json(201, msg(to));
  },
};

const base = { from: FROM, to: ["+14155550123"], text: "hi", idempotency_key: "order-1234-a", confirm: true };

describe("send_message", () => {
  it("is refused while messaging is disabled", async () => {
    const { call, calls } = await setup([sendRoute, numbersRoute], { VOBIZ_ENABLE_MESSAGING: "false" });
    const r = await call("send_message", base);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("messaging_disabled");
    expect(calls).toHaveLength(0);
  });

  it("needs confirm: true and sends nothing without it", async () => {
    const { call, calls } = await setup([sendRoute, numbersRoute]);
    const r = await call("send_message", { ...base, confirm: false });
    expect(r.data.error).toBe("confirmation_required");
    expect(calls).toHaveLength(0);
  });

  it("sends one request per recipient with camelCase fields and cleans the result", async () => {
    const { call, calls } = await setup([sendRoute, numbersRoute]);
    const r = await call("send_message", { ...base, to: ["+14155550123", "14155550124", "+14155550123"], tag: "t1", scheduled_at: "2026-11-01T09:00:00Z" });
    expect(r.isError).toBe(false);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].headers["X-Auth-ID"]).toBe("MA_TEST123");
    expect(posts[0].body).toMatchObject({ from: FROM, to: ["+14155550123"], channel: "sms", text: "hi", tag: "t1", scheduledAt: "2026-11-01T09:00:00Z", idempotencyKey: "order-1234-a:1" });
    expect(posts[1].body).toMatchObject({ to: ["+14155550124"], idempotencyKey: "order-1234-a:2" });
    expect(r.data.sent_count).toBe(2);
    const m = r.data.messages[0];
    expect(m.createdAt).toBeNull();
    expect(m).not.toHaveProperty("provider");
    expect(m).not.toHaveProperty("accountId");
  });

  it("replays the same idempotency key without sending again", async () => {
    const { call, calls } = await setup([sendRoute, numbersRoute]);
    await call("send_message", base);
    const again = await call("send_message", base);
    expect(again.isError).toBe(false);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const conflict = await call("send_message", { ...base, text: "different" });
    expect(conflict.data.error).toBe("idempotency_conflict");
  });

  it("refuses a sender that is not a messaging number on the account", async () => {
    const { call, calls } = await setup([sendRoute, numbersRoute]);
    const r = await call("send_message", { ...base, from: "+14155550999" });
    expect(r.data.error).toBe("not_allowed");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("reports opted-out recipients per message", async () => {
    const { call } = await setup([sendRoute, numbersRoute]);
    const r = await call("send_message", { ...base, to: ["+14155550123", "+14155550199"] });
    expect(r.data.sent_count).toBe(1);
    expect(r.data.messages[1]).toMatchObject({ to: "+14155550199", status: "not_sent", errorCode: "opted_out" });
  });

  it("enforces recipient, country and rate caps", async () => {
    const { call } = await setup([sendRoute, numbersRoute], { VOBIZ_MAX_RECIPIENTS_PER_SEND: "1", VOBIZ_MESSAGING_ALLOWED_COUNTRY_CODES: "1" });
    expect((await call("send_message", { ...base, to: ["+14155550123", "+14155550124"] })).data.error).toBe("not_allowed");
    expect((await call("send_message", { ...base, to: ["+919876543210"], idempotency_key: "order-1234-b" })).data.error).toBe("not_allowed");
    const limited = await setup([sendRoute, numbersRoute], { VOBIZ_MAX_MESSAGES_PER_MINUTE: "1" });
    await limited.call("send_message", base);
    expect((await limited.call("send_message", { ...base, idempotency_key: "order-1234-c" })).data.error).toBe("rate_limited");
  });

  it("uses the RCS sender name as-is and skips the number check", async () => {
    const { call, calls } = await setup([sendRoute]);
    const r = await call("send_message", { ...base, from: "acme_brand", channel: "rcs", failover_to_sms: true });
    expect(r.isError).toBe(false);
    expect(calls[0].body).toMatchObject({ from: "acme_brand", channel: "rcs", failoverToSms: true });
  });

  it("needs text for sms", async () => {
    const { call } = await setup([sendRoute, numbersRoute]);
    expect((await call("send_message", { ...base, text: undefined })).data.error).toBe("invalid_input");
  });
});

describe("messaging read tools", () => {
  it("lists messages with filters and paging", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: sms("/messages"), respond: () => json(200, { messages: [msg("+14155550123")], total: 3, limit: 1, offset: 0 }) },
    ]);
    const r = await call("list_messages", { status: "sent", direction: "out", to: "14155550123", limit: 1 });
    expect(calls[0].url.searchParams.get("to")).toBe("+14155550123");
    expect(calls[0].url.searchParams.get("direction")).toBe("out");
    expect(r.data.pagination).toMatchObject({ total: 3, has_more: true, next_offset: 1 });
  });

  it("maps an unknown message ID to not_found without leaking backend text", async () => {
    const { call } = await setup([{ method: "GET", path: sms("/messages/abcdef123"), respond: () => json(500, { error: "sql: no rows in result set" }) }]);
    const r = await call("get_message", { message_id: "abcdef123" });
    expect(r.data.error).toBe("not_found");
    expect(r.text).not.toContain("sql");
  });

  it("previews cost, checks opt-outs and lists numbers", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: sms("/messages/cost-preview"), respond: () => json(200, { channel: "sms", segmentCount: 2, totalCost: 0.02, currency: "USD" }) },
      { method: "GET", path: sms("/opt-outs/%2B14155550123"), respond: () => json(200, { optedOut: true }) },
      numbersRoute,
    ]);
    expect((await call("preview_message_cost", { from: FROM, to: "+14155550123", text: "x".repeat(170) })).data.preview.segmentCount).toBe(2);
    expect((await call("check_opt_out", { phone_number: "+14155550123" })).data.opted_out).toBe(true);
    expect(calls[1].url.searchParams.get("channel")).toBe("sms");
    expect((await call("list_messaging_numbers")).data.count).toBe(1);
  });

  it("opt-out changes need messaging enabled and confirm", async () => {
    const { call, calls } = await setup([
      { method: "POST", path: sms("/opt-outs"), respond: () => json(201, { status: "opted_out" }) },
      { method: "DELETE", path: sms("/opt-outs/%2B14155550123"), respond: () => json(200, { status: "removed" }) },
    ]);
    expect((await call("remove_opt_out", { phone_number: "+14155550123", confirm: false })).data.error).toBe("confirmation_required");
    expect((await call("add_opt_out", { phone_number: "+14155550123", reason: "asked", confirm: true })).data.opted_out).toBe(true);
    expect(calls[0].body).toEqual({ phoneNumber: "+14155550123", channel: "sms", reason: "asked" });
    expect((await call("remove_opt_out", { phone_number: "+14155550123", confirm: true })).data.opted_out).toBe(false);
  });
});

describe("skills", () => {
  it("lists and loads bundled skills as tools, resources and prompts", async () => {
    const { client, call } = await setup([]);
    const list = await call("list_vobiz_skills");
    expect(list.data.count).toBeGreaterThanOrEqual(10);
    const names = list.data.skills.map((s: { name: string }) => s.name);
    expect(names).toContain("vobiz-voice-calls");
    const skill = await call("get_vobiz_skill", { name: "vobiz-voice-calls" });
    expect(skill.data.instructions).toMatch(/Call/);
    expect(skill.data.instructions).not.toMatch(/^---/);
    const firstSection = list.data.skills.find((s: { name: string }) => s.name === "vobiz-voice-xml").sections[1];
    const part = await call("get_vobiz_skill", { name: "vobiz-voice-xml", section: firstSection });
    expect(part.data.section).toBe(firstSection);

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain("vobiz://skills/vobiz-voice-calls");
    const read = await client.readResource({ uri: "vobiz://skills/vobiz-cdr" });
    expect(String(read.contents[0].text)).toMatch(/^---\nname: vobiz-cdr/);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain("vobiz-sip-trunking");
    const p = await client.getPrompt({ name: "vobiz-sip-trunking", arguments: { task: "create a trunk" } });
    expect(String((p.messages[0].content as { text: string }).text)).toContain("Task: create a trunk");
  });
});
