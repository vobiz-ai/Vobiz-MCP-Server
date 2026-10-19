import { describe, expect, it } from "vitest";
import { OWN_NUMBER, acct, capacityRoutes, connect, json, mockFetch, ownNumberRoute, testConfig, type Route } from "./helpers.js";

const DEST = "+919812345678";
const UUID = "5a9fd4a0-3d4c-11ef-bef9-0242ac110005";
const TRUNK = "aabbccdd-1234-5678-90ab-cdef12345678";
const callArgs = { to: DEST, from: OWN_NUMBER, confirm: true };
const queued = (n = 1) => json(201, { api_id: "a", message: "call queued", request_uuid: `${UUID.slice(0, -1)}${n}` });

function setup(routes: Route[], env: Record<string, string | undefined> = {}) {
  const m = mockFetch([...routes, ...capacityRoutes]);
  return connect(testConfig(env), m.impl).then((c) => ({ ...c, calls: m.calls }));
}
const posts = (calls: { method: string; url: URL }[], path = acct("/Call/")) => calls.filter((c) => c.method === "POST" && c.url.pathname === path);

describe("make_call guardrails (server-side)", () => {
  it("refuses destinations outside allowed countries and blocked prefixes", async () => {
    const { call, calls } = await setup([ownNumberRoute]);
    expect((await call("make_call", { ...callArgs, to: "+14155550123" })).data.error).toBe("not_allowed");
    const b = await setup([ownNumberRoute], { VOBIZ_BLOCKED_PREFIXES: "9198" });
    expect((await b.call("make_call", callArgs)).data.error).toBe("not_allowed");
    expect(posts([...calls, ...b.calls])).toHaveLength(0);
  });

  it("always sends a time_limit within the cap and rejects longer ones", async () => {
    const { call, calls } = await setup([ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => queued() }], { VOBIZ_MAX_CALL_DURATION_SEC: "120" });
    expect((await call("make_call", { ...callArgs, time_limit: 121 })).data.error).toBe("not_allowed");
    await call("make_call", callArgs);
    expect((posts(calls)[0] as { body?: Record<string, unknown> }).body?.time_limit).toBe(120);
  });

  it("refuses when this server's concurrent-call cap is reached", async () => {
    const { call, calls } = await setup(
      [ownNumberRoute, { method: "GET", path: acct("/Call/"), query: { status: "live" }, respond: () => json(200, { calls: ["a", "b", "c"] }) }],
      { VOBIZ_MAX_CONCURRENT_CALLS: "3" },
    );
    const r = await call("make_call", callArgs);
    expect(r.data.error).toBe("rate_limited");
    expect(r.data.message).toMatch(/at most 3/);
    expect(posts(calls)).toHaveLength(0);
  });

  it("refuses at or below the balance floor (prepaid) and skips the floor for postpaid", async () => {
    const low = await setup(
      [ownNumberRoute, { method: "GET", path: acct("/balance"), respond: () => json(200, { balances: [{ currency: "INR", available_balance: 5, is_postpaid: false }] }) }],
      { VOBIZ_MIN_BALANCE: "10" },
    );
    expect((await low.call("make_call", callArgs)).data.error).toBe("insufficient_balance");
    expect(posts(low.calls)).toHaveLength(0);
    const post = await setup(
      [ownNumberRoute, { method: "GET", path: acct("/balance"), respond: () => json(200, { balances: [{ currency: "INR", available_balance: -50, is_postpaid: true }] }) }, { method: "POST", path: acct("/Call/"), respond: () => queued() }],
      { VOBIZ_MIN_BALANCE: "10" },
    );
    expect((await post.call("make_call", callArgs)).isError).toBe(false);
  });

  it("fails closed when the balance cannot be read", async () => {
    const { call, calls } = await setup([ownNumberRoute, { method: "GET", path: acct("/balance"), respond: () => json(503, { error: "down" }) }]);
    expect((await call("make_call", callArgs)).isError).toBe(true);
    expect(posts(calls)).toHaveLength(0);
  });

  it("refuses answer_url on unapproved hosts", async () => {
    const { call, calls } = await setup([ownNumberRoute]);
    const r = await call("make_call", { ...callArgs, answer_url: "https://attacker.example/xml" });
    expect(r.data.error).toBe("not_allowed");
    expect(calls).toHaveLength(0);
  });

  it("enforces the hourly cap", async () => {
    const { call, calls } = await setup([ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => queued() }], { VOBIZ_MAX_CALLS_PER_HOUR: "1" });
    expect((await call("make_call", { ...callArgs, idempotency_key: "hour-key-01" })).isError).toBe(false);
    expect((await call("make_call", { ...callArgs, idempotency_key: "hour-key-02" })).data.error).toBe("rate_limited");
    expect(posts(calls)).toHaveLength(1);
  });
});

