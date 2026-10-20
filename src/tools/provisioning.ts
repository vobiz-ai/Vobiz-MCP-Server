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
import { IdempotencyStore, withIdempotency } from "../idempotency.js";
import { sharedOf } from "../guard/capacity.js";
import { PAGINATION_NOTE, assertAllowedUrl, handler, idempotencyKey, listField, ok, pageInfo, phoneNumber, redact, toE164 } from "../util.js";

type Rec = Record<string, unknown>;

const appId = z.string().regex(/^\d{5,25}$/, "must be a Vobiz application ID (digits)");
const trunkId = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a trunk UUID");
const uuid = trunkId;
const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly approved: ${what}.`);
const e164Path = (n: string) => encodeURIComponent(toE164(n));

function requireProvisioning(ctx: ToolContext, confirmed: boolean | undefined, what: string): void {
  if (!ctx.cfg.enableProvisioning) {
    throw new VobizError("provisioning_disabled", "Account changes are disabled on this server. An administrator must set VOBIZ_ENABLE_PROVISIONING=true.");
  }
  if (confirmed !== true) {
    throw new VobizError("confirmation_required", `Ask the user to approve ${what}, then call again with confirm: true.`);
  }
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

const appFields = {
  app_name: z.string().trim().min(1).max(120).optional(),
  answer_url: z.string().url().optional().describe("XML URL fetched when a call reaches a number linked to this application (approved host)."),
  answer_method: z.enum(["GET", "POST"]).optional(),
  hangup_url: z.string().url().optional(),
  hangup_method: z.enum(["GET", "POST"]).optional(),
  fallback_answer_url: z.string().url().optional(),
  fallback_method: z.enum(["GET", "POST"]).optional(),
  default_number_app: z.boolean().optional(),
  default_endpoint_app: z.boolean().optional(),
};

const trunkFields = {
  name: z.string().trim().min(1).max(100).optional(),
  trunk_status: z.enum(["enabled", "disabled"]).optional(),
  trunk_direction: z.enum(["inbound", "outbound", "both"]).optional(),
  secure: z.boolean().optional(),
  transport: z.enum(["udp", "tcp", "tls"]).optional(),
  concurrent_calls_limit: z.number().int().min(1).max(1000).optional(),
  cps_limit: z.number().int().min(1).max(100).optional(),
  credential_uuid: uuid.optional(),
  ipacl_uuid: uuid.optional(),
  primary_uri_uuid: uuid.optional().describe("Origination URI used first (failover order: primary, then fallback)."),
  fallback_uri_uuid: uuid.optional(),
  inbound_destination: z.string().max(255).optional(),
  description: z.string().max(1000).optional(),
  recording: z.boolean().optional(),
  enable_transcription: z.boolean().optional(),
  webhook_url: z.string().url().optional().describe("Receives CallInitiated and Hangup events (public https)."),
  webhook_method: z.enum(["GET", "POST"]).optional(),
  recording_webhook_enabled: z.boolean().optional(),
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
      description: "List Vobiz applications (answer/hangup URLs used for inbound calls on linked numbers). Max 20 per page (Vobiz limit). " + PAGINATION_NOTE + " Read-only.",
      inputSchema: {
        app_name: z.string().max(120).optional().describe("Filter: name contains"),
        limit: z.number().int().min(1).max(20).optional(),
        offset: z.number().int().min(0).optional(),
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
      description: "Return one Vobiz application's configuration. Read-only.",
      inputSchema: { app_id: appId },
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
      description: "Create a Vobiz application (app_name and answer_url required). URLs must be on approved hosts. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { ...appFields, app_name: z.string().trim().min(1).max(120), answer_url: z.string().url(), confirm: confirm("creating this application") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "creating this application");
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
        "Change a Vobiz application's URLs or flags. Note: Vobiz resets default_endpoint_app to false when it is omitted, so this tool re-sends its current value. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { app_id: appId, ...appFields, confirm: confirm("changing this application") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "changing this application");
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
      description: "Delete a Vobiz application. Linked numbers are unlinked (inbound calls to them stop being handled). Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { app_id: appId, confirm: confirm("deleting this application") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "deleting this application");
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
        "Search Vobiz inventory for numbers available to buy, with setup/monthly fees. Filters: country (e.g. IN), region, contains (digits), series (Indian number series after +91). " +
        PAGINATION_NOTE + " Read-only.",
      inputSchema: {
        country: z.string().regex(/^[A-Z]{2}$/).optional(),
        region: z.string().max(80).optional(),
        contains: z.string().regex(/^\d{1,15}$/).optional().describe("Digits the number must contain (vanity/pattern search)."),
        series: z.string().regex(/^\d{1,6}$/).optional().describe("India only: digits right after +91, e.g. 80."),
        page: z.number().int().min(1).max(10000).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
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
        "Buy one number from Vobiz inventory (POST /numbers/purchase-from-inventory). This charges setup + monthly fee immediately. " +
        "Server checks: provisioning enabled, the number is in inventory, cost within VOBIZ_MAX_NUMBER_COST, enough balance, daily purchase cap, not already owned. " +
        "Requires confirm: true (after showing the user the number and its fees) and an idempotency_key; repeating the key never buys twice.",
      inputSchema: {
        phone_number: phoneNumber.describe("Number from search_available_numbers, E.164."),
        currency: z.string().regex(/^[A-Z]{3}$/).optional(),
        idempotency_key: idempotencyKey,
        confirm: confirm("buying this number at the quoted fees"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "buying this number");
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
        "Change one owned number's configuration: replace its tags, link it to an application (inbound calls run that app's answer_url) or to a SIP trunk, or unlink them. " +
        "A number can be linked to an application OR a trunk, not both. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        phone_number: phoneNumber,
        tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
        application_id: appId.optional(),
        unlink_application: z.boolean().optional(),
        trunk_id: trunkId.optional().describe("Trunk to route this number to (sent as trunk_group_id)."),
        unlink_trunk: z.boolean().optional(),
        confirm: confirm("changing this number's routing"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "changing this number");
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
        "Create a SIP trunk (POST /trunks). Authenticate with credential_uuid and/or ipacl_uuid; route outbound via primary_uri_uuid with fallback_uri_uuid for failover. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { ...trunkFields, name: z.string().trim().min(1).max(100), confirm: confirm("creating this SIP trunk") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "creating this SIP trunk");
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
        "Change a SIP trunk's settings (PUT /trunks/{id}), including limits, auth references, failover URIs, recording and webhook_url. Only the fields you pass change. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { trunk_id: trunkId, ...trunkFields, confirm: confirm("changing this SIP trunk") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "changing this SIP trunk");
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
      description: "Delete a SIP trunk (soft delete). Numbers routed to it are unlinked and stop receiving calls through it. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { trunk_id: trunkId, confirm: confirm("deleting this SIP trunk") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      requireProvisioning(ctx, a.confirm, "deleting this SIP trunk");
      const res = await ctx.client.request("DELETE", ctx.client.accountPath(`/trunks/${a.trunk_id}`), { route: "DELETE trunks/{id}" });
      return ok({ ok: true, deleted: true, trunk_id: a.trunk_id, http_status: res.status });
    }),
  );
}
