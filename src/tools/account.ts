import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { digitsOnly } from "../config.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { PAGINATION_NOTE, handler, listField, ok, pageInfo, phoneNumber, redact, toE164 } from "../util.js";

type Rec = Record<string, unknown>;

const e164Path = (n: string) => encodeURIComponent(toE164(n));

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  // ── Phone numbers ────────────────────────────────────────────
  server.registerTool(
    "list_phone_numbers",
    {
      title: "List phone numbers",
      description:
        "List the phone numbers on this Vobiz account (and its sub-accounts) with status, capabilities, linked application and fees. Supports status filter and search. " + PAGINATION_NOTE + " Read-only.",
      inputSchema: {
        status: z
          .enum(["active", "pending_purchase", "pending_release", "released", "blocked", "quarantined"])
          .optional(),
        search: z
          .string()
          .regex(/^\+?\d{2,15}$/, "must be digits, optionally with a leading +")
          .optional()
          .describe("Filter by (part of) a phone number."),
        page: z.number().int().min(1).max(10000).optional(),
        per_page: z.number().int().min(1).max(100).optional().describe("Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (args) => {
      const page = args.page ?? 1;
      const perPage = args.per_page ?? ctx.cfg.defaultPageSize;
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/numbers"), {
        query: { status: args.status, search: args.search, page, per_page: perPage },
        route: "GET numbers",
      });
      const items = listField(res.data, "items");
      if (!items) {
        throw new VobizError("unexpected_response", "Vobiz returned phone numbers in an unexpected format.", res.status);
      }
      return ok({
        ok: true,
        numbers: items,
        pagination: pageInfo(page, perPage, items.length, res.data.total),
        ...(res.data.is_trial ? { is_trial: true, trial_message: res.data.trial_message ?? null } : {}),
      });
    }),
  );

  server.registerTool(
    "get_phone_number_details",
    {
      title: "Get phone number details",
      description:
        "Return the details (status, capabilities, application, sub-account, fees, billing dates) of ONE phone number on this account. Read-only.",
      inputSchema: { phone_number: phoneNumber.describe("The number in E.164, e.g. +919876543210.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ phone_number }) => {
      // number-service has no GET /numbers/{e164}; search the list and require an exact match.
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/numbers"), {
        query: { search: toE164(phone_number), per_page: 25 },
        route: "GET numbers?search",
      });
      const items = Array.isArray(res.data?.items) ? (res.data.items as Rec[]) : [];
      const match = items.find((n) => typeof n.e164 === "string" && digitsOnly(n.e164) === digitsOnly(phone_number));
      if (!match) throw new VobizError("not_found", "This phone number is not on this account.");
      return ok({ ok: true, number: match });
    }),
  );

  server.registerTool(
    "get_number_health",
    {
      title: "Get phone number health",
      description:
        "Return usage and health of one phone number on this account: spam flag, usage status and daily/hourly call statistics (answer rate, failed calls, minutes). Read-only.",
      inputSchema: {
        phone_number: phoneNumber.describe("The number in E.164."),
        granularity: z.enum(["daily", "hourly"]).optional().describe("Default daily."),
        days: z.number().int().min(1).max(90).optional().describe("Days of history for daily granularity (default 30, max 90)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ phone_number, granularity, days }) => {
      const res = await ctx.client.request<Rec>(
        "GET",
        ctx.client.accountPath(`/numbers/${e164Path(phone_number)}/health`),
        {
          query: { granularity: granularity ?? "daily", days: (granularity ?? "daily") === "daily" ? (days ?? 30) : undefined },
          route: "GET numbers/{e164}/health",
        },
      );
      return ok({ ok: true, health: res.data });
    }),
  );

  // ── Account ──────────────────────────────────────────────────
  server.registerTool(
    "get_account_details",
    {
      title: "Get account details",
      description:
        "Return this Vobiz account's profile: name, account type, status, CPS and concurrent-call limits, enabled features. Credentials are redacted. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      // No trailing slash: account-service would 307-redirect, which the gateway does not follow.
      let res;
      try {
        res = await ctx.client.request<Rec>("GET", ctx.client.accountPath(""), { route: "GET Account/{id}" });
      } catch (err) {
        if (err instanceof VobizError && err.kind === "forbidden" && ctx.client.authId.startsWith("SA_")) {
          throw new VobizError(
            "forbidden",
            "Vobiz only returns account details to main-account (MA_) credentials; this server uses a sub-account. Balance, concurrency and numbers are still available.",
            err.status,
          );
        }
        throw err;
      }
      // account-service answers mismatches with HTTP 200 {status:"fail"}.
      // Older responses wrap the profile in `data`; current ones return it at the top level.
      const profile = (res.data?.data ?? res.data) as Rec | undefined;
      if (res.data?.status === "fail" || !profile || typeof profile !== "object" || !("auth_id" in profile || "id" in profile)) {
        throw new VobizError("not_found", "Vobiz did not return details for this account.", res.status);
      }
      const { status: _s, message: _m, ...account } = profile;
      return ok({ ok: true, account: redact(account) });
    }),
  );

  server.registerTool(
    "get_account_balance",
    {
      title: "Get account balance",
      description:
        "Return the account balance: balance, available balance, reserved funds, credit limit and postpaid flag. Without `currency` it returns every wallet on the account (accounts can be billed in INR, USD or other currencies). Read-only.",
      inputSchema: {
        currency: z
          .string()
          .regex(/^[A-Za-z]{3}$/, "must be a 3-letter currency code")
          .optional()
          .describe("ISO currency code, e.g. INR or USD. Omit to list every wallet."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ currency }) => {
      if (!currency) {
        const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/balance"), { route: "GET balance" });
        const balances = Array.isArray(res.data?.balances) ? (res.data.balances as Rec[]) : [];
        return ok({ ok: true, count: balances.length, balances, balance: balances[0] ?? null });
      }
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath(`/balance/${currency.toUpperCase()}`), {
        route: "GET balance/{currency}",
      });
      return ok({ ok: true, balance: res.data });
    }),
  );

  server.registerTool(
    "get_concurrency",
    {
      title: "Get call concurrency",
      description: "Return how many calls are running right now versus the account's maximum concurrent calls. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/concurrency"), { route: "GET concurrency" });
      return ok({ ok: true, concurrency: res.data });
    }),
  );

  // ── SIP trunks ───────────────────────────────────────────────
  const TRUNK_SECRETS = ["username", "password"];

  server.registerTool(
    "list_sip_trunks",
    {
      title: "List SIP trunks",
      description:
        "List SIP trunks on this account: name, domain, status, direction, CPS and concurrent-call limits. SIP credentials are redacted. " + PAGINATION_NOTE + " Read-only.",
      inputSchema: {
        direction: z.enum(["inbound", "outbound", "both"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ direction, limit, offset }) => {
      const lim = limit ?? ctx.cfg.defaultPageSize;
      const off = offset ?? 0;
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/trunks"), {
        query: { direction, limit: lim, offset: off },
        route: "GET trunks",
      });
      // trunk-service returns {"meta":{...},"objects":null} when the account has no trunks.
      const trunks = listField(res.data, "objects");
      if (!trunks) {
        throw new VobizError("unexpected_response", "Vobiz returned trunks in an unexpected format.", res.status);
      }
      const total = (res.data.meta as Rec | undefined)?.total;
      const hasMore = typeof total === "number" ? off + trunks.length < total : trunks.length === lim;
      return ok({
        ok: true,
        count: trunks.length,
        trunks: redact(trunks, TRUNK_SECRETS),
        pagination: { limit: lim, offset: off, total: typeof total === "number" ? total : null, has_more: hasMore, next_offset: hasMore ? off + lim : null },
      });
    }),
  );

  server.registerTool(
    "get_sip_trunk",
    {
      title: "Get SIP trunk",
      description:
        "Return one SIP trunk's configuration (domain, status, direction, limits, transport, recording). SIP credentials are redacted. Read-only.",
      inputSchema: {
        trunk_id: z
          .string()
          .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a trunk UUID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ trunk_id }) => {
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath(`/trunks/${trunk_id}`), {
        route: "GET trunks/{id}",
      });
      return ok({ ok: true, trunk: redact(res.data, TRUNK_SECRETS) });
    }),
  );
}
