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
import { PAGINATION_NOTE, assertAllowedUrl, callId, handler, isPrivateHost, listField, ok, pageInfo, phoneNumber, toE164 } from "../util.js";
import { callAction } from "./control.js";

type Rec = Record<string, unknown>;

const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly approved: ${what}.` + CONFIRM_NOTE);
const e164Path = (n: string) => encodeURIComponent(toE164(n));
const streamId = z.string().trim().regex(/^[A-Za-z0-9_-]{4,64}$/, "must be a Vobiz stream ID");
const recordingId = z.string().trim().regex(/^[A-Za-z0-9_-]{4,64}$/, "must be a Vobiz recording ID");
const subAccountId = z.string().trim().regex(/^SA_[A-Za-z0-9]{4,40}$/, "must be a Vobiz sub-account Auth ID such as SA_XXXXXXXX");
const uuidStr = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a UUID");
const ledgerDate = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/,
    "must be YYYY-MM-DD or an ISO 8601 timestamp such as 2026-08-28T00:00:00+05:30",
  )
  .refine((s) => !Number.isNaN(Date.parse(s.length === 10 ? s + "T00:00:00Z" : s)), { message: "is not a real date" });

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
        "This sends live call audio to an external server, so it requires confirm: true after the user approves the destination.",
      inputSchema: {
        call_uuid: callId,
        service_url: z.string().describe("wss:// URL of your WebSocket server (approved host)."),
        bidirectional: z.boolean().optional().describe("Allow your server to send audio back into the call (playAudio). Default false."),
        audio_track: z.enum(["inbound", "outbound", "both"]).optional().describe("Which audio to fork. Default both; must be inbound when bidirectional is true."),
        content_type: z
          .enum(["audio/x-l16;rate=8000", "audio/x-l16;rate=16000", "audio/x-mulaw;rate=8000"])
          .optional()
          .describe("Inbound audio format sent to your server. Default audio/x-l16;rate=8000."),
        stream_timeout: z.number().int().min(1).max(86400).optional().describe("Stop the stream automatically after this many seconds. Default 86400."),
        status_callback_url: z.string().url().optional().describe("https URL (approved host) that receives stream status events (StartStream, PlayedStream, StopStream...)."),
        status_callback_method: z.enum(["GET", "POST"]).optional().describe("Default POST."),
        extra_headers: z
          .string()
          .max(1024)
          .regex(/^[A-Za-z0-9-]{1,64}:[^,\r\n]{1,256}(,[A-Za-z0-9-]{1,64}:[^,\r\n]{1,256})*$/, "must be comma-separated header:value pairs")
          .optional()
          .describe("Comma-separated header:value pairs (e.g. X-Session:abc123) passed with the stream. Use the wss:// URL path, not these headers, to authenticate the socket."),
        confirm: confirm("sending this call's live audio to this WebSocket server"),
      },
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
        "List the audio streams on a Vobiz call (GET /Call/{uuid}/Stream/), both active and stopped, with status, WebSocket URL, track and audio format. " +
        PAGINATION_NOTE + " Read-only.",
      inputSchema: {
        call_uuid: callId,
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
        offset: z.number().int().min(0).max(100000).optional(),
      },
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
      description: "Return one audio stream on a Vobiz call (GET /Call/{uuid}/Stream/{stream_id}/): status, WebSocket URL, track, audio format, start and end time. Read-only.",
      inputSchema: { call_uuid: callId, stream_id: streamId },
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
        "Stop one audio stream on a LIVE Vobiz call (DELETE /Call/{uuid}/Stream/{stream_id}/). Other streams on the call keep running, and the call itself continues.",
      inputSchema: { call_uuid: callId, stream_id: streamId },
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
        "List this Vobiz account's billing ledger, newest first: call charges, number rentals, recharges and adjustments, with a summary of total debit/credit over the whole filtered set. " +
        "Filters: from_date/to_date (inclusive; YYYY-MM-DD is a whole UTC day, or pass an ISO timestamp with offset), type (credit/debit or an exact type), status, currency, reference_type (see list_transaction_types), description/reference (substring) and transaction_id. " +
        PAGINATION_NOTE + " Read-only.",
      inputSchema: {
        from_date: ledgerDate.optional(),
        to_date: ledgerDate.optional(),
        type: z.string().regex(/^[a-z_]{1,40}$/).optional().describe("credit, debit, or an exact transaction type."),
        status: z.enum(["completed", "pending", "failed", "cancelled"]).optional(),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
        reference_type: z.string().regex(/^[a-z_]{1,40}$/).optional().describe("Spend source, e.g. cdr or did_rental."),
        description: z.string().trim().min(1).max(200).optional().describe("Case-insensitive substring of the description."),
        reference: z.string().trim().min(1).max(200).optional().describe("Case-insensitive substring of the reference."),
        transaction_id: uuidStr.optional().describe("Fetch one ledger entry by its ID."),
        page: z.number().int().min(1).max(100000).optional(),
        per_page: z.number().int().min(1).max(1000).optional().describe("Max 1000."),
      },
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
      description: "List the reference_type values present on this Vobiz account's ledger (for example cdr, did_rental, recording), for use as the list_transactions reference_type filter. Read-only.",
      inputSchema: {},
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
        "Permanently delete one call recording from this Vobiz account (DELETE /Recording/{id}/). The audio file cannot be restored afterwards. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { recording_id: recordingId, confirm: confirm("permanently deleting this recording") },
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
        "immediate: true skips the cooldown and cannot be cancelled. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        phone_number: phoneNumber,
        immediate: z.boolean().optional().describe("Skip the 24-hour cancellable cooldown. The release then cannot be cancelled."),
        confirm: confirm("releasing this number and paying the release fee"),
      },
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
        "Works only during the 24-hour cooldown. Any trunk or application the release detached must be re-linked with update_phone_number. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { phone_number: phoneNumber, confirm: confirm("cancelling the release of this number") },
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
        "Move a number from this Vobiz account's pool to one of its sub-accounts (POST /account/{id}/numbers/{e164}/assign-subaccount). The sub-account then uses the number for its calls. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: {
        phone_number: phoneNumber,
        sub_account_id: subAccountId,
        confirm: confirm("assigning this number to this sub-account"),
      },
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
        "A 15-day cool-off applies: a number with a call in the last 15 days is moved only after the cool-off ends. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.",
      inputSchema: { phone_number: phoneNumber, confirm: confirm("returning this number to the parent account pool") },
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
