/**
 * Applications, number inventory/purchase/configuration and SIP trunk management.
 * Every change here is gated by VOBIZ_ENABLE_PROVISIONING=true plus confirm: true.
 *
 * Contracts (verified in source):
 *  backend-apis  GET|POST /Application/, GET|POST|DELETE /Application/{id}/   (application_views.go:16-20)
 *  number-svc    GET /inventory/numbers, POST /numbers/purchase-from-inventory {e164, currency},
 *                PATCH /numbers/{e164} {tags}, POST|DELETE /numbers/{e164}/application {application_id},
 *                POST|DELETE /numbers/{e164}/assign {trunk_group_id}                    (number-service/main.go)
 *  trunk-svc     POST /trunks, PUT /trunks/{id}, DELETE /trunks/{id} (soft delete)    (trunk-service/main.go:464-515)
 * trunk-service does not run its validate tags and number purchase does no balance/KYC pre-check,
 * so those checks are done here.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { digitsOnly } from "../config.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { CONFIRM_NOTE, hostOf, requireApproval, type ToolExtra } from "../guard/confirm.js";
import { IdempotencyStore, withIdempotency } from "../idempotency.js";
import { sharedOf } from "../guard/capacity.js";
import { assertAllowedUrl, handler, idempotencyKey, listField, ok, pageInfo, phoneNumber, redact, toE164 } from "../util.js";

type Rec = Record<string, unknown>;

const appId = z
  .string()
  .regex(/^\d{5,25}$/, "must be a Vobiz application ID (digits)")
  .describe("Numeric Vobiz application ID (5-25 digits): the app_id returned by list_applications or create_application.");
const trunkId = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a trunk UUID")
  .describe("SIP trunk UUID: the trunk_id returned by list_sip_trunks, get_sip_trunk or create_sip_trunk.");
const uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a UUID");
const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly approved: ${what}.` + CONFIRM_NOTE);
const e164Path = (n: string) => encodeURIComponent(toE164(n));

const OFFSET_NOTE = "Pagination is stateless: pass limit and offset on every call (nothing is saved between calls) and follow pagination.next_offset.";
const PAGE_NOTE = "Pagination is stateless: pass page and per_page on every call (nothing is saved between calls) and follow pagination.next_page.";

// ── Output schemas (every field optional so a backend change never fails validation) ──
const str = () => z.string().nullable().optional();
const bool = () => z.boolean().nullable().optional();
const num = () => z.number().nullable().optional();
const id = () => z.union([z.string(), z.number()]).nullable().optional();
const httpStatus = z.number().optional().describe("HTTP status Vobiz answered with.");
const backendMessage = str().describe("Status message from Vobiz (e.g. 'created' or 'changed'), when it sent one.");

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

const applicationShape = z
  .object({
    app_id: id().describe("Numeric application ID (string of digits)."),
    app_name: str().describe("Application name."),
    answer_url: str().describe("URL fetched for VobizXML when a call reaches a number or endpoint linked to this application."),
    answer_method: str().describe("HTTP method for answer_url: GET or POST."),
    hangup_url: str().describe("URL notified when the call ends."),
    hangup_method: str().describe("HTTP method for hangup_url."),
    fallback_answer_url: str().describe("URL used only when answer_url fails; null when none is set."),
    fallback_method: str().describe("HTTP method for fallback_answer_url."),
    default_app: bool().describe("True when this is the account-level default application for new numbers."),
    default_endpoint_app: bool().describe("True when new SIP endpoints without an application route here."),
    enabled: bool().describe("False when the application is switched off."),
    sip_uri: str().describe("SIP URI that reaches this application directly without a number."),
    public_uri: bool().describe("True when sip_uri accepts calls from external SIP systems."),
    application_type: str().describe("Application type, normally XML."),
    message_url: str().describe("URL notified for inbound messages; null when none is set."),
    message_method: str().describe("HTTP method for message_url."),
    sub_account: str().describe("Sub-account Auth ID that owns the application, or null for the main account."),
    created_at: str().describe("Creation timestamp."),
    updated_at: str().describe("Last-change timestamp."),
  })
  .passthrough();

const trunkShape = z
  .object({
    trunk_id: str().describe("Trunk UUID; use it as trunk_id elsewhere."),
    name: str().describe("Trunk name."),
    trunk_domain: str().describe("Auto-generated SIP domain of the trunk ({trunk_id}.sip.vobiz.ai)."),
    trunk_status: str().describe("Trunk state as Vobiz reports it (e.g. active or inactive)."),
    trunk_direction: str().describe("inbound, outbound or both."),
    secure: bool().describe("True when media is encrypted with SRTP."),
    transport: str().describe("SIP transport: udp, tcp or tls."),
    concurrent_calls_limit: num().describe("Concurrent-call limit stored on the trunk."),
    cps_limit: num().describe("Calls-per-second limit stored on the trunk."),
    credential_uuid: str().describe("Attached trunk credential UUID, if any."),
    ipacl_uuid: str().describe("Attached IP ACL entry UUID, if any."),
    primary_uri_uuid: str().describe("Primary origination URI UUID, if any."),
    fallback_uri_uuid: str().describe("Fallback origination URI UUID, if any."),
    inbound_destination: str().describe("Inbound call destination configured on the trunk, if any."),
    description: str().describe("Free-text description."),
    recording: bool().describe("True when calls on the trunk are recorded."),
    enable_transcription: bool().describe("True when recordings are transcribed."),
    pii_redaction: bool().describe("True when PII is redacted from transcripts."),
    webhook_url: str().describe("Webhook receiving CallInitiated and Hangup events, if set."),
    webhook_method: str().describe("HTTP method for webhook_url."),
    recording_webhook_enabled: bool().describe("True when recording.completed events are sent to webhook_url."),
    created_at: str().describe("Creation timestamp."),
    updated_at: str().describe("Last-change timestamp."),
  })
  .passthrough()
  .describe("Trunk object as Vobiz returned it; any username or password field is replaced with [redacted].");

const inventoryNumberShape = z
  .object({
    e164: str().describe("The number in E.164 form; pass it to buy_phone_number."),
    country: str().describe("ISO 3166-1 alpha-2 country code."),
    region: str().describe("Region or state the number belongs to, when Vobiz records one."),
    setup_fee: num().describe("One-time fee charged at purchase."),
    monthly_fee: num().describe("Recurring monthly rental, charged at purchase and then monthly."),
    currency: str().describe("ISO 4217 currency of the fees."),
    capabilities: z.record(z.string(), z.unknown()).nullable().optional().describe("Capability flags such as voice, sms, mms and fax."),
    voice_enabled: bool().describe("True when the number can carry voice calls."),
    is_trial_number: bool().describe("True for trial-tier numbers."),
    minimum_commitment_months: num().describe("Minimum rental period in months."),
    aadhaar_verification_required: bool().describe("True when the buyer must complete Aadhaar verification before use (India)."),
    status: str().describe("Inventory status; only active, unassigned numbers are listed."),
    provider: str().describe("Upstream carrier label."),
  })
  .passthrough();

/** Provisioning must be enabled, and the human must approve (elicitation when supported, else confirm: true). */
async function requireProvisioning(server: McpServer, extra: ToolExtra, ctx: ToolContext, confirmed: boolean | undefined, what: string, detail: string): Promise<void> {
  if (!ctx.cfg.enableProvisioning) {
    throw new VobizError("provisioning_disabled", "Account changes are disabled on this server. An administrator must set VOBIZ_ENABLE_PROVISIONING=true.");
  }
  await requireApproval(server, extra, {
    confirmed,
    message: `Change your Vobiz account: ${detail}. Approve?`,
    fallback: `Ask the user to approve ${what}, then call again with confirm: true.`,
  });
}