describe("make_call idempotency", () => {
  const route: Route = { method: "POST", path: acct("/Call/"), respond: () => queued() };

  it("replays the same key without dialling again", async () => {
    const { call, calls } = await setup([ownNumberRoute, route]);
    const a = await call("make_call", { ...callArgs, idempotency_key: "intent-0001" });
    const b = await call("make_call", { ...callArgs, idempotency_key: "intent-0001" });
    expect(b.data).toMatchObject({ request_uuid: a.data.request_uuid, replayed: true });
    expect(posts(calls)).toHaveLength(1);
  });

  it("rejects a reused key with different parameters", async () => {
    const { call } = await setup([ownNumberRoute, route]);
    await call("make_call", { ...callArgs, idempotency_key: "intent-0002" });
    expect((await call("make_call", { ...callArgs, to: "+919812345679", idempotency_key: "intent-0002" })).data.error).toBe("idempotency_conflict");
  });

  it("dials once for two concurrent identical requests", async () => {
    const slow: Route = { method: "POST", path: acct("/Call/"), respond: () => new Promise((r) => setTimeout(() => r(queued()), 50)) };
    const { call, calls } = await setup([ownNumberRoute, slow]);
    const [a, b] = await Promise.all([call("make_call", { ...callArgs, idempotency_key: "intent-0003" }), call("make_call", { ...callArgs, idempotency_key: "intent-0003" })]);
    expect([a.isError, b.isError].sort()).toEqual([false, true]);
    expect([a.data.error, b.data.error]).toContain("in_progress");
    expect(posts(calls)).toHaveLength(1);
  });

  it("blocks an identical call without a key inside the duplicate window", async () => {
    const { call, calls } = await setup([ownNumberRoute, route]);
    expect((await call("make_call", callArgs)).isError).toBe(false);
    const again = await call("make_call", callArgs);
    expect(again.data.error).toBe("duplicate_blocked");
    expect(posts(calls)).toHaveLength(1);
    expect((await call("make_call", { ...callArgs, idempotency_key: "explicit-new-1" })).isError).toBe(false);
    expect(posts(calls)).toHaveLength(2);
  });

  it("never re-sends after an ambiguous timeout, even with the same key", async () => {
    const { call, calls } = await setup([ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => "timeout" }]);
    expect((await call("make_call", { ...callArgs, idempotency_key: "intent-0004" })).data.error).toBe("outcome_unknown");
    expect((await call("make_call", { ...callArgs, idempotency_key: "intent-0004" })).data.error).toBe("outcome_unknown");
    expect((await call("make_call", callArgs)).isError).toBe(true);
    expect(posts(calls)).toHaveLength(2);
  });

  it("allows a retry with the same key after a definitive provider rejection", async () => {
    let n = 0;
    const flaky: Route = { method: "POST", path: acct("/Call/"), respond: () => (++n === 1 ? json(402, { error: "Insufficient balance" }) : queued()) };
    const { call, calls } = await setup([ownNumberRoute, flaky]);
    expect((await call("make_call", { ...callArgs, idempotency_key: "intent-0005" })).data.error).toBe("insufficient_balance");
    expect((await call("make_call", { ...callArgs, idempotency_key: "intent-0005" })).isError).toBe(false);
    expect(posts(calls)).toHaveLength(2);
  });
});

