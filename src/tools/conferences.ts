/**
 * Conference rooms and their members, all on LIVE conferences through api-voice:
 *   GET    Conference/                              list room names               → 200 {conferences: string[]}
 *   DELETE Conference/                              hang up every room            → 204
 *   GET    Conference/{name}/                       room details + members        → 200 (or 200 {"error":"failed"})
 *   DELETE Conference/{name}/                       hang up one room              → 204
 *   POST|DELETE Conference/{name}/Member/{id}/Mute/ mute | unmute                 → 202 | 204
 *   POST|DELETE Conference/{name}/Member/{id}/Deaf/ deaf | undeaf                 → 202 | 204
 *   POST   Conference/{name}/Member/{id}/Kick/      remove, XML flow continues    → 202
 *   DELETE Conference/{name}/Member/{id}/           hang up the member's call     → 204
 *   POST|DELETE Conference/{name}/Member/{id}/Play/ url | -                       → 202 | 204
 *   POST|DELETE Conference/{name}/Record/           file_format | -               → 200 | 204
 * `member_id` is one numeric ID, a comma-separated list, or `all`. A room that is not running
 * (or a member not in it) answers 404 "conference not found".
 *
 * `callback_url` is deliberately never sent on Record: api-voice treats any request carrying it as
 * an async API call and answers without the real result (see control.ts).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { handler, listField, ok } from "../util.js";
import { audioUrl } from "./control.js";
import { UNTRUSTED_DESCRIPTION, markUntrusted, withUntrustedNotice } from "../guard/untrusted.js";

type Rec = Record<string, unknown>;

/**
 * Conference room name as used in <Conference>. Spaces are allowed (URL-encoded on the wire);
 * slashes, `%`, `?`, `#` and dot-only names are not, so a name can never change the request path.
 */
export const conferenceName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$/, "must be a conference room name (letters, digits, spaces and _ . @ : + -, starting with a letter or digit, max 128)")
  .describe("Conference room name, exactly as used in the <Conference> XML element.");

/**
 * One member ID, a comma-separated list of IDs, or `all`. The charset (digits, commas, "all") is
 * path-safe, so it is sent as-is: Vobiz expects literal commas (/Member/17,45/), not %2C.
 */
export const memberId = z
  .string()
  .trim()
  .regex(/^(all|\d{1,10}(,\d{1,10}){0,49})$/, "must be a member ID such as 17, a comma-separated list such as 17,45,82, or all")
  .describe("ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.");

const confirm = (what: string) => z.boolean().describe(`Must be true, set only after the user explicitly asked to ${what}.`);

const write = (idempotentHint: boolean) => ({ readOnlyHint: false, destructiveHint: true, idempotentHint, openWorldHint: true });

const roomPath = (name: string, suffix = "") => `/Conference/${encodeURIComponent(name)}/${suffix}`;

async function conferenceRequest(
  ctx: ToolContext,
  method: "GET" | "POST" | "DELETE",
  suffix: string,
  route: string,
  opts: { body?: Rec; member?: boolean } = {},
): Promise<{ status: number; data: Rec }> {
  try {
    const res = await ctx.client.request<Rec>(method, ctx.client.accountPath(suffix), { body: opts.body, route });
    const data = res.data;
    return { status: res.status, data: data && typeof data === "object" && !Array.isArray(data) ? data : {} };
  } catch (err) {
    if (err instanceof VobizError && err.kind === "not_found") {
      throw new VobizError(
        "not_found",
        opts.member
          ? "The conference is not running, or the member is not in it (they may have left). Check the room name and member_id."
          : "The conference is not running. Check the room name (it is case-sensitive) or start it with the <Conference> XML element.",
        err.status,
        err.apiId,
      );
    }
    throw err;
  }
}

