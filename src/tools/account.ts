import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { digitsOnly } from "../config.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { handler, listField, ok, pageInfo, phoneNumber, redact, toE164 } from "../util.js";

type Rec = Record<string, unknown>;

const e164Path = (n: string) => encodeURIComponent(toE164(n));

// ── Output schema building blocks ───────────────────────────────
const numberItem = z
  .unknown()
  .describe("One phone number as Vobiz returns it: e164, status, capabilities (voice, sms...), linked application, sub-account, monthly and setup fees, billing dates.");
const balanceItem = z
  .unknown()
  .describe("One wallet: currency, balance, available_balance, reserved_funds, promotional_balance, credit_limit, credit_limit_type, is_postpaid, low_balance_threshold, status.");
const trunkItem = z
  .unknown()
  .describe("One SIP trunk: id, name, domain, status, direction, CPS and concurrent-call limits, transport, recording settings; username and password are \"[redacted]\".");

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  // ── Phone numbers ────────────────────────────────────────────
  server.registerTool(
    "list_phone_numbers",
    {
      title: "List phone numbers",
      description:
        "List the phone numbers on this Vobiz account and its sub-accounts with status, capabilities, linked application and fees (GET /numbers). " +
        "Optional status filter and number search; omitted filters are not applied. Paging is stateless: pass page and per_page on every call and stop when pagination.has_more is false. " +
        "For one number's details use get_phone_number_details; for only the numbers that can send SMS/MMS use list_messaging_numbers.",
      inputSchema: {
        status: z
          .enum(["active", "pending_purchase", "pending_release", "released", "blocked", "quarantined"])
          .optional()
          .describe("Only numbers in this state: active (in service), pending_purchase, pending_release, released (no longer on the account), blocked or quarantined. Omit for every state."),
        search: z
          .string()
          .regex(/^\+?\d{2,15}$/, "must be digits, optionally with a leading +")
          .optional()
          .describe("Digits to match anywhere in the number (leading + optional), e.g. 91987 or +14155550123."),
        page: z.number().int().min(1).max(10000).optional().describe("1-based page number (default 1). Use pagination.next_page from the previous result."),
        per_page: z.number().int().min(1).max(100).optional().describe("Numbers per page, 1-100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          numbers: z.array(numberItem).optional().describe("Numbers on this page."),
          pagination: z
            .object({
              page: z.number().optional().describe("Page that was returned."),
              per_page: z.number().optional().describe("Page size that was applied."),
              total: z.number().nullable().optional().describe("Total matching numbers, or null when Vobiz did not report it."),
              returned: z.number().optional().describe("Numbers on this page."),
              has_more: z.boolean().optional().describe("True when another page exists."),
              next_page: z.number().nullable().optional().describe("Page number to pass next, or null on the last page."),
            })
            .passthrough()
            .optional(),
          is_trial: z.boolean().optional().describe("Present and true when the account is still a trial account."),
          trial_message: z.unknown().optional().describe("Vobiz's note about trial limits, when is_trial is true."),
        })
        .passthrough(),
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
        "Return ONE phone number on this account by its E.164 value: status, capabilities, linked application, sub-account, fees and billing dates. " +
        "The number must belong to this account or one of its sub-accounts; any other number returns the not_found error. " +
        "To browse or search numbers use list_phone_numbers; for spam flags and call statistics use get_number_health.",
      inputSchema: { phone_number: phoneNumber.describe("The number to look up, E.164 with or without the leading +, e.g. +919876543210. Must match exactly.") },
      outputSchema: z
        .object({
          ok: z.literal(true),
          number: numberItem.optional(),
        })
        .passthrough(),
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
        "Return usage and health of one phone number on this account (GET /numbers/{e164}/health): spam flag, usage status and call statistics (answer rate, failed calls, minutes) bucketed per day or per hour. " +
        "Use it to judge whether a caller ID is being flagged or over-used; for the number's configuration and fees use get_phone_number_details. " +
        "`days` sets the history window for daily granularity only and is ignored for hourly.",
      inputSchema: {
        phone_number: phoneNumber.describe("The number to inspect, E.164 (leading + optional); must be on this account."),
        granularity: z.enum(["daily", "hourly"]).optional().describe("Bucket size for the statistics: daily (default) or hourly."),
        days: z.number().int().min(1).max(90).optional().describe("Days of history for daily granularity, 1-90 (default 30). Ignored when granularity is hourly."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          health: z.unknown().optional().describe("Vobiz's health report: spam flag, usage status and the per-day or per-hour statistics (calls, answered, failed, answer rate, minutes)."),
        })
        .passthrough(),
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
        "Return this Vobiz account's profile (GET /Account/{id}): name, account type, status, CPS and concurrent-call limits and enabled features. Auth tokens and other secrets are replaced by \"[redacted]\". " +
        "Only main-account (MA_) credentials can read it: with sub-account (SA_) credentials the forbidden error is returned, while get_account_balance, get_concurrency and list_phone_numbers still work. " +
        "For money use get_account_balance; for live call capacity use get_concurrency.",
      inputSchema: {},
      outputSchema: z
        .object({
          ok: z.literal(true),
          account: z.record(z.string(), z.unknown()).optional().describe("The profile: auth_id, name, account type, status, CPS and concurrency limits, enabled features; secret fields hold \"[redacted]\"."),
        })
        .passthrough(),
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
        "Return this account's wallet balance (GET /balance): balance, available_balance, reserved_funds, credit_limit, is_postpaid and status, per currency. " +
        "Without `currency` every wallet is returned in `balances` (accounts can be billed in INR, USD or other currencies) and the first one is repeated as `balance`; with `currency` only that wallet is returned as `balance`. " +
        "For the charges and top-ups behind the balance use list_transactions.",
      inputSchema: {
        currency: z
          .string()
          .regex(/^[A-Za-z]{3}$/, "must be a 3-letter currency code")
          .optional()
          .describe("ISO 4217 code of one wallet, e.g. INR or USD (case-insensitive). Omit to return every wallet."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          count: z.number().optional().describe("Number of wallets returned; present only when currency was omitted."),
          balances: z.array(balanceItem).optional().describe("Every wallet on the account; present only when currency was omitted."),
          balance: z.unknown().optional().describe("The requested wallet, or the first wallet when currency was omitted (null when the account has none)."),
        })
        .passthrough(),
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
      description:
        "Return this account's live call capacity (GET /concurrency): concurrent_calls running right now, the max_concurrent the account may run and utilization_pct. " +
        "It is a count, not a list: to see which calls are live use list_live_calls. Use it before a batch of make_call requests to avoid hitting the concurrency limit.",
      inputSchema: {},
      outputSchema: z
        .object({
          ok: z.literal(true),
          concurrency: z
            .object({
              account_id: z.string().optional().describe("Account the figures belong to."),
              concurrent_calls: z.number().optional().describe("Calls in progress at this moment."),
              max_concurrent: z.number().optional().describe("Maximum simultaneous calls the account may run."),
              utilization_pct: z.number().optional().describe("concurrent_calls as a percentage of max_concurrent."),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
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
        "List the SIP trunks on this account (GET /trunks): name, domain, status, direction, CPS and concurrent-call limits. SIP username and password are replaced by \"[redacted]\". " +
        "Paging is stateless: pass limit and offset on every call and follow pagination.next_offset until has_more is false. " +
        "For one trunk's full configuration use get_sip_trunk.",
      inputSchema: {
        direction: z.enum(["inbound", "outbound", "both"]).optional().describe("Only trunks of this direction: inbound, outbound, or both. Omit to list every trunk."),
        limit: z.number().int().min(1).max(100).optional().describe("Trunks per page, 1-100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
        offset: z.number().int().min(0).optional().describe("Number of trunks to skip before the page starts (default 0). Pass pagination.next_offset from the previous page."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          count: z.number().optional().describe("Number of trunks on this page."),
          trunks: z.array(trunkItem).optional().describe("Trunks on this page."),
          pagination: z
            .object({
              limit: z.number().optional().describe("Page size that was applied."),
              offset: z.number().optional().describe("Offset that was applied."),
              total: z.number().nullable().optional().describe("Total trunks on the account, or null when Vobiz did not report it."),
              has_more: z.boolean().optional().describe("True when another page exists."),
              next_offset: z.number().nullable().optional().describe("Offset to pass for the next page, or null on the last page."),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
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
        "Return one SIP trunk's full configuration by trunk_id (GET /trunks/{id}): domain, status, direction, CPS and concurrent-call limits, transport and recording settings. SIP username and password are replaced by \"[redacted]\". " +
        "A trunk_id that is not on this account returns the not_found error. To find trunk IDs use list_sip_trunks.",
      inputSchema: {
        trunk_id: z
          .string()
          .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a trunk UUID")
          .describe("Trunk UUID, as returned by list_sip_trunks or create_sip_trunk."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          trunk: trunkItem.optional(),
        })
        .passthrough(),
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