describe("call outcomes", () => {
  it("get_call_details and get_call_status classify busy as distinct from not-found", async () => {
    const { call } = await setup([
      { method: "GET", path: acct(`/Call/${UUID}/`), respond: () => json(404, { error: "call not found" }) },
      { method: "GET", path: acct(`/cdr/${UUID}`), respond: () => json(200, { data: { uuid: UUID, hangup_cause: "USER_BUSY", billsec: 0 } }) },
    ]);
    expect((await call("get_call_details", { call_uuid: UUID })).data).toMatchObject({ outcome: "busy", typical_sip_code: 486, retry_may_succeed: true });
    expect((await call("get_call_status", { call_uuid: UUID })).data).toMatchObject({ state: "completed", outcome: "busy" });
  });
});

describe("in-call controls", () => {
  const p = (s: string) => acct(`/Call/${UUID}/${s}`);

  it("transfer_call sends legs + approved aleg_url and needs confirm", async () => {
    const { call, calls } = await setup([{ method: "POST", path: p(""), respond: () => json(202, { message: "call transferred" }) }]);
    expect((await call("transfer_call", { call_uuid: UUID, aleg_url: "https://example.com/next.xml", confirm: false })).data.error).toBe("confirmation_required");
    expect((await call("transfer_call", { call_uuid: UUID, aleg_url: "https://evil.example/x", confirm: true })).data.error).toBe("not_allowed");
    const r = await call("transfer_call", { call_uuid: UUID, aleg_url: "https://example.com/next.xml", confirm: true });
    expect(r.data).toMatchObject({ transferred: true, backend_message: "call transferred" });
    expect(calls.at(-1)?.body).toEqual({ legs: "aleg", aleg_url: "https://example.com/next.xml", aleg_method: "POST" });
    expect((await call("transfer_call", { call_uuid: UUID, legs: "bleg", confirm: true })).data.error).toBe("invalid_input");
  });

  it("transfer to a number needs hosted flows (unsupported in stdio mode)", async () => {
    const { call } = await setup([]);
    expect((await call("transfer_call", { call_uuid: UUID, destination: DEST, confirm: true })).data.error).toBe("unsupported");
  });

  it("maps a non-live call to call_not_active", async () => {
    const { call } = await setup([{ method: "POST", path: p("Speak/"), respond: () => json(404, { error: "call not found" }) }]);
    expect((await call("speak_text", { call_uuid: UUID, text: "hi" })).data.error).toBe("call_not_active");
  });

  it("play_audio validates formats and sends comma-joined urls", async () => {
    const { call, calls } = await setup([{ method: "POST", path: p("Play/"), respond: () => json(202, { message: "play started" }) }]);
    expect((await call("play_audio", { call_uuid: UUID, urls: ["https://cdn.example.org/a.ogg"] })).isError).toBe(true);
    await call("play_audio", { call_uuid: UUID, urls: ["https://cdn.example.org/a.mp3", "https://cdn.example.org/b.wav"], loop: true });
    expect(calls.at(-1)?.body).toEqual({ urls: "https://cdn.example.org/a.mp3,https://cdn.example.org/b.wav", legs: "aleg", loop: true });
  });

  it("speak_text and stop calls use the verified routes", async () => {
    const { call, calls } = await setup([
      { method: "POST", path: p("Speak/"), respond: () => json(202, { message: "speak started" }) },
      { method: "DELETE", path: p("Speak/"), respond: () => new Response(null, { status: 204 }) },
      { method: "DELETE", path: p("Play/"), respond: () => new Response(null, { status: 204 }) },
    ]);
    await call("speak_text", { call_uuid: UUID, text: "Namaste", language: "hi-IN", voice: "WOMAN" });
    expect(calls.at(-1)?.body).toEqual({ text: "Namaste", legs: "aleg", voice: "WOMAN", language: "hi-IN" });
    expect((await call("stop_speaking", { call_uuid: UUID })).data.speaking).toBe(false);
    expect((await call("stop_audio", { call_uuid: UUID })).data.playing).toBe(false);
  });

  it("start_recording needs confirm, never sends callback_url, returns recording id/url", async () => {
    const { call, calls } = await setup([
      { method: "POST", path: p("Record/"), respond: () => json(202, { message: "recording started", recording_id: "rec1", url: "https://media.example/rec1.mp3" }) },
      { method: "DELETE", path: p("Record/"), respond: () => new Response(null, { status: 204 }) },
    ]);
    expect((await call("start_recording", { call_uuid: UUID, confirm: false })).data.error).toBe("confirmation_required");
    const r = await call("start_recording", { call_uuid: UUID, time_limit: 300, file_format: "wav", confirm: true });
    expect(r.data).toMatchObject({ recording_id: "rec1", url: "https://media.example/rec1.mp3" });
    expect(calls.at(-1)?.body).toEqual({ time_limit: 300, file_format: "wav" });
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain("callback_url");
    await call("stop_recording", { call_uuid: UUID, url: "https://media.example/rec1.mp3" });
    expect(calls.at(-1)?.url.searchParams.get("url")).toBe("https://media.example/rec1.mp3");
  });

  it("hold_call is emulated and needs hosted flows", async () => {
    const { call } = await setup([]);
    expect((await call("hold_call", { call_uuid: UUID, confirm: true })).data.error).toBe("unsupported");
  });
});

