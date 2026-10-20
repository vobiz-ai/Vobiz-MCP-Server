/**
 * In-call controls on a LIVE call, all through api-voice:
 *   POST Call/{uuid}/              transfer (legs, aleg_url, bleg_url)     → 202
 *   POST|DELETE Call/{uuid}/Play/  urls, length, legs, loop, mix           → 202 | 204
 *   POST|DELETE Call/{uuid}/Speak/ text, voice, language, legs, loop, mix, type → 202 | 204
 *   POST|DELETE Call/{uuid}/Record/ time_limit, file_format, record_channel_type | url → 202 | 204
 * A call that is not live answers 404 "call not found" (api-voice usecases/calls/mediaserver.go).
 *
 * `callback_url` is deliberately never sent: api-voice treats any request carrying it as an async
 * API call and answers "async api spawned" without the real result (middlewares/asyncapi.go).
 *
 * hold_call/unhold_call place a leg on hold with a transfer to a
 * hosted hold-music flow and back; mute exists only for conference members (not exposed here).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import type { FlowStore } from "../flows.js";
import { VobizError } from "../errors.js";
import { assertDestinationAllowed } from "../policy.js";
import { assertAllowedUrl, callId, handler, ok } from "../util.js";
import { SPEAK_LANGS } from "../xml.js";
import { CONFIRM_NOTE, hostOf, requireApproval, supportsFormElicitation, type ToolExtra } from "../guard/confirm.js";

type Rec = Record<string, unknown>;

const legs = z.enum(["aleg", "bleg", "both"]).optional().describe("Which call leg: aleg (default), bleg or both.");
const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly asked to ${what}.` + CONFIRM_NOTE);

/** https URL to an MP3 or WAV file (the formats Vobiz Play supports). */
export const audioUrl = z
  .string()
  .url()
  .refine((u) => {
    try {
      const p = new URL(u);
      return p.protocol === "https:" && /\.(mp3|wav)$/i.test(p.pathname) && !p.username && !p.password;
    } catch {
      return false;
    }
  }, "must be an https URL ending in .mp3 or .wav");


export async function callAction(
  ctx: ToolContext,
  method: "POST" | "DELETE",
  callUuid: string,
  suffix: string,
  route: string,
  opts: { body?: Rec; query?: Record<string, string | undefined> } = {},
): Promise<{ status: number; data: Rec }> {
  try {
    const res = await ctx.client.request<Rec>(method, ctx.client.accountPath(`/Call/${encodeURIComponent(callUuid)}/${suffix}`), {
      body: opts.body,
      query: opts.query,
      route,
    });
    return { status: res.status, data: res.data ?? {} };
  } catch (err) {
    if (err instanceof VobizError && err.kind === "not_found") {
      throw new VobizError("call_not_active", "The call is not live (it may have ended), so this action could not be applied.", err.status);
    }
    throw err;
  }
}

/** Hosted flow store, or `unsupported` when this process does not serve flows (stdio / no public URL). */
function requireFlows(ctx: ToolContext): FlowStore {
  if (!ctx.cfg.publicUrl || !ctx.flows) {
    throw new VobizError(
      "unsupported",
      "This needs hosted call flows: run the HTTP server (npm run start:http) with VOBIZ_PUBLIC_URL set to its public https address.",
    );
  }
  return ctx.flows;
}

