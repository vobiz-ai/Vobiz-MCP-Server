import { describe, expect, it } from "vitest";
import { AUTH_ID, BASE, OWN_NUMBER, acct, capacityRoutes, connect, json, mockFetch, ownNumberRoute, testConfig, type Route } from "./helpers.js";

const DEST = "+919812345678";
const UUID = "5a9fd4a0-3d4c-11ef-bef9-0242ac110005";

const makeCallArgs = { to: DEST, from: OWN_NUMBER, confirm: true };

function setup(routes: Route[], env: Record<string, string | undefined> = {}) {
  const m = mockFetch([...routes, ...capacityRoutes]);
  return connect(testConfig(env), m.impl).then((c) => ({ ...c, calls: m.calls }));
}

const posts = (calls: { method: string; url: URL }[]) =>
  calls.filter((c) => c.method === "POST" && c.url.pathname === acct("/Call/"));

describe("make_call", () => {
  it("sends the verified payload to POST /Account/{auth_id}/Call/ and reports accepted, not connected", async () => {
    const { call, calls } = await setup([
      ownNumberRoute,
      {
        method: "POST",
        path: acct("/Call/"),
        respond: () => json(201, { api_id: "api-1", message: "call queued", request_uuid: UUID }),
      },
    ]);
    const r = await call("make_call", { ...makeCallArgs, caller_name: "Acme", time_limit: 600 });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ accepted: true, connected: false, request_uuid: UUID, backend_message: "call queued" });

    const post = posts(calls)[0];
    expect(post.url.toString()).toBe(`${BASE}/api/v1/Account/${AUTH_ID}/Call/`);
    expect(post.headers["X-Auth-ID"]).toBe(AUTH_ID);
    expect(post.headers["X-Auth-Token"]).toBe("test-token-not-real");
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(post.body).toEqual({
      from: "919000000001",
      to: DEST,
      answer_url: "https://example.com/answer.xml",
      answer_method: "POST",
      caller_name: "Acme",
      time_limit: 600,
    });
    expect(r.data.time_limit).toBe(600);
    expect(post.body).not.toHaveProperty("callback_url");
  });

  it("is refused when calling is disabled, without touching the API", async () => {
    const { call, calls } = await setup([], { VOBIZ_ENABLE_CALLS: undefined });
    const r = await call("make_call", makeCallArgs);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("calls_disabled");
    expect(calls).toHaveLength(0);
  });

  it("requires confirm: true", async () => {
    const { call, calls } = await setup([]);
    const r = await call("make_call", { ...makeCallArgs, confirm: false });
    expect(r.data.error).toBe("confirmation_required");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["letters", "abc"],
    ["too short", "+12345"],
    ["bulk delimiter", "+919812345678<+919812345679"],
    ["leading zero", "09812345678"],
  ])("rejects an invalid destination (%s)", async (_label, to) => {
    const { call, calls } = await setup([]);
    const r = await call("make_call", { ...makeCallArgs, to });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a caller ID that is not on the account", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [], page: 1, per_page: 25, total: 0 }) },
    ]);
    const r = await call("make_call", makeCallArgs);
    expect(r.data.error).toBe("not_allowed");
    expect(posts(calls)).toHaveLength(0);
  });

  it("refuses a caller ID that is not active", async () => {
    const { call, calls } = await setup([
      {
        method: "GET",
        path: acct("/numbers"),
        respond: () => json(200, { items: [{ e164: OWN_NUMBER, status: "pending_release", voice_enabled: true }] }),
      },
    ]);
    const r = await call("make_call", makeCallArgs);
    expect(r.data.error).toBe("not_allowed");
    expect(posts(calls)).toHaveLength(0);
  });

  it("fails closed when the caller ID lookup fails", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: acct("/numbers"), respond: () => json(503, { error: { code: 503, message: "down" } }) },
    ]);
    const r = await call("make_call", makeCallArgs);
    expect(r.data.error).toBe("service_unavailable");
    expect(posts(calls)).toHaveLength(0);
  });

  it("enforces destination and caller-ID allowlists", async () => {
    const a = await setup([ownNumberRoute], { VOBIZ_ALLOWED_DESTINATIONS: "+911111111111" });
    expect((await a.call("make_call", makeCallArgs)).data.error).toBe("not_allowed");
    const b = await setup([ownNumberRoute], { VOBIZ_ALLOWED_CALLER_IDS: "+912222222222" });
    expect((await b.call("make_call", makeCallArgs)).data.error).toBe("not_allowed");
    expect(posts([...a.calls, ...b.calls])).toHaveLength(0);
  });

  it("requires an answer_url when no default is configured", async () => {
    const { call, calls } = await setup([ownNumberRoute], { VOBIZ_DEFAULT_ANSWER_URL: undefined });
    const r = await call("make_call", makeCallArgs);
    expect(r.data.error).toBe("invalid_input");
    expect(posts(calls)).toHaveLength(0);
  });

  it.each([
    [402, { api_id: "a", error: "Insufficient balance" }, "insufficient_balance"],
    [403, { api_id: "a", error: "Number is blocked" }, "forbidden"],
    [429, { api_id: "a", error: "concurrent call limit exceeded" }, "rate_limited"],
    [400, { api_id: "a", error: "max call rate limit 2 reached" }, "rate_limited"],
    [400, { api_id: "a", error: "from parameter is missing" }, "invalid_input"],
    [500, { api_id: "a", error: "call not fired" }, "backend_error"],
    [503, { error: { code: 503, message: "Service unavailable" } }, "service_unavailable"],
  ])("maps backend %i to %s and never succeeds", async (status, body, kind) => {
    const { call, calls } = await setup([ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => json(status, body) }]);
    const r = await call("make_call", makeCallArgs);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe(kind);
    expect(r.data.http_status).toBe(status);
    expect(posts(calls)).toHaveLength(1);
  });

  it("reports outcome_unknown on timeout and does NOT retry", async () => {
    const { call, calls } = await setup([ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => "timeout" }]);
    const r = await call("make_call", makeCallArgs);
    expect(r.data.error).toBe("outcome_unknown");
    expect(r.data.message).toMatch(/Do NOT retry/);
    expect(posts(calls)).toHaveLength(1);
  });

  it("reports outcome_unknown on a dropped connection and does NOT retry", async () => {
    const { call, calls } = await setup([ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => "network" }]);
    const r = await call("make_call", makeCallArgs);
    expect(r.data.error).toBe("outcome_unknown");
    expect(posts(calls)).toHaveLength(1);
  });

  it("reports outcome_unknown when success has no request_uuid", async () => {
    const { call } = await setup([ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => json(201, { message: "ok" }) }]);
    const r = await call("make_call", makeCallArgs);
    expect(r.data.error).toBe("outcome_unknown");
  });

  it("applies the local per-minute call limit", async () => {
    const { call, calls } = await setup(
      [ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => json(201, { message: "call queued", request_uuid: UUID }) }],
      { VOBIZ_MAX_CALLS_PER_MINUTE: "1" },
    );
    expect((await call("make_call", { ...makeCallArgs, idempotency_key: "call-key-0001" })).isError).toBe(false);
    expect((await call("make_call", { ...makeCallArgs, idempotency_key: "call-key-0002" })).data.error).toBe("rate_limited");
    expect(posts(calls)).toHaveLength(1);
  });
});

