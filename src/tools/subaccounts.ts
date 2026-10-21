/**
 * Sub-account management and sub-account KYC (hosted session + aggregated status).
 * Only main-account (MA_) credentials manage sub-accounts; every change is gated by
 * VOBIZ_ENABLE_PROVISIONING=true plus confirm: true.
 *
 * Contracts (openapi.yaml):
 *  GET|POST            /api/v1/accounts/{auth_id}/sub-accounts/              (list: page, size, active_only)
 *  GET|PUT|DELETE      /api/v1/accounts/{auth_id}/sub-accounts/{sub_auth_id}
 *  GET                 /api/v1/sub-accounts/{sub_auth_id}/kyc/status
 *  POST                /api/v1/sub-accounts/{sub_auth_id}/kyc-sessions         {account_auth_id, flow_type, ...}
 * Note the lowercase plural `accounts` path: it is built here from the configured auth ID, never from tool input.
 * Sub-account credentials (auth_token, JWTs, passwords) are always redacted before reaching the model.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { handler, isPrivateHost, listField, ok, pageInfo, redact } from "../util.js";

type Rec = Record<string, unknown>;

// ── Output shapes (every field optional so validation never fails on a successful result) ──
const subAccountOut = z
  .record(z.string(), z.unknown())
  .describe("The sub-account as Vobiz returns it: name, auth_id, email, phone, enabled, kyc_mode, rate_limit, permissions and timestamps. Credentials are removed.");
const paginationOut = z
  .object({
    page: z.number().optional().describe("Page that was returned (1-based)."),
    per_page: z.number().optional().describe("Page size used for this request."),
    total: z.number().nullable().optional().describe("Total sub-accounts matching the filter, or null when Vobiz did not report it."),
    returned: z.number().optional().describe("Number of items in this page."),
    has_more: z.boolean().optional().describe("true when another page exists."),
    next_page: z.number().nullable().optional().describe("Page to request next, or null on the last page."),
  })
  .passthrough()
  .describe("Stateless paging block for the next call.");
const httpStatus = z.number().optional().describe("HTTP status Vobiz answered with.");
const credentialsNote = z.string().optional().describe("Reminder that credentials are never returned here and where the user finds them.");
const backendMessage = z.string().nullable().optional().describe("Message from Vobiz about the operation, or null.");

const subAuthId = z
  .string()
  .trim()
  .regex(/^SA_[A-Za-z0-9]+$/, "must be a Vobiz sub-account Auth ID such as SA_XXXXXXXX")
  .describe("The sub-account's Auth ID (SA_...), from list_sub_accounts.");
const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly approved: ${what}.`);

const CREDENTIALS_NOTE =
  "Sub-account credentials are never shown here. The user can copy the sub-account's Auth ID and Auth Token from the Vobiz console (Setup > Subaccounts).";
const EXTRA_SECRETS = ["auth_credentials", "tokens", "auth_secret", "password"];

const BUSINESS_TYPES = [
  "individual",
  "proprietorship",
  "private_limited",
  "llp",
  "partnership",
  "public_limited",
  "trust",
  "society",
  "huf",
  "government",
] as const;

const editableFields = {
  name: z.string().trim().min(1).max(120).optional().describe("Human-readable name for the sub-account."),
  email: z.string().trim().email().max(254).optional().describe("Contact email. Required for kyc_mode customer_use."),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, "must be a phone number")
    .optional()
    .describe("Contact phone number for the sub-account's owner: digits with an optional leading + and spaces, dashes or brackets, 6 to 20 characters. Not a caller ID."),
  description: z.string().max(1000).optional().describe("Free-text note about the sub-account (what or whom it is for), up to 1000 characters."),
  rate_limit: z.number().int().min(1).max(1_000_000).optional().describe("API rate limit for the sub-account (Vobiz default 1000)."),
  permissions: z
    .object({ calls: z.boolean().optional(), cdr: z.boolean().optional() })
    .strict()
    .optional()
    .describe("Access flags. Omitted on create: the sub-account inherits the parent's default access."),
  enabled: z.boolean().optional().describe("Whether the sub-account can be used (default true)."),
  kyc_mode: z
    .enum(["personal_use", "customer_use"])
    .optional()
    .describe("personal_use (default) uses the parent's KYC; customer_use means the sub-account completes its own KYC before placing calls (needs email)."),
};

function pick(a: Rec, keys: string[]): Rec {
  const out: Rec = {};
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

/** Sub-accounts are managed with main-account credentials only. Throws before any network I/O. */
function requireMainAccount(ctx: ToolContext): string {
  const authId = ctx.client.authId; // throws missing_credentials when unset
  if (authId.startsWith("SA_")) {
    throw new VobizError(
      "forbidden",
      "Vobiz manages sub-accounts with main-account (MA_) credentials; this server is signed in as a sub-account. Configure the parent account's Auth ID and Auth Token to manage sub-accounts.",
    );
  }
  return authId;
}