/** Public, non-local http(s) URL check for trunk webhooks (trunk-service lets unresolvable hosts through). */
function assertPublicWebhook(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VobizError("invalid_input", "webhook_url is not a valid URL.");
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:") throw new VobizError("invalid_input", "webhook_url must use https.");
  if (url.length > 500) throw new VobizError("invalid_input", "webhook_url may be at most 500 characters.");
  if (h === "localhost" || h.endsWith(".local") || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h.startsWith("[")) {
    throw new VobizError("invalid_input", "webhook_url must be a public host.");
  }
}

const APP_NAME_DESC = "Application name, 1-120 characters: letters, digits, - and _ only (Vobiz rejects other characters).";
const ANSWER_URL_DESC =
  "URL Vobiz fetches for VobizXML when a call reaches a number or SIP endpoint linked to this application. Must be https on an approved host (VOBIZ_ALLOWED_URL_HOSTS) and answer within 10 seconds.";
const appFields = {
  app_name: z.string().trim().min(1).max(120).optional().describe(APP_NAME_DESC),
  answer_url: z.string().url().optional().describe(ANSWER_URL_DESC),
  answer_method: z.enum(["GET", "POST"]).optional().describe("HTTP method used to fetch answer_url: GET or POST (Vobiz default POST)."),
  hangup_url: z
    .string()
    .url()
    .optional()
    .describe("URL Vobiz notifies when a call on this application ends (CallUUID, CallStatus, Duration, HangupCause). Omitted at creation, it defaults to answer_url. Must be https on an approved host."),
  hangup_method: z.enum(["GET", "POST"]).optional().describe("HTTP method for hangup_url: GET or POST (Vobiz default POST)."),
  fallback_answer_url: z
    .string()
    .url()
    .optional()
    .describe("Fetched only when answer_url is unreachable, times out or returns invalid VobizXML; must itself return VobizXML. Without one the call drops on answer_url failure. Must be https on an approved host."),
  fallback_method: z.enum(["GET", "POST"]).optional().describe("HTTP method for fallback_answer_url: GET or POST (Vobiz default POST)."),
  default_number_app: z
    .boolean()
    .optional()
    .describe("true makes this the application for newly bought numbers that have none (Vobiz default false). Existing numbers are not re-routed."),
  default_endpoint_app: z
    .boolean()
    .optional()
    .describe("true makes this the application for newly created SIP endpoints that have none (Vobiz default false). Existing endpoints are not re-routed."),
};

