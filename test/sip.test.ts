import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VobizClient } from "../src/client.js";
import type { ToolContext } from "../src/context.js";
import { silentLogger } from "../src/logger.js";
import { createSharedState } from "../src/server.js";
import { registerSipTools } from "../src/tools/sip.js";
import { acct, json, mockFetch, testConfig, type Route } from "./helpers.js";

const PROV = { VOBIZ_ENABLE_PROVISIONING: "true" };
const EP = "193962768711692";
const CRED = "aabbccdd-1234-5678-90ab-cdef12345678";
const ACL = "11223344-1234-5678-90ab-cdef12345678";
const URI = "99887766-1234-5678-90ab-cdef12345678";
const SECRET = "Sup3r-Secret-Pass!";

async function setup(routes: Route[], env: Record<string, string | undefined> = {}) {
  const m = mockFetch(routes);
  const cfg = testConfig(env);
  const server = new McpServer({ name: "vobiz-test", version: "0" });
  const ctx: ToolContext = { cfg, log: silentLogger, client: new VobizClient(cfg, silentLogger, m.impl), ...createSharedState(cfg), readOnly: false };
  registerSipTools(server, ctx);
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

const WRITES: [string, Record<string, unknown>][] = [
  ["create_sip_endpoint", { username: "frontdesk01", password: SECRET, alias: "Front desk" }],
  ["update_sip_endpoint", { endpoint_id: EP, alias: "x" }],
  ["delete_sip_endpoint", { endpoint_id: EP }],
  ["create_trunk_credential", { username: "pbxuser01", password: SECRET }],
  ["update_trunk_credential", { credential_id: CRED, enabled: false }],
  ["delete_trunk_credential", { credential_id: CRED }],
  ["add_ip_acl_entry", { name: "Office", ip_address: "198.51.100.42" }],
  ["update_ip_acl_entry", { ip_acl_id: ACL, name: "Office", ip_address: "198.51.100.42" }],
  ["delete_ip_acl_entry", { ip_acl_id: ACL }],
  ["create_origination_uri", { name: "Primary", sip_uri: "sip:sbc.example.com", priority: 1 }],
  ["update_origination_uri", { uri_id: URI, name: "Primary", priority: 2 }],
  ["delete_origination_uri", { uri_id: URI }],
];

describe("SIP tool registration", () => {
  it("registers every tool with a title, description and correct annotations", async () => {
    const { client } = await setup([]);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(t.title).toBeTruthy();
      expect((t.description ?? "").length).toBeGreaterThan(40);
      expect(t.description).toContain("Vobiz");
      const isRead = t.name.startsWith("list_") || t.name.startsWith("get_");
      if (isRead) expect(t.annotations?.readOnlyHint).toBe(true);
      else expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    }
    for (const n of ["create_sip_endpoint", "create_trunk_credential"]) {
      const pw = (tools.find((t) => t.name === n)!.inputSchema.properties as Record<string, { description?: string }>).password;
      expect(pw.description).toMatch(/^SECRET/);
    }
  });
});