/** Member IDs Vobiz echoes back: always an array, or the literal "all". */
function echoedMembers(data: Rec, requested: string): unknown {
  const m = data.member_id;
  if (Array.isArray(m) || typeof m === "string") return m;
  return requested === "all" ? "all" : requested.split(",");
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function tidyMember(m: Rec): Rec {
  return {
    member_id: str(m.member_id),
    call_uuid: str(m.call_uuid),
    from: str(m.from),
    to: str(m.to),
    caller_name: str(m.caller_name),
    direction: str(m.direction),
    muted: m.muted === true,
    deaf: m.deaf === true,
    join_time_seconds: num(m.join_time),
  };
}

// ── Output schema building blocks ───────────────────────────────
const NOT_RUNNING_NOTE = " A room that is not running, or a member who already left, returns the not_found error.";
const roomName = z.string().optional().describe("Room the action was applied to.");
const httpStatus = z.number().optional().describe("HTTP status Vobiz answered with (202 = accepted, 204 = done).");
const memberIds = z
  .union([z.string(), z.array(z.unknown())])
  .optional()
  .describe('Members the action was applied to: the literal "all", or the list of member IDs as Vobiz echoed them (or as requested).');
const backendMessage = z.unknown().optional().describe("Vobiz's own status message, or null.");
const memberAction = { ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."), conference_name: roomName, member_id: memberIds, backend_message: backendMessage, http_status: httpStatus };

export function registerConferenceTools(server: McpServer, ctx: ToolContext): void {
  // ── list_conferences / get_conference ────────────────────────
  server.registerTool(
    "list_conferences",
    {
      title: "List live conferences",
      description:
        "List the names of the conference rooms running right now on this Vobiz account (GET /Conference/). " +
        "Rooms that have ended are not listed, there is no paging, and an empty list is a normal result. " +
        "Use it to find a room name for get_conference or the member tools; for the history of a finished room use list_call_records.",
      inputSchema: {},
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          conferences: z.array(z.string()).optional().describe("Names of the rooms running now, exactly as used in <Conference>."),
          count: z.number().optional().describe("Number of live rooms."),
          note: z.string().optional().describe("Present when no room is running."),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      const res = await conferenceRequest(ctx, "GET", "/Conference/", "GET Conference/");
      const names = listField<unknown>(res.data, "conferences");
      if (names === undefined) throw new VobizError("unexpected_response", "Vobiz returned an unexpected conference list.", res.status);
      const conferences = names.map(String);
      return ok({
        ok: true,
        conferences,
        count: conferences.length,
        ...(conferences.length === 0
          ? { note: "No live rooms were listed. To check a specific room, use get_conference with its name." }
          : {}),
      });
    }),
  );

  server.registerTool(
    "get_conference",
    {
      title: "Get a live conference",
      description:
        "Get one running Vobiz conference room by name (GET /Conference/{name}/): run time, member count and each member's member_id, call_uuid, caller, mute and deaf state. " +
        "Use it to find the member_id values that the mute, deafen, kick, hang-up and play tools need. " +
        "A room that is not running returns the not_found error (names are case-sensitive); when Vobiz cannot give live details, details_available is false and no members are listed, so retry shortly." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: { conference_name: conferenceName },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          conference_name: z.string().optional().describe("Room name as Vobiz reports it."),
          details_available: z.boolean().optional().describe("False when Vobiz could not return live details; then members is absent."),
          run_time_seconds: z.number().nullable().optional().describe("Seconds the room has been running, or null when unknown."),
          member_count: z.number().nullable().optional().describe("Members in the room now."),
          members: z
            .array(z.unknown())
            .optional()
            .describe("Each member: member_id, call_uuid, from, to, caller_name, direction, muted, deaf, join_time_seconds, with untrusted: true."),
          backend_message: backendMessage,
          note: z.string().optional().describe("Present when details_available is false."),
          notice: z.string().optional().describe("Reminder that caller names were written by third parties."),
          untrusted_fields: z.array(z.string()).optional().describe("Member fields that hold third-party text."),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ conference_name }) => {
      const res = await conferenceRequest(ctx, "GET", roomPath(conference_name), "GET Conference/{name}/");
      const d = res.data;
      if (typeof d.error === "string" && d.conference_name === undefined) {
        return ok({
          ok: true,
          conference_name,
          details_available: false,
          backend_message: d.error,
          note: "Live details for this room are not available at the moment; try again shortly. Member IDs also arrive in the ConferenceEnter callback (ConferenceMemberID).",
        });
      }
      const members = listField<Rec>(d, "members");
      if (members === undefined) throw new VobizError("unexpected_response", "Vobiz returned an unexpected conference object.", res.status);
      return ok(
        withUntrustedNotice(
          {
            ok: true,
            conference_name: str(d.conference_name) ?? conference_name,
            details_available: true,
            run_time_seconds: num(d.conference_run_time),
            member_count: num(d.conference_member_count) ?? members.length,
            members: members.map((m) => markUntrusted(tidyMember(m))),
          },
          ["caller_name"],
        ),
      );
    }),
  );

  // ── end_conference / end_all_conferences ─────────────────────
  server.registerTool(
    "end_conference",
    {
      title: "End a live conference",
      description:
        "Hang up one running Vobiz conference room (DELETE /Conference/{name}/): every member is disconnected at once and the room ends. " +
        "Use it to close a meeting on time or clean up an abandoned room; to remove only some people, use kick_conference_member or hangup_conference_member. Requires confirm: true. " +
        "A room that is not running returns the not_found error.",
      inputSchema: { conference_name: conferenceName, confirm: confirm("end this conference for everyone in it") },
      outputSchema: z
        .object({ ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."), conference_name: roomName, ended: z.literal(true).optional().describe("Always true: the room is gone."), http_status: httpStatus })
        .passthrough(),
      annotations: write(true),
    },
    handler(async ({ conference_name, confirm }) => {
      if (confirm !== true) throw new VobizError("confirmation_required", "Ask the user to confirm ending this conference for everyone in it, then call again with confirm: true.");
      const res = await conferenceRequest(ctx, "DELETE", roomPath(conference_name), "DELETE Conference/{name}/");
      return ok({ ok: true, conference_name, ended: true, http_status: res.status });
    }),
  );

  server.registerTool(
    "end_all_conferences",
    {
      title: "End every live conference",
      description:
        "Hang up EVERY running conference room on this Vobiz account at once (DELETE /Conference/): all members of all rooms are disconnected. " +
        "Use it only for account-wide cleanup or maintenance; to close one room, use end_conference. Requires confirm: true after the user explicitly agrees to end all conferences.",
      inputSchema: { confirm: confirm("end every live conference on the account") },
      outputSchema: z
        .object({ ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."), ended_all: z.literal(true).optional().describe("Always true: every room was hung up."), http_status: httpStatus })
        .passthrough(),
      annotations: write(true),
    },
    handler(async ({ confirm }) => {
      if (confirm !== true) throw new VobizError("confirmation_required", "This ends every live conference on the account. Ask the user to confirm, then call again with confirm: true.");
      const res = await conferenceRequest(ctx, "DELETE", "/Conference/", "DELETE Conference/");
      return ok({ ok: true, ended_all: true, http_status: res.status });
    }),
  );

  // ── member audio state: mute / deaf ──────────────────────────
  const memberState = (
    name: string,
    title: string,
    description: string,
    method: "POST" | "DELETE",
    action: "Mute" | "Deaf",
    result: Rec,
  ) =>
    server.registerTool(
      name,
      {
        title,
        description: description + NOT_RUNNING_NOTE,
        inputSchema: { conference_name: conferenceName, member_id: memberId },
        outputSchema: z
          .object({
            ...memberAction,
            muted: z.boolean().optional().describe("New mute state of the members (mute and unmute tools only)."),
            deaf: z.boolean().optional().describe("New deaf state of the members (deafen and undeafen tools only)."),
          })
          .passthrough(),
        annotations: write(true),
      },
      handler(async ({ conference_name, member_id }) => {
        const res = await conferenceRequest(
          ctx,
          method,
          roomPath(conference_name, `Member/${member_id}/${action}/`),
          `${method} Conference/{name}/Member/{id}/${action}/`,
          { body: method === "POST" ? {} : undefined, member: true },
        );
        return ok({
          ok: true,
          conference_name,
          member_id: echoedMembers(res.data, member_id),
          ...result,
          backend_message: res.data.message ?? null,
          http_status: res.status,
        });
      }),
    );

  memberState(
    "mute_conference_member",
    "Mute a conference member",
    "Mute one or more members of a live Vobiz conference (POST /Conference/{name}/Member/{id}/Mute/) so others cannot hear them; they still hear the room. " +
      "Pass one member_id, a comma-separated list, or all (for example presenter mode). Undo with unmute_conference_member.",
    "POST",
    "Mute",
    { muted: true },
  );
  memberState(
    "unmute_conference_member",
    "Unmute a conference member",
    "Unmute members of a live Vobiz conference (DELETE /Conference/{name}/Member/{id}/Mute/) so the room can hear them again; the reverse of mute_conference_member. " +
      "Unmuting a member who is not muted still succeeds.",
    "DELETE",
    "Mute",
    { muted: false },
  );
  memberState(
    "deafen_conference_member",
    "Deafen a conference member",
    "Deafen members of a live Vobiz conference (POST /Conference/{name}/Member/{id}/Deaf/) so they stop hearing the room; others still hear them. " +
      "Use it for listen-only setups or private side conversations. Pass one member_id, a comma-separated list, or all. Undo with undeafen_conference_member.",
    "POST",
    "Deaf",
    { deaf: true },
  );
  memberState(
    "undeafen_conference_member",
    "Undeafen a conference member",
    "Let deafened members of a live Vobiz conference hear the room again (DELETE /Conference/{name}/Member/{id}/Deaf/); the reverse of deafen_conference_member. " +
      "Undeafening a member who is not deafened still succeeds.",
    "DELETE",
    "Deaf",
    { deaf: false },
  );

  // ── kick / hang up a member ──────────────────────────────────
  server.registerTool(
    "kick_conference_member",
    {
      title: "Kick a conference member",
      description:
        "Remove members from a live Vobiz conference while keeping their call up (POST /Conference/{name}/Member/{id}/Kick/): their call continues with the next VobizXML element after <Conference>, " +
        "so you can play them a message or route them elsewhere. To end their call instead, use hangup_conference_member. Requires confirm: true." +
        NOT_RUNNING_NOTE,
      inputSchema: { conference_name: conferenceName, member_id: memberId, confirm: confirm("remove this member from the conference") },
      outputSchema: z
        .object({
          ...memberAction,
          kicked: z.literal(true).optional().describe("Always true: the members left the room."),
          note: z.string().optional().describe("What happens to the members' calls next."),
        })
        .passthrough(),
      annotations: write(false),
    },
    handler(async ({ conference_name, member_id, confirm }) => {
      if (confirm !== true) throw new VobizError("confirmation_required", "Ask the user to confirm removing this member from the conference, then call again with confirm: true.");
      const res = await conferenceRequest(
        ctx,
        "POST",
        roomPath(conference_name, `Member/${member_id}/Kick/`),
        "POST Conference/{name}/Member/{id}/Kick/",
        { body: {}, member: true },
      );
      return ok({
        ok: true,
        conference_name,
        member_id: echoedMembers(res.data, member_id),
        kicked: true,
        backend_message: res.data.message ?? null,
        http_status: res.status,
        note: "The member's call continues with the VobizXML after <Conference>. A later join may reuse the same member_id.",
      });
    }),
  );

  server.registerTool(
    "hangup_conference_member",
    {
      title: "Hang up a conference member",
      description:
        "End the calls of members in a live Vobiz conference (DELETE /Conference/{name}/Member/{id}/): they leave the room and their call hangs up. " +
        "Use it to drop a participant completely; to keep their call going after they leave, use kick_conference_member. Requires confirm: true." +
        NOT_RUNNING_NOTE,
      inputSchema: { conference_name: conferenceName, member_id: memberId, confirm: confirm("hang up this member's call") },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          conference_name: roomName,
          member_id: memberIds,
          hung_up: z.literal(true).optional().describe("Always true: the hang-up was accepted."),
          http_status: httpStatus,
          note: z.string().optional().describe("How to confirm the members actually left."),
        })
        .passthrough(),
      annotations: write(true),
    },
    handler(async ({ conference_name, member_id, confirm }) => {
      if (confirm !== true) throw new VobizError("confirmation_required", "Ask the user to confirm hanging up this member's call, then call again with confirm: true.");
      const res = await conferenceRequest(
        ctx,
        "DELETE",
        roomPath(conference_name, `Member/${member_id}/`),
        "DELETE Conference/{name}/Member/{id}/",
        { member: true },
      );
      return ok({
        ok: true,
        conference_name,
        member_id: member_id === "all" ? "all" : member_id.split(","),
        hung_up: true,
        http_status: res.status,
        note: "Confirm removal through the ConferenceExit or call hangup callback.",
      });
    }),
  );

  // ── play / stop audio to members ─────────────────────────────
  server.registerTool(
    "play_audio_to_conference_member",
    {
      title: "Play audio to a conference member",
      description:
        "Play an audio file (https .mp3/.wav) privately to members of a live Vobiz conference (POST /Conference/{name}/Member/{id}/Play/); other members do not hear it. " +
        "Use it for whispered prompts or announcements, or pass member_id all to reach the whole room. Vobiz accepts the request (202) and starts playback asynchronously; stop it early with stop_audio_to_conference_member." +
        NOT_RUNNING_NOTE,
      inputSchema: { conference_name: conferenceName, member_id: memberId, url: audioUrl.describe("Public https URL of the .mp3 or .wav file to play; its host must be approved by the server.") },
      outputSchema: z
        .object({ ...memberAction, playing: z.literal(true).optional().describe("Always true: playback was accepted.") })
        .passthrough(),
      annotations: write(false),
    },
    handler(async ({ conference_name, member_id, url }) => {
      const res = await conferenceRequest(
        ctx,
        "POST",
        roomPath(conference_name, `Member/${member_id}/Play/`),
        "POST Conference/{name}/Member/{id}/Play/",
        { body: { url }, member: true },
      );
      return ok({
        ok: true,
        conference_name,
        member_id: echoedMembers(res.data, member_id),
        playing: true,
        backend_message: res.data.message ?? null,
        http_status: res.status,
      });
    }),
  );

  server.registerTool(
    "stop_audio_to_conference_member",
    {
      title: "Stop audio to a conference member",
      description:
        "Stop audio started by play_audio_to_conference_member for members of a live Vobiz conference (DELETE /Conference/{name}/Member/{id}/Play/). " +
        "It succeeds even when nothing is playing." + NOT_RUNNING_NOTE,
      inputSchema: { conference_name: conferenceName, member_id: memberId },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          conference_name: roomName,
          member_id: memberIds,
          playing: z.literal(false).optional().describe("Always false: playback is stopped."),
          http_status: httpStatus,
        })
        .passthrough(),
      annotations: write(true),
    },
    handler(async ({ conference_name, member_id }) => {
      const res = await conferenceRequest(
        ctx,
        "DELETE",
        roomPath(conference_name, `Member/${member_id}/Play/`),
        "DELETE Conference/{name}/Member/{id}/Play/",
        { member: true },
      );
      return ok({ ok: true, conference_name, member_id: member_id === "all" ? "all" : member_id.split(","), playing: false, http_status: res.status });
    }),
  );

  // ── conference recording ─────────────────────────────────────
  server.registerTool(
    "start_conference_recording",
    {
      title: "Start recording a conference",
      description:
        "Start recording the mixed audio of a live Vobiz conference room (POST /Conference/{name}/Record/) in mp3 (default) or wav. " +
        "Recording may require consent from every participant in your jurisdiction, so confirm with the user first (consider announcing it). " +
        "Vobiz queues the recording; the reply carries no recording ID or file URL, and the file appears in list_recordings after the room ends. Stop with stop_conference_recording. Requires confirm: true. " +
        "A room that is not running returns the not_found error.",
      inputSchema: {
        conference_name: conferenceName,
        file_format: z.enum(["mp3", "wav"]).optional().describe("Audio format of the file: mp3 (default, smaller) or wav (uncompressed)."),
        confirm: confirm("record this conference"),
      },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          conference_name: roomName,
          recording: z.literal(true).optional().describe("Always true: recording was queued."),
          file_format: z.string().optional().describe("Format that will be produced: mp3 or wav."),
          backend_message: backendMessage,
          http_status: httpStatus,
          note: z.string().optional().describe("Where to find the file later."),
        })
        .passthrough(),
      annotations: write(false),
    },
    handler(async ({ conference_name, file_format, confirm }) => {
      if (confirm !== true) throw new VobizError("confirmation_required", "Ask the user to confirm recording this conference (and that consent is in place), then call again with confirm: true.");
      const body: Rec = {};
      if (file_format) body.file_format = file_format;
      const res = await conferenceRequest(ctx, "POST", roomPath(conference_name, "Record/"), "POST Conference/{name}/Record/", { body });
      return ok({
        ok: true,
        conference_name,
        recording: true,
        file_format: file_format ?? "mp3",
        backend_message: res.data.message ?? null,
        http_status: res.status,
        note: "Vobiz queued the recording. The reply has no recording ID or URL; find the file later with list_recordings.",
      });
    }),
  );

  server.registerTool(
    "stop_conference_recording",
    {
      title: "Stop recording a conference",
      description:
        "Stop the recording started by start_conference_recording on a live Vobiz conference room (DELETE /Conference/{name}/Record/). " +
        "Use it when the part you needed is captured; the conference itself keeps running and the file appears later in list_recordings. A room that is not running returns the not_found error.",
      inputSchema: { conference_name: conferenceName },
      outputSchema: z
        .object({ ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."), conference_name: roomName, recording: z.literal(false).optional().describe("Always false: recording is stopped."), http_status: httpStatus })
        .passthrough(),
      annotations: write(true),
    },
    handler(async ({ conference_name }) => {
      const res = await conferenceRequest(ctx, "DELETE", roomPath(conference_name, "Record/"), "DELETE Conference/{name}/Record/");
      return ok({ ok: true, conference_name, recording: false, http_status: res.status });
    }),
  );
}
