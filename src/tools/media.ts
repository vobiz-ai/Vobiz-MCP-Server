/**
 * Live-call audio streams, billing ledger, recording deletion and number lifecycle.
 *
 * Contracts (openapi.yaml + docs pages):
 *   POST|GET Call/{uuid}/Stream/                 start (service_url, bidirectional, audio_track, content_type,
 *                                                stream_timeout, status_callback_url/method, extra_headers) | list (limit/offset)
 *   GET|DELETE Call/{uuid}/Stream/{stream_id}/   retrieve | stop (204)
 *   GET transactions, GET transactions/reference-types
 *   DELETE Recording/{id}/                       204
 *   DELETE numbers/{e164}?immediate              release (fee charged; 24-hour cancellable cooldown unless immediate)
 *   POST /api/v1/account/{id}/numbers/{e164}/cancel-release           (lowercase "account" per the spec)
 *   POST|DELETE /api/v1/account/{id}/numbers/{e164}/assign-subaccount {sub_account_id}  (lowercase too)
 *
 * The REST stream route only honours bidirectional as the JSON string "true" (a boolean silently
 * yields a one-way stream), and bidirectional streams require audio_track=inbound. Both are handled here.
 * Every lowercase /account/ path is built from the configured auth ID, never from tool input.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { CONFIRM_NOTE, hostOf, requireApproval, supportsFormElicitation, type ToolExtra } from "../guard/confirm.js";
import { assertAllowedUrl, callId, handler, isPrivateHost, listField, ok, pageInfo, phoneNumber, toE164 } from "../util.js";
import { callAction } from "./control.js";

type Rec = Record<string, unknown>;

const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly approved: ${what}.` + CONFIRM_NOTE);
const e164Path = (n: string) => encodeURIComponent(toE164(n));
const streamId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{4,64}$/, "must be a Vobiz stream ID")
  .describe("The stream's ID: stream_id as returned by start_audio_stream or listed by list_audio_streams.");
const recordingId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{4,64}$/, "must be a Vobiz recording ID")
  .describe("The recording's ID, from list_recordings or get_call_recording.");
const subAccountId = z
  .string()
  .trim()
  .regex(/^SA_[A-Za-z0-9]{4,40}$/, "must be a Vobiz sub-account Auth ID such as SA_XXXXXXXX")
  .describe("Auth ID (SA_...) of the sub-account that will own the number, from list_sub_accounts.");
const uuidStr = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a UUID");
const ledgerDate = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/,
    "must be YYYY-MM-DD or an ISO 8601 timestamp such as 2026-08-28T00:00:00+05:30",
  )
  .refine((s) => !Number.isNaN(Date.parse(s.length === 10 ? s + "T00:00:00Z" : s)), { message: "is not a real date" });

// ── Output shapes: every field optional so validation never fails; ok is a boolean because clients validate error results too ──
const okOut = z.boolean().optional().describe("true on success; false (with error and message) when the tool failed.");
const httpStatus = z.number().optional().describe("HTTP status Vobiz answered with.");
const backendMessage = z.unknown().optional().describe("Message from Vobiz about the operation, or null.");
const e164Out = z.string().optional().describe("The number, E.164.");
const streamOut = z
  .record(z.string(), z.unknown())
  .describe("The stream as Vobiz returns it: stream_id, status, service_url, audio_track, content_type, bidirectional, start and end time.");
const pageOut = z
  .object({
    page: z.number().optional().describe("Page that was returned (1-based)."),
    per_page: z.number().optional().describe("Page size used for this request."),
    total: z.number().nullable().optional().describe("Total entries matching the filters, or null when Vobiz did not report it."),
    returned: z.number().optional().describe("Number of entries in this page."),
    has_more: z.boolean().optional().describe("true when another page exists."),
    next_page: z.number().nullable().optional().describe("Page to request next, or null on the last page."),
  })
  .passthrough()
  .describe("Stateless paging block for the next call.");

/** Paths the spec defines under lowercase `/account/`; scoped to the configured auth ID only. */
function lowerAccountPath(ctx: ToolContext, suffix: string): string {
  return `/api/v1/account/${encodeURIComponent(ctx.client.authId)}${suffix}`;
}

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

