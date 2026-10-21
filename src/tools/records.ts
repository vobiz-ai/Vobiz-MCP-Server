import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { CALL_UNTRUSTED_FIELDS, outcomeFields } from "./calls.js";
import { UNTRUSTED_DESCRIPTION, markUntrusted, withUntrustedNotice } from "../guard/untrusted.js";
import { VobizError } from "../errors.js";
import { callId, handler, isoDate, listField, ok, pageInfo, phoneNumber } from "../util.js";

type Rec = Record<string, unknown>;

/** cdr-api has no range limit and returns 500 when a scan exceeds its DB timeout, so we cap it here. */
export const MAX_CDR_RANGE_DAYS = 92;

// ── Output schema building blocks ───────────────────────────────
const untrustedOut = {
  notice: z.string().optional().describe("Reminder that caller names and similar fields were written by third parties."),
  untrusted_fields: z.array(z.string()).optional().describe("Names of the record fields that hold third-party text."),
};
const recordingItem = z
  .unknown()
  .describe("One recording as Vobiz returns it: recording_id, call_uuid, recording_url, from/to numbers, duration, file format and timestamps.");
const offsetPage = z
  .object({
    limit: z.number().optional().describe("Page size that was applied."),
    offset: z.number().optional().describe("Offset that was applied."),
    total: z.number().nullable().optional().describe("Total matching recordings, or null when Vobiz did not report it."),
    has_more: z.boolean().optional().describe("True when another page exists."),
    next_offset: z.number().nullable().optional().describe("Offset to pass for the next page, or null on the last page."),
  })
  .passthrough();

