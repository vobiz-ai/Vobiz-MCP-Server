import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VobizClient } from "../src/client.js";
import type { ToolContext } from "../src/context.js";
import { silentLogger } from "../src/logger.js";
import { createSharedState } from "../src/server.js";
import { registerSubAccountTools } from "../src/tools/subaccounts.js";
import { AUTH_ID, json, mockFetch, testConfig, type Route } from "./helpers.js";

const SUB = "SA_ABC123";
const base = (suffix: string) => `/api/v1/accounts/${AUTH_ID}/sub-accounts${suffix}`;
const kyc = (suffix: string) => `/api/v1/sub-accounts/${SUB}${suffix}`;
const PROV = { VOBIZ_ENABLE_PROVISIONING: "true" };

const SECRET_TOKEN = "super-secret-sub-token-123";
const subRecord = (over: Record<string, unknown> = {}) => ({
  name: "Acme",
  email: "o@acme.example",
  id: "500001",
  parent_auth_id: AUTH_ID,
  auth_id: SUB,
  auth_token: SECRET_TOKEN,
  enabled: true,
  kyc_mode: "customer_use",
  kyc_calls_blocked: true,
  ...over,
});

async function setup(routes: Route[], env: Record<string, string | undefined> = {}) {
  const m = mockFetch(routes);
  const cfg = testConfig(env);
  const server = new McpServer({ name: "vobiz", version: "test" });
  const ctx: ToolContext = {
    cfg,
    log: silentLogger,
    client: new VobizClient(cfg, silentLogger, m.impl),
    ...createSharedState(cfg),
    readOnly: false,
  };
  registerSubAccountTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
      content: { type: string; text: string }[];
    };
    return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, any>, text: res.content?.[0]?.text ?? "" };
  };
  return { client, call, calls: m.calls };
}

const ALL = [
  "create_sub_account",
  "create_sub_account_kyc_session",
  "delete_sub_account",
  "get_sub_account",
  "get_sub_account_kyc_status",
  "list_sub_accounts",
  "update_sub_account",
];
const WRITES = {
  create_sub_account: { name: "Acme" },
  update_sub_account: { sub_auth_id: SUB, name: "New" },
  delete_sub_account: { sub_auth_id: SUB },
  create_sub_account_kyc_session: { sub_auth_id: SUB, customer_email: "o@acme.example" },
} as Record<string, Record<string, unknown>>;