describe("SIP write gates", () => {
  it("refuses every write when provisioning is disabled, sending nothing", async () => {
    const { call, calls } = await setup([]);
    for (const [t, a] of WRITES) expect((await call(t, { ...a, confirm: true })).data.error, t).toBe("provisioning_disabled");
    expect(calls).toHaveLength(0);
  });

  it("refuses every write without confirm: true, sending nothing", async () => {
    const { call, calls } = await setup([], PROV);
    for (const [t, a] of WRITES) {
      expect((await call(t, { ...a, confirm: false })).data.error, t).toBe("confirmation_required");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("SIP endpoints", () => {
  const epObj = { alias: "Front desk", endpoint_id: EP, username: "frontdesk01", password: SECRET, sip_uri: "sip:frontdesk01@registrar.vobiz.ai", sip_registered: "false" };

  it("list passes filters and paging, redacts passwords and handles null objects", async () => {
    const { call, calls } = await setup([
      { method: "GET", path: acct("/Endpoint/"), respond: () => json(200, { api_id: "a", meta: { limit: 5, offset: 0, total_count: 7 }, objects: [epObj] }) },
    ]);
    const r = await call("list_sip_endpoints", { username_contains: "front", application_id: "20577609616603585", without_application: false, sub_account: "SA_ABCD1234", limit: 5 });
    expect(r.isError).toBe(false);
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({
      limit: "5",
      offset: "0",
      username__contains: "front",
      application_id__exact: "20577609616603585",
      application_id__isnull: "false",
      sub_account: "SA_ABCD1234",
    });
    expect(r.data.endpoints[0].password).toBe("[redacted]");
    expect(r.text).not.toContain(SECRET);
    expect(r.data.pagination).toMatchObject({ total: 7, has_more: true, next_offset: 5 });

    const empty = await setup([{ method: "GET", path: acct("/Endpoint/"), respond: () => json(200, { meta: { total_count: 0 }, objects: null }) }]);
    expect((await empty.call("list_sip_endpoints")).data.count).toBe(0);
  });

  it("get uses the endpoint path and redacts", async () => {
    const { call, calls } = await setup([{ method: "GET", path: acct(`/Endpoint/${EP}/`), respond: () => json(200, epObj) }]);
    const r = await call("get_sip_endpoint", { endpoint_id: EP });
    expect(calls[0].method).toBe("GET");
    expect(r.data.endpoint.username).toBe("frontdesk01");
    expect(r.text).not.toContain(SECRET);
    expect((await call("get_sip_endpoint", { endpoint_id: "../Call" })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("create sends the documented body and never echoes the password", async () => {
    const { call, calls } = await setup([{ method: "POST", path: acct("/Endpoint/"), respond: () => json(201, epObj) }], PROV);
    const r = await call("create_sip_endpoint", { username: "frontdesk01", password: SECRET, alias: "Front desk", application_id: "12345678", confirm: true });
    expect(r.isError).toBe(false);
    expect(calls[0].body).toEqual({ username: "frontdesk01", password: SECRET, alias: "Front desk", application: 12345678 });
    expect(r.data.endpoint_id).toBe(EP);
    expect(r.data.sip_uri).toBe("sip:frontdesk01@registrar.vobiz.ai");
    expect(r.text).not.toContain(SECRET);
    // Application IDs beyond 2^53 keep every digit (sent as a string).
    await call("create_sip_endpoint", { username: "frontdesk02", password: SECRET, alias: "B", application_id: "20577609616603585", confirm: true });
    expect((calls[1].body as Record<string, unknown>).application).toBe("20577609616603585");
    expect((await call("create_sip_endpoint", { username: "x", password: SECRET, alias: "a", confirm: true })).isError).toBe(true);
    expect((await call("create_sip_endpoint", { username: "abc123", password: "short", alias: "a", confirm: true })).isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("update is a POST with only the given fields; delete is a DELETE", async () => {
    const { call, calls } = await setup(
      [
        { method: "POST", path: acct(`/Endpoint/${EP}/`), respond: () => new Response(null, { status: 202 }) },
        { method: "DELETE", path: acct(`/Endpoint/${EP}/`), respond: () => new Response(null, { status: 204 }) },
      ],
      PROV,
    );
    expect((await call("update_sip_endpoint", { endpoint_id: EP, confirm: true })).data.error).toBe("invalid_input");
    const u = await call("update_sip_endpoint", { endpoint_id: EP, password: SECRET, allow_video: true, confirm: true });
    expect(u.data.updated).toBe(true);
    expect(calls[0].body).toEqual({ password: SECRET, allow_video: true });
    expect(u.text).not.toContain(SECRET);
    expect((await call("delete_sip_endpoint", { endpoint_id: EP, confirm: true })).data.deleted).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
  });
});

describe("trunk credentials", () => {
  const cred = { id: CRED, account_id: "MA_TEST123", username: "pbxuser01", password: SECRET, realm: "MA_TEST123.sip.vobiz.ai", enabled: true };

  it("list uses /trunks/credentials with paging and redacts", async () => {
    const { call, calls } = await setup([{ method: "GET", path: acct("/trunks/credentials"), respond: () => json(200, { meta: { limit: 20, offset: 0, total: 1 }, objects: [cred] }) }]);
    const r = await call("list_trunk_credentials", { offset: 0 });
    expect(calls[0].url.searchParams.get("limit")).toBe("20");
    expect(r.data.credentials[0]).toMatchObject({ username: "pbxuser01", realm: "MA_TEST123.sip.vobiz.ai", password: "[redacted]" });
    expect(r.text).not.toContain(SECRET);
    expect(r.data.pagination.has_more).toBe(false);
  });

  it("create, update and delete hit the documented paths and redact responses", async () => {
    const { call, calls } = await setup(
      [
        { method: "POST", path: acct("/credentials"), respond: () => json(201, cred) },
        { method: "PUT", path: acct(`/credentials/${CRED}`), respond: () => json(200, cred) },
        { method: "DELETE", path: acct(`/credentials/${CRED}`), respond: () => new Response(null, { status: 204 }) },
      ],
      PROV,
    );
    const c = await call("create_trunk_credential", { username: "pbxuser01", password: SECRET, confirm: true });
    expect(calls[0].body).toEqual({ username: "pbxuser01", password: SECRET });
    expect(c.data.credential_id).toBe(CRED);
    expect(c.data.credential.password).toBe("[redacted]");
    expect(c.text).not.toContain(SECRET);
    const u = await call("update_trunk_credential", { credential_id: CRED, password: SECRET, enabled: false, confirm: true });
    expect(calls[1].body).toEqual({ password: SECRET, enabled: false });
    expect(u.text).not.toContain(SECRET);
    expect((await call("update_trunk_credential", { credential_id: CRED, confirm: true })).data.error).toBe("invalid_input");
    expect((await call("delete_trunk_credential", { credential_id: CRED, confirm: true })).data.deleted).toBe(true);
    expect((await call("delete_trunk_credential", { credential_id: "not-a-uuid", confirm: true })).isError).toBe(true);
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      `POST ${acct("/credentials")}`,
      `PUT ${acct(`/credentials/${CRED}`)}`,
      `DELETE ${acct(`/credentials/${CRED}`)}`,
    ]);
  });
});

describe("IP ACL", () => {
  const entry = { id: ACL, account_id: "MA_TEST123", ip_address: "10.20.30.0/24", description: "Office", enabled: true };
  const routes: Route[] = [
    { method: "GET", path: acct("/trunks/ip-acl"), respond: () => json(200, { meta: { total: 1 }, objects: [entry] }) },
    { method: "POST", path: acct("/ip-acl"), respond: () => json(201, entry) },
    { method: "PUT", path: acct(`/ip-acl/${ACL}`), respond: () => json(200, entry) },
    { method: "DELETE", path: acct(`/ip-acl/${ACL}`), respond: () => new Response(null, { status: 204 }) },
  ];

  it("lists, adds, updates and deletes with the documented bodies", async () => {
    const { call, calls } = await setup(routes, PROV);
    expect((await call("list_ip_acl_entries")).data.ip_acl_entries).toHaveLength(1);
    const c = await call("add_ip_acl_entry", { name: "Office", ip_address: "10.20.30.0/24", confirm: true });
    expect(c.data.ip_acl_id).toBe(ACL);
    expect(calls[1].body).toEqual({ name: "Office", ip_address: "10.20.30.0/24" });
    await call("update_ip_acl_entry", { ip_acl_id: ACL, name: "PBX", ip_address: "198.51.100.42", confirm: true });
    expect(calls[2].body).toEqual({ name: "PBX", ip_address: "198.51.100.42" });
    expect((await call("delete_ip_acl_entry", { ip_acl_id: ACL, confirm: true })).data.deleted).toBe(true);
    expect(calls.map((x) => x.method)).toEqual(["GET", "POST", "PUT", "DELETE"]);
  });

  it("rejects invalid, IPv6, too-broad and non-unicast addresses before any request", async () => {
    const { call, calls } = await setup(routes, PROV);
    for (const ip of ["300.1.1.1", "10.0.0", "abc", "2001:db8::1", "10.20.30.5/24", "0.0.0.0/0", "8.0.0.0/4", "127.0.0.1", "224.0.0.1", "10.1.1.1/33", "010.1.1.1"]) {
      const r = await call("add_ip_acl_entry", { name: "x", ip_address: ip, confirm: true });
      expect(r.isError, ip).toBe(true);
      expect(["invalid_input", "not_allowed"]).toContain(r.data.error);
    }
    expect((await call("update_ip_acl_entry", { ip_acl_id: ACL, name: "x", ip_address: "fe80::1", confirm: true })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("origination URIs", () => {
  const o = { id: URI, account_id: "MA_TEST123", uri: "sip:sbc.example.com:5060", priority: 1, weight: 10, enabled: true, transport: "udp", description: "Primary" };
  const routes: Route[] = [
    { method: "GET", path: acct("/trunks/origination-uris"), respond: () => json(200, { meta: { total: 30 }, objects: [o] }) },
    { method: "POST", path: acct("/origination-uris"), respond: () => json(201, o) },
    { method: "PUT", path: acct(`/origination-uris/${URI}`), respond: () => json(200, { ...o, priority: 2 }) },
    { method: "DELETE", path: acct(`/origination-uris/${URI}`), respond: () => new Response(null, { status: 204 }) },
  ];

  it("lists, creates, updates and deletes with the documented bodies", async () => {
    const { call, calls } = await setup(routes, PROV);
    const l = await call("list_origination_uris", { limit: 10, offset: 10 });
    expect(l.data.pagination).toMatchObject({ total: 30, has_more: true, next_offset: 20 });
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ limit: "10", offset: "10" });
    for (const u of ["sip:sbc.example.com", "sip:sbc.example.com:5060", "sip:trunk@sip.carrier.net:5061", "sip:198.51.100.7:5060"]) {
      expect((await call("create_origination_uri", { name: "P", sip_uri: u, priority: 1, confirm: true })).isError, u).toBe(false);
    }
    expect(calls[1].body).toEqual({ name: "P", sip_uri: "sip:sbc.example.com", priority: 1 });
    const u = await call("update_origination_uri", { uri_id: URI, name: "Backup", priority: 2, confirm: true });
    expect(calls[5].body).toEqual({ name: "Backup", priority: 2 });
    expect(u.data.origination_uri.priority).toBe(2);
    expect((await call("delete_origination_uri", { uri_id: URI, confirm: true })).data.deleted).toBe(true);
  });

  it("rejects malformed, private and loopback URIs before any request", async () => {
    const { call, calls } = await setup(routes, PROV);
    for (const u of [
      "http://sip.example.com",
      "provider@sip.example.com:5060",
      "sip:",
      "sip:sbc.example.com:99999",
      "sip:sbc.example.com;transport=tcp",
      "sip:localhost",
      "sip:127.0.0.1:5060",
      "sip:192.168.1.100:5060",
      "sip:10.0.0.5",
      "sip:pbx.local",
      "sip:169.254.169.254",
      "sip:nodot",
    ]) {
      const r = await call("create_origination_uri", { name: "x", sip_uri: u, priority: 1, confirm: true });
      expect(r.isError, u).toBe(true);
      expect(["invalid_input", "not_allowed"]).toContain(r.data.error);
    }
    expect(calls).toHaveLength(0);
  });
});
