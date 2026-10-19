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

export function registerConferenceTools(server: McpServer, ctx: ToolContext): void {
  // ── list_conferences / get_conference ────────────────────────
  server.registerTool(
    "list_conferences",
    {
      title: "List live conferences",
      description:
        "List the names of conference rooms currently running on this Vobiz account (GET /Conference/). " +
        "Use it to find a room before inspecting it with get_conference or controlling its members. " +
        "Keep a record of the rooms you start so you can check or end each one by name with get_conference and end_conference.",
      inputSchema: {},
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
        "Use it to find the member_id values that the mute, deafen, kick, hang-up and play tools need.",
      inputSchema: { conference_name: conferenceName },
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
      return ok({
        ok: true,
        conference_name: str(d.conference_name) ?? conference_name,
        details_available: true,
        run_time_seconds: num(d.conference_run_time),
        member_count: num(d.conference_member_count) ?? members.length,
        members: members.map(tidyMember),
      });
    }),
  );

  // ── end_conference / end_all_conferences ─────────────────────
  server.registerTool(
    "end_conference",
    {
      title: "End a live conference",
      description:
        "Hang up one running Vobiz conference room (DELETE /Conference/{name}/): every member is disconnected at once and the room ends. " +
        "Use it to close a meeting on time or clean up an abandoned room; to remove only some people, use kick_conference_member or hangup_conference_member. Requires confirm: true.",
      inputSchema: { conference_name: conferenceName, confirm: confirm("end this conference for everyone in it") },
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
        description,
        inputSchema: { conference_name: conferenceName, member_id: memberId },
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
    "Unmute members of a live Vobiz conference (DELETE /Conference/{name}/Member/{id}/Mute/) so the room can hear them again. " +
      "Pass one member_id, a comma-separated list, or all. Unmuting a member who is not muted still succeeds.",
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
    "Let deafened members of a live Vobiz conference hear the room again (DELETE /Conference/{name}/Member/{id}/Deaf/). " +
      "Pass one member_id, a comma-separated list, or all. Undeafening a member who is not deafened still succeeds.",
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
        "so you can play them a message or route them elsewhere. To end their call instead, use hangup_conference_member. Pass one member_id, a comma-separated list, or all. Requires confirm: true.",
      inputSchema: { conference_name: conferenceName, member_id: memberId, confirm: confirm("remove this member from the conference") },
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
        "Use it to drop a participant completely; to keep their call going after they leave, use kick_conference_member. Pass one member_id, a comma-separated list, or all. Requires confirm: true.",
      inputSchema: { conference_name: conferenceName, member_id: memberId, confirm: confirm("hang up this member's call") },
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
        "Use it for whispered prompts or announcements, or pass member_id all to reach the whole room. Stop with stop_audio_to_conference_member.",
      inputSchema: { conference_name: conferenceName, member_id: memberId, url: audioUrl.describe("Audio file to play (https .mp3 or .wav).") },
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
        "Pass one member_id, a comma-separated list, or all. It succeeds even when nothing is playing.",
      inputSchema: { conference_name: conferenceName, member_id: memberId },
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
        "Vobiz queues the recording; the reply carries no recording ID or file URL. Stop with stop_conference_recording. Requires confirm: true.",
      inputSchema: {
        conference_name: conferenceName,
        file_format: z.enum(["mp3", "wav"]).optional().describe("Recording format (default mp3)."),
        confirm: confirm("record this conference"),
      },
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
        "Stop the recording of a live Vobiz conference room (DELETE /Conference/{name}/Record/). Use it when the part you needed is captured; the conference itself keeps running.",
      inputSchema: { conference_name: conferenceName },
      annotations: write(true),
    },
    handler(async ({ conference_name }) => {
      const res = await conferenceRequest(ctx, "DELETE", roomPath(conference_name, "Record/"), "DELETE Conference/{name}/Record/");
      return ok({ ok: true, conference_name, recording: false, http_status: res.status });
    }),
  );
}