describe("get_call_status", () => {
  it("returns live state from Call/{uuid}/?status=live", async () => {
    const { call, calls } = await setup([
      {
        method: "GET",
        path: acct(`/Call/${UUID}/`),
        query: { status: "live" },
        respond: () => json(200, { call_uuid: UUID, call_status: "in-progress", direction: "outbound" }),
      },
    ]);
    const r = await call("get_call_status", { call_uuid: UUID });
    expect(r.data).toMatchObject({ state: "live", call_status: "in-progress" });
    expect(calls).toHaveLength(1);
  });

  it("falls back to queued, then to the CDR", async () => {
    const q = await setup([
      { method: "GET", path: acct(`/Call/${UUID}/`), query: { status: "live" }, respond: () => json(404, { error: "call not found" }) },
      { method: "GET", path: acct(`/Call/${UUID}/`), query: { status: "queued" }, respond: () => json(200, { call_status: "queued" }) },
    ]);
    expect((await q.call("get_call_status", { call_uuid: UUID })).data.state).toBe("queued");

    const c = await setup([
      { method: "GET", path: acct(`/Call/${UUID}/`), respond: () => json(404, { error: "call not found" }) },
      {
        method: "GET",
        path: acct(`/cdr/${UUID}`),
        respond: () => json(200, { success: true, data: { uuid: UUID, hangup_cause: "NORMAL_CLEARING", duration: 42, billsec: 40 } }),
      },
    ]);
    const r = await c.call("get_call_status", { call_uuid: UUID });
    expect(r.data).toMatchObject({ state: "completed", hangup_cause: "NORMAL_CLEARING", duration: 42, answered: true });
  });

  it("returns not_found for an unknown call", async () => {
    const { call } = await setup([]);
    const r = await call("get_call_status", { call_uuid: UUID });
    expect(r.data.error).toBe("not_found");
  });

  it("rejects malformed / path-injecting call IDs", async () => {
    const { call, calls } = await setup([]);
    for (const bad of ["../../numbers", "abc", "x".repeat(65), "a b c d e f g h"]) {
      expect((await call("get_call_status", { call_uuid: bad })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("end_call", () => {
  const liveRoute: Route = {
    method: "GET",
    path: acct(`/Call/${UUID}/`),
    query: { status: "live" },
    respond: () => json(200, { call_status: "in-progress" }),
  };

  it("requires confirm: true", async () => {
    const { call, calls } = await setup([liveRoute]);
    expect((await call("end_call", { call_uuid: UUID, confirm: false })).data.error).toBe("confirmation_required");
    expect(calls).toHaveLength(0);
  });

  it("hangs up a live call with DELETE and reports 204", async () => {
    const { call, calls } = await setup([liveRoute, { method: "DELETE", path: acct(`/Call/${UUID}/`), respond: () => new Response(null, { status: 204 }) }]);
    const r = await call("end_call", { call_uuid: UUID, confirm: true });
    expect(r.data).toMatchObject({ terminated: true, previous_state: "live", http_status: 204 });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("does not DELETE a call that already ended", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: acct(`/Call/${UUID}/`), respond: () => json(404, { error: "call not found" }) },
      { method: "GET", path: acct(`/cdr/${UUID}`), respond: () => json(200, { success: true, data: { uuid: UUID } }) },
    ]);
    const r = await call("end_call", { call_uuid: UUID, confirm: true });
    expect(r.data.error).toBe("call_not_active");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("reports call_not_active when the call ends during the hangup", async () => {
    const { call } = await setup([liveRoute, { method: "DELETE", path: acct(`/Call/${UUID}/`), respond: () => json(404, { error: "call not found" }) }]);
    expect((await call("end_call", { call_uuid: UUID, confirm: true })).data.error).toBe("call_not_active");
  });
});

describe("list_live_calls and send_dtmf", () => {
  it("lists live and queued call IDs", async () => {
    const { call } = await setup([
      { method: "GET", path: acct("/Call/"), query: { status: "live" }, respond: () => json(200, { calls: [UUID] }) },
      { method: "GET", path: acct("/Call/"), query: { status: "queued" }, respond: () => json(200, { calls: [] }) },
    ]);
    const r = await call("list_live_calls", { include_queued: true });
    expect(r.data).toMatchObject({ live_calls: [UUID], live_count: 1, queued_calls: [], queued_count: 0 });
  });

  it("sends DTMF with digits and legs", async () => {
    const { call, calls } = await setup([
      { method: "POST", path: acct(`/Call/${UUID}/DTMF/`), respond: () => json(202, { message: "digits sent" }) },
    ]);
    const r = await call("send_dtmf", { call_uuid: UUID, digits: "1w2#" });
    expect(r.data.sent).toBe(true);
    expect(calls[0].body).toEqual({ digits: "1w2#", legs: "aleg" });
  });

  it("rejects invalid DTMF digits", async () => {
    const { call, calls } = await setup([]);
    expect((await call("send_dtmf", { call_uuid: UUID, digits: "12a" })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
