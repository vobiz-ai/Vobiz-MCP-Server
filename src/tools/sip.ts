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
import { handler, isPrivateHost, listField, ok, redact } from "../util.js";

type Rec = Record<string, unknown>;

// ── Input schemas ───────────────────────────────────────────────

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const endpointId = z
  .string()
  .trim()
  .regex(/^\d{4,25}$/, "must be a Vobiz endpoint ID (digits)")
  .describe("Numeric SIP endpoint ID (4-25 digits): endpoint_id from list_sip_endpoints or create_sip_endpoint. Unknown ids raise not_found.");
const credentialId = z
  .string()
  .trim()
  .regex(uuidRe, "must be a credential UUID")
  .describe("Trunk credential UUID: the id from list_trunk_credentials or create_trunk_credential. Unknown ids raise not_found.");
const ipAclId = z
  .string()
  .trim()
  .regex(uuidRe, "must be an IP ACL entry UUID")
  .describe("IP ACL entry UUID: the id from list_ip_acl_entries or add_ip_acl_entry. Unknown ids raise not_found.");
const uriId = z
  .string()
  .trim()
  .regex(uuidRe, "must be an origination URI UUID")
  .describe("Origination URI UUID: the id from list_origination_uris or create_origination_uri. Unknown ids raise not_found.");
