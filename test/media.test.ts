import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VobizClient } from "../src/client.js";
import type { Config } from "../src/config.js";
import type { ToolContext } from "../src/context.js";
import { silentLogger } from "../src/logger.js";
import { createSharedState } from "../src/server.js";
import { registerMediaTools } from "../src/tools/media.js";
import { AUTH_ID, acct, json, mockFetch, testConfig, type Route } from "./helpers.js";

const CALL = "5a9fd4a0-3d4c-11ef-bef9-0242ac110005";
const STREAM = "728e273b-9c2c-4902-8509-2f88224cd3d5";
const NUM = "+919876543210";
const ENC = "%2B919876543210";
const lower = (suffix: string) => `/api/v1/account/${AUTH_ID}${suffix}`;
const PROV = { VOBIZ_ENABLE_PROVISIONING: "true" };

async function connectMedia(cfg: Config, fetchImpl: typeof fetch) {
  const server = new McpServer({ name: "vobiz", version: "0" });
  const ctx: ToolContext = { cfg, log: silentLogger, client: new VobizClient(cfg, silentLogger, fetchImpl), ...createSharedState(cfg), readOnly: false };
  registerMediaTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
    return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, any> };
  };
  return { client, call };
}

async function setup(routes: Route[], env: Record<string, string | undefined> = {}) {
  const m = mockFetch(routes);
  const c = await connectMedia(testConfig(env), m.impl);
  return { ...c, calls: m.calls };
}

const rawPath = (u: URL) => u.pathname; // pathname keeps %2B encoded

describe("media tool metadata", () => {
  it("registers every tool with a title, description and correct hints", async () => {
    const { client } = await setup([]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "assign_number_to_subaccount",
        "cancel_number_release",
        "delete_recording",
        "get_audio_stream",
        "list_audio_streams",
        "list_transaction_types",
        "list_transactions",
        "release_phone_number",
        "start_audio_stream",
        "stop_audio_stream",
        "unassign_number_from_subaccount",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(t.title).toBeTruthy();
      expect((t.description ?? "").length).toBeGreaterThan(40);
      expect(t.description).toMatch(/Vobiz/);
      const ro = ["list_audio_streams", "get_audio_stream", "list_transactions", "list_transaction_types"].includes(t.name);
      expect(t.annotations?.readOnlyHint).toBe(ro);
      if (!ro) {
        expect(t.annotations?.destructiveHint).toBe(true);
        expect(t.annotations?.openWorldHint).toBe(true);
        expect(typeof t.annotations?.idempotentHint).toBe("boolean");
      }
    }
  });
});