describe("provisioning", () => {
  const prov = { VOBIZ_ENABLE_PROVISIONING: "true", VOBIZ_MAX_NUMBER_COST: "1000" };
  const NEW = "+918071500001";
  const inventory: Route = { method: "GET", path: acct("/inventory/numbers"), respond: () => json(200, { items: [{ e164: NEW, setup_fee: 100, monthly_fee: 300, currency: "INR" }], total: 1 }) };
  const noneOwned: Route = { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [], total: 0 }) };
  const buy = (extra = {}) => ({ phone_number: NEW, idempotency_key: "buy-key-0001", confirm: true, ...extra });

  it("is disabled by default", async () => {
    const { call, calls } = await setup([]);
    for (const [t, a] of [
      ["buy_phone_number", buy()],
      ["create_sip_trunk", { name: "x", confirm: true }],
      ["delete_sip_trunk", { trunk_id: TRUNK, confirm: true }],
      ["update_phone_number", { phone_number: OWN_NUMBER, tags: ["a"], confirm: true }],
      ["create_application", { app_name: "a", answer_url: "https://example.com/a", confirm: true }],
    ] as const) {
      expect((await call(t, a)).data.error).toBe("provisioning_disabled");
    }
    expect(calls).toHaveLength(0);
  });

  it("search_available_numbers passes the verified filters", async () => {
    const { call, calls } = await setup([inventory]);
    const r = await call("search_available_numbers", { country: "IN", contains: "807", series: "80", per_page: 10 });
    expect(r.data.numbers).toHaveLength(1);
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({ country: "IN", search: "807", series: "80", per_page: "10" });
  });

  it("buys once, checks cost cap and balance, and replays the same key", async () => {
    const { call, calls } = await setup(
      [inventory, noneOwned, { method: "POST", path: acct("/numbers/purchase-from-inventory"), respond: () => json(200, { number: { e164: NEW }, message: "purchased from inventory" }) }],
      prov,
    );
    const r = await call("buy_phone_number", buy());
    expect(r.data).toMatchObject({ purchased: true, charged_estimate: { amount: 400, currency: "INR" } });
    expect((await call("buy_phone_number", buy())).data).toMatchObject({ replayed: true });
    expect(posts(calls, acct("/numbers/purchase-from-inventory"))).toHaveLength(1);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ e164: NEW, currency: "INR" });
  });

  it("refuses over the cost cap, without balance, when owned, or beyond the daily cap", async () => {
    const cap = await setup([inventory, noneOwned], { ...prov, VOBIZ_MAX_NUMBER_COST: "399" });
    expect((await cap.call("buy_phone_number", buy())).data.error).toBe("spending_limit");
    const poor = await setup([inventory, noneOwned, { method: "GET", path: acct("/balance/INR"), respond: () => json(200, { available_balance: 50 }) }], prov);
    expect((await poor.call("buy_phone_number", buy())).data.error).toBe("insufficient_balance");
    const owned = await setup([inventory, { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [{ e164: NEW }] }) }], prov);
    expect((await owned.call("buy_phone_number", buy())).data.error).toBe("not_allowed");
    const daily = await setup([inventory, noneOwned, { method: "POST", path: acct("/numbers/purchase-from-inventory"), respond: () => json(200, { number: {} }) }], prov);
    await daily.call("buy_phone_number", buy());
    expect((await daily.call("buy_phone_number", buy({ idempotency_key: "buy-key-0002" }))).data.error).toBe("spending_limit");
    for (const s of [cap, poor, owned]) expect(posts(s.calls, acct("/numbers/purchase-from-inventory"))).toHaveLength(0);
  });

  it("keeps a purchase key blocked after an ambiguous timeout", async () => {
    const { call, calls } = await setup([inventory, noneOwned, { method: "POST", path: acct("/numbers/purchase-from-inventory"), respond: () => "timeout" }], prov);
    expect((await call("buy_phone_number", buy())).data.error).toBe("outcome_unknown");
    expect((await call("buy_phone_number", buy())).data.error).toBe("outcome_unknown");
    expect(posts(calls, acct("/numbers/purchase-from-inventory"))).toHaveLength(1);
  });

  it("update_phone_number links an application and replaces tags on an owned number", async () => {
    const { call, calls } = await setup(
      [
        ownNumberRoute,
        { method: "POST", path: acct("/numbers/%2B919000000001/application"), respond: () => new Response(null, { status: 204 }) },
        { method: "PATCH", path: acct("/numbers/%2B919000000001"), respond: () => new Response(null, { status: 204 }) },
      ],
      prov,
    );
    const r = await call("update_phone_number", { phone_number: OWN_NUMBER, application_id: "20577609616603585", tags: ["sales"], confirm: true });
    expect(r.data.changes).toEqual(["linked to application 20577609616603585", "tags replaced"]);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ application_id: "20577609616603585" });
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ tags: ["sales"] });
    expect((await call("update_phone_number", { phone_number: OWN_NUMBER, application_id: "20577609616603585", trunk_id: TRUNK, confirm: true })).data.error).toBe("invalid_input");
  });

  it("SIP trunk create/update/delete validate input and redact credentials", async () => {
    const trunk = { trunk_id: TRUNK, name: "t", password: "secret-pass" };
    const { call, calls } = await setup(
      [
        { method: "POST", path: acct("/trunks"), respond: () => json(201, trunk) },
        { method: "PUT", path: acct(`/trunks/${TRUNK}`), respond: () => json(200, trunk) },
        { method: "DELETE", path: acct(`/trunks/${TRUNK}`), respond: () => new Response(null, { status: 204 }) },
      ],
      prov,
    );
    expect((await call("create_sip_trunk", { name: "t", webhook_url: "https://127.0.0.1/x", confirm: true })).data.error).toBe("invalid_input");
    expect((await call("create_sip_trunk", { name: "t", cps_limit: 1000, confirm: true })).isError).toBe(true);
    const c = await call("create_sip_trunk", { name: "t", trunk_direction: "outbound", cps_limit: 2, confirm: true });
    expect(c.text).not.toContain("secret-pass");
    expect((await call("update_sip_trunk", { trunk_id: TRUNK, confirm: true })).data.error).toBe("invalid_input");
    await call("update_sip_trunk", { trunk_id: TRUNK, concurrent_calls_limit: 20, webhook_url: "https://hooks.example.org/t", confirm: true });
    expect(calls.find((x) => x.method === "PUT")?.body).toEqual({ concurrent_calls_limit: 20, webhook_url: "https://hooks.example.org/t" });
    expect((await call("delete_sip_trunk", { trunk_id: TRUNK, confirm: true })).data.deleted).toBe(true);
  });

  it("update_application keeps default_endpoint_app (Vobiz resets it when omitted)", async () => {
    const id = "20577609616603585";
    const { call, calls } = await setup(
      [
        { method: "GET", path: acct(`/Application/${id}/`), respond: () => json(200, { app_id: id, default_endpoint_app: true }) },
        { method: "POST", path: acct(`/Application/${id}/`), respond: () => json(202, { message: "changed" }) },
      ],
      prov,
    );
    expect((await call("update_application", { app_id: id, answer_url: "https://evil.example/a", confirm: true })).data.error).toBe("not_allowed");
    await call("update_application", { app_id: id, answer_url: "https://example.com/a.xml", confirm: true });
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ answer_url: "https://example.com/a.xml", default_endpoint_app: true });
  });

  it("list_webhooks aggregates application and trunk webhooks", async () => {
    const { call } = await setup([
      { method: "GET", path: acct("/Application/"), respond: () => json(200, { objects: [{ app_id: "1", app_name: "IVR", answer_url: "https://a.example/ans", answer_method: "POST", hangup_url: "https://a.example/h" }], meta: {} }) },
      { method: "GET", path: acct("/trunks"), respond: () => json(200, { objects: [{ trunk_id: TRUNK, name: "t", webhook_url: "https://hooks.example/t", recording_webhook_enabled: true }], meta: {} }) },
    ]);
    const r = await call("list_webhooks");
    expect(r.data.count).toBe(3);
    expect(r.data.webhooks.find((w: { source: string }) => w.source === "sip_trunk").events).toEqual(["CallInitiated", "Hangup", "recording.completed"]);
  });
});