const OFFSET_NOTE = "Pagination is stateless: pass limit and offset on every call (nothing is saved between calls) and follow pagination.next_offset.";
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
const limit = z.number().int().min(1).max(100).optional().describe("Records per page, 1-100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).");
const offset = z.number().int().min(0).optional().describe("Number of records to skip (default 0); pass pagination.next_offset from the previous page.");
const priority = z.number().int().min(1).max(1000).describe("Routing priority, 1-1000: lower is tried first (1 = primary, 2+ = failover). URIs sharing a priority split traffic by weight.");
const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly approved: ${what}.`);

// ── Output schemas (every field optional so a backend change never fails validation) ──
const str = () => z.string().nullable().optional();
const bool = () => z.boolean().nullable().optional();
const num = () => z.number().nullable().optional();
const id = () => z.union([z.string(), z.number()]).nullable().optional();
const httpStatus = z.number().optional().describe("HTTP status Vobiz answered with.");
const noteField = z.string().optional().describe("Reminder that passwords are never returned here.");
const offsetPagination = z
  .object({
    limit: z.number().optional().describe("Page size applied."),
    offset: z.number().optional().describe("Offset applied."),
    total: z.number().nullable().optional().describe("Total matching records, or null when Vobiz did not report one."),
    has_more: z.boolean().optional().describe("True when another page exists."),
    next_offset: z.number().nullable().optional().describe("offset to pass for the next page, or null on the last page."),
  })
  .passthrough()
  .describe("Stateless paging: pass next_offset as offset to continue.");

const endpointShape = z
  .object({
    endpoint_id: id().describe("Numeric endpoint ID."),
    username: str().describe("SIP username the device registers with."),
    alias: str().describe("Friendly name."),
    sip_uri: str().describe("SIP URI of the endpoint (sip:username@registrar.vobiz.ai)."),
    sip_registered: z.union([z.string(), z.boolean()]).nullable().optional().describe("\"true\" while a device is registered, otherwise \"false\"."),
    sip_registration: z.record(z.string(), z.unknown()).nullable().optional().describe("Present only while registered: contact, expires, user_agent, received."),
    application: z.unknown().optional().describe("Attached application: an app_id string in lists, an object with app_id, app_name and answer_url in get_sip_endpoint, or null."),
    allow_voice: bool().describe("Voice calls permitted."),
    allow_message: bool().describe("Messaging permitted."),
    allow_video: bool().describe("Video calls permitted."),
    sub_account: str().describe("Owning sub-account Auth ID, or null."),
    resource_uri: str().describe("API path of the endpoint."),
    created_at: str().describe("Creation timestamp."),
    updated_at: str().describe("Last-change timestamp."),
  })
  .passthrough()
  .describe("Endpoint object as Vobiz returned it; any password field is replaced with [redacted].");

const credentialShape = z
  .object({
    id: str().describe("Credential UUID; use it as credential_uuid on a trunk or credential_id here."),
    username: str().describe("SIP username (permanent)."),
    password: str().describe("Always [redacted]; the real password is never returned."),
    realm: str().describe("SIP digest realm the client must present, {account_id}.sip.vobiz.ai."),
    enabled: bool().describe("False while authentication with this credential is paused."),
    description: str().describe("Free-text note, if any."),
    account_id: str().describe("Owning account Auth ID."),
    created_at: str().describe("Creation timestamp."),
    updated_at: str().describe("Last-change timestamp."),
  })
  .passthrough();

const ipAclShape = z
  .object({
    id: str().describe("IP ACL entry UUID; use it as ipacl_uuid on a trunk or ip_acl_id here."),
    ip_address: str().describe("Allow-listed IPv4 address or CIDR block."),
    description: str().describe("Label given as name when the entry was created."),
    enabled: bool().describe("False while the entry is switched off."),
    account_id: str().describe("Owning account Auth ID."),
    created_at: str().describe("Creation timestamp."),
    updated_at: str().describe("Last-change timestamp."),
  })
  .passthrough();

const originationUriShape = z
  .object({
    id: str().describe("Origination URI UUID; use it as primary_uri_uuid or fallback_uri_uuid on a trunk or uri_id here."),
    uri: str().describe("SIP destination, e.g. sip:sbc.example.com:5060."),
    priority: num().describe("Failover order: lower is tried first."),
    weight: num().describe("Load-balancing weight among URIs of the same priority (higher gets more traffic)."),
    enabled: bool().describe("False while the destination is switched off."),
    transport: str().describe("SIP transport used to reach it: udp, tcp or tls."),
    description: str().describe("Label given as name when the URI was created."),
    account_id: str().describe("Owning account Auth ID."),
    created_at: str().describe("Creation timestamp."),
    updated_at: str().describe("Last-change timestamp."),
  })
  .passthrough();

const listOutput = <T extends z.ZodTypeAny>(key: string, item: T, what: string) => ({
  ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
  count: z.number().optional().describe(`${what} in this page.`),
  [key]: z.array(item).optional().describe(`${what}; empty when the account has none.`),
  pagination: offsetPagination.optional(),
  note: noteField,
});

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
        "Shows each endpoint's endpoint_id, username, alias, SIP URI, attached application and whether a device is registered. Filter by username, alias, application or sub-account; " +
        "for one endpoint's live registration details (contact, expiry, user agent) use get_sip_endpoint. " + OFFSET_NOTE + " " + SECRET_NOTE,
      inputSchema: {
        username_contains: z.string().trim().regex(/^[A-Za-z0-9_]{1,64}$/).optional().describe("Only endpoints whose username contains this text (letters, digits, _)."),
        alias_contains: z.string().trim().min(1).max(100).optional().describe("Only endpoints whose alias contains this text."),
        application_id: appId.optional().describe("Only endpoints attached to this application (app_id from list_applications)."),
        without_application: z.boolean().optional().describe("true = only endpoints with no application attached; false = only endpoints that have one. Omit for both."),
        sub_account: subAccount.optional().describe("Only endpoints owned by this sub-account (Auth ID SA_...)."),
        limit,
        offset,
      },
      outputSchema: listOutput("endpoints", endpointShape, "Endpoints"),
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
        "Return one Vobiz SIP endpoint by endpoint_id: username, alias, SIP URI, voice/message/video permissions, the attached application (app_id, name, answer_url) and, " +
        "while a device is registered, a sip_registration block with contact, expiry and user agent. Use it to check whether a soft-phone or WebRTC client is online; " +
        "to find the id or browse many endpoints use list_sip_endpoints. An unknown endpoint_id raises not_found. " + SECRET_NOTE,
      inputSchema: { endpoint_id: endpointId },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        endpoint: endpointShape.nullable().optional().describe("The endpoint as Vobiz returned it."),
        note: noteField,
      },
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
        "Attach an application to handle its calls (otherwise the account's default endpoint application applies, if set). The username cannot be changed later; use update_sip_endpoint for everything else. " +
        "Returns the endpoint_id and the SIP URI to configure on the device. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true. The password is write-only and never returned; " +
        "every call creates another endpoint, so a retry after a timeout should first check list_sip_endpoints.",
      inputSchema: {
        username: sipUsername.describe("SIP username, 3-64 letters, digits or _, unique on the account and permanent. Letters and digits are safest."),
        password: secretPassword("endpoint's SIP"),
        alias: alias.describe("Friendly name shown for the endpoint, 1-100 characters, e.g. Front desk phone."),
        application_id: appId.optional().describe("Application (app_id from list_applications) that handles calls to and from this endpoint; sent to Vobiz as `application`. An unknown id is rejected."),
        confirm: confirm("creating this SIP endpoint"),
      },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        created: z.literal(true).optional().describe("True when the record was created by this call."),
        endpoint_id: id().describe("ID of the new endpoint, or null if Vobiz did not return one."),
        endpoint: endpointShape.optional().describe("The endpoint as Vobiz returned it (username, alias, endpoint_id)."),
        sip_uri: z.string().optional().describe("SIP URI the device registers as: sip:username@registrar.vobiz.ai."),
        registrar: z.string().optional().describe("Registrar host to configure on the device."),
        note: z.string().optional().describe("How to register the device and that the password is never shown again."),
        http_status: httpStatus,
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
        "Change a Vobiz SIP endpoint's alias, password, attached application or voice/message/video permissions. Only the fields you pass change; the username is permanent (create a new endpoint to rename). " +
        "A new password signs out every registered device until it re-registers with it. Vobiz answers 202 with no body, so the result lists the fields sent rather than the new state; read it back with get_sip_endpoint. " +
        "An unknown endpoint_id raises not_found. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        endpoint_id: endpointId,
        alias: alias.optional().describe("New friendly name, 1-100 characters."),
        password: secretPassword("endpoint's new SIP").optional(),
        application_id: appId.optional().describe("Application (app_id from list_applications) that should handle this endpoint's calls from now on; sent to Vobiz as `application`. An unknown id is rejected."),
        allow_voice: z.boolean().optional().describe("Permit voice calls on this endpoint (Vobiz default true)."),
        allow_message: z.boolean().optional().describe("Permit messaging on this endpoint (Vobiz default true)."),
        allow_video: z.boolean().optional().describe("Permit video calls on this endpoint (Vobiz default false)."),
        confirm: confirm("changing this SIP endpoint"),
      },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        updated: z.literal(true).optional().describe("True when the change was applied by this call."),
        endpoint_id: z.string().optional().describe("The endpoint that was changed."),
        changed: z.array(z.string()).optional().describe("Names of the fields sent to Vobiz (application_id appears as application)."),
        note: z.string().optional().describe("Present after a password change: devices must re-register."),
        http_status: httpStatus,
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
        "Permanently delete a Vobiz SIP endpoint; this cannot be undone. Devices registered with it disconnect immediately and its SIP URI stops working; the username becomes free for a new endpoint. " +
        "To block a device temporarily, change its password with update_sip_endpoint instead. An unknown endpoint_id raises not_found. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { endpoint_id: endpointId, confirm: confirm("deleting this SIP endpoint") },
      outputSchema: { ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."), deleted: z.literal(true).optional(), endpoint_id: z.string().optional().describe("The endpoint that was deleted."), http_status: httpStatus },
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
        "List the SIP digest credentials on this Vobiz account that trunks use to authenticate a PBX, carrier or voice agent: id, username, realm and enabled state. " +
        "Credentials are account-wide, not per trunk; which trunk uses one is visible as credential_uuid in list_sip_trunks. Use an id as credential_uuid on update_sip_trunk, " +
        "or as credential_id for update_trunk_credential and delete_trunk_credential. " + OFFSET_NOTE + " " + SECRET_NOTE,
      inputSchema: { limit, offset },
      outputSchema: listOutput("credentials", credentialShape, "Credentials"),
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
        "Attach it to a trunk afterwards with update_sip_trunk (credential_uuid); for static-IP peers use add_ip_acl_entry instead. The username is permanent; rotate the password with update_trunk_credential. " +
        "Returns the credential id and the realm the SIP client must present. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true. The password is write-only and never returned; " +
        "every call creates another credential, so a retry after a timeout should first check list_trunk_credentials.",
      inputSchema: {
        username: sipUsername.describe("SIP username, 3-64 letters, digits or _, unique on the account and permanent. Letters and digits are safest."),
        password: secretPassword("trunk credential's SIP"),
        confirm: confirm("creating this trunk credential"),
      },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        created: z.literal(true).optional().describe("True when the record was created by this call."),
        credential_id: id().describe("UUID of the new credential: use it as credential_uuid on a trunk. Null if Vobiz did not return one."),
        credential: credentialShape.optional().describe("The credential as Vobiz returned it, password redacted; realm is what the SIP client presents."),
        note: z.string().optional().describe("How the client authenticates and that the password is never shown again."),
        http_status: httpStatus,
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
        "A new password takes effect for the next SIP authentication; only the fields you pass change. Prefer enabled: false over delete_trunk_credential when access may be needed again. " +
        "Returns the updated credential with the password redacted. An unknown credential_id raises not_found. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        credential_id: credentialId,
        password: secretPassword("trunk credential's new SIP").optional(),
        enabled: z.boolean().optional().describe("false pauses authentication with this credential without deleting it; true re-enables it."),
        description: z.string().trim().max(255).optional().describe("Free-text note of up to 255 characters, e.g. why or when the password was rotated."),
        confirm: confirm("changing this trunk credential"),
      },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        updated: z.literal(true).optional().describe("True when the change was applied by this call."),
        credential: credentialShape.nullable().optional().describe("The credential after the change, password redacted."),
        changed: z.array(z.string()).optional().describe("Names of the fields sent to Vobiz."),
        note: noteField,
        http_status: httpStatus,
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
        "Delete a trunk credential from this Vobiz account; this cannot be undone. Any PBX or device authenticating with it is refused from then on, and trunks that referenced it lose that credential; " +
        "Vobiz may refuse while it is in use by active calls. To pause access and keep the credential, use update_trunk_credential with enabled: false. An unknown credential_id raises not_found. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { credential_id: credentialId, confirm: confirm("deleting this trunk credential") },
      outputSchema: { ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."), deleted: z.literal(true).optional(), credential_id: z.string().optional().describe("The credential that was deleted."), http_status: httpStatus },
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
        "List the IP access control entries on this Vobiz account: the IPv4 addresses and CIDR ranges allowed to send SIP traffic to trunks without digest credentials, with id, label and enabled state. " +
        "Entries are account-wide and IP authentication is checked before digest authentication on every trunk. Use it to audit which PBXs, SBCs or carriers are trusted; " +
        "add with add_ip_acl_entry, change with update_ip_acl_entry, remove with delete_ip_acl_entry. " + OFFSET_NOTE,
      inputSchema: { limit, offset },
      outputSchema: listOutput("ip_acl_entries", ipAclShape, "IP ACL entries"),
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
        "Attach it to a trunk with update_sip_trunk (ipacl_uuid); for peers on dynamic IPs use create_trunk_credential instead. The server rejects ranges wider than /8, host bits set in a CIDR, " +
        "and non-unicast or loopback addresses; IPv6 is not accepted. Returns the entry's id. Remove it later with delete_ip_acl_entry. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        name: label.describe("Label of 1-255 characters, e.g. Office PBX. Returned by Vobiz as `description`."),
        ip_address: z.string().trim().max(18).describe("Public IPv4 address (198.51.100.42) or IPv4 CIDR network (10.20.30.0/24, prefix 8-32, no host bits). Use the peer's public address, not a NAT-internal one."),
        confirm: confirm("allow-listing this IP address for SIP traffic"),
      },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        created: z.literal(true).optional().describe("True when the record was created by this call."),
        ip_acl_id: id().describe("UUID of the new entry: use it as ipacl_uuid on a trunk. Null if Vobiz did not return one."),
        ip_acl_entry: ipAclShape.optional().describe("The entry as Vobiz returned it."),
        http_status: httpStatus,
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
        "Traffic from the old address stops being trusted (changes can take a little time to reach the SIP edge); the entry keeps its id, so trunks referencing it need no change. " +
        "Read the current values with list_ip_acl_entries first. The same address rules as add_ip_acl_entry apply. An unknown ip_acl_id raises not_found. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        ip_acl_id: ipAclId,
        name: label.describe("Label of 1-255 characters (resend the current one to keep it). Returned by Vobiz as `description`."),
        ip_address: z.string().trim().max(18).describe("Public IPv4 address or IPv4 CIDR network, prefix 8-32 (resend the current one to keep it)."),
        confirm: confirm("changing this IP ACL entry"),
      },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        updated: z.literal(true).optional().describe("True when the change was applied by this call."),
        ip_acl_entry: ipAclShape.nullable().optional().describe("The entry after the change."),
        http_status: httpStatus,
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
        "Remove an IP ACL entry from this Vobiz account; this reverses add_ip_acl_entry and cannot be undone. SIP traffic from that address or range is no longer trusted and needs digest credentials; " +
        "the change can take a little time to reach the SIP edge. Trunks that referenced the entry keep working with their other authentication. An unknown ip_acl_id raises not_found. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { ip_acl_id: ipAclId, confirm: confirm("deleting this IP ACL entry") },
      outputSchema: { ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."), deleted: z.literal(true).optional(), ip_acl_id: z.string().optional().describe("The entry that was deleted."), http_status: httpStatus },
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
        "List the origination URIs on this Vobiz account: the SIP destinations trunks deliver outbound calls to, with id, priority (failover order, lowest first), weight (load split within a priority), " +
        "transport and enabled state. URIs are account-wide; a trunk picks its own with primary_uri_uuid and fallback_uri_uuid (see list_sip_trunks). " +
        "Add with create_origination_uri, re-prioritise with update_origination_uri, remove with delete_origination_uri. " + OFFSET_NOTE,
      inputSchema: { limit, offset },
      outputSchema: listOutput("origination_uris", originationUriShape, "Origination URIs"),
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
        "attach it to a trunk with update_sip_trunk (primary_uri_uuid or fallback_uri_uuid). The host must be a public FQDN or IPv4 address; private, loopback and .local targets are rejected. " +
        "Weight (Vobiz default 10) and transport are set in the Vobiz console. Returns the URI's id. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true; " +
        "every call adds another URI, so a retry after a timeout should first check list_origination_uris.",
      inputSchema: {
        name: label.describe("Label of 1-255 characters, e.g. Primary SBC. Returned by Vobiz as `description`."),
        sip_uri: z
          .string()
          .trim()
          .max(255)
          .describe("SIP destination: sip:host, sip:host:port, sip:user@host or sip:user@host:port, e.g. sip:sbc.example.com:5060 (port 1-65535, host public). Returned by Vobiz as `uri`."),
        priority,
        confirm: confirm("adding this outbound SIP destination"),
      },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        created: z.literal(true).optional().describe("True when the record was created by this call."),
        uri_id: id().describe("UUID of the new URI: use it as primary_uri_uuid or fallback_uri_uuid on a trunk. Null if Vobiz did not return one."),
        origination_uri: originationUriShape.optional().describe("The URI as Vobiz returned it."),
        http_status: httpStatus,
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
        "To point at a different host, create a new origination URI and delete this one; weight and enabled are managed in the Vobiz console. Read current values with list_origination_uris first. " +
        "A priority change applies to the next outbound call on every trunk using the URI. An unknown uri_id raises not_found. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        uri_id: uriId,
        name: label.describe("Label of 1-255 characters (resend the current one to keep it). Returned by Vobiz as `description`."),
        priority,
        confirm: confirm("changing this origination URI"),
      },
      outputSchema: {
        ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."),
        updated: z.literal(true).optional().describe("True when the change was applied by this call."),
        origination_uri: originationUriShape.nullable().optional().describe("The URI after the change."),
        http_status: httpStatus,
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
        "Delete an origination URI from this Vobiz account; this cannot be undone. Trunks stop routing outbound calls to that destination, so add a replacement with create_origination_uri and " +
        "re-point the trunk with update_sip_trunk first if it is a trunk's only route. An unknown uri_id raises not_found. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { uri_id: uriId, confirm: confirm("deleting this origination URI") },
      outputSchema: { ok: z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`."), deleted: z.literal(true).optional(), uri_id: z.string().optional().describe("The URI that was deleted."), http_status: httpStatus },
      annotations: write(true),
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "deleting this origination URI");
      const res = await ctx.client.request("DELETE", path(`/origination-uris/${encodeURIComponent(a.uri_id)}`), { route: "DELETE origination-uris/{id}" });
      return ok({ ok: true, deleted: true, uri_id: a.uri_id, http_status: res.status });
    }),
  );
}
