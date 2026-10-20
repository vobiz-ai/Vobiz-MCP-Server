import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { silentLogger } from "../src/logger.js";
import { createServer, TOOLSET_NAMES, type ServerOptions } from "../src/server.js";
import { formatLocal, isValidTimeZone, parseWhen } from "../src/tz.js";
import { AUTH_ID, OWN_NUMBER, acct, json, mockFetch, ownNumberRoute, testConfig, type Route } from "./helpers.js";
import { FakeReminders } from "./fake-reminders.js";

const ME = "+919811112222";
const REMINDER_TOOLS = ["schedule_reminder_call", "list_reminder_calls", "get_reminder_call", "cancel_reminder_call"];

async function connect(opts: ServerOptions, routes: Route[] = [ownNumberRoute], env: Record<string, string> = {}) {
  const fetch = mockFetch(routes);
  const server = createServer(testConfig(env), silentLogger, fetch.impl, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
    return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, any> };
  };
  return { client, call, fetch };
}

const future = (h = 2) => new Date(Date.now() + h * 3600_000).toISOString();
/** A calendar date three days ahead in Asia/Kolkata, as YYYY-MM-DD. */
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 3 * 86400_000));

describe("reminder tools registration", () => {
  it("registers nothing without a ReminderService (stdio mode)", async () => {
    const { client } = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of REMINDER_TOOLS) expect(names).not.toContain(n);
    expect(TOOLSET_NAMES).toContain("reminders");
  });

  it("registers the four tools with the right annotations when a service is present", async () => {
    const { client } = await connect({ reminders: new FakeReminders() });
    const tools = (await client.listTools()).tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of REMINDER_TOOLS) expect(by[n]).toBeDefined();
    expect(by.schedule_reminder_call!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true, idempotentHint: false });
    expect(by.schedule_reminder_call!.description).toMatch(/^Vobiz: use this when the user wants a PHONE CALL at a time/);
    expect(by.list_reminder_calls!.annotations?.readOnlyHint).toBe(true);
    expect(by.get_reminder_call!.annotations?.readOnlyHint).toBe(true);
    expect(by.cancel_reminder_call!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });

  it("read-only keeps list/get but drops schedule/cancel; includeTools is an allowlist", async () => {
    const ro = await connect({ reminders: new FakeReminders(), readOnly: true });
    const roNames = (await ro.client.listTools()).tools.map((t) => t.name);
    expect(roNames).toEqual(expect.arrayContaining(["list_reminder_calls", "get_reminder_call"]));
    expect(roNames).not.toContain("schedule_reminder_call");
    expect(roNames).not.toContain("cancel_reminder_call");

    const only = await connect({ reminders: new FakeReminders(), includeTools: ["list_reminder_calls", "get_account_balance", "make_call"], excludeTools: ["make_call"] });
    expect((await only.client.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_account_balance", "list_reminder_calls"]);
  });
});