export function registerControlTools(server: McpServer, ctx: ToolContext): void {
  // ── transfer_call ────────────────────────────────────────────
  server.registerTool(
    "transfer_call",
    {
      title: "Transfer a live call",
      description:
        "Blind-transfer a LIVE call (POST /Call/{uuid}/): Vobiz stops the current flow on the chosen leg and fetches new call XML. " +
        "Give either `destination` (a phone number in E.164 or a sip: URI; the server hosts a <Dial> flow for it, HTTP mode only) or `aleg_url`/`bleg_url` (your own XML URL on an approved host). " +
        "For an attended (warm) transfer, build the flow in VobizXML (for example hold music, then <Dial>). Requires confirm: true.",
      inputSchema: {
        call_uuid: callId,
        destination: z
          .string()
          .regex(/^(\+?[1-9]\d{6,14}|sip:[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9.-]{1,253})$/, "must be an E.164 number or sip:user@host")
          .optional()
          .describe("Number or SIP URI to connect the call to."),
        caller_id: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional().describe("Caller ID for the transferred leg (a number on this account)."),
        legs,
        aleg_url: z.string().url().optional().describe("XML URL for the A leg (approved host only)."),
        aleg_method: z.enum(["GET", "POST"]).optional(),
        bleg_url: z.string().url().optional().describe("XML URL for the B leg (approved host only)."),
        bleg_method: z.enum(["GET", "POST"]).optional(),
        confirm: confirm("transfer this call"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      const l = a.legs ?? "aleg";
      if (a.confirm !== true && !supportsFormElicitation(server.server.getClientCapabilities())) {
        throw new VobizError("confirmation_required", "Ask the user to confirm the transfer, then call again with confirm: true.");
      }
      const body: Rec = { legs: l };
      if (a.destination) {
        if (a.aleg_url || a.bleg_url) throw new VobizError("invalid_input", "Give either destination or aleg_url/bleg_url, not both.");
        if (l !== "aleg") throw new VobizError("invalid_input", "destination transfers move the A leg; use legs: aleg.");
        if (/^\+?\d/.test(a.destination)) {
          assertDestinationAllowed(ctx.cfg, a.destination);
        }
        const flows = requireFlows(ctx);
        body.aleg_url = flows.flowUrl(flows.create({ kind: "dial", destination: a.destination, callerId: a.caller_id, timeLimit: ctx.cfg.policy.maxCallDurationSec }));
        body.aleg_method = "POST";
      } else {
        if ((l === "aleg" || l === "both") && !a.aleg_url) throw new VobizError("invalid_input", "aleg_url is required when legs is aleg or both.");
        if ((l === "bleg" || l === "both") && !a.bleg_url) throw new VobizError("invalid_input", "bleg_url is required when legs is bleg or both.");
        if (a.aleg_url) {
          assertAllowedUrl(ctx.cfg, a.aleg_url, "aleg_url");
          body.aleg_url = a.aleg_url;
          body.aleg_method = a.aleg_method ?? "POST";
        }
        if (a.bleg_url) {
          assertAllowedUrl(ctx.cfg, a.bleg_url, "bleg_url");
          body.bleg_url = a.bleg_url;
          body.bleg_method = a.bleg_method ?? "POST";
        }
      }
      // After validation and the destination policy, so the user only approves what would really run.
      const target = a.destination
        ? a.destination
        : [a.aleg_url ? `A leg -> ${hostOf(a.aleg_url)}` : "", a.bleg_url ? `B leg -> ${hostOf(a.bleg_url)}` : ""].filter(Boolean).join(", ") || "(no target)";
      await requireApproval(server, extra, {
        confirmed: a.confirm,
        message: `Transfer live call ${a.call_uuid} to ${target}${a.destination && /^\+?\d/.test(a.destination) ? " (an outbound, billed call leg)" : ""}. The call's current flow stops. Approve?`,
        fallback: "Ask the user to confirm the transfer, then call again with confirm: true.",
      });
      const res = await callAction(ctx, "POST", a.call_uuid, "", "POST Call/{uuid}/ (transfer)", { body });
      return ok({ ok: true, call_uuid: a.call_uuid, transferred: true, legs: l, backend_message: res.data.message ?? null, http_status: res.status });
    }),
  );

  // ── hold_call / unhold_call (emulated) ───────────────────────
  server.registerTool(
    "hold_call",
    {
      title: "Put a live call on hold",
      description:
        "Puts a leg on hold by transferring it to a hosted flow that plays hold music (or silence) in a loop. " +
        "Resume with unhold_call and the XML URL that should take over. HTTP mode with VOBIZ_PUBLIC_URL only. Requires confirm: true.",
      inputSchema: {
        call_uuid: callId,
        legs,
        music_url: audioUrl.optional().describe("Hold music (https .mp3/.wav). Silence if omitted."),
        confirm: confirm("put this call on hold"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireApproval(server, extra, {
        confirmed: a.confirm,
        message: `Put live call ${a.call_uuid} on hold${a.music_url ? ` with music from ${hostOf(a.music_url)}` : ""}. Approve?`,
        fallback: "Ask the user to confirm putting the call on hold, then call again with confirm: true.",
      });
      const l = a.legs ?? "aleg";
      const flows = requireFlows(ctx);
      const url = flows.flowUrl(flows.create({ kind: "hold", musicUrl: a.music_url }));
      const body: Rec = { legs: l };
      if (l !== "bleg") Object.assign(body, { aleg_url: url, aleg_method: "POST" });
      if (l !== "aleg") Object.assign(body, { bleg_url: url, bleg_method: "POST" });
      const res = await callAction(ctx, "POST", a.call_uuid, "", "POST Call/{uuid}/ (hold)", { body });
      return ok({ ok: true, call_uuid: a.call_uuid, on_hold: true, legs: l, emulated: true, http_status: res.status });
    }),
  );

  server.registerTool(
    "unhold_call",
    {
      title: "Resume a held call",
      description:
        "Takes a leg off emulated hold by transferring it to `resume_url` (XML on an approved host, e.g. a hosted flow from generate_answer_xml). " +
        "Vobiz cannot return to the exact point the call was at before hold. Requires confirm: true.",
      inputSchema: {
        call_uuid: callId,
        resume_url: z.string().url().describe("XML URL that should control the call after hold (approved host)."),
        legs,
        confirm: confirm("take this call off hold"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      if (a.confirm !== true && !supportsFormElicitation(server.server.getClientCapabilities())) throw new VobizError("confirmation_required", "Ask the user to confirm, then call again with confirm: true.");
      assertAllowedUrl(ctx.cfg, a.resume_url, "resume_url");
      await requireApproval(server, extra, {
        confirmed: a.confirm,
        message: `Take live call ${a.call_uuid} off hold and hand it to call-control XML from ${hostOf(a.resume_url)}. Approve?`,
        fallback: "Ask the user to confirm, then call again with confirm: true.",
      });
      const l = a.legs ?? "aleg";
      const body: Rec = { legs: l };
      if (l !== "bleg") Object.assign(body, { aleg_url: a.resume_url, aleg_method: "POST" });
      if (l !== "aleg") Object.assign(body, { bleg_url: a.resume_url, bleg_method: "POST" });
      const res = await callAction(ctx, "POST", a.call_uuid, "", "POST Call/{uuid}/ (unhold)", { body });
      return ok({ ok: true, call_uuid: a.call_uuid, on_hold: false, legs: l, emulated: true, http_status: res.status });
    }),
  );

  // ── play_audio / stop_audio ──────────────────────────────────
  server.registerTool(
    "play_audio",
    {
      title: "Play audio on a live call",
      description:
        "Play one or more audio files (https .mp3/.wav) into a LIVE call (POST /Call/{uuid}/Play/). `mix: true` (default) plays over the conversation; false replaces it. Stop with stop_audio.",
      inputSchema: {
        call_uuid: callId,
        urls: z.array(audioUrl).min(1).max(5).describe("Audio files to play in order."),
        legs,
        loop: z.boolean().optional().describe("Repeat until stopped."),
        mix: z.boolean().optional().describe("Mix with the call audio (default true)."),
        length: z.number().int().min(1).max(3600).optional().describe("Stop after this many seconds."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      const body: Rec = { urls: a.urls.join(","), legs: a.legs ?? "aleg" };
      if (a.loop !== undefined) body.loop = a.loop;
      if (a.mix !== undefined) body.mix = a.mix;
      if (a.length !== undefined) body.length = a.length;
      const res = await callAction(ctx, "POST", a.call_uuid, "Play/", "POST Call/{uuid}/Play", { body });
      return ok({ ok: true, call_uuid: a.call_uuid, playing: true, backend_message: res.data.message ?? null, http_status: res.status });
    }),
  );

  server.registerTool(
    "stop_audio",
    {
      title: "Stop audio on a live call",
      description: "Stop audio started by play_audio on a LIVE call (DELETE /Call/{uuid}/Play/).",
      inputSchema: { call_uuid: callId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid }) => {
      const res = await callAction(ctx, "DELETE", call_uuid, "Play/", "DELETE Call/{uuid}/Play");
      return ok({ ok: true, call_uuid, playing: false, http_status: res.status });
    }),
  );

  // ── speak_text / stop_speaking ───────────────────────────────
  server.registerTool(
    "speak_text",
    {
      title: "Speak text on a live call",
      description:
        "Read text aloud into a LIVE call with Vobiz text-to-speech (POST /Call/{uuid}/Speak/). voice WOMAN or MAN; language e.g. en-US, en-IN, hi-IN; type ssml for SSML markup. Stop with stop_speaking.",
      inputSchema: {
        call_uuid: callId,
        text: z.string().trim().min(1).max(3000).describe("Text (or SSML when type is ssml), max 3000 characters."),
        voice: z.enum(["WOMAN", "MAN"]).optional(),
        language: z.enum(SPEAK_LANGS).optional().describe("Default en-US."),
        type: z.enum(["text", "ssml"]).optional(),
        legs,
        loop: z.boolean().optional(),
        mix: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      const body: Rec = { text: a.text, legs: a.legs ?? "aleg" };
      for (const k of ["voice", "language", "type", "loop", "mix"] as const) if (a[k] !== undefined) body[k] = a[k];
      const res = await callAction(ctx, "POST", a.call_uuid, "Speak/", "POST Call/{uuid}/Speak", { body });
      return ok({ ok: true, call_uuid: a.call_uuid, speaking: true, backend_message: res.data.message ?? null, http_status: res.status });
    }),
  );

  server.registerTool(
    "stop_speaking",
    {
      title: "Stop speech on a live call",
      description: "Stop text-to-speech started by speak_text on a LIVE call (DELETE /Call/{uuid}/Speak/).",
      inputSchema: { call_uuid: callId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid }) => {
      const res = await callAction(ctx, "DELETE", call_uuid, "Speak/", "DELETE Call/{uuid}/Speak");
      return ok({ ok: true, call_uuid, speaking: false, http_status: res.status });
    }),
  );

  // ── start_recording / stop_recording ─────────────────────────
  server.registerTool(
    "start_recording",
    {
      title: "Start recording a live call",
      description:
        "Start recording a LIVE call (POST /Call/{uuid}/Record/). Recording may require consent from the other party in your jurisdiction; confirm with the user first. " +
        "Returns the recording_id/url Vobiz reports. Stop with stop_recording; find the file afterwards with get_call_recording. Requires confirm: true.",
      inputSchema: {
        call_uuid: callId,
        time_limit: z.number().int().min(1).max(28800).optional().describe("Max seconds to record (Vobiz max 28800; default 60)."),
        file_format: z.enum(["mp3", "wav"]).optional(),
        record_channel_type: z.enum(["mono", "stereo"]).optional(),
        confirm: confirm("record this call"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
      await requireApproval(server, extra, {
        confirmed: a.confirm,
        message: `Start recording live call ${a.call_uuid}${a.time_limit ? ` for up to ${a.time_limit}s` : ""}. Recording may need the other party's consent; storage is billed. Approve?`,
        fallback: "Ask the user to confirm recording (and that consent is in place), then call again with confirm: true.",
      });
      const body: Rec = {};
      if (a.time_limit !== undefined) body.time_limit = a.time_limit;
      if (a.file_format) body.file_format = a.file_format;
      if (a.record_channel_type) body.record_channel_type = a.record_channel_type;
      const res = await callAction(ctx, "POST", a.call_uuid, "Record/", "POST Call/{uuid}/Record", { body });
      return ok({
        ok: true,
        call_uuid: a.call_uuid,
        recording: true,
        recording_id: res.data.recording_id ?? null,
        url: res.data.url ?? null,
        backend_message: res.data.message ?? null,
        http_status: res.status,
        note: "The file becomes available after recording stops; use get_call_recording with this call_uuid.",
      });
    }),
  );

  server.registerTool(
    "stop_recording",
    {
      title: "Stop recording a live call",
      description:
        "Stop recording on a LIVE call (DELETE /Call/{uuid}/Record/). Pass the recording `url` returned by start_recording to stop one recording; omit it to stop all recordings on the call.",
      inputSchema: {
        call_uuid: callId,
        url: z.string().url().optional().describe("Recording file URL from start_recording."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid, url }) => {
      const res = await callAction(ctx, "DELETE", call_uuid, "Record/", "DELETE Call/{uuid}/Record", { query: { url } });
      return ok({ ok: true, call_uuid, recording: false, stopped: url ? "one" : "all", http_status: res.status });
    }),
  );
}