const trunkFields = {
  name: z.string().trim().min(1).max(100).optional().describe("Display name of the trunk, 1-100 characters."),
  trunk_status: z
    .enum(["enabled", "disabled"])
    .optional()
    .describe("enabled or disabled. A disabled trunk keeps its configuration, credentials and routing but handles no calls; Vobiz reports the state as active/inactive on the trunk object."),
  trunk_direction: z.enum(["inbound", "outbound", "both"]).optional().describe("Which calls the trunk carries: inbound (to your numbers), outbound (from your PBX) or both."),
  secure: z.boolean().optional().describe("true encrypts media with SRTP (Vobiz default false). Signalling encryption is chosen with transport: tls."),
  transport: z.enum(["udp", "tcp", "tls"]).optional().describe("SIP signalling transport: udp (Vobiz default), tcp or tls (encrypted signalling)."),
  concurrent_calls_limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum simultaneous calls on the trunk, 1-1000 (Vobiz default 10). Stored on the trunk; the enforced concurrency is the account-level limit."),
  cps_limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum new calls per second (flood protection), 1-100 (Vobiz default 2). Independent of concurrent_calls_limit; the enforced CPS is the account-level limit."),
  credential_uuid: uuid.optional().describe("UUID of a trunk credential (id from list_trunk_credentials or create_trunk_credential) for SIP digest authentication of this trunk's peer."),
  ipacl_uuid: uuid
    .optional()
    .describe("UUID of an IP ACL entry (id from list_ip_acl_entries or add_ip_acl_entry) so SIP from that address is accepted without a password. May be set together with credential_uuid."),
  primary_uri_uuid: uuid
    .optional()
    .describe("UUID of the origination URI (id from list_origination_uris or create_origination_uri) that outbound calls are sent to first; failover order is primary, then fallback."),
  fallback_uri_uuid: uuid.optional().describe("UUID of the origination URI tried when the primary one fails."),
  inbound_destination: z.string().max(255).optional().describe("Destination inbound calls on this trunk are delivered to (inbound trunks), up to 255 characters, in the form your Vobiz trunk setup uses."),
  description: z.string().max(1000).optional().describe("Free-text note on the trunk's purpose, up to 1000 characters."),
  recording: z.boolean().optional().describe("true records every call on the trunk (Vobiz default false). Required for enable_transcription and recording_webhook_enabled to have any effect."),
  enable_transcription: z.boolean().optional().describe("true transcribes recordings automatically (Vobiz default false); only effective while recording is true."),
  webhook_url: z
    .string()
    .url()
    .optional()
    .describe("Public https URL (max 500 characters) that receives CallInitiated and Hangup events for calls on this trunk; private and local hosts are rejected."),
  webhook_method: z.enum(["GET", "POST"]).optional().describe("HTTP method for webhook_url deliveries: POST (Vobiz default) or GET."),
  recording_webhook_enabled: z
    .boolean()
    .optional()
    .describe("true also sends a recording.completed event to webhook_url after each recording is saved (Vobiz default false); needs recording true and a webhook_url."),
};

