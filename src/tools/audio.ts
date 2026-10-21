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
import { handler, ok, safeErrorText } from "../util.js";

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

/** Errors from storage (not VobizError) are logged (name and a short, URL-query-stripped message) before they become internal_error. */
function logged<T>(ctx: ToolContext, op: string, p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    if (!(err instanceof VobizError)) ctx.log.info(`audio: ${op} failed: ${safeErrorText(err)}`);
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

// ── Result fields shared by the audio tools ─────────────────────
const okTrue = z.literal(true).describe("Always true on success; failures come back as an isError result with `error` and `message` instead.");
const audioOut = z
  .object({
    id: z.string().optional().describe("Library id of the file, unique per account; accepted wherever a name is."),
    name: z.string().optional().describe("The saved name, as given on upload or import; pass it as `audio` to schedule_reminder_call or `play` to make_call."),
    duration_sec: z.number().optional().describe("Length of the converted audio in seconds."),
    bytes: z.number().optional().describe("Size of the stored (phone-ready) file in bytes."),
    source: z.enum(["upload", "url", "phone"]).optional().describe("How it was added: upload (file or microphone via an upload link), url (import_audio_from_url) or phone (recorded on a call)."),
    created_at: z.string().optional().describe("When it was saved (ISO 8601, UTC)."),
  })
  .passthrough()
  .describe("One audio file in the account's library.");

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
          "Afterwards pass the saved name as `audio` to schedule_reminder_call. For a public https link the user pastes, use import_audio_from_url. " +
          "Creating the link stores nothing: the file joins the library (see list_audio) only once the upload completes, and the link works for a single attempt. Fails with not_allowed while audio conversion is unavailable.",
        inputSchema: {
          name: audioName
            .optional()
            .describe("Suggested name for the audio, 1-80 characters of letters, digits, spaces and - _ . ( ), e.g. \"Morning alarm\"; prefilled on the upload page and used in the curl command. The user can still change it."),
        },
        outputSchema: z
          .object({
            ok: okTrue,
            upload_url: z.string().optional().describe("One-time https upload link: open it in a browser to pick, drop or record a file, or PUT the file to it directly."),
            expires_in_minutes: z.number().int().optional().describe("Minutes the link stays valid (15)."),
            how_to: z.array(z.string()).optional().describe("Step-by-step instructions, including the exact curl command for a direct PUT upload."),
          })
          .passthrough(),
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
        "It needs a direct https link to an audio FILE (.mp3, .wav, .m4a, .ogg…), not a web page such as Pixabay, YouTube, Spotify or SoundCloud; if the user only has a page link, ask for the direct file link or use create_audio_upload_link so they can upload the file. " +
        `${limitsText(svc)} Then pass the name as \`audio\` to schedule_reminder_call. For a file on the user's device, or a recording, use create_audio_upload_link. ` +
        "The download is size-capped, follows only a few redirects and refuses private hosts; the file is converted to phone audio before it is saved, so the call completes only after the download and conversion. Fails with not_allowed while conversion is unavailable.",
      inputSchema: {
        url: z.string().trim().url().max(2048).describe("Public https link straight to the audio file (no credentials in the URL, not a web page)."),
        name: audioName.describe("Name to save it under, 1-80 characters of letters, digits, spaces and - _ . ( ), e.g. \"Morning alarm\"; unique in this account's library."),
      },
      outputSchema: z
        .object({
          ok: okTrue,
          audio: audioOut.optional().describe("The saved file, with the name to use on calls and its length."),
          note: z.string().optional().describe("Human-readable confirmation naming the file and how to play it on a call."),
        })
        .passthrough(),
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
      description:
        "List the audio files in this Vobiz account's library (newest first) that can be played on reminder and wake-up calls: id, name, length in seconds, size, how each was added and when, plus the library's limits (files per account, MB and seconds per file, uploads per day). " +
        "Use a file's name or id as `audio` in schedule_reminder_call or `play` in make_call; add files with import_audio_from_url or create_audio_upload_link, remove them with delete_audio. An empty library returns count 0, not an error.",
      inputSchema: {},
      outputSchema: z
        .object({
          ok: okTrue,
          count: z.number().int().optional().describe("Number of files in the library."),
          audio: z.array(audioOut).optional().describe("The files, newest first."),
          limits: z
            .object({
              max_files: z.number().optional().describe("Maximum files the library holds; delete one before adding more at the cap."),
              max_mb_per_file: z.number().optional().describe("Maximum size of one uploaded or imported file, in MB."),
              max_seconds_per_file: z.number().optional().describe("Maximum length of one file, in seconds."),
              max_uploads_per_day: z.number().optional().describe("Maximum uploads and imports per day for this account."),
            })
            .passthrough()
            .optional()
            .describe("The library limits this server enforces."),
        })
        .passthrough(),
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
        "Delete ONE audio file from this Vobiz account's library, permanently. Needs confirm: true after the user agrees; called without it, the tool answers confirmation_required naming the file and how many scheduled reminder calls use it, so the user can decide. " +
        "Reminder calls that use it still ring and speak their message, without the audio. Fails with not_found when no file matches (list_audio shows the saved names); to replace a file, import or upload the new one first.",
      inputSchema: {
        audio: audioRef.describe("The file to delete: its saved name (as shown by list_audio) or its id."),
        confirm: z.boolean().describe("Must be true, set only after the user confirmed deleting this audio."),
      },
      outputSchema: z
        .object({
          ok: okTrue,
          deleted: z.literal(true).optional().describe("True once the file was removed."),
          audio: audioOut.optional().describe("The file that was deleted."),
          reminders_using_it: z.number().int().optional().describe("How many scheduled, snoozed or in-progress reminder calls referenced it; they will play their message without the audio."),
          note: z.string().optional().describe("Human-readable confirmation, including the reminders affected."),
        })
        .passthrough(),
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