describe("audio streams", () => {
  const startRoute: Route = { method: "POST", path: acct(`/Call/${CALL}/Stream/`), respond: () => json(202, { message: "audio streaming started", stream_id: STREAM }) };
  const base = { call_uuid: CALL, service_url: "wss://example.com/ws", confirm: true };

  it("starts a bidirectional stream with the string 'true' and inbound track", async () => {
    const { call, calls } = await setup([startRoute]);
    const r = await call("start_audio_stream", {
      ...base,
      bidirectional: true,
      content_type: "audio/x-l16;rate=16000",
      stream_timeout: 600,
      status_callback_url: "https://example.com/status",
      status_callback_method: "POST",
      extra_headers: "X-Session:abc123,X-Tenant:t1",
    });
    expect(r.isError).toBe(false);
    expect(r.data.stream_id).toBe(STREAM);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      service_url: "wss://example.com/ws",
      bidirectional: "true",
      audio_track: "inbound",
      content_type: "audio/x-l16;rate=16000",
      stream_timeout: 600,
      status_callback_url: "https://example.com/status",
      status_callback_method: "POST",
      extra_headers: "X-Session:abc123,X-Tenant:t1",
    });
  });

  it("sends only service_url for a default one-way stream", async () => {
    const { call, calls } = await setup([startRoute]);
    expect((await call("start_audio_stream", base)).isError).toBe(false);
    expect(calls[0].body).toEqual({ service_url: "wss://example.com/ws" });
  });

  it("refuses without confirm, non-wss URLs, unapproved and private hosts, and sends nothing", async () => {
    const { call, calls } = await setup([startRoute]);
    expect((await call("start_audio_stream", { ...base, confirm: false })).data.error).toBe("confirmation_required");
    expect((await call("start_audio_stream", { ...base, service_url: "https://example.com/ws" })).data.error).toBe("invalid_input");
    expect((await call("start_audio_stream", { ...base, service_url: "ws://example.com/ws" })).data.error).toBe("invalid_input");
    expect((await call("start_audio_stream", { ...base, service_url: "wss://user:pw@example.com/ws" })).data.error).toBe("invalid_input");
    expect((await call("start_audio_stream", { ...base, service_url: "wss://attacker.example/ws" })).data.error).toBe("not_allowed");
    expect((await call("start_audio_stream", { ...base, status_callback_url: "https://attacker.example/s" })).data.error).toBe("not_allowed");
    expect((await call("start_audio_stream", { ...base, status_callback_url: "http://example.com/s" })).data.error).toBe("invalid_input");
    expect((await call("start_audio_stream", { ...base, bidirectional: true, audio_track: "both" })).data.error).toBe("invalid_input");
    expect((await call("start_audio_stream", { ...base, extra_headers: "bad header\r\nx" })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("with VOBIZ_ALLOW_ANY_URL_HOST allows public hosts but never private ones", async () => {
    const { call, calls } = await setup([startRoute], { VOBIZ_ALLOW_ANY_URL_HOST: "true" });
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.5", "[::1]", "svc.internal"]) {
      expect((await call("start_audio_stream", { ...base, service_url: `wss://${h}/ws` })).data.error).toBe("not_allowed");
    }
    expect(calls).toHaveLength(0);
    expect((await call("start_audio_stream", { ...base, service_url: "wss://agent.public-host.example/ws" })).isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("maps 404 on a live-call action to call_not_active", async () => {
    const { call } = await setup([
      { method: "POST", path: acct(`/Call/${CALL}/Stream/`), respond: () => json(404, { error: "call not found" }) },
      { method: "DELETE", path: acct(`/Call/${CALL}/Stream/${STREAM}/`), respond: () => json(404, { error: "stream not found" }) },
    ]);
    expect((await call("start_audio_stream", base)).data.error).toBe("call_not_active");
    expect((await call("stop_audio_stream", { call_uuid: CALL, stream_id: STREAM })).data.error).toBe("call_not_active");
  });

  it("lists, gets and stops streams on the right paths", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: acct(`/Call/${CALL}/Stream/`), respond: () => json(200, { page: 1, per_page: 5, total: 7, objects: [{ stream_id: STREAM }] }) },
      { method: "GET", path: acct(`/Call/${CALL}/Stream/${STREAM}/`), respond: () => json(200, { stream_id: STREAM, status: "in-progress" }) },
      { method: "DELETE", path: acct(`/Call/${CALL}/Stream/${STREAM}/`), respond: () => new Response(null, { status: 204 }) },
    ]);
    const l = await call("list_audio_streams", { call_uuid: CALL, limit: 5, offset: 0 });
    expect(l.data.count).toBe(1);
    expect(l.data.pagination).toMatchObject({ total: 7, has_more: true, next_offset: 5 });
    expect(calls[0].url.searchParams.get("limit")).toBe("5");
    expect((await call("get_audio_stream", { call_uuid: CALL, stream_id: STREAM })).data.stream.status).toBe("in-progress");
    const s = await call("stop_audio_stream", { call_uuid: CALL, stream_id: STREAM });
    expect(s.data).toMatchObject({ ok: true, streaming: false, http_status: 204 });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "DELETE"]);
  });

  it("rejects path-injection in stream_id and call_uuid", async () => {
    const { call, calls } = await setup([]);
    expect((await call("get_audio_stream", { call_uuid: CALL, stream_id: "../../x" })).isError).toBe(true);
    expect((await call("stop_audio_stream", { call_uuid: "a/b/../c", stream_id: STREAM })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("billing", () => {
  it("passes filters and paging to /transactions and normalises pagination", async () => {
    const { call, calls } = await setup([
      {
        method: "GET",
        path: acct("/transactions"),
        respond: () => json(200, { transactions: [{ id: "t1" }, { id: "t2" }], summary: { total_debit: 1 }, total: 5, page: 2, per_page: 2, total_pages: 3 }),
      },
    ]);
    const r = await call("list_transactions", {
      from_date: "2026-08-25",
      to_date: "2026-08-28T00:00:00+05:30",
      type: "debit",
      status: "completed",
      currency: "inr",
      reference_type: "cdr",
      description: "Call to",
      page: 2,
      per_page: 2,
    });
    expect(r.isError).toBe(false);
    expect(r.data.summary).toEqual({ total_debit: 1 });
    expect(r.data.pagination).toMatchObject({ page: 2, per_page: 2, total: 5, has_more: true, next_page: 3 });
    const q = calls[0].url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      page: "2",
      per_page: "2",
      from_date: "2026-08-25",
      to_date: "2026-08-28T00:00:00+05:30",
      type: "debit",
      status: "completed",
      currency: "INR",
      reference_type: "cdr",
      description: "Call to",
    });
  });

  it("rejects bad dates and per_page above 1000 without calling Vobiz", async () => {
    const { call, calls } = await setup([]);
    expect((await call("list_transactions", { from_date: "2026-13-40" })).isError).toBe(true);
    expect((await call("list_transactions", { per_page: 1001 })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("lists reference types", async () => {
    const { call } = await setup([{ method: "GET", path: acct("/transactions/reference-types"), respond: () => json(200, { reference_types: ["cdr", "did_rental"] }) }]);
    expect((await call("list_transaction_types")).data).toMatchObject({ count: 2, reference_types: ["cdr", "did_rental"] });
  });
});

describe("delete_recording", () => {
  const route: Route = { method: "DELETE", path: acct("/Recording/rec_ABC123/"), respond: () => new Response(null, { status: 204 }) };

  it("is gated by provisioning and confirm, and sends nothing when refused", async () => {
    const off = await setup([route]);
    expect((await off.call("delete_recording", { recording_id: "rec_ABC123", confirm: true })).data.error).toBe("provisioning_disabled");
    const on = await setup([route], PROV);
    expect((await on.call("delete_recording", { recording_id: "rec_ABC123", confirm: false })).data.error).toBe("confirmation_required");
    expect([...off.calls, ...on.calls]).toHaveLength(0);
  });

  it("deletes on the recording path", async () => {
    const { call, calls } = await setup([route], PROV);
    expect((await call("delete_recording", { recording_id: "rec_ABC123", confirm: true })).data).toMatchObject({ ok: true, deleted: true });
    expect(calls[0].method).toBe("DELETE");
    expect(rawPath(calls[0].url)).toBe(acct("/Recording/rec_ABC123/"));
  });
});

describe("number lifecycle", () => {
  it("refuses every number write without provisioning or confirm and sends nothing", async () => {
    const off = await setup([]);
    const on = await setup([], PROV);
    const tools: [string, Record<string, unknown>][] = [
      ["release_phone_number", { phone_number: NUM }],
      ["cancel_number_release", { phone_number: NUM }],
      ["assign_number_to_subaccount", { phone_number: NUM, sub_account_id: "SA_ABCDEF12" }],
      ["unassign_number_from_subaccount", { phone_number: NUM }],
    ];
    for (const [name, args] of tools) {
      expect((await off.call(name, { ...args, confirm: true })).data.error).toBe("provisioning_disabled");
      expect((await on.call(name, { ...args, confirm: false })).data.error).toBe("confirmation_required");
    }
    expect([...off.calls, ...on.calls]).toHaveLength(0);
  });

  it("releases with the encoded e164 path and passes immediate only when asked", async () => {
    const { call, calls } = await setup(
      [
        {
          method: "DELETE",
          path: acct(`/numbers/${ENC}`),
          respond: () => json(200, { status: "pending_release", release_fee: 700, cooldown_ends_at: "2026-07-21T09:18:26Z", cancel_url: "x", message: "number release initiated" }),
        },
      ],
      PROV,
    );
    const r = await call("release_phone_number", { phone_number: NUM, confirm: true });
    expect(r.data).toMatchObject({ ok: true, status: "pending_release", release_fee: 700, cancellable: true });
    expect(calls[0].url.searchParams.has("immediate")).toBe(false);
    await call("release_phone_number", { phone_number: "919876543210", immediate: true, confirm: true });
    expect(rawPath(calls[1].url)).toBe(acct(`/numbers/${ENC}`));
    expect(calls[1].url.searchParams.get("immediate")).toBe("true");
  });

  it("cancels a release on the lowercase /account/ path built from the configured auth ID", async () => {
    const { call, calls } = await setup(
      [{ method: "POST", path: lower(`/numbers/${ENC}/cancel-release`), respond: () => json(200, { message: "restored", status: "active", currency: "INR", refund_amount: 700 }) }],
      PROV,
    );
    const r = await call("cancel_number_release", { phone_number: NUM, confirm: true });
    expect(r.data).toMatchObject({ ok: true, status: "active", refund_amount: 700 });
    expect(calls[0].method).toBe("POST");
    expect(rawPath(calls[0].url)).toBe(`/api/v1/account/${AUTH_ID}/numbers/${ENC}/cancel-release`);
    expect(calls[0].headers["X-Auth-ID"]).toBe(AUTH_ID);
  });

  it("uses only the configured auth ID in the lowercase path and ignores any account in input", async () => {
    const odd = "SA_SUBTEST99";
    const m = mockFetch([]);
    const c = await connectMedia(testConfig({ ...PROV, VOBIZ_AUTH_ID: odd }), m.impl);
    await c.call("cancel_number_release", { phone_number: NUM, confirm: true, account_id: "MA_OTHER" });
    expect(rawPath(m.calls[0].url)).toBe(`/api/v1/account/${encodeURIComponent(odd)}/numbers/${ENC}/cancel-release`);
    expect(m.calls[0].url.pathname).not.toContain("MA_OTHER");
  });

  it("assigns and unassigns a number to a sub-account", async () => {
    const path = lower(`/numbers/${ENC}/assign-subaccount`);
    const { call, calls } = await setup(
      [
        { method: "POST", path, respond: () => json(200, { message: "assigned" }) },
        { method: "DELETE", path, respond: () => new Response(null, { status: 204 }) },
      ],
      PROV,
    );
    expect((await call("assign_number_to_subaccount", { phone_number: NUM, sub_account_id: "SA_ABCDEF12", confirm: true })).data.assigned).toBe(true);
    expect(calls[0].body).toEqual({ sub_account_id: "SA_ABCDEF12" });
    expect((await call("unassign_number_from_subaccount", { phone_number: NUM, confirm: true })).data.unassigned).toBe(true);
    expect(calls.map((c) => `${c.method} ${rawPath(c.url)}`)).toEqual([`POST ${path}`, `DELETE ${path}`]);
    expect(calls[1].url.searchParams.has("force")).toBe(false);
  });

  it("rejects malformed sub-account IDs and reports the cool-off as not_allowed", async () => {
    const { call, calls } = await setup(
      [{ method: "DELETE", path: lower(`/numbers/${ENC}/assign-subaccount`), respond: () => json(409, { error: "did_cool_off_in_effect", cool_off_until: "2026-06-09T10:00:00Z" }) }],
      PROV,
    );
    expect((await call("assign_number_to_subaccount", { phone_number: NUM, sub_account_id: "MA_XYZ/../", confirm: true })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    const r = await call("unassign_number_from_subaccount", { phone_number: NUM, confirm: true });
    expect(r.data.error).toBe("not_allowed");
    expect(r.data.message).toMatch(/15 days/);
  });
});
