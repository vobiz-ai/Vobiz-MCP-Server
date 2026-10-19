/**
 * SIP infrastructure: endpoints (registered SIP clients) and the trunk building blocks
 * (credentials, IP ACL entries, origination URIs).
 * Every change is gated by VOBIZ_ENABLE_PROVISIONING=true plus confirm: true, checked before any network call.
 *
 * Contracts (openapi.yaml + docs pages):
 *  Endpoints     POST|GET /Endpoint/, GET|POST(update)|DELETE /Endpoint/{endpoint_id}/
 *                list filters: limit/offset, username__contains, alias__contains, application_id__exact,
 *                application_id__isnull, sub_account; meta.total_count. Update answers 202 with an empty body.
 *  Credentials   POST /credentials, GET /trunks/credentials, PUT|DELETE /credentials/{id}
 *  IP ACL        POST /ip-acl, GET /trunks/ip-acl, PUT|DELETE /ip-acl/{id}   (PUT is a replace of name + ip_address)
 *  Origination   POST /origination-uris, GET /trunks/origination-uris, PUT|DELETE /origination-uris/{id}
 *                (PUT is a replace of name + priority)
 *  Trunk lists are account-wide (no trunk filter), paged by limit/offset with meta.total.
 * Passwords are write-only on Vobiz; this module also redacts any secret field a response might carry.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { PAGINATION_NOTE, handler, isPrivateHost, listField, ok, redact } from "../util.js";

type Rec = Record<string, unknown>;

// ── Input schemas ───────────────────────────────────────────────

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const endpointId = z.string().trim().regex(/^\d{4,25}$/, "must be a Vobiz endpoint ID (digits)");
const credentialId = z.string().trim().regex(uuidRe, "must be a credential UUID");
const ipAclId = z.string().trim().regex(uuidRe, "must be an IP ACL entry UUID");
const uriId = z.string().trim().regex(uuidRe, "must be an origination URI UUID");
const appId = z.string().trim().regex(/^\d{5,25}$/, "must be a Vobiz application ID (digits)");
const subAccount = z.string().trim().regex(/^SA_[A-Za-z0-9]{4,40}$/, "must be a sub-account Auth ID (SA_...)");
const sipUsername = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,64}$/, "must be 3-64 letters, digits or _ (letters and digits only is safest)");
const secretPassword = (what: string) =>
  z
    .string()
    .min(8, "must be at least 8 characters")
    .max(128)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "must not contain control characters")
    .describe(`SECRET: the ${what} password (8+ characters; 12+ with mixed case, digits and symbols recommended). It is sent to Vobiz once and never shown again.`);
const label = z.string().trim().min(1).max(255);
const alias = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9 _'.-]{1,100}$/, "must be 1-100 letters, digits, spaces or - _ ' .");
const limit = z.number().int().min(1).max(100).optional().describe("Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).");
const offset = z.number().int().min(0).optional();
const priority = z.number().int().min(1).max(1000).describe("Routing priority: lower is tried first (1 = primary, 2+ = failover).");
const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly approved: ${what}.`);

// ── Guards and helpers ──────────────────────────────────────────

function requireProvisioning(ctx: ToolContext, confirmed: boolean | undefined, what: string): void {
  if (!ctx.cfg.enableProvisioning) {
    throw new VobizError("provisioning_disabled", "Account changes are disabled on this server. An administrator must set VOBIZ_ENABLE_PROVISIONING=true.");
  }
  if (confirmed !== true) {
    throw new VobizError("confirmation_required", `Ask the user to approve ${what}, then call again with confirm: true.`);
  }
}

/** Fields that must never reach the model, on top of util.redact's defaults (password, secret, token, ...). */
const SIP_SECRETS = ["auth_password", "sip_auth_password", "passwd", "ha1", "ha1b", "credential_secret"];
const SECRET_NOTE = "Passwords are never shown here. The user can view or reset them in the Vobiz console.";

const clean = <T>(v: T): T => redact(v, SIP_SECRETS);

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * IP ACL entries take a single IPv4 address or an IPv4 CIDR block (docs: trunks/ip-acl/create-ip-acl).
 * Refuses ranges that would open the trunk to the whole internet, and addresses that can never send SIP.
 */
