import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { CALL_UNTRUSTED_FIELDS, outcomeFields } from "./calls.js";
import { UNTRUSTED_DESCRIPTION, markUntrusted, withUntrustedNotice } from "../guard/untrusted.js";
import { VobizError } from "../errors.js";
import { PAGINATION_NOTE, callId, handler, isoDate, listField, ok, pageInfo, phoneNumber } from "../util.js";

type Rec = Record<string, unknown>;

/** cdr-api has no range limit and returns 500 when a scan exceeds its DB timeout, so we cap it here. */
export const MAX_CDR_RANGE_DAYS = 92;

export function registerRecordTools(server: McpServer, ctx: ToolContext): void {
  // ── get_call_details ─────────────────────────────────────────
  server.registerTool(
    "get_call_details",
    {
      title: "Get call details",
      description:
        "Return the full call detail record (CDR) of a COMPLETED call: direction, numbers, start/answer/end time, duration, billed seconds, hangup cause, cost, quality (MOS, jitter). " +
        "For a call still in progress use get_call_status. Read-only." + UNTRUSTED_DESCRIPTION,
      inputSchema: { call_uuid: callId.describe("UUID of the call.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid }) => {
      try {
        const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath(`/cdr/${encodeURIComponent(call_uuid)}`), {
          route: "GET cdr/{uuid}",
        });
        const record = (res.data?.data ?? null) as Rec | null;
        if (!record || typeof record !== "object") {
          throw new VobizError("unexpected_response", "Vobiz returned a call record in an unexpected format.", res.status);
        }
        return ok(withUntrustedNotice({ ok: true, call_uuid, ...outcomeFields(record), record: markUntrusted(record) }, CALL_UNTRUSTED_FIELDS));
      } catch (err) {
        if (err instanceof VobizError && err.kind === "not_found") {
          throw new VobizError(
            "not_found",
            "No completed call record with this ID on this account. If the call is still active use get_call_status; a just-ended call can take a short while to appear.",
            err.status,
          );
        }
        throw err;
      }
    }),
  );

  // ── list_call_records ────────────────────────────────────────
  server.registerTool(
    "list_call_records",
    {
      title: "List call records",
      description:
        "List completed call records (CDRs) for this account, newest first, with pagination and a summary (total, answered, answer rate, duration, cost). " +
        `Optional filters: start_date/end_date (YYYY-MM-DD, max ${MAX_CDR_RANGE_DAYS} days apart), call_direction, from_number, to_number, hangup_cause, min/max duration. ` +
        "Filter by hangup_cause (e.g. NORMAL_CLEARING for answered, NO_ANSWER, USER_BUSY) to find answered, missed or busy calls. " +
        PAGINATION_NOTE +
        " Read-only." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: {
        start_date: isoDate.optional().describe("Start of range, YYYY-MM-DD."),
        end_date: isoDate.optional().describe("End of range, YYYY-MM-DD (inclusive)."),
        call_direction: z.enum(["inbound", "outbound"]).optional(),
        from_number: phoneNumber.optional().describe("Caller number (partial match on the backend)."),
        to_number: phoneNumber.optional().describe("Destination number (partial match on the backend)."),
        hangup_cause: z
          .string()
          .regex(/^[A-Z_]{3,64}$/, "must be an uppercase hangup cause such as NORMAL_CLEARING")
          .optional(),
        min_duration: z.number().int().min(0).optional().describe("Minimum duration in seconds."),
        max_duration: z.number().int().min(0).optional().describe("Maximum duration in seconds."),
        page: z.number().int().min(1).max(10000).optional().describe("Page number (default 1)."),
        per_page: z.number().int().min(1).max(100).optional().describe("Records per page, max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
        include_summary: z.boolean().optional().describe("Include the aggregate summary block (default true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (args) => {
      if ((args.start_date && !args.end_date) || (!args.start_date && args.end_date)) {
        throw new VobizError("invalid_input", "Provide both start_date and end_date, or neither.");
      }
      if (args.start_date && args.end_date) {
        const s = Date.parse(args.start_date + "T00:00:00Z");
        const e = Date.parse(args.end_date + "T00:00:00Z");
        if (e < s) throw new VobizError("invalid_input", "end_date must be on or after start_date.");
        if ((e - s) / 86_400_000 > MAX_CDR_RANGE_DAYS) {
          throw new VobizError("invalid_input", `The date range may span at most ${MAX_CDR_RANGE_DAYS} days.`);
        }
      }
      if (args.min_duration !== undefined && args.max_duration !== undefined && args.max_duration < args.min_duration) {
        throw new VobizError("invalid_input", "max_duration must be greater than or equal to min_duration.");
      }

      const page = args.page ?? 1;
      const perPage = args.per_page ?? ctx.cfg.defaultPageSize;
      let res;
      try {
        res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/cdr"), {
        query: {
          start_date: args.start_date,
          end_date: args.end_date,
          call_direction: args.call_direction,
          from_number: args.from_number?.replace(/^\+/, ""),
          to_number: args.to_number?.replace(/^\+/, ""),
          hangup_cause: args.hangup_cause,
          min_duration: args.min_duration,
          max_duration: args.max_duration,
          page,
          per_page: perPage,
          summary: args.include_summary === false ? "false" : undefined,
        },
        route: "GET cdr",
      });
      } catch (err) {
        // A list endpoint never 404s for an empty result: a 404 here means the CDR service route is down.
        if (err instanceof VobizError && err.kind === "not_found") {
          throw new VobizError("service_unavailable", "The Vobiz call-records service is not answering this route (HTTP 404). Try again later or check Vobiz status.", err.status);
        }
        throw err;
      }
      const data = res.data;
      const records = listField(data, "data");
      if (!records) {
        throw new VobizError("unexpected_response", "Vobiz returned call records in an unexpected format.", res.status);
      }
      return ok(
        withUntrustedNotice(
          {
            ok: true,
            count: records.length,
            records: records.map(markUntrusted),
            pagination: pageInfo(page, perPage, records.length, (data.pagination as Rec | undefined)?.total),
            summary: data.summary ?? null,
          },
          CALL_UNTRUSTED_FIELDS,
        ),
      );
    }),
  );

  // ── get_call_recording ───────────────────────────────────────
  server.registerTool(
    "get_call_recording",
    {
      title: "Get call recording",
      description:
        "Find the recording(s) of a call on this account and return their metadata and recording_url. Provide exactly one of call_uuid or recording_id. " +
        "Not every call is recorded: an empty result means no recording exists. Recording URLs give access to call audio, so share them only with the account owner. Read-only.",
      inputSchema: {
        call_uuid: callId.optional().describe("UUID of the call whose recordings to find."),
        recording_id: z
          .string()
          .regex(/^[A-Za-z0-9_-]{4,64}$/, "must be a Vobiz recording ID")
          .optional()
          .describe("A specific recording ID."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid, recording_id }) => {
      if (!!call_uuid === !!recording_id) {
        throw new VobizError("invalid_input", "Provide exactly one of call_uuid or recording_id.");
      }
      if (recording_id) {
        try {
          const res = await ctx.client.request<Rec>(
            "GET",
            ctx.client.accountPath(`/Recording/${encodeURIComponent(recording_id)}/`),
            { route: "GET Recording/{id}/" },
          );
          return ok({ ok: true, recording_id, recordings: [res.data], count: 1 });
        } catch (err) {
          if (err instanceof VobizError && err.kind === "not_found") {
            throw new VobizError("not_found", "No recording with this ID exists on this account.", err.status);
          }
          throw err;
        }
      }
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/Recording/"), {
        query: { call_uuid, limit: 20 },
        route: "GET Recording/?call_uuid",
      });
      const objects = listField(res.data, "objects");
      if (!objects) {
        throw new VobizError("unexpected_response", "Vobiz returned recordings in an unexpected format.", res.status);
      }
      // Defence in depth: only return recordings that belong to the requested call.
      const recordings = (objects as Rec[]).filter((r) => r.call_uuid === call_uuid);
      return ok({
        ok: true,
        call_uuid,
        count: recordings.length,
        recordings,
        note: recordings.length ? undefined : "No recording exists for this call (it may not have been recorded).",
      });
    }),
  );

  // ── list_recordings ──────────────────────────────────────────
  server.registerTool(
    "list_recordings",
    {
      title: "List recordings",
      description:
        "List call recordings on this account (including its sub-accounts), newest first, with recording_url, call_uuid, numbers and duration. " +
        "Optional from_date/to_date (YYYY-MM-DD). Vobiz returns at most 20 per page. " +
        PAGINATION_NOTE +
        " Recording URLs give access to call audio, so share them only with the account owner. Read-only.",
      inputSchema: {
        from_date: isoDate.optional().describe("Earliest recording date, YYYY-MM-DD."),
        to_date: isoDate.optional().describe("Latest recording date, YYYY-MM-DD."),
        limit: z.number().int().min(1).max(20).optional().describe("Max 20 (Vobiz limit). Default 20."),
        offset: z.number().int().min(0).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ from_date, to_date, limit, offset }) => {
      if (from_date && to_date && Date.parse(to_date) < Date.parse(from_date)) {
        throw new VobizError("invalid_input", "to_date must be on or after from_date.");
      }
      const lim = limit ?? 20;
      const off = offset ?? 0;
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/Recording/"), {
        query: { limit: lim, offset: off, from_date, to_date },
        route: "GET Recording/",
      });
      const recordings = listField(res.data, "objects");
      if (!recordings) {
        throw new VobizError("unexpected_response", "Vobiz returned recordings in an unexpected format.", res.status);
      }
      const total = (res.data.meta as Rec | undefined)?.total_count;
      const hasMore = typeof total === "number" ? off + recordings.length < total : recordings.length === lim;
      return ok({
        ok: true,
        count: recordings.length,
        recordings,
        pagination: {
          limit: lim,
          offset: off,
          total: typeof total === "number" ? total : null,
          has_more: hasMore,
          next_offset: hasMore ? off + lim : null,
        },
      });
    }),
  );
}