describe("tool inventory", () => {
  it("every tool has a description, object schema and annotations; mutating tools need confirm or are bounded", async () => {
    const { client } = await setup([]);
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThanOrEqual(40);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations, t.name).toBeDefined();
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props.some((p) => !p.startsWith("sub_") && /auth_id|account_id|tenant/i.test(p)), t.name).toBe(false);
      // Every write tool is annotated destructive (Claude asks before running it). In-call media and DTMF act only on a
      // call the user already placed, so they need no extra confirm flag; every other write tool does.
      const inCall = [
        "send_dtmf", "play_audio", "stop_audio", "speak_text", "stop_speaking", "stop_recording",
        "mute_conference_member", "unmute_conference_member", "deafen_conference_member", "undeafen_conference_member",
        "play_audio_to_conference_member", "stop_audio_to_conference_member", "stop_conference_recording", "stop_audio_stream",
      ];
      if (t.annotations?.destructiveHint && !inCall.includes(t.name)) expect(props, t.name).toContain("confirm");
    }
  });
});

describe("live-found error mappings", () => {
  it("call records 404 (route down) is service_unavailable, not 'no records'", async () => {
    const { call } = await setup([{ method: "GET", path: acct("/cdr"), respond: () => json(404, { message: "Not Found" }) }]);
    expect((await call("list_call_records")).data).toMatchObject({ error: "service_unavailable", retryable: true });
  });
  it("account details with sub-account credentials explains the 403", async () => {
    const m = mockFetch([{ method: "GET", path: "/api/v1/Account/SA_TEST1", respond: () => json(403, { error: "HTTPError", message: "This operation requires account-level authentication" }) }]);
    const { call } = await connect(testConfig({ VOBIZ_AUTH_ID: "SA_TEST1" }), m.impl);
    const r = await call("get_account_details");
    expect(r.data.error).toBe("forbidden");
    expect(r.data.message).toMatch(/main-account/);
  });
});