describe("schedule_reminder_call", () => {
  it("schedules with profile defaults: to = callMeOn, from = callFrom (verified), timezone from profile", async () => {
    const svc = new FakeReminders();
    const { call, fetch } = await connect({ reminders: svc, profile: { scope: "full", callMeOn: ME, callFrom: OWN_NUMBER, timezone: "Asia/Kolkata" } });
    const r = await call("schedule_reminder_call", { at: `${DAY}T06:00`, message: "Take the 7:10 train", kind: "wake_up", confirm: true, idempotency_key: "key-00000001" });
    expect(r.isError).toBe(false);
    expect(svc.scheduled).toHaveLength(1);
    const { account, input, opts } = svc.scheduled[0]!;
    expect(account).toEqual({ authId: AUTH_ID, authToken: "test-token-not-real" });
    expect(input).toMatchObject({ kind: "wake_up", to: ME, from: OWN_NUMBER, timezone: "Asia/Kolkata", at: `${DAY}T00:30:00.000Z`, language: "en-US", voice: "WOMAN", snoozeMinutes: 10, maxAttempts: 3, retryMinutes: 5 });
    expect(opts).toEqual({ idempotencyKey: "key-00000001" });
    expect(r.data).toMatchObject({ ok: true, reminder_id: "r_fake1", status: "scheduled", at_utc: `${DAY}T00:30:00.000Z`, timezone: "Asia/Kolkata", to: ME, from: OWN_NUMBER, snooze_minutes: 10, max_attempts: 3 });
    expect(r.data.at_local).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, 06:00 IST$/);
    expect(JSON.stringify(r.data)).not.toContain("test-token-not-real");
    expect(fetch.calls.some((c) => c.url.searchParams.get("search") === OWN_NUMBER)).toBe(true);
  });

  it("assistant scope forces `to` to the user's own number", async () => {
    const svc = new FakeReminders();
    const { call } = await connect({ reminders: svc, profile: { scope: "assistant", callMeOn: ME, callFrom: OWN_NUMBER, timezone: "Asia/Kolkata" } });
    const bad = await call("schedule_reminder_call", { at: future(), message: "hi", to: "+919900000000", confirm: true });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toBe("not_allowed");
    expect(bad.data.message).toContain("This connection may only call your own number");
    const same = await call("schedule_reminder_call", { at: future(), message: "hi", to: "919811112222", confirm: true });
    expect(same.isError).toBe(false);
    const none = await call("schedule_reminder_call", { at: future(), message: "hi", confirm: true });
    expect(none.isError).toBe(false);
    expect(svc.scheduled.map((s) => s.input.to)).toEqual([ME, ME]);
  });

  it("full scope may call another allowed number; policy still applies", async () => {
    const svc = new FakeReminders();
    const { call } = await connect({ reminders: svc, profile: { scope: "full", callMeOn: ME, callFrom: OWN_NUMBER, timezone: "UTC" } });
    expect((await call("schedule_reminder_call", { at: future(), message: "hi", to: "+919900000000", confirm: true })).isError).toBe(false);
    const us = await call("schedule_reminder_call", { at: future(), message: "hi", to: "+14155550123", confirm: true });
    expect(us.data.error).toBe("not_allowed"); // testConfig allows +91 only
  });

  it("defaults `from` to the first active voice number on the account", async () => {
    const svc = new FakeReminders();
    const routes: Route[] = [
      {
        method: "GET",
        path: acct("/numbers"),
        respond: () =>
          json(200, {
            items: [
              { e164: "+918000000009", status: "active", voice_enabled: false },
              { e164: "918000000007", status: "active", capabilities: { voice: true } },
            ],
          }),
      },
    ];
    const { call, fetch } = await connect({ reminders: svc, profile: { scope: "full", callMeOn: ME, timezone: "Asia/Kolkata" } }, routes);
    const r = await call("schedule_reminder_call", { at: "now", message: "hi", confirm: true });
    expect(r.isError).toBe(false);
    expect(svc.scheduled[0]!.input.from).toBe("+918000000007");
    expect(fetch.calls[0]!.url.searchParams.get("status")).toBe("active");
  });

  it("refuses when the account has no voice number", async () => {
    const { call } = await connect({ reminders: new FakeReminders(), profile: { scope: "full", callMeOn: ME } }, [
      { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: null }) },
    ]);
    const r = await call("schedule_reminder_call", { at: "now", message: "hi", confirm: true });
    expect(r.data.error).toBe("not_allowed");
  });

  it("refuses a caller ID that is not on the account", async () => {
    const { call } = await connect({ reminders: new FakeReminders(), profile: { scope: "full", callMeOn: ME } }, [
      { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [] }) },
    ]);
    const r = await call("schedule_reminder_call", { at: "now", message: "hi", from: "+918888888888", confirm: true });
    expect(r.data.error).toBe("not_allowed");
  });

  it("requires confirm: true and a destination, and rejects bad inputs", async () => {
    const svc = new FakeReminders();
    const { call } = await connect({ reminders: svc, profile: { scope: "full", timezone: "Asia/Kolkata" } });
    const noConfirm = await call("schedule_reminder_call", { at: future(), message: "hi", to: ME, confirm: false });
    expect(noConfirm.data.error).toBe("confirmation_required");
    expect(noConfirm.data.message).toContain(ME);
    expect((await call("schedule_reminder_call", { at: future(), message: "hi", confirm: true })).data.error).toBe("invalid_input");
    expect((await call("schedule_reminder_call", { at: "tomorrow 6am", message: "hi", to: ME, confirm: true })).data.error).toBe("invalid_input");
    expect((await call("schedule_reminder_call", { at: "2020-01-01T00:00:00Z", message: "hi", to: ME, confirm: true })).data.message).toContain("already passed");
    expect((await call("schedule_reminder_call", { at: future(24 * 40), message: "hi", to: ME, confirm: true })).data.message).toContain("30 days");
    // Lists and SIP URIs are rejected by the schema (Vobiz would fan a `<` list out).
    expect((await call("schedule_reminder_call", { at: future(), message: "hi", to: "+919811112222<+919811113333", confirm: true })).isError).toBe(true);
    expect((await call("schedule_reminder_call", { at: future(), message: "hi", to: "sip:me@example.com", confirm: true })).isError).toBe(true);
    expect((await call("schedule_reminder_call", { at: future(), message: "x".repeat(401), to: ME, confirm: true })).isError).toBe(true);
    expect(svc.scheduled).toHaveLength(0);
  });

  it("is refused when calling is disabled on the server", async () => {
    const { call } = await connect({ reminders: new FakeReminders(), profile: { scope: "full", callMeOn: ME } }, [ownNumberRoute], { VOBIZ_ENABLE_CALLS: "false" });
    expect((await call("schedule_reminder_call", { at: "now", message: "hi", confirm: true })).data.error).toBe("calls_disabled");
  });
});

