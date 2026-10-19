import { describe, expect, it } from "vitest";
import { AUTH_ID, OWN_NUMBER, acct, connect, json, mockFetch, testConfig, type Route } from "./helpers.js";

const UUID = "4b7ae653-f40d-42f1-b582-6b05dfcd0c0a";
const TRUNK = "aabbccdd-1234-5678-90ab-cdef12345678";

function setup(routes: Route[], env: Record<string, string | undefined> = {}) {
  const m = mockFetch(routes);
  return connect(testConfig(env), m.impl).then((c) => ({ ...c, calls: m.calls }));
}

const EXPECTED_TOOLS = [
  "add_ip_acl_entry",
  "add_opt_out",
  "assign_number_to_subaccount",
  "buy_phone_number",
  "cancel_number_release",
  "check_opt_out",
  "create_application",
  "create_origination_uri",
  "create_sip_endpoint",
  "create_sip_trunk",
  "create_sub_account",
  "create_sub_account_kyc_session",
  "create_trunk_credential",
  "deafen_conference_member",
  "delete_application",
  "delete_ip_acl_entry",
  "delete_origination_uri",
  "delete_recording",
  "delete_sip_endpoint",
  "delete_sip_trunk",
  "delete_sub_account",
  "delete_trunk_credential",
  "end_all_conferences",
  "end_call",
  "end_conference",
  "gather_dtmf",
  "generate_answer_xml",
  "get_account_balance",
  "get_account_details",
  "get_application",
  "get_audio_stream",
  "get_broadcast",
  "get_call_details",
  "get_call_recording",
  "get_call_status",
  "get_concurrency",
  "get_conference",
  "get_conversation_messages",
  "get_gather_result",
  "get_message",
  "get_number_health",
  "get_phone_number_details",
  "get_sip_endpoint",
  "get_sip_trunk",
  "get_sub_account",
  "get_sub_account_kyc_status",
  "get_vobiz_skill",
  "hangup_conference_member",
  "hold_call",
  "kick_conference_member",
  "list_applications",
  "list_audio_streams",
  "list_broadcasts",
  "list_call_records",
  "list_conferences",
  "list_conversations",
  "list_ip_acl_entries",
  "list_live_calls",
  "list_messages",
  "list_messaging_numbers",
  "list_opt_outs",
  "list_origination_uris",
  "list_phone_numbers",
  "list_recordings",
  "list_sip_endpoints",
  "list_sip_trunks",
  "list_sub_accounts",
  "list_transaction_types",
  "list_transactions",
  "list_trunk_credentials",
  "list_vobiz_skills",
  "list_webhook_events",
  "list_webhooks",
  "make_call",
  "mute_conference_member",
  "play_audio",
  "play_audio_to_conference_member",
  "preview_message_cost",
  "release_phone_number",
  "remove_opt_out",
  "search_available_numbers",
  "send_dtmf",
  "send_message",
  "speak_text",
  "start_audio_stream",
  "start_conference_recording",
  "start_recording",
  "stop_audio",
  "stop_audio_stream",
  "stop_audio_to_conference_member",
  "stop_conference_recording",
  "stop_recording",
  "stop_speaking",
  "transfer_call",
  "unassign_number_from_subaccount",
  "undeafen_conference_member",
  "unhold_call",
  "unmute_conference_member",
  "update_application",
  "update_ip_acl_entry",
  "update_origination_uri",
  "update_phone_number",
  "update_sip_endpoint",
  "update_sip_trunk",
  "update_sub_account",
  "update_trunk_credential",
];

