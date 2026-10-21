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

const legs = z
  .enum(["aleg", "bleg", "both"])
  .optional()
  .describe("Which call leg the action applies to: aleg (the call's first leg, default), bleg (the leg bridged to it by <Dial>) or both.");
const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly asked to ${what}.` + CONFIRM_NOTE);
const liveCallUuid = callId.describe("UUID of the LIVE call to act on: the request_uuid returned by make_call, or a UUID from list_live_calls.");

// ── Result fields shared by the in-call tools ───────────────────
const okFlag = z.boolean().optional().describe("True on success. On a failure the result is isError with ok: false plus `error` (kind), `message`, `retryable` and sometimes `http_status`.");
const outCallUuid = z.string().optional().describe("The call UUID the action was applied to, echoed from the request.");
const outLegs = z.enum(["aleg", "bleg", "both"]).optional().describe("The leg(s) the action was applied to (aleg when none was given).");
const backendMessage = z.string().nullable().optional().describe("Vobiz's own confirmation text for the request, or null when it sent none.");
const httpStatus = z.number().int().optional().describe("HTTP status Vobiz answered with: 202 when an action was accepted, 204 when one was stopped.");

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
        "Blind-transfer a LIVE call (POST /Call/{uuid}/): Vobiz stops whatever the chosen leg is doing (IVR, playback, bridge) and fetches new VobizXML from the transfer URL. " +
        "Give either `destination` (an E.164 number or sip: URI; this server hosts a <Dial> flow for it, A leg only, HTTP mode with VOBIZ_PUBLIC_URL) or your own `aleg_url` / `bleg_url` on an approved host, never both. " +
        "For an attended (warm) transfer build the flow with generate_answer_xml (hold music, then dial) and pass its URL. To park a leg use hold_call, to run a keypad menu on it use gather_dtmf, to end the call use end_call. " +
        "A destination number must pass the server's destination policy and becomes a new, billed call leg; a call that is not live fails with call_not_active. Requires confirm: true.",
      inputSchema: {
        call_uuid: liveCallUuid,
        destination: z
          .string()
          .regex(/^(\+?[1-9]\d{6,14}|sip:[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9.-]{1,253})$/, "must be an E.164 number or sip:user@host")
          .optional()
          .describe("Where to connect the A leg: an E.164 number such as +14155550100, or sip:user@host. The server hosts the <Dial> flow (HTTP mode only). Not combinable with aleg_url/bleg_url."),
        caller_id: z
          .string()
          .regex(/^\+?[1-9]\d{6,14}$/)
          .optional()
          .describe("Caller ID the destination sees: an E.164 number on this account. Only used together with `destination`."),
        legs: legs.describe("Leg to transfer: aleg (the call's first leg, default), bleg (the party bridged by <Dial>) or both. With `destination` only aleg is allowed."),
        aleg_url: z.string().url().optional().describe("https URL on an approved host that returns the VobizXML the A leg runs next. Required when legs is aleg or both and no destination is given."),
        aleg_method: z.enum(["GET", "POST"]).optional().describe("HTTP method Vobiz uses to fetch aleg_url: GET or POST (default POST)."),
        bleg_url: z.string().url().optional().describe("https URL on an approved host that returns the VobizXML the B leg runs next. Required when legs is bleg or both."),
        bleg_method: z.enum(["GET", "POST"]).optional().describe("HTTP method Vobiz uses to fetch bleg_url: GET or POST (default POST)."),
        confirm: confirm("transfer this call"),
      },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          transferred: z.literal(true).optional().describe("True once Vobiz accepted the transfer; the leg fetches and runs the new XML asynchronously."),
          legs: outLegs,
          backend_message: backendMessage,
          http_status: httpStatus,
        })
        .passthrough(),
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
        "Put one leg of a LIVE call on hold (emulated: the leg is transferred to a hosted flow that loops `music_url`, or plays silence for up to an hour), so whatever that leg was doing stops. " +
        "Resume with unhold_call and the XML URL that should take over; Vobiz cannot return to the exact point before the hold. To send the leg somewhere else use transfer_call; to silence audio you started with play_audio use stop_audio instead. " +
        "HTTP mode with VOBIZ_PUBLIC_URL only; a call that is not live fails with call_not_active. Requires confirm: true.",
      inputSchema: {
        call_uuid: liveCallUuid,
        legs: legs.describe("Leg to park: aleg (the call's first leg, default), bleg (the party bridged by <Dial>) or both. Give the same value to unhold_call."),
        music_url: audioUrl.optional().describe("https .mp3/.wav to loop while on hold. Silence if omitted."),
        confirm: confirm("put this call on hold"),
      },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          on_hold: z.literal(true).optional().describe("True once Vobiz accepted the transfer into the hold flow."),
          legs: outLegs,
          emulated: z.literal(true).optional().describe("Always true: Vobiz has no native hold, so this is a transfer to a hosted hold flow."),
          http_status: httpStatus,
        })
        .passthrough(),
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
        "Take a leg of a LIVE call off emulated hold by transferring it to `resume_url` (VobizXML on an approved host, for example a hosted flow from generate_answer_xml or the url from gather_dtmf). " +
        "Vobiz cannot return to the point the call was at before hold_call, so the resume XML decides what happens next (speak, dial the other party again, a menu). To end the call instead use end_call. " +
        "Only meaningful after hold_call; a call that is not live fails with call_not_active. Requires confirm: true.",
      inputSchema: {
        call_uuid: liveCallUuid,
        resume_url: z.string().url().describe("https URL on an approved host returning the VobizXML that controls the leg after hold."),
        legs: legs.describe("Leg to resume: the same value given to hold_call (default aleg)."),
        confirm: confirm("take this call off hold"),
      },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          on_hold: z.literal(false).optional().describe("False once Vobiz accepted the transfer to resume_url."),
          legs: outLegs,
          emulated: z.literal(true).optional().describe("Always true: hold and resume are transfers between hosted flows, not a native Vobiz hold."),
          http_status: httpStatus,
        })
        .passthrough(),
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
        "Play one to five audio files (https .mp3/.wav, in order) into a LIVE call (POST /Call/{uuid}/Play/). " +
        "Use it for pre-recorded audio; for spoken text use speak_text, and to send the call's audio to your own WebSocket server use start_audio_stream. " +
        "`mix: true` (default) plays over the conversation so the parties keep hearing each other; false replaces the leg's audio until playback ends. " +
        "Playback ends when the files finish, after `length` seconds, or with stop_audio (stop_speaking and stop_recording do not affect it); with `loop` it repeats until stopped. A call that is not live fails with call_not_active.",
      inputSchema: {
        call_uuid: liveCallUuid,
        urls: z.array(audioUrl).min(1).max(5).describe("One to five https URLs of .mp3 or .wav files, played in this order."),
        legs,
        loop: z.boolean().optional().describe("Repeat the files until stop_audio or `length` ends playback (default false)."),
        mix: z.boolean().optional().describe("true (default): play over the conversation; false: replace the leg's audio while playing."),
        length: z.number().int().min(1).max(3600).optional().describe("Stop playback after this many seconds (1-3600). Omit to play to the end."),
      },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          playing: z.literal(true).optional().describe("True once Vobiz accepted the playback request; audio starts within moments."),
          backend_message: backendMessage,
          http_status: httpStatus,
        })
        .passthrough(),
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
      description:
        "Stop audio started by play_audio on a LIVE call (DELETE /Call/{uuid}/Play/); the call itself continues. " +
        "It does not stop text-to-speech (use stop_speaking), a recording (stop_recording) or an audio stream (stop_audio_stream). A call that is not live fails with call_not_active.",
      inputSchema: { call_uuid: liveCallUuid.describe("UUID of the live call whose play_audio playback should stop.") },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          playing: z.literal(false).optional().describe("False once Vobiz accepted the stop request."),
          http_status: httpStatus,
        })
        .passthrough(),
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
        "Read `text` aloud into a LIVE call with Vobiz text-to-speech (POST /Call/{uuid}/Speak/). " +
        "Use it for dynamic sentences; for a pre-recorded file use play_audio, and to connect your own AI voice agent or transcription use start_audio_stream. " +
        "Plain text or SSML (`type: ssml`), up to 3000 characters, spoken in `language` (default en-US) with a WOMAN (default) or MAN voice; `mix` and `loop` work as in play_audio. " +
        "Speech ends when the text finishes, or earlier with stop_speaking (stop_audio does not stop it). A call that is not live fails with call_not_active.",
      inputSchema: {
        call_uuid: liveCallUuid,
        text: z.string().trim().min(1).max(3000).describe("Text to speak, or SSML markup when type is ssml; 1-3000 characters."),
        voice: z.enum(["WOMAN", "MAN"]).optional().describe("Voice: WOMAN (default) or MAN."),
        language: z.enum(SPEAK_LANGS).optional().describe("Locale the text is spoken in, e.g. en-US (default), en-IN, hi-IN, de-DE; pick the one matching the text."),
        type: z.enum(["text", "ssml"]).optional().describe("text (default): `text` is plain text; ssml: `text` is SSML markup for pauses, emphasis and prosody."),
        legs,
        loop: z.boolean().optional().describe("Repeat the text until stop_speaking is called (default false)."),
        mix: z.boolean().optional().describe("true: speak over the conversation so the parties still hear each other; false: replace the leg's audio while speaking."),
      },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          speaking: z.literal(true).optional().describe("True once Vobiz accepted the speech request; audio starts within moments."),
          backend_message: backendMessage,
          http_status: httpStatus,
        })
        .passthrough(),
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
      description:
        "Stop text-to-speech started by speak_text on a LIVE call (DELETE /Call/{uuid}/Speak/); the call itself continues. " +
        "It does not stop play_audio playback (use stop_audio), a recording (stop_recording) or an audio stream (stop_audio_stream). A call that is not live fails with call_not_active.",
      inputSchema: { call_uuid: liveCallUuid.describe("UUID of the live call whose speak_text speech should stop.") },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          speaking: z.literal(false).optional().describe("False once Vobiz accepted the stop request."),
          http_status: httpStatus,
        })
        .passthrough(),
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
        "Start recording a LIVE call (POST /Call/{uuid}/Record/) into one file, either mixed (mono, default) or one party per channel (stereo). " +
        "Recording ends at `time_limit` seconds (default 60, max 8 hours), when the call hangs up, or with stop_recording; the file then appears in get_call_recording / list_recordings and its storage is billed. " +
        "Playback and speech on the call (play_audio, speak_text) are unaffected; to capture only a caller's answer inside an IVR use the record action of generate_answer_xml instead. " +
        "Recording may require consent from the other party in your jurisdiction, so confirm with the user first. Requires confirm: true.",
      inputSchema: {
        call_uuid: liveCallUuid,
        time_limit: z.number().int().min(1).max(28800).optional().describe("Maximum seconds to record, 1-28800 (default 60). The recording also ends when the call does."),
        file_format: z.enum(["mp3", "wav"]).optional().describe("Audio format of the file: mp3 (default) or wav."),
        record_channel_type: z.enum(["mono", "stereo"]).optional().describe("mono (default): both parties mixed into one channel; stereo: each party on its own channel."),
        confirm: confirm("record this call"),
      },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          recording: z.literal(true).optional().describe("True once Vobiz accepted the request and started recording."),
          recording_id: z.union([z.string(), z.number()]).nullable().optional().describe("Identifier Vobiz assigned to this recording, or null when it did not report one."),
          url: z.string().nullable().optional().describe("URL of the recording file as Vobiz reports it; pass it to stop_recording to stop just this recording. Null when not reported."),
          backend_message: backendMessage,
          http_status: httpStatus,
          note: z.string().optional().describe("Reminder that the file is only retrievable (get_call_recording) after the recording stops."),
        })
        .passthrough(),
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
        "Stop a recording on a LIVE call (DELETE /Call/{uuid}/Record/): pass the `url` returned by start_recording to stop that one recording, or omit it to stop every recording on the call. " +
        "The file is finalised and appears in get_call_recording shortly after; the call itself, playback (stop_audio) and speech (stop_speaking) are unaffected. " +
        "A call that is not live fails with call_not_active (the hangup already closed its recordings).",
      inputSchema: {
        call_uuid: liveCallUuid.describe("UUID of the live call being recorded."),
        url: z.string().url().optional().describe("Recording file URL from start_recording, to stop only that recording. Omit to stop all recordings on the call."),
      },
      outputSchema: z
        .object({
          ok: okFlag,
          call_uuid: outCallUuid,
          recording: z.literal(false).optional().describe("False once Vobiz accepted the stop request."),
          stopped: z.enum(["one", "all"]).optional().describe("\"one\" when a url was given, \"all\" when every recording on the call was stopped."),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ call_uuid, url }) => {
      const res = await callAction(ctx, "DELETE", call_uuid, "Record/", "DELETE Call/{uuid}/Record", { query: { url } });
      return ok({ ok: true, call_uuid, recording: false, stopped: url ? "one" : "all", http_status: res.status });
    }),
  );
}