function pick(a: Rec, keys: string[]): Rec {
  const out: Rec = {};
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

export function registerProvisioningTools(server: McpServer, ctx: ToolContext): void {
  const { cfg } = ctx;

  // ── Applications (where inbound call webhooks live) ──────────
  server.registerTool(
    "list_applications",
    {
      title: "List voice applications",
      description:
        "List the voice applications on this Vobiz account: each one's app_id, name, answer/hangup/fallback URLs and methods, default-app flags and SIP URI. " +
        "Use it to find the app_id for get_application, update_application, update_phone_number (application_id) or create_sip_endpoint; for one known id call get_application instead. " +
        "Pages hold at most 20 applications (Vobiz limit). " + OFFSET_NOTE,
      inputSchema: {
        app_name: z.string().max(120).optional().describe("Only applications whose name contains this text (case as Vobiz matches it). Omit for all."),
        limit: z.number().int().min(1).max(20).optional().describe("Applications per page, 1-20 (default 20)."),
        offset: z.number().int().min(0).optional().describe("Number of applications to skip (default 0); pass pagination.next_offset from the previous page."),
      },
      outputSchema: {
        ok: z.literal(true),
        count: z.number().optional().describe("Applications in this page."),
        applications: z.array(applicationShape).optional().describe("Application objects, newest first as Vobiz orders them."),
        pagination: offsetPagination.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ app_name, limit, offset }) => {
      const lim = limit ?? 20;
      const off = offset ?? 0;
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/Application/"), {
        query: { app_name, limit: lim, offset: off },
        route: "GET Application/",
      });
      const apps = listField(res.data, "objects");
      if (!apps) throw new VobizError("unexpected_response", "Vobiz returned applications in an unexpected format.", res.status);
      const meta = (res.data.meta ?? {}) as Rec;
      const total = typeof meta.total_count === "number" ? meta.total_count : null;
      const hasMore = total !== null ? off + apps.length < total : apps.length === lim;
      return ok({ ok: true, count: apps.length, applications: apps, pagination: { limit: lim, offset: off, total, has_more: hasMore, next_offset: hasMore ? off + lim : null } });
    }),
  );

  server.registerTool(
    "get_application",
    {
      title: "Get voice application",
      description:
        "Return one Vobiz voice application's full configuration by app_id: name, answer_url and answer_method (where Vobiz fetches VobizXML for inbound calls), hangup_url and hangup_method, " +
        "fallback_answer_url and fallback_method, the default_app and default_endpoint_app flags, enabled, sip_uri (dials the application directly), sub_account and timestamps. " +
        "Use list_applications to find the id or to see several applications at once; linked numbers are not included, use list_phone_numbers for those. " +
        "An app_id that is not on this account raises not_found.",
      inputSchema: { app_id: appId.describe("Numeric Vobiz application ID (5-25 digits) from list_applications or create_application. Unknown ids raise not_found.") },
      outputSchema: {
        ok: z.literal(true),
        application: applicationShape.optional().describe("The application exactly as Vobiz returned it."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ app_id }) => {
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath(`/Application/${app_id}/`), { route: "GET Application/{id}/" });
      return ok({ ok: true, application: res.data });
    }),
  );

  server.registerTool(
    "create_application",
    {
      title: "Create voice application",
      description:
        "Create a Vobiz voice application: the set of webhook URLs Vobiz calls for inbound calls on the numbers and SIP endpoints linked to it. " +
        "Only app_name and answer_url are required; hangup_url defaults to answer_url and every URL must be https on an approved host (VOBIZ_ALLOWED_URL_HOSTS). " +
        "Returns the new app_id; link it afterwards with update_phone_number (application_id) or create_sip_endpoint (application_id). To change an existing application use update_application. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true. Every call creates another application, so after a timeout check list_applications before retrying.",
      inputSchema: {
        ...appFields,
        app_name: z.string().trim().min(1).max(120).describe(APP_NAME_DESC),
        answer_url: z.string().url().describe(ANSWER_URL_DESC),
        confirm: confirm("creating this application"),
      },
      outputSchema: {
        ok: z.literal(true),
        created: z.literal(true).optional(),
        app_id: id().describe("ID of the new application; use it as app_id or application_id elsewhere. Null if Vobiz did not return one."),
        backend_message: backendMessage,
        http_status: httpStatus,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "creating this application", `create application "${a.app_name}" answering calls with XML from ${hostOf(a.answer_url)}`);
      for (const k of ["answer_url", "hangup_url", "fallback_answer_url"] as const) if (a[k]) assertAllowedUrl(cfg, a[k] as string, k);
      const res = await ctx.client.request<Rec>("POST", ctx.client.accountPath("/Application/"), {
        body: pick(a as Rec, Object.keys(appFields)),
        route: "POST Application/",
      });
      return ok({ ok: true, created: true, app_id: res.data.app_id ?? null, backend_message: res.data.message ?? null, http_status: res.status });
    }),
  );

  server.registerTool(
    "update_application",
    {
      title: "Update voice application",
      description:
        "Change selected fields of an existing Vobiz voice application (name, webhook URLs and methods, default-app flags). Only the fields you pass change; app_id and sub_account cannot change. " +
        "Vobiz resets default_endpoint_app to false whenever it is omitted, so this tool reads the current value and re-sends it. New URLs must be https on an approved host (VOBIZ_ALLOWED_URL_HOSTS). " +
        "Use create_application for a new application and update_phone_number to change which application a number uses. An unknown app_id raises not_found. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        app_id: appId,
        ...appFields,
        default_endpoint_app: appFields.default_endpoint_app.describe(
          "true makes this the application for newly created SIP endpoints that have none; false clears that. Omitted, the current value is re-sent (Vobiz would otherwise reset it to false).",
        ),
        confirm: confirm("changing this application"),
      },
      outputSchema: {
        ok: z.literal(true),
        updated: z.literal(true).optional(),
        app_id: z.string().optional().describe("The application that was changed."),
        backend_message: backendMessage,
        http_status: httpStatus,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "changing this application", `update application ${a.app_id}${a.answer_url ? `; inbound calls will fetch XML from ${hostOf(a.answer_url)}` : ""}${a.hangup_url ? `; hangup events go to ${hostOf(a.hangup_url)}` : ""}${a.fallback_answer_url ? `; fallback XML from ${hostOf(a.fallback_answer_url)}` : ""}`);
      for (const k of ["answer_url", "hangup_url", "fallback_answer_url"] as const) if (a[k]) assertAllowedUrl(cfg, a[k] as string, k);
      const body = pick(a as Rec, Object.keys(appFields));
      if (!Object.keys(body).length) throw new VobizError("invalid_input", "Nothing to update.");
      if (body.default_endpoint_app === undefined) {
        const cur = await ctx.client.request<Rec>("GET", ctx.client.accountPath(`/Application/${a.app_id}/`), { route: "GET Application/{id}/" });
        body.default_endpoint_app = cur.data.default_endpoint_app === true || cur.data.direct_dial === true;
      }
      const res = await ctx.client.request<Rec>("POST", ctx.client.accountPath(`/Application/${a.app_id}/`), { body, route: "POST Application/{id}/" });
      return ok({ ok: true, updated: true, app_id: a.app_id, backend_message: res.data.message ?? null, http_status: res.status });
    }),
  );

  server.registerTool(
    "delete_application",
    {
      title: "Delete voice application",
      description:
        "Permanently delete a Vobiz voice application; this cannot be undone. Inbound calls on numbers still linked to it stop being handled, and Vobiz may refuse the delete (HTTP 409) while numbers are linked, " +
        "so unlink them first with update_phone_number (unlink_application). SIP endpoints attached to it are kept, not deleted (cascade is off), and need a new application via update_sip_endpoint. " +
        "To stop using an application without deleting it, re-point its numbers instead. An unknown app_id raises not_found. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { app_id: appId, confirm: confirm("deleting this application") },
      outputSchema: {
        ok: z.literal(true),
        deleted: z.literal(true).optional(),
        app_id: z.string().optional().describe("The application that was deleted."),
        http_status: httpStatus,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "deleting this application", `delete application ${a.app_id} (inbound calls on its numbers stop being handled)`);
      // cascade=false keeps endpoints instead of deleting them with the application.
      const res = await ctx.client.request("DELETE", ctx.client.accountPath(`/Application/${a.app_id}/`), { query: { cascade: "false" }, route: "DELETE Application/{id}/" });
      return ok({ ok: true, deleted: true, app_id: a.app_id, http_status: res.status });
    }),
  );

  // ── Number inventory and purchase ────────────────────────────
  server.registerTool(
    "search_available_numbers",
    {
      title: "Search numbers to buy",
      description:
        "Search Vobiz inventory for phone numbers you can buy, returning each number's setup_fee, monthly_fee, currency, capabilities, minimum commitment and whether Aadhaar verification is required. " +
        "Filter by country, region, contains (digits anywhere in the number) or series (India). Numbers already on the account are not inventory: use list_phone_numbers for those. " +
        "Buy a result with buy_phone_number, which quotes the same fees. " + PAGE_NOTE,
      inputSchema: {
        country: z.string().regex(/^[A-Z]{2}$/).optional().describe("ISO 3166-1 alpha-2 country code in upper case, e.g. IN or US. Omit for every country."),
        region: z.string().max(80).optional().describe("Only numbers whose inventory region matches this text (up to 80 characters), for countries where Vobiz records a region such as a state or city."),
        contains: z.string().regex(/^\d{1,15}$/).optional().describe("Digits (1-15) that must appear somewhere in the number, e.g. 80 matches +918065...; vanity or pattern search."),
        series: z.string().regex(/^\d{1,6}$/).optional().describe("India only: the digits right after +91 the number must start with, e.g. 80 for the 80-series."),
        page: z.number().int().min(1).max(10000).optional().describe("1-based page number (default 1); pass pagination.next_page from the previous result."),
        per_page: z.number().int().min(1).max(100).optional().describe("Numbers per page, 1-100 (default: the server's VOBIZ_DEFAULT_PAGE_SIZE, normally 20)."),
      },
      outputSchema: {
        ok: z.literal(true),
        numbers: z.array(inventoryNumberShape).optional().describe("Inventory numbers matching the filters; empty when nothing matches."),
        pagination: z
          .object({
            page: z.number().optional().describe("Page returned."),
            per_page: z.number().optional().describe("Page size applied."),
            total: z.number().nullable().optional().describe("Total matching numbers, or null when Vobiz did not report one."),
            returned: z.number().optional().describe("Numbers in this page."),
            has_more: z.boolean().optional().describe("True when another page exists."),
            next_page: z.number().nullable().optional().describe("page to pass next, or null on the last page."),
          })
          .passthrough()
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const page = a.page ?? 1;
      const perPage = a.per_page ?? cfg.defaultPageSize;
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/inventory/numbers"), {
        query: { country: a.country, region: a.region, search: a.contains, series: a.series, page, per_page: perPage },
        route: "GET inventory/numbers",
      });
      const items = listField(res.data, "items");
      if (!items) throw new VobizError("unexpected_response", "Vobiz returned inventory in an unexpected format.", res.status);
      return ok({ ok: true, numbers: items, pagination: pageInfo(page, perPage, items.length, res.data.total) });
    }),
  );

  server.registerTool(
    "buy_phone_number",
    {
      title: "Buy a phone number",
      description:
        "Buy one phone number from Vobiz inventory and add it to this account. The setup fee plus the first monthly fee are charged to the account balance immediately (a sub-account's parent is charged). " +
        "Before buying, the server checks in order: provisioning enabled, the number is not already owned, it is in inventory (else not_found), setup + monthly fee within VOBIZ_MAX_NUMBER_COST, " +
        "enough available balance (postpaid accounts skip this), and the daily purchase cap. Find candidates with search_available_numbers first; configure the bought number with update_phone_number " +
        "and undo a purchase with release_phone_number. Requires confirm: true after showing the user the number and its fees, plus an idempotency_key; repeating the key replays the first result and never buys twice.",
      inputSchema: {
        phone_number: phoneNumber.describe("The number to buy, in E.164 form exactly as search_available_numbers listed it (e.g. +918065551234)."),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional()
          .describe("ISO 4217 code (e.g. INR, USD) of the wallet to charge. Defaults to the number's listed currency, then the server's configured balance currency, then the account's primary wallet."),
        idempotency_key: idempotencyKey,
        confirm: confirm("buying this number at the quoted fees"),
      },
      outputSchema: {
        ok: z.literal(true),
        purchased: z.literal(true).optional(),
        number: z.record(z.string(), z.unknown()).nullable().optional().describe("The number record Vobiz returned after purchase (e164, status, fees), or null if it sent none."),
        charged_estimate: z
          .object({ amount: z.number().optional().describe("Setup fee plus first monthly fee, as quoted in inventory."), currency: z.string().optional().describe("Wallet currency charged.") })
          .passthrough()
          .optional()
          .describe("What the purchase is expected to cost; the wallet transaction is authoritative."),
        compliance: z.string().nullable().optional().describe("Set when the number needs Aadhaar verification in the Vobiz console before use; otherwise null."),
        backend_message: backendMessage,
        http_status: httpStatus,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "buying this number", `buy phone number ${toE164(a.phone_number)}; the setup and monthly fees are charged now`);
      if (cfg.maxNumberCost <= 0) {
        throw new VobizError("spending_limit", "Number purchases are capped at 0 on this server. An administrator must set VOBIZ_MAX_NUMBER_COST.");
      }
      const e164 = toE164(a.phone_number);
      const fp = IdempotencyStore.fingerprint({ op: "buy_number", e164, currency: a.currency ?? null });
      return ok(
        await withIdempotency(ctx.idempotency, `buy:${a.idempotency_key}`, fp, async () => {
          const owned = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/numbers"), { query: { search: e164, per_page: 25 }, route: "GET numbers?search" });
          if ((listField(owned.data, "items") ?? []).some((n) => typeof n.e164 === "string" && digitsOnly(n.e164) === digitsOnly(e164))) {
            throw new VobizError("not_allowed", "This number is already on the account; nothing was bought.");
          }
          const inv = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/inventory/numbers"), { query: { search: digitsOnly(e164), per_page: 25 }, route: "GET inventory/numbers" });
          const item = (listField(inv.data, "items") ?? []).find((n) => typeof n.e164 === "string" && digitsOnly(n.e164) === digitsOnly(e164));
          if (!item) throw new VobizError("not_found", "This number is not available in Vobiz inventory.");
          const cost = Number(item.setup_fee ?? 0) + Number(item.monthly_fee ?? 0);
          let currency = String(a.currency ?? item.currency ?? cfg.policy.balanceCurrency ?? "").toUpperCase();
          if (!currency) {
            // No currency anywhere: use the account's primary (first) wallet.
            const all = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/balance"), { route: "GET balance" });
            const first = Array.isArray(all.data?.balances) ? (all.data.balances as Rec[])[0] : undefined;
            if (!first?.currency) throw new VobizError("unexpected_response", "Could not read the account balance, so nothing was bought.");
            currency = String(first.currency).toUpperCase();
          }
          if (!Number.isFinite(cost)) throw new VobizError("unexpected_response", "Could not read this number's fees.");
          if (cost > cfg.maxNumberCost) {
            throw new VobizError("spending_limit", `First charge ${cost} ${currency} exceeds this server's limit of ${cfg.maxNumberCost} (VOBIZ_MAX_NUMBER_COST).`);
          }
          const bal = await ctx.client.request<Rec>("GET", ctx.client.accountPath(`/balance/${currency}`), { route: "GET balance/{currency}" });
          const available = Number(bal.data?.available_balance ?? bal.data?.balance);
          if (bal.data?.is_postpaid !== true && !(available >= cost)) {
            throw new VobizError("insufficient_balance", `Available balance ${available} ${currency} is below the first charge of ${cost}.`);
          }
          if (cfg.maxNumberPurchasesPerDay === 0 || !ctx.purchaseLimiter.tryAcquire()) {
            throw new VobizError("spending_limit", `This server allows at most ${cfg.maxNumberPurchasesPerDay} number purchases per day.`);
          }
          const res = await ctx.client.request<Rec>("POST", ctx.client.accountPath("/numbers/purchase-from-inventory"), {
            body: { e164, currency },
            sideEffect: true,
            route: "POST numbers/purchase-from-inventory",
          });
          return {
            ok: true,
            purchased: true,
            number: res.data.number ?? null,
            charged_estimate: { amount: cost, currency },
            compliance:
              item.aadhaar_verification_required === true
                ? "This number requires Aadhaar verification before use. Complete it in the Vobiz console."
                : null,
            backend_message: res.data.message ?? null,
            http_status: res.status,
          };
        }, { shared: sharedOf(ctx) }),
      );
    }),
  );

  server.registerTool(
    "update_phone_number",
    {
      title: "Configure a phone number",
      description:
        "Change one owned phone number's configuration: replace its tags, link it to a voice application (inbound calls then fetch that application's answer_url) or to a SIP trunk " +
        "(inbound calls are delivered through the trunk), or unlink either. A number can be linked to an application or a trunk, not both; unlinks run before links, so one call can switch. " +
        "The number must already be on the account (see list_phone_numbers), otherwise not_found. To buy or release a number use buy_phone_number or release_phone_number. " +
        "Returns the list of changes applied. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        phone_number: phoneNumber.describe("An owned number from list_phone_numbers, in E.164 form (e.g. +918065551234)."),
        tags: z
          .array(z.string().trim().min(1).max(50))
          .max(20)
          .optional()
          .describe("Replaces the number's whole tag list (up to 20 tags of 1-50 characters); include every tag to keep. An empty array clears the tags."),
        application_id: appId.optional().describe("Application (app_id from list_applications) whose answer_url handles inbound calls to this number. Not with unlink_application or trunk_id."),
        unlink_application: z.boolean().optional().describe("true removes the number's current application link; reverses application_id. Not together with application_id."),
        trunk_id: trunkId.optional().describe("SIP trunk (trunk_id from list_sip_trunks) that inbound calls to this number are routed through; sent to Vobiz as trunk_group_id. Not with unlink_trunk or application_id."),
        unlink_trunk: z.boolean().optional().describe("true removes the number's SIP trunk link so inbound calls stop routing through it; reverses trunk_id. Not together with trunk_id."),
        confirm: confirm("changing this number's routing"),
      },
      outputSchema: {
        ok: z.literal(true),
        phone_number: z.string().optional().describe("The number that was changed, in E.164 form."),
        changes: z.array(z.string()).optional().describe("Human-readable list of the changes applied, in the order they ran."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "changing this number", `change routing of ${toE164(a.phone_number)}${a.application_id ? ` to application ${a.application_id}` : ""}${a.trunk_id ? ` to SIP trunk ${a.trunk_id}` : ""}${a.unlink_application ? " (unlink its application)" : ""}${a.unlink_trunk ? " (unlink its trunk)" : ""}${a.tags ? " (replace tags)" : ""}`);
      if (a.application_id && a.unlink_application) throw new VobizError("invalid_input", "Give application_id or unlink_application, not both.");
      if (a.trunk_id && a.unlink_trunk) throw new VobizError("invalid_input", "Give trunk_id or unlink_trunk, not both.");
      if (a.application_id && a.trunk_id) throw new VobizError("invalid_input", "A number can be linked to an application or a trunk, not both.");
      const owned = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/numbers"), { query: { search: toE164(a.phone_number), per_page: 25 }, route: "GET numbers?search" });
      if (!(listField(owned.data, "items") ?? []).some((n) => typeof n.e164 === "string" && digitsOnly(n.e164) === digitsOnly(a.phone_number))) {
        throw new VobizError("not_found", "This number is not on the account.");
      }
      const base = `/numbers/${e164Path(a.phone_number)}`;
      const done: string[] = [];
      // Unlink first so a switch from trunk to application (or back) is allowed.
      if (a.unlink_trunk || a.application_id) {
        if (a.unlink_trunk) {
          await ctx.client.request("DELETE", ctx.client.accountPath(`${base}/assign`), { route: "DELETE numbers/{e164}/assign" });
          done.push("trunk unlinked");
        }
      }
      if (a.unlink_application) {
        await ctx.client.request("DELETE", ctx.client.accountPath(`${base}/application`), { route: "DELETE numbers/{e164}/application" });
        done.push("application unlinked");
      }
      if (a.application_id) {
        await ctx.client.request("POST", ctx.client.accountPath(`${base}/application`), { body: { application_id: a.application_id }, route: "POST numbers/{e164}/application" });
        done.push(`linked to application ${a.application_id}`);
      }
      if (a.trunk_id) {
        await ctx.client.request("POST", ctx.client.accountPath(`${base}/assign`), { body: { trunk_group_id: a.trunk_id }, route: "POST numbers/{e164}/assign" });
        done.push(`linked to trunk ${a.trunk_id}`);
      }
      if (a.tags) {
        await ctx.client.request("PATCH", ctx.client.accountPath(base), { body: { tags: a.tags }, route: "PATCH numbers/{e164}" });
        done.push("tags replaced");
      }
      if (!done.length) throw new VobizError("invalid_input", "Nothing to change.");
      return ok({ ok: true, phone_number: toE164(a.phone_number), changes: done });
    }),
  );

  // ── SIP trunks ───────────────────────────────────────────────
  const TRUNK_SECRETS = ["username", "password"];

  server.registerTool(
    "create_sip_trunk",
    {
      title: "Create SIP trunk",
      description:
        "Create a SIP trunk on this Vobiz account: a voice gateway with its own auto-generated SIP domain ({trunk_id}.sip.vobiz.ai), authentication, call limits and outbound routing. " +
        "Only name is required; Vobiz defaults are transport udp, secure false and cps_limit 2. Authenticate the peer with credential_uuid (digest) and/or ipacl_uuid (source IP), and route outbound calls " +
        "via primary_uri_uuid with fallback_uri_uuid for failover; create those first with create_trunk_credential, add_ip_acl_entry and create_origination_uri, or attach them later with update_sip_trunk. " +
        "Returns the full trunk object with any credential fields redacted. Route numbers to the trunk afterwards with update_phone_number (trunk_id). " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true; every call creates another trunk, so after a timeout check list_sip_trunks before retrying.",
      inputSchema: { ...trunkFields, name: z.string().trim().min(1).max(100).describe("Display name of the trunk, 1-100 characters."), confirm: confirm("creating this SIP trunk") },
      outputSchema: {
        ok: z.literal(true),
        created: z.literal(true).optional(),
        trunk: trunkShape.optional().describe("The new trunk; its trunk_id is needed for update_sip_trunk, delete_sip_trunk and update_phone_number."),
        http_status: httpStatus,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "creating this SIP trunk", `create SIP trunk "${a.name}"${a.webhook_url ? ` with webhooks to ${hostOf(a.webhook_url)}` : ""}`);
      if (a.webhook_url) assertPublicWebhook(a.webhook_url);
      const res = await ctx.client.request<Rec>("POST", ctx.client.accountPath("/trunks"), { body: pick(a as Rec, Object.keys(trunkFields)), route: "POST trunks" });
      return ok({ ok: true, created: true, trunk: redact(res.data, TRUNK_SECRETS), http_status: res.status });
    }),
  );

  server.registerTool(
    "update_sip_trunk",
    {
      title: "Update SIP trunk",
      description:
        "Change settings of an existing Vobiz SIP trunk: only the fields you pass change; trunk_id and trunk_domain never change. Use it to attach authentication (credential_uuid, ipacl_uuid), " +
        "set outbound routing (primary_uri_uuid, fallback_uri_uuid), adjust limits, turn on recording or the event webhook, or pause a trunk with trunk_status: disabled instead of deleting it. " +
        "Read current values first with get_sip_trunk; for a new trunk use create_sip_trunk. Returns the updated trunk object with credential fields redacted. An unknown trunk_id raises not_found. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { trunk_id: trunkId, ...trunkFields, confirm: confirm("changing this SIP trunk") },
      outputSchema: {
        ok: z.literal(true),
        updated: z.literal(true).optional(),
        trunk: trunkShape.optional().describe("The trunk after the change."),
        http_status: httpStatus,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "changing this SIP trunk", `update SIP trunk ${a.trunk_id}${a.webhook_url ? `; webhooks go to ${hostOf(a.webhook_url)}` : ""}${a.primary_uri_uuid || a.fallback_uri_uuid ? "; outbound routing URIs change" : ""}`);
      if (a.webhook_url) assertPublicWebhook(a.webhook_url);
      const body = pick(a as Rec, Object.keys(trunkFields));
      if (!Object.keys(body).length) throw new VobizError("invalid_input", "Nothing to update.");
      const res = await ctx.client.request<Rec>("PUT", ctx.client.accountPath(`/trunks/${a.trunk_id}`), { body, route: "PUT trunks/{id}" });
      return ok({ ok: true, updated: true, trunk: redact(res.data, TRUNK_SECRETS), http_status: res.status });
    }),
  );

  server.registerTool(
    "delete_sip_trunk",
    {
      title: "Delete SIP trunk",
      description:
        "Soft-delete a Vobiz SIP trunk: it disappears from list_sip_trunks, its SIP domain stops accepting calls, and numbers routed to it are unlinked and stop receiving calls through it. " +
        "The credentials, IP ACL entries and origination URIs it referenced are account-level and are kept. To pause a trunk and keep its configuration, use update_sip_trunk with trunk_status: disabled instead. " +
        "An unknown trunk_id raises not_found. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { trunk_id: trunkId, confirm: confirm("deleting this SIP trunk") },
      outputSchema: {
        ok: z.literal(true),
        deleted: z.literal(true).optional(),
        trunk_id: z.string().optional().describe("The trunk that was deleted."),
        http_status: httpStatus,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "deleting this SIP trunk", `delete SIP trunk ${a.trunk_id} (numbers routed to it stop receiving calls through it)`);
      const res = await ctx.client.request("DELETE", ctx.client.accountPath(`/trunks/${a.trunk_id}`), { route: "DELETE trunks/{id}" });
      return ok({ ok: true, deleted: true, trunk_id: a.trunk_id, http_status: res.status });
    }),
  );
}