export function assertAclAddress(input: string): string {
  const v = input.trim();
  const [addr, prefixStr, extra] = v.split("/");
  if (extra !== undefined) throw new VobizError("invalid_input", "ip_address must be an IPv4 address or CIDR block such as 198.51.100.42 or 10.20.30.0/24.");
  if (addr.includes(":")) {
    throw new VobizError("invalid_input", "IP ACL entries take an IPv4 address or IPv4 CIDR block, such as 198.51.100.42 or 10.20.30.0/24.");
  }
  const oct = parseIPv4(addr);
  if (!oct) throw new VobizError("invalid_input", "ip_address must be an IPv4 address or CIDR block such as 198.51.100.42 or 10.20.30.0/24.");
  let prefix = 32;
  if (prefixStr !== undefined) {
    if (!/^(\d|[12]\d|3[0-2])$/.test(prefixStr)) throw new VobizError("invalid_input", "The CIDR prefix must be a number from 0 to 32.");
    prefix = Number(prefixStr);
  }
  if (prefix < 8) {
    throw new VobizError("not_allowed", `A /${prefix} range would let most of the internet use this trunk. Allow-list the exact public IP or a narrow range of the user's PBX or SBC.`);
  }
  const ip = ((oct[0] << 24) | (oct[1] << 16) | (oct[2] << 8) | oct[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if ((ip & mask) >>> 0 !== ip) {
    const net = ip & mask;
    const netStr = [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
    throw new VobizError("invalid_input", `${v} has host bits set. Use the network address, e.g. ${netStr}/${prefix}.`);
  }
  if (oct[0] === 0 || oct[0] === 127 || oct[0] >= 224 || (oct[0] === 169 && oct[1] === 254)) {
    throw new VobizError("invalid_input", "ip_address must be a unicast address a SIP device can send from (not 0.x, loopback, link-local, multicast or broadcast).");
  }
  return v;
}

const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62}$/;

/**
 * Origination URIs must be `sip:host`, `sip:host:port`, `sip:user@host` or `sip:user@host:port`
 * (docs: trunks/origination-uri/create-origination-uri). The host must be public: Vobiz delivers
 * calls to it over the internet, and private or loopback targets are never reachable.
 */
export function assertOriginationUri(input: string): string {
  const v = input.trim();
  const m = /^sip:(?:([A-Za-z0-9_.+%-]{1,64})@)?([^:@;?/\s]+)(?::(\d{1,5}))?$/i.exec(v);
  if (!m || !v.startsWith("sip:")) {
    throw new VobizError("invalid_input", "sip_uri must look like sip:sbc.example.com, sip:sbc.example.com:5060 or sip:user@sip.example.com:5061.");
  }
  const host = m[2];
  const port = m[3];
  const v4 = parseIPv4(host);
  if (!v4 && !HOST_RE.test(host)) throw new VobizError("invalid_input", "sip_uri host must be a fully qualified domain name or an IPv4 address.");
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw new VobizError("invalid_input", "sip_uri port must be between 1 and 65535.");
  if (isPrivateHost(host) || (v4 && v4[0] >= 224)) {
    throw new VobizError("not_allowed", "sip_uri must point at a public host that Vobiz can reach over the internet (not a private, loopback, link-local or .local address).");
  }
  return v;
}

/** Application IDs are numeric in the Endpoint API; send as a number only when that is lossless. */
function appRef(id: string): number | string {
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : id;
}

function listResult(res: { status: number; data: Rec }, lim: number, off: number, key: string, what: string, totalKey: "total" | "total_count") {
  const items = listField(res.data, "objects");
  if (!items) throw new VobizError("unexpected_response", `Vobiz returned ${what} in an unexpected format.`, res.status);
  const total = (res.data?.meta as Rec | undefined)?.[totalKey];
  const t = typeof total === "number" ? total : null;
  const hasMore = t !== null ? off + items.length < t : items.length === lim;
  return ok({
    ok: true,
    count: items.length,
    [key]: clean(items),
    pagination: { limit: lim, offset: off, total: t, has_more: hasMore, next_offset: hasMore ? off + lim : null },
    note: SECRET_NOTE,
  });
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const write = (idempotent: boolean) => ({ readOnlyHint: false, destructiveHint: true, idempotentHint: idempotent, openWorldHint: true }) as const;

export function registerSipTools(server: McpServer, ctx: ToolContext): void {
  const path = (s: string) => ctx.client.accountPath(s);

  // ── SIP endpoints (registered soft-phones, desk phones, WebRTC clients) ──
  server.registerTool(
    "list_sip_endpoints",
    {
      title: "List SIP endpoints",
      description:
        "List the SIP endpoints on this Vobiz account: soft-phones, desk phones and WebRTC clients that register at registrar.vobiz.ai. " +
        "Shows each endpoint's username, alias, SIP URI, attached application and registration state. Filter by username, alias, application or sub-account. " +
        PAGINATION_NOTE + " Read-only. " + SECRET_NOTE,
      inputSchema: {
        username_contains: z.string().trim().regex(/^[A-Za-z0-9_]{1,64}$/).optional().describe("Filter: username contains this text."),
        alias_contains: z.string().trim().min(1).max(100).optional().describe("Filter: alias contains this text."),
        application_id: appId.optional().describe("Filter: endpoints attached to this application."),
        without_application: z.boolean().optional().describe("true = only endpoints with no application attached."),
        sub_account: subAccount.optional().describe("Filter: endpoints of this sub-account."),
        limit,
        offset,
      },
      annotations: readOnly,
    },
    handler(async (a) => {
      const lim = a.limit ?? ctx.cfg.defaultPageSize;
      const off = a.offset ?? 0;
      const res = await ctx.client.request<Rec>("GET", path("/Endpoint/"), {
        query: {
          limit: lim,
          offset: off,
          username__contains: a.username_contains,
          alias__contains: a.alias_contains,
          application_id__exact: a.application_id,
          application_id__isnull: a.without_application === undefined ? undefined : a.without_application,
          sub_account: a.sub_account,
        },
        route: "GET Endpoint/",
      });
      return listResult(res, lim, off, "endpoints", "endpoints", "total_count");
    }),
  );

  server.registerTool(
    "get_sip_endpoint",
    {
      title: "Get SIP endpoint",
      description:
        "Return one Vobiz SIP endpoint: username, alias, SIP URI, attached application and, when a device is registered, its registration details (contact, expiry, user agent). " +
        "Use it to check whether a soft-phone or WebRTC client is online. Read-only. " + SECRET_NOTE,
      inputSchema: { endpoint_id: endpointId },
      annotations: readOnly,
    },
    handler(async ({ endpoint_id }) => {
      const res = await ctx.client.request<Rec>("GET", path(`/Endpoint/${encodeURIComponent(endpoint_id)}/`), { route: "GET Endpoint/{id}/" });
      return ok({ ok: true, endpoint: clean(res.data ?? null), note: SECRET_NOTE });
    }),
  );

  server.registerTool(
    "create_sip_endpoint",
    {
      title: "Create SIP endpoint",
      description:
        "Create a Vobiz SIP endpoint so a soft-phone, desk phone or WebRTC client can register at registrar.vobiz.ai with its own username and password. " +
        "Attach an application to handle its calls (otherwise the account's default endpoint application applies, if set). The username cannot be changed later. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true. The password is write-only and never returned.",
      inputSchema: {
        username: sipUsername.describe("SIP username, unique on the account and permanent. Letters and digits are safest."),
        password: secretPassword("endpoint's SIP"),
        alias: alias.describe("Friendly name, e.g. Front desk phone."),
        application_id: appId.optional().describe("Application that handles this endpoint's calls (sent as `application`)."),
        confirm: confirm("creating this SIP endpoint"),
      },
      annotations: write(false),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "creating this SIP endpoint");
      const body: Rec = { username: a.username, password: a.password, alias: a.alias };
      if (a.application_id) body.application = appRef(a.application_id);
      const res = await ctx.client.request<Rec>("POST", path("/Endpoint/"), { body, route: "POST Endpoint/" });
      const ep = clean((res.data ?? {}) as Rec);
      return ok({
        ok: true,
        created: true,
        endpoint_id: ep.endpoint_id ?? null,
        endpoint: ep,
        sip_uri: `sip:${a.username}@registrar.vobiz.ai`,
        registrar: "registrar.vobiz.ai",
        note: "Register the device with this username and the password the user chose. Vobiz never returns the password; the user can reset it with update_sip_endpoint or in the Vobiz console.",
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "update_sip_endpoint",
    {
      title: "Update SIP endpoint",
      description:
        "Change a Vobiz SIP endpoint's alias, password, attached application or voice/message/video permissions. Only the fields you pass change; the username is permanent. " +
        "A new password signs out every registered device until it re-registers. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        endpoint_id: endpointId,
        alias: alias.optional(),
        password: secretPassword("endpoint's new SIP").optional(),
        application_id: appId.optional().describe("Application that should handle this endpoint's calls (sent as `application`)."),
        allow_voice: z.boolean().optional(),
        allow_message: z.boolean().optional(),
        allow_video: z.boolean().optional(),
        confirm: confirm("changing this SIP endpoint"),
      },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "changing this SIP endpoint");
      const body: Rec = {};
      if (a.alias !== undefined) body.alias = a.alias;
      if (a.password !== undefined) body.password = a.password;
      if (a.application_id !== undefined) body.application = appRef(a.application_id);
      for (const k of ["allow_voice", "allow_message", "allow_video"] as const) if (a[k] !== undefined) body[k] = a[k];
      if (!Object.keys(body).length) throw new VobizError("invalid_input", "Nothing to update.");
      const res = await ctx.client.request<Rec>("POST", path(`/Endpoint/${encodeURIComponent(a.endpoint_id)}/`), { body, route: "POST Endpoint/{id}/" });
      return ok({
        ok: true,
        updated: true,
        endpoint_id: a.endpoint_id,
        changed: Object.keys(body),
        ...(a.password !== undefined ? { note: "Password changed. Registered devices must re-register with the new password. It is never shown again." } : {}),
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "delete_sip_endpoint",
    {
      title: "Delete SIP endpoint",
      description:
        "Permanently delete a Vobiz SIP endpoint. Devices registered with it disconnect immediately and its SIP URI stops working. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { endpoint_id: endpointId, confirm: confirm("deleting this SIP endpoint") },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "deleting this SIP endpoint");
      const res = await ctx.client.request("DELETE", path(`/Endpoint/${encodeURIComponent(a.endpoint_id)}/`), { route: "DELETE Endpoint/{id}/" });
      return ok({ ok: true, deleted: true, endpoint_id: a.endpoint_id, http_status: res.status });
    }),
  );

  // ── Trunk credentials (SIP digest auth) ──────────────────────
  server.registerTool(
    "list_trunk_credentials",
    {
      title: "List trunk credentials",
      description:
        "List the SIP digest credentials on this Vobiz account that trunks use to authenticate a PBX, carrier or voice agent: username, realm and enabled state. " +
        "Use the credential id as credential_uuid on a trunk. " + PAGINATION_NOTE + " Read-only. " + SECRET_NOTE,
      inputSchema: { limit, offset },
      annotations: readOnly,
    },
    handler(async ({ limit: l, offset: o }) => {
      const lim = l ?? ctx.cfg.defaultPageSize;
      const off = o ?? 0;
      const res = await ctx.client.request<Rec>("GET", path("/trunks/credentials"), { query: { limit: lim, offset: off }, route: "GET trunks/credentials" });
      return listResult(res, lim, off, "credentials", "credentials", "total");
    }),
  );

  server.registerTool(
    "create_trunk_credential",
    {
      title: "Create trunk credential",
      description:
        "Create a SIP digest credential (username and password) on this Vobiz account for trunk authentication, for dynamic-IP PBXs, remote sites or voice agents. " +
        "Attach it to a trunk afterwards with update_sip_trunk (credential_uuid). The username is permanent. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true. The password is write-only and never returned.",
      inputSchema: {
        username: sipUsername.describe("SIP username, unique on the account and permanent. Letters and digits are safest."),
        password: secretPassword("trunk credential's SIP"),
        confirm: confirm("creating this trunk credential"),
      },
      annotations: write(false),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "creating this trunk credential");
      const res = await ctx.client.request<Rec>("POST", path("/credentials"), { body: { username: a.username, password: a.password }, route: "POST credentials" });
      const cred = clean((res.data ?? {}) as Rec);
      return ok({
        ok: true,
        created: true,
        credential_id: cred.id ?? null,
        credential: cred,
        note: "The SIP client authenticates with this username, the password the user chose, and the realm above. Vobiz never returns the password; the user can reset it with update_trunk_credential or in the Vobiz console.",
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "update_trunk_credential",
    {
      title: "Update trunk credential",
      description:
        "Rotate a trunk credential's password, enable or disable it, or change its description on Vobiz. The username is permanent; to rename, create a new credential and delete the old one. " +
        "A new password takes effect for the next SIP authentication. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        credential_id: credentialId,
        password: secretPassword("trunk credential's new SIP").optional(),
        enabled: z.boolean().optional().describe("false pauses authentication with this credential without deleting it."),
        description: z.string().trim().max(255).optional(),
        confirm: confirm("changing this trunk credential"),
      },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "changing this trunk credential");
      const body: Rec = {};
      if (a.password !== undefined) body.password = a.password;
      if (a.enabled !== undefined) body.enabled = a.enabled;
      if (a.description !== undefined) body.description = a.description;
      if (!Object.keys(body).length) throw new VobizError("invalid_input", "Nothing to update.");
      const res = await ctx.client.request<Rec>("PUT", path(`/credentials/${encodeURIComponent(a.credential_id)}`), { body, route: "PUT credentials/{id}" });
      return ok({ ok: true, updated: true, credential: clean(res.data ?? null), changed: Object.keys(body), note: SECRET_NOTE, http_status: res.status });
    }),
  );

  server.registerTool(
    "delete_trunk_credential",
    {
      title: "Delete trunk credential",
      description:
        "Delete a trunk credential from this Vobiz account. Any PBX or device authenticating with it is refused from then on; Vobiz may refuse while it is in use by active calls. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { credential_id: credentialId, confirm: confirm("deleting this trunk credential") },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "deleting this trunk credential");
      const res = await ctx.client.request("DELETE", path(`/credentials/${encodeURIComponent(a.credential_id)}`), { route: "DELETE credentials/{id}" });
      return ok({ ok: true, deleted: true, credential_id: a.credential_id, http_status: res.status });
    }),
  );

  // ── IP ACL (source-IP allowlist for trunks) ──────────────────
  server.registerTool(
    "list_ip_acl_entries",
    {
      title: "List trunk IP ACL entries",
      description:
        "List the IP access control entries on this Vobiz account: the IPv4 addresses and CIDR ranges allowed to send SIP traffic to trunks without digest credentials. " +
        "Use it to audit which PBXs, SBCs or carriers are trusted. " + PAGINATION_NOTE + " Read-only.",
      inputSchema: { limit, offset },
      annotations: readOnly,
    },
    handler(async ({ limit: l, offset: o }) => {
      const lim = l ?? ctx.cfg.defaultPageSize;
      const off = o ?? 0;
      const res = await ctx.client.request<Rec>("GET", path("/trunks/ip-acl"), { query: { limit: lim, offset: off }, route: "GET trunks/ip-acl" });
      return listResult(res, lim, off, "ip_acl_entries", "IP ACL entries", "total");
    }),
  );

  server.registerTool(
    "add_ip_acl_entry",
    {
      title: "Add trunk IP ACL entry",
      description:
        "Allow-list a public IPv4 address or CIDR range (e.g. 198.51.100.42 or 10.20.30.0/24) so a static-IP PBX, SBC or carrier can use Vobiz trunks without digest credentials. " +
        "Attach it to a trunk with update_sip_trunk (ipacl_uuid). Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        name: label.describe("Label, e.g. Office PBX. Returned as `description`."),
        ip_address: z.string().trim().max(18).describe("IPv4 address or IPv4 CIDR block."),
        confirm: confirm("allow-listing this IP address for SIP traffic"),
      },
      annotations: write(false),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "allow-listing this IP address");
      const ip = assertAclAddress(a.ip_address);
      const res = await ctx.client.request<Rec>("POST", path("/ip-acl"), { body: { name: a.name, ip_address: ip }, route: "POST ip-acl" });
      const entry = clean((res.data ?? {}) as Rec);
      return ok({ ok: true, created: true, ip_acl_id: entry.id ?? null, ip_acl_entry: entry, http_status: res.status });
    }),
  );

  server.registerTool(
    "update_ip_acl_entry",
    {
      title: "Update trunk IP ACL entry",
      description:
        "Replace a Vobiz IP ACL entry's label and address. Both name and ip_address are required on every update; resend the current value of the one you keep. " +
        "Traffic from the old address stops being trusted. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        ip_acl_id: ipAclId,
        name: label.describe("Label for the entry (resend the current one to keep it)."),
        ip_address: z.string().trim().max(18).describe("IPv4 address or IPv4 CIDR block (resend the current one to keep it)."),
        confirm: confirm("changing this IP ACL entry"),
      },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "changing this IP ACL entry");
      const ip = assertAclAddress(a.ip_address);
      const res = await ctx.client.request<Rec>("PUT", path(`/ip-acl/${encodeURIComponent(a.ip_acl_id)}`), { body: { name: a.name, ip_address: ip }, route: "PUT ip-acl/{id}" });
      return ok({ ok: true, updated: true, ip_acl_entry: clean(res.data ?? null), http_status: res.status });
    }),
  );

  server.registerTool(
    "delete_ip_acl_entry",
    {
      title: "Delete trunk IP ACL entry",
      description:
        "Remove an IP ACL entry from this Vobiz account. SIP traffic from that address or range is no longer trusted and needs other authentication. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { ip_acl_id: ipAclId, confirm: confirm("deleting this IP ACL entry") },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "deleting this IP ACL entry");
      const res = await ctx.client.request("DELETE", path(`/ip-acl/${encodeURIComponent(a.ip_acl_id)}`), { route: "DELETE ip-acl/{id}" });
      return ok({ ok: true, deleted: true, ip_acl_id: a.ip_acl_id, http_status: res.status });
    }),
  );

  // ── Origination URIs (outbound destinations with failover) ───
  server.registerTool(
    "list_origination_uris",
    {
      title: "List trunk origination URIs",
      description:
        "List the origination URIs on this Vobiz account: the SIP destinations trunks deliver outbound calls to, with priority (failover order), weight (load split), transport and enabled state. " +
        PAGINATION_NOTE + " Read-only.",
      inputSchema: { limit, offset },
      annotations: readOnly,
    },
    handler(async ({ limit: l, offset: o }) => {
      const lim = l ?? ctx.cfg.defaultPageSize;
      const off = o ?? 0;
      const res = await ctx.client.request<Rec>("GET", path("/trunks/origination-uris"), { query: { limit: lim, offset: off }, route: "GET trunks/origination-uris" });
      return listResult(res, lim, off, "origination_uris", "origination URIs", "total");
    }),
  );

  server.registerTool(
    "create_origination_uri",
    {
      title: "Create trunk origination URI",
      description:
        "Add a SIP destination (origination URI) such as sip:sbc.example.com:5060 that Vobiz trunks route outbound calls to. Use priority 1 for the primary and 2+ for failover; " +
        "attach it to a trunk with update_sip_trunk (primary_uri_uuid or fallback_uri_uuid). The host must be public. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        name: label.describe("Label, e.g. Primary SBC. Returned as `description`."),
        sip_uri: z.string().trim().max(255).describe("sip:host, sip:host:port, sip:user@host or sip:user@host:port. Returned as `uri`."),
        priority,
        confirm: confirm("adding this outbound SIP destination"),
      },
      annotations: write(false),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "adding this outbound SIP destination");
      const uri = assertOriginationUri(a.sip_uri);
      const res = await ctx.client.request<Rec>("POST", path("/origination-uris"), { body: { name: a.name, sip_uri: uri, priority: a.priority }, route: "POST origination-uris" });
      const o = clean((res.data ?? {}) as Rec);
      return ok({ ok: true, created: true, uri_id: o.id ?? null, origination_uri: o, http_status: res.status });
    }),
  );

  server.registerTool(
    "update_origination_uri",
    {
      title: "Update trunk origination URI",
      description:
        "Replace a Vobiz origination URI's label and priority, for example to promote a failover destination to primary. Both name and priority are required; resend the current value you keep. " +
        "To point at a different host, create a new origination URI and delete this one; weight and enabled are managed in the Vobiz console. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        uri_id: uriId,
        name: label.describe("Label (resend the current one to keep it)."),
        priority,
        confirm: confirm("changing this origination URI"),
      },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "changing this origination URI");
      const res = await ctx.client.request<Rec>("PUT", path(`/origination-uris/${encodeURIComponent(a.uri_id)}`), { body: { name: a.name, priority: a.priority }, route: "PUT origination-uris/{id}" });
      return ok({ ok: true, updated: true, origination_uri: clean(res.data ?? null), http_status: res.status });
    }),
  );

  server.registerTool(
    "delete_origination_uri",
    {
      title: "Delete trunk origination URI",
      description:
        "Delete an origination URI from this Vobiz account. Trunks stop routing outbound calls to that destination; add a replacement first if it is a trunk's only route. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { uri_id: uriId, confirm: confirm("deleting this origination URI") },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "deleting this origination URI");
      const res = await ctx.client.request("DELETE", path(`/origination-uris/${encodeURIComponent(a.uri_id)}`), { route: "DELETE origination-uris/{id}" });
      return ok({ ok: true, deleted: true, uri_id: a.uri_id, http_status: res.status });
    }),
  );
}