describe("sub-account tool registration", () => {
  it("registers the tools with titles, descriptions and annotations", async () => {
    const { client } = await setup([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.description).toContain("Vobiz");
      if (t.name in WRITES) {
        expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
        expect(typeof t.annotations?.idempotentHint).toBe("boolean");
        expect(t.inputSchema.required).toContain("confirm");
      } else {
        expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
    expect(tools.find((t) => t.name === "delete_sub_account")!.description).toMatch(/permanently delete/i);
  });
});

describe("sub-account reads", () => {
  it("lists with page/size/active_only on the lowercase accounts path and redacts tokens", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: base("/"), respond: () => json(200, { sub_accounts: [subRecord()], total: 3, page: 2, size: 1 }) },
    ]);
    const r = await call("list_sub_accounts", { page: 2, size: 1, active_only: true });
    expect(r.isError).toBe(false);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe(`/api/v1/accounts/${AUTH_ID}/sub-accounts/`);
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ page: "2", size: "1", active_only: "true" });
    expect(r.data.sub_accounts[0].auth_token).toBe("[redacted]");
    expect(r.data.sub_accounts[0].auth_id).toBe(SUB);
    expect(r.data.pagination).toMatchObject({ page: 2, per_page: 1, total: 3, has_more: true, next_page: 3 });
    expect(r.text).not.toContain(SECRET_TOKEN);
  });

  it("treats a null list as empty and rejects other shapes", async () => {
    const empty = await setup([{ method: "GET", path: base("/"), respond: () => json(200, { sub_accounts: null, total: 0 }) }]);
    expect((await empty.call("list_sub_accounts")).data).toMatchObject({ ok: true, count: 0 });
    const bad = await setup([{ method: "GET", path: base("/"), respond: () => json(200, { sub_accounts: "x" }) }]);
    expect((await bad.call("list_sub_accounts")).data.error).toBe("unexpected_response");
  });

  it("gets one sub-account and redacts its token", async () => {
    const { call, calls } = await setup([{ method: "GET", path: base(`/${SUB}`), respond: () => json(200, subRecord()) }]);
    const r = await call("get_sub_account", { sub_auth_id: SUB });
    expect(calls[0].url.pathname).toBe(`/api/v1/accounts/${AUTH_ID}/sub-accounts/${SUB}`);
    expect(r.data.sub_account).toMatchObject({ auth_id: SUB, auth_token: "[redacted]" });
    expect(r.data.credentials_note).toMatch(/Vobiz console/);
    expect(r.text).not.toContain(SECRET_TOKEN);
  });

  it("reads KYC status", async () => {
    const status = { sub_account_id: SUB, overall_status: "pending", kyc_calls_blocked: true, verifications: { pan: "verified" } };
    const { call, calls } = await setup([{ method: "GET", path: kyc("/kyc/status"), respond: () => json(200, status) }]);
    const r = await call("get_sub_account_kyc_status", { sub_auth_id: SUB });
    expect(calls[0].url.pathname).toBe(`/api/v1/sub-accounts/${SUB}/kyc/status`);
    expect(r.data.kyc).toEqual(status);
  });

  it("rejects invalid sub_auth_id values without calling Vobiz", async () => {
    const { call, calls } = await setup([]);
    for (const bad of ["MA_ABC", "SA_../x", "SA_", "../../Account/MA_X", "SA_abc?x=1"]) {
      const r = await call("get_sub_account", { sub_auth_id: bad });
      expect(r.isError).toBe(true);
      const d = await call("delete_sub_account", { sub_auth_id: bad, confirm: true });
      expect(d.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("ignores an injected auth_id and always uses the configured main account", async () => {
    const { call, calls } = await setup([{ method: "GET", path: base("/"), respond: () => json(200, { sub_accounts: [], total: 0 }) }]);
    await call("list_sub_accounts", { auth_id: "MA_VICTIM" });
    expect(calls[0].url.toString()).not.toContain("VICTIM");
  });
});

describe("sub-account credential and safety gates", () => {
  it("refuses every tool for SA_ credentials before any network call", async () => {
    const { call, calls } = await setup([], { ...PROV, VOBIZ_AUTH_ID: "SA_SELF999" });
    const args: Record<string, Record<string, unknown>> = {
      list_sub_accounts: {},
      get_sub_account: { sub_auth_id: SUB },
      get_sub_account_kyc_status: { sub_auth_id: SUB },
      ...Object.fromEntries(Object.entries(WRITES).map(([k, v]) => [k, { ...v, confirm: true }])),
    };
    for (const name of ALL) {
      const r = await call(name, args[name]);
      expect(r.data.error, name).toBe("forbidden");
      expect(r.data.message).toMatch(/main-account \(MA_\)/);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses writes when provisioning is disabled, sending nothing", async () => {
    const { call, calls } = await setup([]);
    for (const [name, a] of Object.entries(WRITES)) {
      expect((await call(name, { ...a, confirm: true })).data.error, name).toBe("provisioning_disabled");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses writes without confirm: true, sending nothing", async () => {
    const { call, calls } = await setup([], PROV);
    for (const [name, a] of Object.entries(WRITES)) {
      expect((await call(name, { ...a, confirm: false })).data.error, name).toBe("confirmation_required");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("sub-account writes", () => {
  it("creates with the given body and never returns credentials", async () => {
    const { call, calls } = await setup(
      [
        {
          method: "POST",
          path: base("/"),
          respond: () =>
            json(201, {
              message: "Sub-account created successfully",
              sub_account: subRecord(),
              auth_credentials: { auth_id: SUB, auth_token: SECRET_TOKEN },
              tokens: { access_token: "eyJ.access.jwt", refresh_token: "eyJ.refresh.jwt", token_type: "bearer", expires_in: 1800 },
            }),
        },
      ],
      PROV,
    );
    const r = await call("create_sub_account", {
      name: "Acme",
      email: "o@acme.example",
      kyc_mode: "customer_use",
      business_type: "private_limited",
      rate_limit: 500,
      permissions: { calls: true, cdr: false },
      confirm: true,
    });
    expect(r.isError).toBe(false);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe(`/api/v1/accounts/${AUTH_ID}/sub-accounts/`);
    expect(calls[0].body).toEqual({
      name: "Acme",
      email: "o@acme.example",
      kyc_mode: "customer_use",
      business_type: "private_limited",
      rate_limit: 500,
      permissions: { calls: true, cdr: false },
    });
    expect(r.data).toMatchObject({ created: true, sub_auth_id: SUB, kyc_calls_blocked: true, http_status: 201 });
    expect(r.data.sub_account.auth_token).toBe("[redacted]");
    expect(r.data.credentials_note).toMatch(/Vobiz console/);
    for (const s of [SECRET_TOKEN, "eyJ.access.jwt", "eyJ.refresh.jwt"]) expect(r.text).not.toContain(s);
  });

  it("requires email for customer_use before calling Vobiz", async () => {
    const { call, calls } = await setup([], PROV);
    const r = await call("create_sub_account", { name: "Acme", kyc_mode: "customer_use", confirm: true });
    expect(r.data.error).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("updates with PUT and only the passed fields", async () => {
    const { call, calls } = await setup(
      [{ method: "PUT", path: base(`/${SUB}`), respond: () => json(200, subRecord({ enabled: false })) }],
      PROV,
    );
    const r = await call("update_sub_account", { sub_auth_id: SUB, enabled: false, kyc_mode: "personal_use", confirm: true });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url.pathname).toBe(`/api/v1/accounts/${AUTH_ID}/sub-accounts/${SUB}`);
    expect(calls[0].body).toEqual({ enabled: false, kyc_mode: "personal_use" });
    expect(r.data.sub_account.auth_token).toBe("[redacted]");
    expect(r.text).not.toContain(SECRET_TOKEN);
  });

  it("rejects an empty update without calling Vobiz", async () => {
    const { call, calls } = await setup([], PROV);
    expect((await call("update_sub_account", { sub_auth_id: SUB, confirm: true })).data.error).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("deletes with DELETE", async () => {
    const { call, calls } = await setup(
      [{ method: "DELETE", path: base(`/${SUB}`), respond: () => json(200, { message: "Sub-account deleted successfully" }) }],
      PROV,
    );
    const r = await call("delete_sub_account", { sub_auth_id: SUB, confirm: true });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.pathname).toBe(`/api/v1/accounts/${AUTH_ID}/sub-accounts/${SUB}`);
    expect(r.data).toMatchObject({ deleted: true, sub_auth_id: SUB, backend_message: "Sub-account deleted successfully" });
  });

  it("creates an email-flow KYC session with account_auth_id from the path", async () => {
    const { call, calls } = await setup(
      [
        {
          method: "POST",
          path: kyc("/kyc-sessions"),
          respond: () => json(201, { session_id: "s1", account_auth_id: SUB, status: "email_sent", widget_url: null }),
        },
      ],
      PROV,
    );
    const r = await call("create_sub_account_kyc_session", {
      sub_auth_id: SUB,
      customer_email: "o@acme.example",
      webhook_url: "https://hooks.example.com/kyc",
      expires_in_days: 30,
      confirm: true,
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe(`/api/v1/sub-accounts/${SUB}/kyc-sessions`);
    expect(calls[0].body).toEqual({
      account_auth_id: SUB,
      flow_type: "email",
      customer_email: "o@acme.example",
      webhook_url: "https://hooks.example.com/kyc",
      expires_in_days: 30,
    });
    expect(r.data).toMatchObject({ created: true, session: { status: "email_sent" } });
  });

  it("creates a redirect-flow KYC session and returns the widget_url", async () => {
    const { call, calls } = await setup(
      [
        {
          method: "POST",
          path: kyc("/kyc-sessions"),
          respond: () => json(201, { session_id: "s2", status: "link_ready", widget_url: "https://kyc.vobiz.ai/verify?token=kst_x" }),
        },
      ],
      PROV,
    );
    const r = await call("create_sub_account_kyc_session", {
      sub_auth_id: SUB,
      flow_type: "redirect",
      redirect_url: "https://app.example.com/kyc/done",
      confirm: true,
    });
    expect(calls[0].body).toEqual({ account_auth_id: SUB, flow_type: "redirect", redirect_url: "https://app.example.com/kyc/done" });
    expect(r.data.session.widget_url).toBe("https://kyc.vobiz.ai/verify?token=kst_x");
  });

  it("validates KYC session flow inputs and URLs before calling Vobiz", async () => {
    const { call, calls } = await setup([], PROV);
    const cases: Record<string, unknown>[] = [
      { sub_auth_id: SUB },
      { sub_auth_id: SUB, flow_type: "redirect" },
      { sub_auth_id: SUB, flow_type: "redirect", redirect_url: "http://app.example.com/done" },
      { sub_auth_id: SUB, flow_type: "redirect", redirect_url: "https://127.0.0.1/done" },
      { sub_auth_id: SUB, customer_email: "o@acme.example", webhook_url: "https://localhost/kyc" },
      { sub_auth_id: SUB, customer_email: "o@acme.example", redirect_url: "https://app.example.com/done" },
    ];
    for (const c of cases) {
      const r = await call("create_sub_account_kyc_session", { ...c, confirm: true });
      expect(r.data.error, JSON.stringify(c)).toBe("invalid_input");
    }
    expect(calls).toHaveLength(0);
  });
});
