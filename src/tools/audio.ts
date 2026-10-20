/**
 * Audio library tools: the user's own recordings and sounds, played with <Play> before the spoken message of a
 * reminder call. Registered from the reminders toolset, only when the hosted connector provides a MediaService.
 *
 * Files reach the library three ways: the one-time upload page (pick, drop or record), a direct PUT to the same
 * link (code sandboxes), or an https URL import. schedule_reminder_call then takes the file's name as `audio`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import type { AudioMeta, MediaService } from "../media/types.js";
import { handler, ok } from "../util.js";

type Rec = Record<string, unknown>;

/** The same rule the service and the upload page apply. */
export const audioName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} _.()-]+$/u, "may use letters, digits, spaces and - _ . ( ) only");

/** An id from list_audio, or a saved name. */
export const audioRef = z.string().trim().min(1).max(80).describe("The audio's name (as saved) or its id from list_audio.");

export function audioView(m: AudioMeta): Rec {
  return {
    id: m.id,
    name: m.name,
    duration_sec: m.durationSec,
    bytes: m.bytes,
    source: m.source,
    created_at: m.createdAt,
  };
}

function authIdOf(ctx: ToolContext): string {
  const id = ctx.cfg.authId;
  if (!id) throw new VobizError("missing_credentials", "This connection has no Vobiz account credentials. Sign in again.");
  return id;
}