describe("tool registration", () => {
  it("registers exactly the operational tools with descriptions and schemas", async () => {
    const { client } = await setup([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      // Claude connector directory: a title, a name of at most 64 characters, and readOnlyHint or destructiveHint set to true.
      expect(t.title ?? t.annotations?.title).toBeTruthy();
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.annotations?.readOnlyHint === true || t.annotations?.destructiveHint === true).toBe(true);
    }
    const make = tools.find((t) => t.name === "make_call")!;
    expect(make.inputSchema.required).toEqual(expect.arrayContaining(["to", "from", "confirm"]));
    expect(make.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    const end = tools.find((t) => t.name === "end_call")!;
    expect(end.inputSchema.required).toEqual(expect.arrayContaining(["call_uuid", "confirm"]));
    for (const name of ["get_call_status", "list_call_records", "list_phone_numbers"]) {
      expect(tools.find((t) => t.name === name)!.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("does not overlap the Documentation MCP (vobiz-docs) tools", async () => {
    const { client } = await setup([]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const docsTool of ["search_vobiz", "query_docs_filesystem_vobiz", "submit_feedback", "search", "fetch"]) {
      expect(names).not.toContain(docsTool);
    }
    expect(client.getServerVersion()?.name).toBe("vobiz");
  });

  it("no tool accepts an account or tenant ID", async () => {
    const { client } = await setup([]);
    for (const t of (await client.listTools()).tools) {
      const props = Object.keys((t.inputSchema.properties ?? {}) as object);
      // Sub-account IDs (sub_*) name a child account to manage; the caller's own account always comes from the credentials.
      expect(props.some((p) => !p.startsWith("sub_") && /auth_id|account|tenant/i.test(p))).toBe(false);
    }
  });
});

describe("credentials and tenant isolation", () => {
  it("returns missing_credentials without any network call", async () => {
    const { call, calls } = await setup([], { VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined });
    const r = await call("get_account_balance");
    expect(r.data.error).toBe("missing_credentials");
    expect(calls).toHaveLength(0);
  });

  it("maps 401 to auth_failed", async () => {
    const { call } = await setup([
      { method: "GET", path: acct("/balance"), respond: () => json(401, { error: { code: 401, message: "Invalid API key" } }) },
    ]);
    const r = await call("get_account_balance");
    expect(r.data).toMatchObject({ error: "auth_failed", http_status: 401, message: "Invalid API key" });
  });

  it("ignores injected account IDs and always uses the configured account", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: acct("/balance"), respond: () => json(200, { balances: [{ currency: "INR", balance: 10 }] }) },
    ]);
    await call("get_account_balance", { auth_id: "MA_VICTIM", account_id: "MA_VICTIM" });
    expect(calls[0].url.pathname).toBe(`/api/v1/Account/${AUTH_ID}/balance`);
    expect(calls[0].url.toString()).not.toContain("VICTIM");
  });

  it("surfaces the gateway's cross-account 403 as forbidden", async () => {
    const { call } = await setup([
      {
        method: "GET",
        path: acct(`/cdr/${UUID}`),
        respond: () => json(403, { error: { code: 403, message: "Access denied: account ID mismatch" } }),
      },
    ]);
    const r = await call("get_call_details", { call_uuid: UUID });
    expect(r.data.error).toBe("forbidden");
  });

  it("rejects an invalid VOBIZ_AUTH_ID and non-https base URLs at startup", () => {
    expect(() => testConfig({ VOBIZ_AUTH_ID: "../x" })).toThrow(/VOBIZ_AUTH_ID/);
    expect(() => testConfig({ VOBIZ_BASE_URL: "http://api.vobiz.ai" })).toThrow(/https/);
    expect(() => testConfig({ VOBIZ_BASE_URL: "http://localhost:8080" })).not.toThrow();
  });
});

describe("backend failures", () => {
  it.each([
    [500, "backend_error"],
    [502, "service_unavailable"],
    [410, "account_suspended"],
  ])("maps %i to %s", async (status, kind) => {
    const { call } = await setup([{ method: "GET", path: acct("/balance"), respond: () => json(status, { error: "x" }) }]);
    expect((await call("get_account_balance")).data.error).toBe(kind);
  });

  it("reports timeouts on reads", async () => {
    const { call } = await setup([{ method: "GET", path: acct("/concurrency"), respond: () => "timeout" }]);
    expect((await call("get_concurrency")).data.error).toBe("timeout");
  });

  it("reports network errors on reads", async () => {
    const { call } = await setup([{ method: "GET", path: acct("/concurrency"), respond: () => "network" }]);
    expect((await call("get_concurrency")).data.error).toBe("network_error");
  });

  it("flags a non-JSON success body as unexpected_response", async () => {
    const { call } = await setup([{ method: "GET", path: acct("/concurrency"), respond: () => new Response("<html>", { status: 200 }) }]);
    expect((await call("get_concurrency")).data.error).toBe("unexpected_response");
  });
});

describe("call records", () => {
  const cdrList = { success: true, count: 1, data: [{ uuid: UUID }], pagination: { page: 2, per_page: 50, total: 51 }, summary: { totalCalls: 51 } };

  it("passes verified filters to GET /cdr", async () => {
    const { call, calls } = await setup([{ method: "GET", path: acct("/cdr"), respond: () => json(200, cdrList) }]);
    const r = await call("list_call_records", {
      start_date: "2026-10-01",
      end_date: "2026-10-13",
      call_direction: "outbound",
      to_number: "+919812345678",
      hangup_cause: "NO_ANSWER",
      page: 2,
      per_page: 50,
    });
    expect(r.data).toMatchObject({ count: 1, pagination: { page: 2, per_page: 50, total: 51, has_more: false, next_page: null }, summary: { totalCalls: 51 } });
    const q = Object.fromEntries(calls[0].url.searchParams);
    expect(q).toEqual({
      start_date: "2026-10-01",
      end_date: "2026-10-13",
      call_direction: "outbound",
      to_number: "919812345678",
      hangup_cause: "NO_ANSWER",
      page: "2",
      per_page: "50",
    });
  });

  it.each([
    [{ start_date: "2026-10-13", end_date: "2026-10-01" }],
    [{ start_date: "2026-01-01", end_date: "2026-10-01" }],
    [{ start_date: "2026-10-01" }],
    [{ start_date: "2026-02-30", end_date: "2026-03-01" }],
    [{ start_date: "13/10/2026", end_date: "2026-10-13" }],
    [{ per_page: 500 }],
    [{ page: 0 }],
  ])("rejects invalid ranges and paging %j", async (args) => {
    const { call, calls } = await setup([]);
    expect((await call("list_call_records", args)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns an empty list cleanly", async () => {
    const { call } = await setup([
      { method: "GET", path: acct("/cdr"), respond: () => json(200, { success: true, count: 0, data: [], pagination: { total: 0 } }) },
    ]);
    const r = await call("list_call_records");
    expect(r.isError).toBe(false);
    expect(r.data.count).toBe(0);
  });

  it("get_call_details returns the CDR and handles 404", async () => {
    const ok = await setup([{ method: "GET", path: acct(`/cdr/${UUID}`), respond: () => json(200, { success: true, data: { uuid: UUID, billsec: 3 } }) }]);
    expect((await ok.call("get_call_details", { call_uuid: UUID })).data.record).toMatchObject({ billsec: 3 });
    const nf = await setup([{ method: "GET", path: acct(`/cdr/${UUID}`), respond: () => json(404, { success: false, error: "CDR not found" }) }]);
    expect((await nf.call("get_call_details", { call_uuid: UUID })).data.error).toBe("not_found");
  });
});

describe("recordings", () => {
  it("finds recordings by call_uuid and drops any for other calls", async () => {
    const { call, calls } = await setup([
      {
        method: "GET",
        path: acct("/Recording/"),
        respond: () =>
          json(200, {
            api_id: "a",
            meta: { total_count: 2 },
            objects: [
              { recording_id: "rec1", call_uuid: UUID, recording_url: "https://media.example/rec1.mp3" },
              { recording_id: "rec2", call_uuid: "other-call-uuid-123", recording_url: "https://media.example/rec2.mp3" },
            ],
          }),
      },
    ]);
    const r = await call("get_call_recording", { call_uuid: UUID });
    expect(r.data.count).toBe(1);
    expect(r.data.recordings[0].recording_id).toBe("rec1");
    expect(calls[0].url.searchParams.get("call_uuid")).toBe(UUID);
  });

  it("reports when a call has no recording", async () => {
    const { call } = await setup([{ method: "GET", path: acct("/Recording/"), respond: () => json(200, { objects: [], meta: {} }) }]);
    const r = await call("get_call_recording", { call_uuid: UUID });
    expect(r.isError).toBe(false);
    expect(r.data.count).toBe(0);
    expect(r.data.note).toMatch(/No recording/);
  });

  it("list_recordings pages with limit/offset and tolerates null", async () => {
    const { call, calls } = await setup([
      {
        method: "GET",
        path: acct("/Recording/"),
        query: { offset: "0" },
        respond: () => json(200, { meta: { total_count: 25, limit: 20, offset: 0 }, objects: Array.from({ length: 20 }, (_, i) => ({ recording_id: "r" + i })) }),
      },
      { method: "GET", path: acct("/Recording/"), query: { offset: "20" }, respond: () => json(200, { meta: { total_count: 0 }, objects: null }) },
    ]);
    const first = await call("list_recordings", { from_date: "2026-10-01", to_date: "2026-10-13" });
    expect(first.data.pagination).toMatchObject({ limit: 20, offset: 0, total: 25, has_more: true, next_offset: 20 });
    expect(calls[0].url.searchParams.get("from_date")).toBe("2026-10-01");
    const second = await call("list_recordings", { offset: 20 });
    expect(second.data).toMatchObject({ count: 0, recordings: [] });
    expect((await call("list_recordings", { limit: 50 })).isError).toBe(true);
    expect((await call("list_recordings", { from_date: "2026-10-13", to_date: "2026-10-01" })).data.error).toBe("invalid_input");
  });

  it("requires exactly one identifier and maps 404/403", async () => {
    const both = await setup([]);
    expect((await both.call("get_call_recording", { call_uuid: UUID, recording_id: "rec1" })).data.error).toBe("invalid_input");
    expect((await both.call("get_call_recording", {})).data.error).toBe("invalid_input");

    const nf = await setup([{ method: "GET", path: acct("/Recording/rec1/"), respond: () => json(404, { error: "Recording rec1 not found" }) }]);
    expect((await nf.call("get_call_recording", { recording_id: "rec1" })).data.error).toBe("not_found");

    const forbidden = await setup([
      { method: "GET", path: acct("/Recording/rec1/"), respond: () => json(403, { error: { code: 403, message: "Access denied" } }) },
    ]);
    const r = await forbidden.call("get_call_recording", { recording_id: "rec1" });
    expect(r.data.error).toBe("forbidden");
    expect(r.text).not.toContain("recording_url");
  });
});

describe("numbers, account, trunks", () => {
  it("lists numbers with paging", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [{ e164: OWN_NUMBER }], page: 1, per_page: 10, total: 1 }) },
    ]);
    const r = await call("list_phone_numbers", { status: "active", per_page: 10 });
    expect(r.data).toMatchObject({ numbers: [{ e164: OWN_NUMBER }], pagination: { page: 1, per_page: 10, total: 1, has_more: false } });
    expect(calls[0].url.searchParams.get("status")).toBe("active");
  });

  it("get_phone_number_details requires an exact match", async () => {
    const { call } = await setup([
      { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [{ e164: "+9190000000012" }] }) },
    ]);
    expect((await call("get_phone_number_details", { phone_number: OWN_NUMBER })).data.error).toBe("not_found");
  });

  it("get_number_health URL-encodes the number", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: acct("/numbers/%2B919000000001/health"), respond: () => json(200, { e164: OWN_NUMBER, is_spam: false }) },
    ]);
    const r = await call("get_number_health", { phone_number: OWN_NUMBER });
    expect(r.data.health.is_spam).toBe(false);
    expect(calls[0].url.searchParams.get("granularity")).toBe("daily");
  });

  it("redacts secrets from account details and handles status fail", async () => {
    const ok = await setup([
      {
        method: "GET",
        path: acct(""),
        respond: () => json(200, { status: "success", data: { auth_id: AUTH_ID, name: "Acme", auth_secret: "SUPERSECRET", auth_token: "T" } }),
      },
    ]);
    const r = await ok.call("get_account_details");
    expect(r.data.account).toMatchObject({ name: "Acme", auth_secret: "[redacted]", auth_token: "[redacted]" });
    expect(r.text).not.toContain("SUPERSECRET");

    const fail = await setup([{ method: "GET", path: acct(""), respond: () => json(200, { status: "fail", message: "not found" }) }]);
    expect((await fail.call("get_account_details")).data.error).toBe("not_found");
  });

  it("redacts SIP credentials from trunks", async () => {
    const trunk = { trunk_id: TRUNK, name: "Out", username: "sipuser", password: "sippass", trunk_status: "active" };
    const { call } = await setup([
      { method: "GET", path: acct("/trunks"), respond: () => json(200, { meta: { total: 1 }, objects: [trunk] }) },
      { method: "GET", path: acct(`/trunks/${TRUNK}`), respond: () => json(200, trunk) },
    ]);
    const list = await call("list_sip_trunks");
    expect(list.text).not.toContain("sippass");
    expect(list.text).not.toContain("sipuser");
    const one = await call("get_sip_trunk", { trunk_id: TRUNK });
    expect(one.data.trunk).toMatchObject({ name: "Out", password: "[redacted]", username: "[redacted]" });
  });

  it("treats Go null lists as empty (account with no trunks/numbers/records/recordings)", async () => {
    const { call } = await setup([
      { method: "GET", path: acct("/trunks"), respond: () => json(200, { meta: { limit: 20, offset: 0, total: 0 }, objects: null }) },
      { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: null, page: 1, per_page: 25, total: 0 }) },
      { method: "GET", path: acct("/cdr"), respond: () => json(200, { success: true, count: 0, data: null }) },
      { method: "GET", path: acct("/Recording/"), respond: () => json(200, { objects: null, meta: {} }) },
    ]);
    const trunks = await call("list_sip_trunks");
    expect(trunks.isError).toBe(false);
    expect(trunks.data).toMatchObject({ count: 0, trunks: [], pagination: { total: 0, has_more: false, next_offset: null } });
    expect((await call("list_phone_numbers")).data.numbers).toEqual([]);
    expect((await call("list_call_records")).data.count).toBe(0);
    expect((await call("get_call_recording", { call_uuid: UUID })).data.count).toBe(0);
  });

  it("still flags a genuinely wrong trunk list shape", async () => {
    const { call } = await setup([{ method: "GET", path: acct("/trunks"), respond: () => json(200, { objects: { a: 1 } }) }]);
    expect((await call("list_sip_trunks")).data.error).toBe("unexpected_response");
  });

  it("pagination is stateless: server default page size, next_page / next_offset returned", async () => {
    const { call, calls } = await setup(
      [
        { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [{}, {}, {}], page: 1, per_page: 3, total: 7 }) },
        { method: "GET", path: acct("/cdr"), respond: () => json(200, { data: [{}, {}, {}], pagination: { total: 3 } }) },
        { method: "GET", path: acct("/trunks"), respond: () => json(200, { meta: { total: 5 }, objects: [{}, {}, {}] }) },
      ],
      { VOBIZ_DEFAULT_PAGE_SIZE: "3" },
    );
    expect((await call("list_phone_numbers")).data.pagination).toMatchObject({ page: 1, per_page: 3, total: 7, has_more: true, next_page: 2 });
    expect((await call("list_call_records")).data.pagination).toMatchObject({ has_more: false, next_page: null });
    expect((await call("list_sip_trunks")).data.pagination).toMatchObject({ limit: 3, offset: 0, has_more: true, next_offset: 3 });
    expect(calls[0].url.searchParams.get("per_page")).toBe("3");
    expect(calls[1].url.searchParams.get("per_page")).toBe("3");
    expect(calls[2].url.searchParams.get("limit")).toBe("3");
    expect(() => testConfig({ VOBIZ_DEFAULT_PAGE_SIZE: "500" })).toThrow(/VOBIZ_DEFAULT_PAGE_SIZE/);
  });

  it("balance uppercases the currency and validates it", async () => {
    const { call, calls } = await setup([{ method: "GET", path: acct("/balance/USD"), respond: () => json(200, { currency: "USD", balance: 5 }) }]);
    expect((await call("get_account_balance", { currency: "usd" })).data.balance.currency).toBe("USD");
    expect((await call("get_account_balance", { currency: "../x" })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