function requireProvisioning(ctx: ToolContext, confirmed: boolean | undefined, what: string): void {
  if (!ctx.cfg.enableProvisioning) {
    throw new VobizError("provisioning_disabled", "Account changes are disabled on this server. An administrator must set VOBIZ_ENABLE_PROVISIONING=true.");
  }
  if (confirmed !== true) {
    throw new VobizError("confirmation_required", `Ask the user to approve ${what}, then call again with confirm: true.`);
  }
}

/** /api/v1/accounts/{auth_id}/sub-accounts{suffix}, built from the configured main account. */
function subPath(ctx: ToolContext, suffix: string): string {
  return `/api/v1/accounts/${encodeURIComponent(requireMainAccount(ctx))}/sub-accounts${suffix}`;
}

function kycPath(sub: string, suffix: string): string {
  return `/api/v1/sub-accounts/${encodeURIComponent(sub)}${suffix}`;
}

/** KYC session URLs are reached by Vobiz (webhook) or the customer's browser (redirect): public https only. */
function assertPublicHttps(url: string, field: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VobizError("invalid_input", `${field} is not a valid URL.`);
  }
  if (u.protocol !== "https:") throw new VobizError("invalid_input", `${field} must use https.`);
  if (u.username || u.password) throw new VobizError("invalid_input", `${field} must not contain credentials.`);
  if (url.length > 2000) throw new VobizError("invalid_input", `${field} may be at most 2000 characters.`);
  if (isPrivateHost(u.hostname)) throw new VobizError("invalid_input", `${field} must be a public internet address.`);
}

/** Get/update responses return the sub-account at the top level; tolerate a `sub_account` wrapper. */
function subAccountFrom(data: unknown): Rec | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Rec;
  const inner = d.sub_account;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Rec) : d;
}