describe("list, get and cancel reminder calls", () => {
  it("lists, shows attempts in plain words, and cancels with confirmation", async () => {
    const svc = new FakeReminders();
    const { call } = await connect({ reminders: svc, profile: { scope: "full", callMeOn: ME, callFrom: OWN_NUMBER, timezone: "Asia/Kolkata" } });
    const s = await call("schedule_reminder_call", { at: `${DAY}T15:00:00+05:30`, message: "Call the bank", confirm: true });
    const id = s.data.reminder_id as string;
    const r = svc.items.get(`${AUTH_ID}/${id}`)!;
    r.attempts[0] = { n: 1, scheduledFor: r.at, startedAt: r.at, outcome: "no_answer" };
    r.attempts.push({ n: 2, scheduledFor: r.at });

    const list = await call("list_reminder_calls", { status: "active" });
    expect(list.data.count).toBe(1);
    expect(list.data.reminders[0]).toMatchObject({ reminder_id: id, status: "scheduled", at_local: expect.stringMatching(/, 15:00 IST$/), attempts_made: 1 });
    expect((await call("list_reminder_calls", { status: "done" })).data.count).toBe(0);

    const got = await call("get_reminder_call", { reminder_id: id });
    expect(got.data.attempts[0]).toMatchObject({ attempt: 1, outcome: "no_answer", outcome_text: "not answered" });
    expect(got.data.attempts[1].outcome_text).toBe("not placed yet");
    expect((await call("get_reminder_call", { reminder_id: "r_missing" })).data.error).toBe("not_found");

    expect((await call("cancel_reminder_call", { reminder_id: id, confirm: false })).data.error).toBe("confirmation_required");
    const c = await call("cancel_reminder_call", { reminder_id: id, confirm: true });
    expect(c.data).toMatchObject({ ok: true, cancelled: true, status: "cancelled" });
    const again = await call("cancel_reminder_call", { reminder_id: id, confirm: true });
    expect(again.data).toMatchObject({ ok: true, cancelled: false });
  });
});

describe("time helpers", () => {
  it("parses offsets, local times in a zone and now", () => {
    const now = Date.UTC(2026, 9, 20, 12, 0, 0);
    expect(parseWhen("now", "UTC", now)!.getTime()).toBe(now);
    expect(parseWhen("2026-10-21T06:00:00+05:30", "UTC")!.toISOString()).toBe("2026-10-21T00:30:00.000Z");
    expect(parseWhen("2026-10-21T06:00:00Z", "Asia/Kolkata")!.toISOString()).toBe("2026-10-21T06:00:00.000Z");
    expect(parseWhen("2026-10-21T06:00", "Asia/Kolkata")!.toISOString()).toBe("2026-10-21T00:30:00.000Z");
    expect(parseWhen("2026-07-01 09:30", "America/New_York")!.toISOString()).toBe("2026-07-01T13:30:00.000Z"); // EDT
    expect(parseWhen("2026-12-01T09:30", "America/New_York")!.toISOString()).toBe("2026-12-01T14:30:00.000Z"); // EST
    expect(parseWhen("2026-02-31T09:30", "UTC")).toBeUndefined();
    expect(parseWhen("6am", "UTC")).toBeUndefined();
  });

  it("formats in the reminder's zone and validates zones", () => {
    expect(formatLocal("2026-10-21T00:30:00.000Z", "Asia/Kolkata")).toBe("Wed 21 Oct, 06:00 IST");
    expect(formatLocal("2026-07-01T13:30:00.000Z", "America/New_York")).toBe("Wed 1 Jul, 09:30 EDT");
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Kyiv")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("<script>")).toBe(false);
  });
});