/** The wss:// counterpart of assertAllowedUrl: same host policy, WebSocket scheme only. */
export function assertAllowedWss(cfg: Config, url: string, field: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VobizError("invalid_input", `${field} is not a valid URL.`);
  }
  if (u.protocol !== "wss:") throw new VobizError("invalid_input", `${field} must be a secure WebSocket URL (wss://).`);
  if (u.username || u.password) throw new VobizError("invalid_input", `${field} must not contain credentials.`);
  if (cfg.allowAnyUrlHost) {
    if (isPrivateHost(u.hostname)) throw new VobizError("not_allowed", `${field} must be a public internet address that Vobiz can reach.`);
    return;
  }
  if (!cfg.allowedUrlHosts.includes(u.host.toLowerCase())) {
    throw new VobizError(
      "not_allowed",
      `${field} host ${u.host} is not approved. Allowed hosts: ${cfg.allowedUrlHosts.join(", ") || "(none configured)"}. An administrator can add it to VOBIZ_ALLOWED_URL_HOSTS.`,
    );
  }
}

/** GET on a call's streams; a 404 is reported as an unknown call or stream (it may be from an older call). */
async function streamRead(ctx: ToolContext, callUuid: string, suffix: string, route: string, query?: Record<string, number>): Promise<{ status: number; data: Rec }> {
  try {
    const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath(`/Call/${encodeURIComponent(callUuid)}/Stream/${suffix}`), { query, route });
    return { status: res.status, data: res.data ?? {} };
  } catch (err) {
    if (err instanceof VobizError && err.kind === "not_found") {
      throw new VobizError("not_found", "No such call or stream was found on this account.", err.status);
    }
    throw err;
  }
}