export function registerRecordTools(server: McpServer, ctx: ToolContext): void {
  // ── get_call_details ─────────────────────────────────────────
  server.registerTool(
    "get_call_details",
    {
      title: "Get call details",
      description:
        "Return the full call detail record (CDR) of one COMPLETED call by call_uuid: direction, numbers, start/answer/end times, duration and billed seconds, hangup cause, cost and currency, quality (MOS, jitter, packet loss), " +
        "plus a derived `outcome` (answered, busy, no_answer, ...) and `retry_may_succeed`. " +
        "For a call that is still ringing or connected use get_call_status; to find calls by number, date or hangup cause use list_call_records. " +
        "A call_uuid that is unknown or still active returns the not_found error, and a call that just ended can take a short while to appear." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: { call_uuid: callId.describe("UUID of the completed call: request_uuid from make_call, or call_uuid from list_call_records or a hangup callback.") },
      outputSchema: z
        .object({
          ok: z.literal(true),
          call_uuid: z.string().optional().describe("The call UUID that was looked up."),
          outcome: z
            .string()
            .optional()
            .describe("Derived from hangup_cause and billsec: answered, busy, no_answer, rejected, invalid_number, unreachable, network_failure, cancelled, not_allowed, failed or unknown."),
          typical_sip_code: z.number().nullable().optional().describe("SIP response code usually behind this hangup cause (e.g. 486 for USER_BUSY), or null when none applies."),
          retry_may_succeed: z.boolean().optional().describe("True when the cause is transient (busy, no answer, network failure) so a later attempt may connect."),
          record: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("The CDR as Vobiz returns it: call_direction, caller_id_number, destination_number, start_time, answer_time, end_time, duration, billsec, hangup_cause, hangup_cause_code, cost, currency, mos, jitter, packet_loss and more, with untrusted: true added."),
          ...untrustedOut,
        })
        .passthrough(),
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
        "List completed call records (CDRs) on this account, newest first, 20 per page by default (max 100), with a `summary` block (total calls, answered, answer rate, duration, cost) computed over the whole filtered set. " +
        `Filter by date range (start_date and end_date together, at most ${MAX_CDR_RANGE_DAYS} days apart), call_direction, from_number, to_number, hangup_cause and min/max duration; omitted filters are not applied. ` +
        "For one call's full CDR use get_call_details; for calls ringing or connected right now use list_live_calls. " +
        "Paging is stateless: pass page and per_page on every call and stop when pagination.has_more is false." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: {
        start_date: isoDate.optional().describe("First day of the range, YYYY-MM-DD (UTC). Must be given together with end_date."),
        end_date: isoDate.optional().describe(`Last day of the range, YYYY-MM-DD, inclusive. Must be given together with start_date and be at most ${MAX_CDR_RANGE_DAYS} days after it.`),
        call_direction: z
          .enum(["inbound", "outbound"])
          .optional()
          .describe("Only calls in this direction: inbound (received on one of your numbers or trunks) or outbound (placed from this account). Omit for both."),
        from_number: phoneNumber.optional().describe("Caller number to match (digits, leading + optional); the backend matches on part of the number."),
        to_number: phoneNumber.optional().describe("Destination number to match (digits, leading + optional); the backend matches on part of the number."),
        hangup_cause: z
          .string()
          .regex(/^[A-Z_]{3,64}$/, "must be an uppercase hangup cause such as NORMAL_CLEARING")
          .optional()
          .describe(
            "Only calls that ended with this telephony hangup cause, uppercase. Common values: NORMAL_CLEARING (a party hung up normally; answered calls), USER_BUSY (callee busy or declined), NO_ANSWER (rang out), " +
              "ORIGINATOR_CANCEL (caller gave up before answer), CALL_REJECTED, UNALLOCATED_NUMBER or INVALID_NUMBER (bad destination), SERVICE_UNAVAILABLE, NORMAL_TEMPORARY_FAILURE or SWITCH_CONGESTION (carrier or network trouble), MEDIA_TIMEOUT (no audio packets), UNKNOWN.",
          ),
        min_duration: z.number().int().min(0).optional().describe("Only calls whose total duration (ring + talk) is at least this many seconds."),
        max_duration: z.number().int().min(0).optional().describe("Only calls whose total duration is at most this many seconds; must not be below min_duration."),
        page: z.number().int().min(1).max(10000).optional().describe("1-based page number (default 1). Use pagination.next_page from the previous result."),
        per_page: z.number().int().min(1).max(100).optional().describe("Records per page, 1-100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
        include_summary: z.boolean().optional().describe("Set false to leave out the aggregate summary block (default true)."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          count: z.number().optional().describe("Number of records on this page."),
          records: z
            .array(z.unknown())
            .optional()
            .describe("CDRs on this page, newest first, each with call_direction, caller_id_number, destination_number, start_time, duration, billsec, hangup_cause, cost and currency, plus untrusted: true."),
          pagination: z
            .object({
              page: z.number().optional().describe("Page that was returned."),
              per_page: z.number().optional().describe("Page size that was applied."),
              total: z.number().nullable().optional().describe("Total matching records, or null when Vobiz did not report it."),
              returned: z.number().optional().describe("Records on this page."),
              has_more: z.boolean().optional().describe("True when another page exists."),
              next_page: z.number().nullable().optional().describe("Page number to pass next, or null on the last page."),
            })
            .passthrough()
            .optional(),
          summary: z.unknown().describe("Aggregate block over the whole filtered set (total calls, answered, answer rate, duration, cost), or null when include_summary is false."),
          ...untrustedOut,
        })
        .passthrough(),
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
        "Find the recording(s) of one call on this account and return their metadata and recording_url (GET /Recording/). Pass exactly one of call_uuid (every recording of that call, up to 20) or recording_id (that one recording). " +
        "Not every call is recorded: an unrecorded or unknown call_uuid returns ok with count 0, while an unknown recording_id returns the not_found error. " +
        "To browse recordings across calls or by date use list_recordings. Recording URLs give access to call audio, so share them only with the account owner.",
      inputSchema: {
        call_uuid: callId.optional().describe("UUID of the call whose recordings to find. Leave out when passing recording_id."),
        recording_id: z
          .string()
          .regex(/^[A-Za-z0-9_-]{4,64}$/, "must be a Vobiz recording ID")
          .optional()
          .describe("ID of one recording, as returned by list_recordings or a recording callback. Leave out when passing call_uuid."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          call_uuid: z.string().optional().describe("Echo of the call_uuid that was searched, when that form was used."),
          recording_id: z.string().optional().describe("Echo of the recording_id that was fetched, when that form was used."),
          count: z.number().optional().describe("Number of recordings returned (0 when the call was not recorded)."),
          recordings: z.array(recordingItem).optional().describe("The recordings found, each with its recording_url."),
          note: z.string().optional().describe("Present when no recording exists for the call."),
        })
        .passthrough(),
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
        "List call recordings on this account and its sub-accounts, newest first, with recording_url, call_uuid, numbers and duration (GET /Recording/). " +
        "Optional from_date/to_date narrow by recording date; omitted, every recording is eligible. Vobiz returns at most 20 per page: pass limit and offset on every call (nothing is kept between calls) and follow pagination.next_offset until has_more is false. " +
        "For the recordings of one known call use get_call_recording. Recording URLs give access to call audio, so share them only with the account owner.",
      inputSchema: {
        from_date: isoDate.optional().describe("Earliest recording date to include, YYYY-MM-DD."),
        to_date: isoDate.optional().describe("Latest recording date to include, YYYY-MM-DD; must not be before from_date."),
        limit: z.number().int().min(1).max(20).optional().describe("Page size, 1-20 (Vobiz caps a page at 20). Default 20."),
        offset: z.number().int().min(0).max(1_000_000).optional().describe("Number of recordings to skip before the page starts (default 0). Pass pagination.next_offset from the previous page."),
      },
      outputSchema: z
        .object({
          ok: z.literal(true),
          count: z.number().optional().describe("Number of recordings on this page."),
          recordings: z.array(recordingItem).optional().describe("Recordings on this page, newest first."),
          pagination: offsetPage.optional(),
        })
        .passthrough(),
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