export function registerSubAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_sub_accounts",
    {
      title: "List sub-accounts",
      description:
        "List the sub-accounts under this Vobiz main account, one page at a time: name, Auth ID (SA_...), enabled state, KYC mode, rate limit and permissions, never credentials. " +
        "Use it to find the sub_auth_id the other sub-account tools take; for one sub-account's full record use get_sub_account, and for its KYC progress use get_sub_account_kyc_status. " +
        "Pagination is stateless: pass page and size on every call and follow pagination.next_page until has_more is false. " +
        "Needs main-account (MA_) credentials: signed in as a sub-account it fails with forbidden before any request.",
      inputSchema: {
        page: z.number().int().min(1).max(10000).optional().describe("1-based page number (default 1). Take the next value from pagination.next_page."),
        size: z.number().int().min(1).max(100).optional().describe("Results per page, max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
        active_only: z.boolean().optional().describe("true returns only active (enabled) sub-accounts; omitted or false returns disabled ones too."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          count: z.number().optional().describe("Number of sub-accounts in this page."),
          sub_accounts: z.array(subAccountOut).optional().describe("The sub-accounts in this page."),
          pagination: paginationOut.optional(),
          credentials_note: credentialsNote,
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ page, size, active_only }) => {
      const p = page ?? 1;
      const s = size ?? ctx.cfg.defaultPageSize;
      const res = await ctx.client.request<Rec>("GET", subPath(ctx, "/"), {
        query: { page: p, size: s, active_only },
        route: "GET accounts/{id}/sub-accounts/",
      });
      const items = listField(res.data, "sub_accounts");
      if (!items) throw new VobizError("unexpected_response", "Vobiz returned sub-accounts in an unexpected format.", res.status);
      return ok({
        ok: true,
        count: items.length,
        sub_accounts: redact(items, EXTRA_SECRETS),
        pagination: pageInfo(p, s, items.length, res.data.total),
        credentials_note: CREDENTIALS_NOTE,
      });
    }),
  );

  server.registerTool(
    "get_sub_account",
    {
      title: "Get sub-account",
      description:
        "Return one Vobiz sub-account's full record by Auth ID: name, contact email and phone, description, enabled state, KYC mode, rate limit, permissions and timestamps, with credentials removed. " +
        "Use it when you already have a sub_auth_id and need its settings; to find Auth IDs use list_sub_accounts, and for the sub-account's KYC verification state use get_sub_account_kyc_status instead. " +
        "An Auth ID that is not a sub-account of this main account fails with not_found. Needs main-account (MA_) credentials.",
      inputSchema: { sub_auth_id: subAuthId },
      outputSchema: z
        .object({
          ok: z.literal(true),
          sub_account: subAccountOut.optional(),
          credentials_note: credentialsNote,
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ sub_auth_id }) => {
      const res = await ctx.client.request<Rec>("GET", subPath(ctx, `/${encodeURIComponent(sub_auth_id)}`), {
        route: "GET accounts/{id}/sub-accounts/{sub}",
      });
      const sub = subAccountFrom(res.data);
      if (!sub) throw new VobizError("unexpected_response", "Vobiz returned the sub-account in an unexpected format.", res.status);
      return ok({ ok: true, sub_account: redact(sub, EXTRA_SECRETS), credentials_note: CREDENTIALS_NOTE });
    }),
  );

  server.registerTool(
    "create_sub_account",
    {
      title: "Create sub-account",
      description:
        "Create a new Vobiz sub-account under this main account (only name is required); to change an existing one use update_sub_account. " +
        "kyc_mode customer_use needs email, and such a sub-account places calls only after its own KYC (start it with create_sub_account_kyc_session). " +
        "Returns the new sub_auth_id and the redacted record; the credentials are never returned here, the user copies them from the Vobiz console. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true; needs main-account (MA_) credentials.",
      inputSchema: {
        ...editableFields,
        name: z.string().trim().min(1).max(120).describe("Human-readable name for the sub-account."),
        business_type: z
          .enum(BUSINESS_TYPES)
          .optional()
          .describe(
            "Legal constitution of the customer (individual, proprietorship, private_limited, llp, partnership, public_limited, trust, society, huf or government); decides which KYC documents are collected. Matters for kyc_mode customer_use.",
          ),
        confirm: confirm("creating this sub-account"),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          created: z.boolean().optional().describe("true once Vobiz created the sub-account."),
          sub_account: subAccountOut.nullable().optional(),
          sub_auth_id: z.string().nullable().optional().describe("Auth ID of the new sub-account (SA_...), for the other sub-account tools."),
          kyc_calls_blocked: z.boolean().nullable().optional().describe("true when the sub-account cannot place calls until its own KYC is verified."),
          backend_message: backendMessage,
          credentials_note: credentialsNote,
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      requireMainAccount(ctx);
      requireProvisioning(ctx, a.confirm, "creating this sub-account");
      if (a.kyc_mode === "customer_use" && !a.email) {
        throw new VobizError("invalid_input", "kyc_mode customer_use needs an email (the KYC link and reminders go there).");
      }
      const body = pick(a as Rec, [...Object.keys(editableFields), "business_type"]);
      const res = await ctx.client.request<Rec>("POST", subPath(ctx, "/"), { body, route: "POST accounts/{id}/sub-accounts/" });
      const sub = subAccountFrom(res.data);
      return ok({
        ok: true,
        created: true,
        sub_account: sub ? redact(sub, EXTRA_SECRETS) : null,
        sub_auth_id: typeof sub?.auth_id === "string" ? sub.auth_id : null,
        kyc_calls_blocked: typeof sub?.kyc_calls_blocked === "boolean" ? sub.kyc_calls_blocked : null,
        backend_message: typeof res.data?.message === "string" ? res.data.message : null,
        credentials_note: CREDENTIALS_NOTE,
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "update_sub_account",
    {
      title: "Update sub-account",
      description:
        "Change an existing Vobiz sub-account's name, contact details, description, rate limit, permissions, enabled flag or kyc_mode. " +
        "Only the fields you pass change; omitted fields keep their values, and a call with no fields fails with invalid_input. " +
        "Moving to customer_use needs an email on the sub-account and can pause its calls until its KYC is verified. " +
        "Returns the updated record with credentials removed. To make a new sub-account use create_sub_account; to remove one use delete_sub_account. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true; needs main-account (MA_) credentials.",
      inputSchema: { sub_auth_id: subAuthId, ...editableFields, confirm: confirm("changing this sub-account") },
      outputSchema: z
        .object({
          ok: z.literal(true),
          updated: z.boolean().optional().describe("true once Vobiz applied the change."),
          sub_auth_id: z.string().optional().describe("The sub-account that was changed."),
          sub_account: subAccountOut.nullable().optional(),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      requireMainAccount(ctx);
      requireProvisioning(ctx, a.confirm, "changing this sub-account");
      const body = pick(a as Rec, Object.keys(editableFields));
      if (!Object.keys(body).length) throw new VobizError("invalid_input", "Nothing to update.");
      const res = await ctx.client.request<Rec>("PUT", subPath(ctx, `/${encodeURIComponent(a.sub_auth_id)}`), {
        body,
        route: "PUT accounts/{id}/sub-accounts/{sub}",
      });
      const sub = subAccountFrom(res.data);
      return ok({ ok: true, updated: true, sub_auth_id: a.sub_auth_id, sub_account: sub ? redact(sub, EXTRA_SECRETS) : null, http_status: res.status });
    }),
  );

  server.registerTool(
    "delete_sub_account",
    {
      title: "Delete sub-account",
      description:
        "Permanently delete a Vobiz sub-account and revoke its credentials. This removes the sub-account and cannot be undone: anything using its Auth ID stops working. " +
        "To take a sub-account out of use while keeping it, use update_sub_account with enabled: false instead. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true; needs main-account (MA_) credentials.",
      inputSchema: { sub_auth_id: subAuthId, confirm: confirm("permanently deleting this sub-account and revoking its credentials") },
      outputSchema: z
        .object({
          ok: z.literal(true),
          deleted: z.boolean().optional().describe("true once Vobiz removed the sub-account."),
          sub_auth_id: z.string().optional().describe("The Auth ID that was deleted."),
          backend_message: backendMessage,
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      requireMainAccount(ctx);
      requireProvisioning(ctx, a.confirm, "permanently deleting this sub-account");
      const res = await ctx.client.request<Rec>("DELETE", subPath(ctx, `/${encodeURIComponent(a.sub_auth_id)}`), {
        route: "DELETE accounts/{id}/sub-accounts/{sub}",
      });
      return ok({
        ok: true,
        deleted: true,
        sub_auth_id: a.sub_auth_id,
        backend_message: typeof res.data?.message === "string" ? res.data.message : null,
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "get_sub_account_kyc_status",
    {
      title: "Get sub-account KYC status",
      description:
        "Return a Vobiz sub-account's aggregated KYC state: overall status, per-document status (PAN, GST, CIN, Aadhaar), business type and whether calls are paused pending KYC. " +
        "Use it to track progress after create_sub_account_kyc_session or to explain why a customer_use sub-account cannot place calls; for the sub-account's settings and contact details use get_sub_account instead. " +
        "Makes one request and changes nothing; needs main-account (MA_) credentials.",
      inputSchema: { sub_auth_id: subAuthId },
      outputSchema: z
        .object({
          ok: z.literal(true),
          kyc: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Aggregated KYC record from Vobiz: overall status, per-document statuses, business_type and the calls-paused flag."),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ sub_auth_id }) => {
      requireMainAccount(ctx);
      const res = await ctx.client.request<Rec>("GET", kycPath(sub_auth_id, "/kyc/status"), { route: "GET sub-accounts/{sub}/kyc/status" });
      if (!res.data || typeof res.data !== "object" || Array.isArray(res.data)) {
        throw new VobizError("unexpected_response", "Vobiz returned KYC status in an unexpected format.", res.status);
      }
      return ok({ ok: true, kyc: redact(res.data, EXTRA_SECRETS) });
    }),
  );

  server.registerTool(
    "create_sub_account_kyc_session",
    {
      title: "Initialize sub-account KYC",
      description:
        "Start a Vobiz-hosted KYC session for a sub-account. flow_type email (default) has Vobiz email the customer a secure verification link (customer_email required); " +
        "flow_type redirect returns a widget_url to send the customer to (redirect_url required). Optional webhook_url receives KYC events. " +
        "Returns the session record (widget_url for the redirect flow) and a next_step hint; track progress with get_sub_account_kyc_status. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true; needs main-account (MA_) credentials.",
      inputSchema: {
        sub_auth_id: subAuthId,
        flow_type: z
          .enum(["email", "redirect"])
          .optional()
          .describe("email (default): Vobiz emails the customer a verification link. redirect: you send the customer to the returned widget_url yourself."),
        customer_email: z.string().trim().email().max(254).optional().describe("Required for flow_type email: Vobiz sends the KYC link here."),
        redirect_url: z.string().url().optional().describe("Required for flow_type redirect: where the customer's browser goes after verification (public https)."),
        webhook_url: z.string().url().optional().describe("Public https endpoint that receives KYC events. Omit for no callbacks."),
        expires_in_days: z.number().int().min(1).max(90).optional().describe("Days until the link expires (Vobiz default 7)."),
        confirm: confirm("starting KYC for this sub-account (the email flow emails the customer)"),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          created: z.boolean().optional().describe("true once the KYC session exists."),
          session: z.record(z.string(), z.unknown()).optional().describe("The KYC session as Vobiz returns it (session id, flow_type, expiry, and widget_url for the redirect flow); secrets removed."),
          next_step: z.string().optional().describe("What to do now: wait for the customer's email, or send them to widget_url."),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      requireMainAccount(ctx);
      requireProvisioning(ctx, a.confirm, "starting KYC for this sub-account");
      const flow = a.flow_type ?? "email";
      if (flow === "email") {
        if (!a.customer_email) throw new VobizError("invalid_input", "flow_type email needs customer_email.");
        if (a.redirect_url) throw new VobizError("invalid_input", "redirect_url applies to flow_type redirect only.");
      } else {
        if (!a.redirect_url) throw new VobizError("invalid_input", "flow_type redirect needs redirect_url.");
        if (a.customer_email) throw new VobizError("invalid_input", "customer_email applies to flow_type email only.");
        assertPublicHttps(a.redirect_url, "redirect_url");
      }
      if (a.webhook_url) assertPublicHttps(a.webhook_url, "webhook_url");
      const body: Rec = {
        account_auth_id: a.sub_auth_id,
        flow_type: flow,
        ...pick(a as Rec, ["customer_email", "redirect_url", "webhook_url", "expires_in_days"]),
      };
      const res = await ctx.client.request<Rec>("POST", kycPath(a.sub_auth_id, "/kyc-sessions"), {
        body,
        route: "POST sub-accounts/{sub}/kyc-sessions",
      });
      const d = (res.data && typeof res.data === "object" ? res.data : {}) as Rec;
      return ok({
        ok: true,
        created: true,
        session: redact(d, EXTRA_SECRETS),
        next_step:
          flow === "email"
            ? "Vobiz emailed the customer a KYC link. Check progress with get_sub_account_kyc_status."
            : "Send the customer to widget_url to complete KYC. Check progress with get_sub_account_kyc_status.",
        http_status: res.status,
      });
    }),
  );
}