/** Errors from storage (not VobizError) are logged by message only before they become internal_error. */
function logged<T>(ctx: ToolContext, op: string, p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    if (!(err instanceof VobizError)) ctx.log.info(`audio: ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  });
}

async function assertConversionAvailable(ctx: ToolContext): Promise<void> {
  const available = ctx.mediaUploads?.available;
  if (available && !(await available().catch(() => false))) {
    throw new VobizError(
      "not_allowed",
      "Adding audio is temporarily unavailable on this server. For now, pass audio_url to schedule_reminder_call with a public https link to an MP3 or WAV file.",
    );
  }
}

const mb = (bytes: number) => Math.max(1, Math.round(bytes / 1048576));
const limitsText = (svc: MediaService) => `Up to ${mb(svc.limits.maxInputBytes)} MB and ${Math.round(svc.limits.maxDurationSec / 6) / 10} minutes per file.`;

export function registerAudioTools(server: McpServer, ctx: ToolContext): void {
  const svc = ctx.media;
  if (!svc) return;

  // ── create_audio_upload_link ─────────────────────────────────
  if (ctx.mediaUploads) {
    const uploads = ctx.mediaUploads;
    server.registerTool(
      "create_audio_upload_link",
      {
        title: "Create an audio upload link",
        description:
          "Vobiz: use this when the user wants their OWN audio file or recording played on a reminder or wake-up call (e.g. 'use this MP3 as my alarm', 'let me record the message'). " +
          "Returns a one-time Vobiz upload link (valid 15 minutes) where the user picks or drops a file, or records from the microphone, and gives it a name. " +
          "When the user attached the file in this chat and you can run code, upload it to the same link with the curl command in how_to instead. " +
          `${limitsText(svc)} Any common format works (MP3, WAV, M4A, OGG, WEBM, AAC, FLAC); it is converted for phone calls. ` +
          "Afterwards pass the saved name as `audio` to schedule_reminder_call. For a public https link the user pastes, use import_audio_from_url.",
        inputSchema: {
          name: audioName.optional().describe("Suggested name for the audio, e.g. \"Morning alarm\"; prefilled on the upload page and used in the curl command."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      handler(async ({ name }) => {
        const authId = authIdOf(ctx);
        await assertConversionAvailable(ctx);
        const url = uploads.url(authId, name);
        const label = name ?? "<name>";
        return ok({
          ok: true,
          upload_url: url,
          expires_in_minutes: 15,
          how_to: [
            "Give the user upload_url: they open it to upload a file or record from the microphone, then name it. The link works for one attempt: if that upload fails, create a new link to try again.",
            `Or, when the user attached the file in this chat and you can run code, upload it yourself (set Content-Type to the file's type): curl -sS -X PUT -H "Content-Type: audio/mpeg" -H "X-Audio-Name: ${label}" --data-binary @<file> ${url}`,
            `Then the user says "use the audio ${label}": pass that name as audio to schedule_reminder_call.`,
          ],
        });
      }),
    );
  }

  // ── import_audio_from_url ────────────────────────────────────
  server.registerTool(
    "import_audio_from_url",
    {
      title: "Import audio from a link",
      description:
        "Vobiz: save the audio at a public https link the user pastes (an MP3, WAV or other audio file) into this account's audio library under a name, for use on reminder and wake-up calls. " +
        `${limitsText(svc)} Then pass the name as \`audio\` to schedule_reminder_call. For a file on the user's device, or a recording, use create_audio_upload_link.`,
      inputSchema: {
        url: z.string().trim().url().max(2048).describe("Public https link to the audio file."),
        name: audioName.describe("Name to save it under, e.g. \"Morning alarm\"; unique in this account's library."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async ({ url, name }) => {
      const authId = authIdOf(ctx);
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new VobizError("invalid_input", "url is not a valid link.");
      }
      if (u.protocol !== "https:") throw new VobizError("invalid_input", "url must be an https link.");
      if (u.username || u.password) throw new VobizError("invalid_input", "url must not contain credentials.");
      await assertConversionAvailable(ctx);
      const m = await logged(ctx, "import", svc.importFromUrl(authId, url, name));
      return ok({ ok: true, audio: audioView(m), note: `Saved as "${m.name}" (${m.durationSec} s). Pass audio: "${m.name}" to schedule_reminder_call to play it on a call.` });
    }),
  );

  // ── list_audio ───────────────────────────────────────────────
  server.registerTool(
    "list_audio",
    {
      title: "List saved audio",
      description: "List the audio files in this Vobiz account's library (newest first) that can be played on reminder and wake-up calls, with their names and lengths. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async () => {
      const items = await logged(ctx, "list", svc.list(authIdOf(ctx)));
      return ok({
        ok: true,
        count: items.length,
        audio: items.map(audioView),
        limits: { max_files: svc.limits.maxPerAccount, max_mb_per_file: mb(svc.limits.maxInputBytes), max_seconds_per_file: svc.limits.maxDurationSec, max_uploads_per_day: svc.limits.maxUploadsPerDay },
      });
    }),
  );

  // ── delete_audio ─────────────────────────────────────────────
  server.registerTool(
    "delete_audio",
    {
      title: "Delete saved audio",
      description:
        "Delete ONE audio file from this Vobiz account's library. Needs confirm: true after the user agrees. Reminder calls that use it still ring and speak their message, without the audio.",
      inputSchema: {
        audio: audioRef,
        confirm: z.boolean().describe("Must be true, set only after the user confirmed deleting this audio."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ audio, confirm }) => {
      const authId = authIdOf(ctx);
      const m = await logged(ctx, "find", svc.find(authId, audio));
      if (!m) throw new VobizError("not_found", "No audio with this name or id in this account's library. Use list_audio to see the saved files.");
      const active = ctx.reminders
        ? (await ctx.reminders.list(authId, { status: ["scheduled", "snoozed", "calling"], limit: 100 }).catch(() => [])).filter((r) => r.audioId === m.id).length
        : 0;
      const usedBy = active ? ` ${active} scheduled reminder call${active === 1 ? " uses" : "s use"} it and will play the message without the audio.` : "";
      if (confirm !== true) {
        throw new VobizError("confirmation_required", `Ask the user to confirm deleting the audio "${m.name}".${usedBy} Then call delete_audio again with confirm: true.`);
      }
      const gone = await logged(ctx, "delete", svc.delete(authId, m.id));
      if (!gone) throw new VobizError("not_found", "No audio with this name or id in this account's library.");
      return ok({ ok: true, deleted: true, audio: audioView(gone), reminders_using_it: active, note: `Deleted "${gone.name}".${usedBy}` });
    }),
  );
}