export function registerMediaTools(server: McpServer, ctx: ToolContext): void {
  const { cfg } = ctx;

  // ── Audio streams on a live call ─────────────────────────────
  server.registerTool(
    "start_audio_stream",
    {
      title: "Start an audio stream on a live call",
      description:
        "Fork the audio of a LIVE Vobiz call to your WebSocket server in near real time (POST /Call/{uuid}/Stream/), for example for live transcription or an AI voice agent. " +
        "service_url must be wss:// on an approved host. bidirectional: true lets your server play audio back into the call and requires audio_track inbound (the default when bidirectional). " +
        "content_type sets the inbound audio format (L16 8 kHz default, L16 16 kHz, or mu-law 8 kHz). Returns a stream_id for get_audio_stream / stop_audio_stream. " +
        "This sends live call audio to an external server, so it requires confirm: true after the user approves the destination. " +
        "Fails with call_not_active once the call has ended. To play audio into the call without a socket use play_audio; to see streams already running use list_audio_streams.",
      inputSchema: {
        call_uuid: callId.describe("UUID of the live call to fork: the request_uuid returned by make_call, or call_uuid from list_live_calls."),
        service_url: z.string().describe("wss:// URL of your WebSocket server. Its host must be on the server's VOBIZ_ALLOWED_URL_HOSTS allowlist (or be a public host when any host is allowed)."),
        bidirectional: z.boolean().optional().describe("Allow your server to send audio back into the call (playAudio). Default false."),
        audio_track: z.enum(["inbound", "outbound", "both"]).optional().describe("Which audio to fork. Default both; must be inbound when bidirectional is true."),
        content_type: z
          .enum(["audio/x-l16;rate=8000", "audio/x-l16;rate=16000", "audio/x-mulaw;rate=8000"])
          .optional()
          .describe("Inbound audio format sent to your server. Default audio/x-l16;rate=8000."),
        stream_timeout: z.number().int().min(1).max(86400).optional().describe("Stop the stream automatically after this many seconds. Default 86400."),
        status_callback_url: z.string().url().optional().describe("https URL (approved host) that receives stream status events (StartStream, PlayedStream, StopStream...)."),
        status_callback_method: z.enum(["GET", "POST"]).optional().describe("HTTP method for status_callback_url (default POST). Ignored without status_callback_url."),
        extra_headers: z
          .string()
          .max(1024)
          .regex(/^[A-Za-z0-9-]{1,64}:[^,\r\n]{1,256}(,[A-Za-z0-9-]{1,64}:[^,\r\n]{1,256})*$/, "must be comma-separated header:value pairs")
          .optional()
          .describe("Comma-separated header:value pairs (e.g. X-Session:abc123) passed with the stream. Use the wss:// URL path, not these headers, to authenticate the socket."),
        confirm: confirm("sending this call's live audio to this WebSocket server"),
      },
      outputSchema: z
        .object({
          ok: okOut,
          call_uuid: z.string().optional().describe("The call whose audio is being forked."),
          streaming: z.boolean().optional().describe("true once the stream is running."),
          stream_id: z.unknown().optional().describe("ID of the new stream for get_audio_stream and stop_audio_stream, or null if Vobiz did not return one."),
          bidirectional: z.boolean().optional().describe("Whether your server may send audio back into the call."),
          audio_track: z.string().optional().describe("Which side is forked: inbound, outbound or both."),
          backend_message: backendMessage,
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      const fallback = "Ask the user to approve streaming this call's audio to the given server, then call again with confirm: true.";
      if (a.confirm !== true && !supportsFormElicitation(server.server.getClientCapabilities())) throw new VobizError("confirmation_required", fallback);
      assertAllowedWss(cfg, a.service_url, "service_url");
      if (a.status_callback_url) assertAllowedUrl(cfg, a.status_callback_url, "status_callback_url");
      await requireApproval(server, extra, {
        confirmed: a.confirm,
        message: `Send the live audio of call ${a.call_uuid} to the WebSocket server at ${hostOf(a.service_url)}${a.bidirectional ? ", which may also play audio into the call" : ""}. Approve?`,
        fallback,
      });
      if (a.bidirectional && a.audio_track && a.audio_track !== "inbound") {
        throw new VobizError("invalid_input", "A bidirectional stream must use audio_track inbound. To capture both sides, start two one-way streams.");
      }
      const body: Rec = { service_url: a.service_url };
      if (a.bidirectional !== undefined) body.bidirectional = a.bidirectional ? "true" : "false";
      const track = a.audio_track ?? (a.bidirectional ? "inbound" : undefined);
      if (track) body.audio_track = track;
      for (const k of ["content_type", "stream_timeout", "status_callback_url", "status_callback_method", "extra_headers"] as const) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      const res = await callAction(ctx, "POST", a.call_uuid, "Stream/", "POST Call/{uuid}/Stream", { body });
      return ok({
        ok: true,
        call_uuid: a.call_uuid,
        streaming: true,
        stream_id: res.data.stream_id ?? null,
        bidirectional: a.bidirectional === true,
        audio_track: track ?? "both",
        backend_message: res.data.message ?? null,
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "list_audio_streams",
    {
      title: "List audio streams on a call",
      description:
        "List the audio streams started on one Vobiz call (GET /Call/{uuid}/Stream/), running and stopped alike, with status, WebSocket URL, track and audio format. " +
        "Use it to find stream_ids or check what is still streaming; for one stream's full record use get_audio_stream. " +
        "Pagination is stateless: pass limit and offset on every call and continue with pagination.next_offset while has_more is true. An unknown call fails with not_found.",
      inputSchema: {
        call_uuid: callId.describe("UUID of the call whose streams to list: the request_uuid returned by make_call, or call_uuid from list_live_calls or list_call_records."),
        limit: z.number().int().min(1).max(100).optional().describe("Streams per page, max 100 (default 20)."),
        offset: z.number().int().min(0).max(100000).optional().describe("Streams to skip before the first returned (default 0); use pagination.next_offset from the previous page."),
      },
      outputSchema: z
        .object({
          ok: okOut,
          call_uuid: z.string().optional().describe("The call that was queried."),
          count: z.number().optional().describe("Streams in this page."),
          streams: z.array(streamOut).optional().describe("The streams in this page."),
          pagination: z
            .object({
              limit: z.number().optional().describe("Page size used."),
              offset: z.number().optional().describe("Offset used."),
              total: z.number().nullable().optional().describe("Total streams on the call, or null when Vobiz did not report it."),
              has_more: z.boolean().optional().describe("true when another page exists."),
              next_offset: z.number().nullable().optional().describe("Offset for the next page, or null on the last page."),
            })
            .passthrough()
            .optional()
            .describe("Stateless paging block for the next call."),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid, limit, offset }) => {
      const lim = limit ?? 20;
      const off = offset ?? 0;
      const res = await streamRead(ctx, call_uuid, "", "GET Call/{uuid}/Stream", { limit: lim, offset: off });
      const streams = listField(res.data, "objects");
      if (!streams) throw new VobizError("unexpected_response", "Vobiz returned audio streams in an unexpected format.", res.status);
      const total = typeof res.data.total === "number" ? res.data.total : null;
      const hasMore = total !== null ? off + streams.length < total : streams.length === lim;
      return ok({
        ok: true,
        call_uuid,
        count: streams.length,
        streams,
        pagination: { limit: lim, offset: off, total, has_more: hasMore, next_offset: hasMore ? off + lim : null },
      });
    }),
  );

  server.registerTool(
    "get_audio_stream",
    {
      title: "Get an audio stream",
      description:
        "Return one audio stream on a Vobiz call (GET /Call/{uuid}/Stream/{stream_id}/): status, WebSocket URL, track, audio format, start and end time. " +
        "Use it to check whether a stream you started is still running or when it ended; for every stream on the call use list_audio_streams, and to end one use stop_audio_stream. " +
        "An unknown call or stream fails with not_found (streams of older calls may no longer be retrievable).",
      inputSchema: { call_uuid: callId.describe("UUID of the call the stream belongs to (request_uuid from make_call or call_uuid from list_live_calls)."), stream_id: streamId },
      outputSchema: z
        .object({
          ok: okOut,
          call_uuid: z.string().optional().describe("The call the stream belongs to."),
          stream: streamOut.optional(),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid, stream_id }) => {
      const res = await streamRead(ctx, call_uuid, `${encodeURIComponent(stream_id)}/`, "GET Call/{uuid}/Stream/{id}");
      return ok({ ok: true, call_uuid, stream: res.data });
    }),
  );

  server.registerTool(
    "stop_audio_stream",
    {
      title: "Stop an audio stream",
      description:
        "Stop one audio stream on a LIVE Vobiz call (DELETE /Call/{uuid}/Stream/{stream_id}/): the undo of start_audio_stream. Other streams on the call keep running, and the call itself continues; to end the call use end_call. " +
        "No confirmation is needed because it only stops something started on a call the user already placed. " +
        "If the call has ended, or the stream is unknown or already stopped, it fails with call_not_active and nothing is streaming for it.",
      inputSchema: { call_uuid: callId.describe("UUID of the live call the stream is on (request_uuid from make_call or call_uuid from list_live_calls)."), stream_id: streamId },
      outputSchema: z
        .object({
          ok: okOut,
          call_uuid: z.string().optional().describe("The call the stream was on."),
          stream_id: z.string().optional().describe("The stream that was stopped."),
          streaming: z.boolean().optional().describe("false once the stream is stopped."),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid, stream_id }) => {
      try {
        const res = await callAction(ctx, "DELETE", call_uuid, `Stream/${encodeURIComponent(stream_id)}/`, "DELETE Call/{uuid}/Stream/{id}");
        return ok({ ok: true, call_uuid, stream_id, streaming: false, http_status: res.status });
      } catch (err) {
        if (err instanceof VobizError && err.kind === "call_not_active") {
          throw new VobizError(
            "call_not_active",
            "The call is not live, or this stream is unknown or already stopped (for example because the caller hung up). Nothing is streaming for it now.",
            err.status,
          );
        }
        throw err;
      }
    }),
  );

  // ── Billing ledger ───────────────────────────────────────────
  server.registerTool(
    "list_transactions",
    {
      title: "List account transactions",
      description:
        "List this Vobiz account's billing ledger, newest first: call charges, number rentals, recharges and adjustments, with a summary of total debit and credit over the whole filtered set, not just the page. " +
        "Use it for 'what did I spend' questions and to find a transaction_id; for the current balance use get_account_balance, and for the reference_type values to filter on use list_transaction_types. " +
        "All filters combine with AND. Pagination is stateless: pass page and per_page on every call and follow pagination.next_page while has_more is true.",
      inputSchema: {
        from_date: ledgerDate.optional().describe("Start of the period, inclusive: YYYY-MM-DD (the whole UTC day) or an ISO 8601 timestamp with offset such as 2026-08-28T00:00:00+05:30."),
        to_date: ledgerDate.optional().describe("End of the period, inclusive, in the same formats as from_date."),
        type: z.string().regex(/^[a-z_]{1,40}$/).optional().describe("credit (money in), debit (money out), or an exact transaction type as it appears on entries."),
        status: z.enum(["completed", "pending", "failed", "cancelled"]).optional().describe("Only entries in this state: completed (posted), pending, failed or cancelled."),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe("Three-letter ISO 4217 code such as USD or INR (any case)."),
        reference_type: z.string().regex(/^[a-z_]{1,40}$/).optional().describe("Spend source, e.g. cdr or did_rental; the valid values come from list_transaction_types."),
        description: z.string().trim().min(1).max(200).optional().describe("Case-insensitive substring of the description."),
        reference: z.string().trim().min(1).max(200).optional().describe("Case-insensitive substring of the reference."),
        transaction_id: uuidStr.optional().describe("Fetch one ledger entry by its UUID (from an earlier listing); other filters still apply."),
        page: z.number().int().min(1).max(100000).optional().describe("1-based page number (default 1). Take the next value from pagination.next_page."),
        per_page: z.number().int().min(1).max(1000).optional().describe("Entries per page, max 1000. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
      },
      outputSchema: z
        .object({
          ok: okOut,
          count: z.number().optional().describe("Entries in this page."),
          transactions: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe("Ledger entries as Vobiz returns them: id, type, amount, currency, status, reference_type, description, reference and timestamps."),
          summary: z.unknown().optional().describe("Totals (debit, credit, net) over every entry matching the filters, or null when Vobiz did not report them."),
          pagination: pageOut.optional(),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const page = a.page ?? 1;
      const perPage = a.per_page ?? cfg.defaultPageSize;
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/transactions"), {
        query: {
          page,
          per_page: perPage,
          from_date: a.from_date,
          to_date: a.to_date,
          type: a.type,
          status: a.status,
          currency: a.currency?.toUpperCase(),
          reference_type: a.reference_type,
          description: a.description,
          reference: a.reference,
          transaction_id: a.transaction_id,
        },
        route: "GET transactions",
      });
      const transactions = listField(res.data, "transactions");
      if (!transactions) throw new VobizError("unexpected_response", "Vobiz returned transactions in an unexpected format.", res.status);
      return ok({
        ok: true,
        count: transactions.length,
        transactions,
        summary: res.data.summary ?? null,
        pagination: pageInfo(page, perPage, transactions.length, res.data.total),
      });
    }),
  );

  server.registerTool(
    "list_transaction_types",
    {
      title: "List transaction reference types",
      description:
        "List the distinct reference_type values present on this Vobiz account's ledger (for example cdr, did_rental, recording), to use as the reference_type filter of list_transactions. " +
        "Returns names only, no amounts or entries; the entries themselves come from list_transactions. Takes no input and makes one request.",
      inputSchema: {},
      outputSchema: z
        .object({
          ok: okOut,
          count: z.number().optional().describe("Number of distinct types."),
          reference_types: z.array(z.string()).optional().describe("The reference_type values, exactly as list_transactions accepts them."),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/transactions/reference-types"), { route: "GET transactions/reference-types" });
      const types = listField<string>(res.data, "reference_types");
      if (!types) throw new VobizError("unexpected_response", "Vobiz returned reference types in an unexpected format.", res.status);
      return ok({ ok: true, count: types.length, reference_types: types });
    }),
  );

  // ── Recordings ───────────────────────────────────────────────
  server.registerTool(
    "delete_recording",
    {
      title: "Delete a call recording",
      description:
        "Permanently delete one call recording from this Vobiz account (DELETE /Recording/{id}/). The audio file cannot be restored afterwards. " +
        "To fetch or play a recording instead use get_call_recording; to find IDs use list_recordings. An ID that no longer exists fails with not_found. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { recording_id: recordingId, confirm: confirm("permanently deleting this recording") },
      outputSchema: z
        .object({
          ok: okOut,
          deleted: z.boolean().optional().describe("true once Vobiz removed the recording."),
          recording_id: z.string().optional().describe("The recording that was deleted."),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "permanently deleting this recording", `permanently delete recording ${a.recording_id} (cannot be restored)`);
      try {
        const res = await ctx.client.request("DELETE", ctx.client.accountPath(`/Recording/${encodeURIComponent(a.recording_id)}/`), { route: "DELETE Recording/{id}/" });
        return ok({ ok: true, deleted: true, recording_id: a.recording_id, http_status: res.status });
      } catch (err) {
        if (err instanceof VobizError && err.kind === "not_found") {
          throw new VobizError("not_found", "No recording with this ID exists on this account (it may already be deleted).", err.status);
        }
        throw err;
      }
    }),
  );

  // ── Number lifecycle ─────────────────────────────────────────
  server.registerTool(
    "release_phone_number",
    {
      title: "Release a phone number",
      description:
        "Release a phone number from this Vobiz account (DELETE /numbers/{e164}). This charges the account's number-release fee (returned as release_fee) and the number stops serving calls. " +
        "By default it enters pending_release for a 24-hour cooldown, during which cancel_number_release restores it and refunds the fee; after that window the number leaves the account and may not be recoverable. " +
        "immediate: true skips the cooldown and cannot be cancelled. To hand a number to a sub-account instead of giving it up, use assign_number_to_subaccount. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        phone_number: phoneNumber.describe("The number to release, E.164, from list_phone_numbers."),
        immediate: z.boolean().optional().describe("true skips the 24-hour cancellable cooldown; the release then cannot be cancelled. Default false."),
        confirm: confirm("releasing this number and paying the release fee"),
      },
      outputSchema: z
        .object({
          ok: okOut,
          phone_number: e164Out,
          status: z.unknown().optional().describe("The number's new state, typically pending_release or released, or null."),
          release_fee: z.unknown().optional().describe("Fee charged for the release, as Vobiz reports it, or null."),
          cooldown_ends_at: z.unknown().optional().describe("When the cancellable cooldown ends (ISO 8601), or null for an immediate release."),
          cancellable: z.boolean().optional().describe("true when cancel_number_release can still restore the number."),
          backend_message: backendMessage,
          note: z.unknown().optional().describe("What to do next, in plain words."),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "releasing this number (a release fee applies)", `release phone number ${toE164(a.phone_number)}${a.immediate ? " immediately (cannot be cancelled)" : " (24-hour cancellable cooldown)"}; a number-release fee is charged`);
      const res = await ctx.client.request<Rec>("DELETE", ctx.client.accountPath(`/numbers/${e164Path(a.phone_number)}`), {
        query: a.immediate ? { immediate: "true" } : undefined,
        route: "DELETE numbers/{e164}",
      });
      const d = res.data ?? {};
      return ok({
        ok: true,
        phone_number: toE164(a.phone_number),
        status: d.status ?? null,
        release_fee: d.release_fee ?? null,
        cooldown_ends_at: d.cooldown_ends_at ?? null,
        cancellable: !a.immediate,
        backend_message: d.message ?? null,
        note: d.note ?? (a.immediate ? "Released immediately; this cannot be cancelled." : "Use cancel_number_release before cooldown_ends_at to keep the number."),
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "cancel_number_release",
    {
      title: "Cancel a pending number release",
      description:
        "Keep a number that is in pending_release (POST /account/{id}/numbers/{e164}/cancel-release): Vobiz restores it to active and refunds the release fee to the balance. " +
        "It is the undo of release_phone_number and works only during the 24-hour cooldown. Any trunk or application the release detached must be re-linked with update_phone_number. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { phone_number: phoneNumber.describe("The number in pending_release, E.164."), confirm: confirm("cancelling the release of this number") },
      outputSchema: z
        .object({
          ok: okOut,
          phone_number: e164Out,
          status: z.unknown().optional().describe("The number's state after the cancel, typically active, or null."),
          refund_amount: z.unknown().optional().describe("Release fee refunded, or null."),
          currency: z.unknown().optional().describe("Currency of the refund, or null."),
          refund_status: z.unknown().optional().describe("State of the refund as Vobiz reports it, or null."),
          refund_error: z.unknown().optional().describe("Why the refund failed, if it did, else null."),
          backend_message: backendMessage,
          note: z.string().optional().describe("Reminder to re-link the trunk or application."),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "cancelling this number's release", `cancel the pending release of ${toE164(a.phone_number)} (the release fee is refunded)`);
      const res = await ctx.client.request<Rec>("POST", lowerAccountPath(ctx, `/numbers/${e164Path(a.phone_number)}/cancel-release`), {
        route: "POST numbers/{e164}/cancel-release",
      });
      const d = res.data ?? {};
      return ok({
        ok: true,
        phone_number: toE164(a.phone_number),
        status: d.status ?? null,
        refund_amount: d.refund_amount ?? null,
        currency: d.currency ?? null,
        refund_status: d.refund_status ?? null,
        refund_error: d.refund_error ?? null,
        backend_message: d.message ?? null,
        note: "Re-link any trunk or application with update_phone_number; the release detached them.",
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "assign_number_to_subaccount",
    {
      title: "Assign a number to a sub-account",
      description:
        "Move a number from this Vobiz account's pool to one of its sub-accounts (POST /account/{id}/numbers/{e164}/assign-subaccount). The sub-account then uses the number for its calls and the main account no longer does. " +
        "The undo is unassign_number_from_subaccount. To find sub-account Auth IDs use list_sub_accounts; to give the number up entirely use release_phone_number. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        phone_number: phoneNumber.describe("The number to move, E.164; it must belong to this main account."),
        sub_account_id: subAccountId,
        confirm: confirm("assigning this number to this sub-account"),
      },
      outputSchema: z
        .object({
          ok: okOut,
          phone_number: e164Out,
          sub_account_id: z.string().optional().describe("The sub-account that now owns the number."),
          assigned: z.boolean().optional().describe("true once the move is done."),
          backend_message: backendMessage,
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "assigning this number to the sub-account", `move ${toE164(a.phone_number)} to sub-account ${a.sub_account_id}`);
      const res = await ctx.client.request<Rec>("POST", lowerAccountPath(ctx, `/numbers/${e164Path(a.phone_number)}/assign-subaccount`), {
        body: { sub_account_id: a.sub_account_id },
        route: "POST numbers/{e164}/assign-subaccount",
      });
      return ok({ ok: true, phone_number: toE164(a.phone_number), sub_account_id: a.sub_account_id, assigned: true, backend_message: res.data?.message ?? null, http_status: res.status });
    }),
  );

  server.registerTool(
    "unassign_number_from_subaccount",
    {
      title: "Return a number from a sub-account",
      description:
        "Move a number from a sub-account back to this Vobiz account's pool (DELETE /account/{id}/numbers/{e164}/assign-subaccount). " +
        "It is the undo of assign_number_to_subaccount. A 15-day cool-off applies: a number with a call in the last 15 days stays with the sub-account and the tool fails with not_allowed until the cool-off ends. " +
        "Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { phone_number: phoneNumber.describe("The number to take back, E.164; it must currently be assigned to one of this account's sub-accounts."), confirm: confirm("returning this number to the parent account pool") },
      outputSchema: z
        .object({
          ok: okOut,
          phone_number: e164Out,
          unassigned: z.boolean().optional().describe("true once the number is back in the main account's pool."),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireProvisioning(server, extra, ctx, a.confirm, "returning this number to the parent pool", `return ${toE164(a.phone_number)} from its sub-account to the main account pool`);
      try {
        const res = await ctx.client.request<Rec>("DELETE", lowerAccountPath(ctx, `/numbers/${e164Path(a.phone_number)}/assign-subaccount`), {
          route: "DELETE numbers/{e164}/assign-subaccount",
        });
        return ok({ ok: true, phone_number: toE164(a.phone_number), unassigned: true, http_status: res.status });
      } catch (err) {
        if (err instanceof VobizError && err.status === 409) {
          throw new VobizError(
            "not_allowed",
            "This number had a call in the last 15 days, so it stays with the sub-account until the cool-off ends. Try again after that.",
            err.status,
          );
        }
        throw err;
      }
    }),
  );
}
