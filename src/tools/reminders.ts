import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { digitsOnly } from "../config.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { assertDestinationAllowed } from "../policy.js";
import type { Attempt, AttemptOutcome, Reminder, ReminderAccount, ReminderService, ReminderStatus } from "../reminders/types.js";
import { DEFAULT_TIME_ZONE, formatLocal, parseWhen } from "../tz.js";
import { handler, idempotencyKey, listField, ok, phoneNumber, toE164 } from "../util.js";
import { SPEAK_LANGS } from "../xml.js";
import type { AudioMeta } from "../media/types.js";
import { audioRef, registerAudioTools } from "./audio.js";
import { assertCallerIdOwned } from "./calls.js";

/** Errors from the store or scheduler (not VobizError) are logged by message only before they become internal_error. */
function logged<T>(ctx: ToolContext, op: string, p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    if (!(err instanceof VobizError)) ctx.log.info(`reminders: ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  });
}

type Rec = Record<string, unknown>;

const STATUSES = ["scheduled", "calling", "snoozed", "done", "stopped", "cancelled", "failed"] as const satisfies readonly ReminderStatus[];
const ACTIVE: ReminderStatus[] = ["scheduled", "snoozed", "calling"];

const reminderId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{4,100}$/, "must be a reminder id returned by schedule_reminder_call or list_reminder_calls");

const STATUS_WORDS: Record<ReminderStatus, string> = {
  scheduled: "scheduled: the call will be placed at the next call time",
  calling: "calling now",
  snoozed: "snoozed: the user pressed 1, the call will be placed again at the next call time",
  done: "done: the user pressed 2 to confirm",
  stopped: "stopped: the user pressed 9 to stop these calls",
  cancelled: "cancelled",
  failed: "failed: no further calls will be placed",
};

const OUTCOME_WORDS: Record<AttemptOutcome, string> = {
  confirmed: "answered and pressed 2 to confirm",
  snoozed: "answered and pressed 1 to snooze",
  stopped: "answered and pressed 9 to stop",
  no_input: "answered but no key was pressed",
  no_answer: "not answered",
  busy: "the line was busy",
  voicemail: "went to voicemail (answering machine)",
  rejected: "the call was rejected",
  failed: "the call could not be placed",
};

/** The signed-in account's credentials (hosted mode puts them on cfg for each request). */
function account(ctx: ToolContext): ReminderAccount {
  const { authId, authToken } = ctx.cfg;
  if (!authId || !authToken) throw new VobizError("missing_credentials", "This connection has no Vobiz account credentials. Sign in again.");
  return { authId, authToken };
}

const tzOf = (ctx: ToolContext) => ctx.profile?.timezone || DEFAULT_TIME_ZONE;

/** First active, voice-capable number on the account: the default caller ID when the user did not choose one. */
async function firstVoiceNumber(ctx: ToolContext): Promise<string> {
  const res = await ctx.client.request<Rec>("GET", ctx.client.accountPath("/numbers"), {
    query: { status: "active", page: 1, per_page: 100 },
    route: "GET numbers",
  });
  const items = listField(res.data, "items") ?? [];
  const n = items.find(
    (x) =>
      typeof x.e164 === "string" &&
      (x.status === undefined || x.status === "active") &&
      x.voice_enabled !== false &&
      (x.capabilities as Rec | undefined)?.voice !== false &&
      x.is_blocked !== true,
  );
  if (!n) {
    throw new VobizError(
      "not_allowed",
      "This Vobiz account has no active voice number to place the reminder call from. Add one in the Vobiz console, or pass `from`.",
    );
  }
  return toE164(n.e164 as string);
}

function summary(r: Reminder): Rec {
  return {
    reminder_id: r.id,
    status: r.status,
    status_text: STATUS_WORDS[r.status] ?? r.status,
    kind: r.kind,
    message: r.message,
    at_utc: r.at,
    at_local: formatLocal(r.at, r.timezone),
    next_call_utc: r.nextAt,
    next_call_local: r.nextAt ? formatLocal(r.nextAt, r.timezone) : null,
    timezone: r.timezone,
    to: r.to,
    from: r.from,
    attempts_made: r.attempts.filter((a) => a.startedAt || a.outcome).length,
    max_attempts: r.maxAttempts,
  };
}

function attemptView(a: Attempt, tz: string): Rec {
  return {
    attempt: a.n,
    scheduled_for_local: formatLocal(a.scheduledFor, tz),
    started_local: a.startedAt ? formatLocal(a.startedAt, tz) : null,
    outcome: a.outcome ?? null,
    outcome_text: a.outcome ? OUTCOME_WORDS[a.outcome] : a.startedAt ? "in progress" : "not placed yet",
    digits: a.digits ?? null,
    talk_seconds: a.billsec ?? null,
    call_uuid: a.callUuid ?? null,
  };
}

export function registerReminderTools(server: McpServer, ctx: ToolContext): void {
  const svc: ReminderService | undefined = ctx.reminders;
  // Reminder calls need this server to fire jobs and answer Vobiz callbacks: hosted connector only.
  if (!svc) return;

  // ── schedule_reminder_call ───────────────────────────────────
  server.registerTool(
    "schedule_reminder_call",
    {
      title: "Schedule a reminder or wake-up call",
      description:
        "Vobiz: use this when the user wants a PHONE CALL at a time — a wake-up call, a reminder call, 'call me at…'. Not for text or in-app reminders. " +
        "The server places the call itself at that time, speaks the message, and lets the user press 1 to snooze, 2 to confirm, 9 to stop; it retries when there is no answer. " +
        "Confirm the time (in the user's timezone), the message and the number with the user, then pass confirm: true. " +
        "Call it ONCE per reminder: nothing has to stay open or be polled afterwards. `at` is ISO 8601 with an offset (2026-10-21T06:00:00+05:30), a local time without an offset (read in the timezone chosen at sign-in), or \"now\". " +
        (ctx.media
          ? "To play the user's own audio first, pass `audio` (a name from list_audio; add files with create_audio_upload_link or import_audio_from_url) or a public `audio_url`. "
          : "") +
        `\`to\` defaults to the user's own number from sign-in; \`from\` defaults to the caller ID chosen at sign-in, else the first voice number on the account. At most ${svc.limits.maxDaysAhead} days ahead.`,
      inputSchema: {
        at: z.string().trim().min(3).max(40).describe("When to call: ISO 8601 with offset, local ISO time without offset (sign-in timezone), or \"now\"."),
        message: z.string().trim().min(1).max(400).describe("What the call says after the intro, in plain words (max 400 characters)."),
        kind: z.enum(["wake_up", "reminder"]).optional().describe("wake_up opens with a good-morning greeting; reminder (default) with a reminder greeting."),
        to: phoneNumber.optional().describe("Number to call, E.164. One number only. Defaults to the user's own number from sign-in."),
        from: phoneNumber.optional().describe("Caller ID: a voice number on this account, E.164."),
        language: z.enum(SPEAK_LANGS).optional().describe("Speech language (default en-US)."),
        voice: z.enum(["WOMAN", "MAN"]).optional().describe("Speech voice (default WOMAN)."),
        audio_url: z
          .string()
          .url()
          .max(2048)
          .optional()
          .describe("Optional public https link to an MP3 or WAV file played at the start of the call, before the spoken message (for example the user's own recording or alarm sound). Not together with audio."),
        audio: audioRef
          .optional()
          .describe("Optional audio from this account's library (its name or id, see list_audio) played at the start of the call, before the spoken message. Not together with audio_url."),
        snooze_minutes: z.number().int().min(1).max(60).optional().describe("Pressing 1 calls again after this many minutes (default 10)."),
        max_attempts: z.number().int().min(1).max(5).optional().describe("Total call attempts including retries (default 3)."),
        retry_minutes: z.number().int().min(1).max(30).optional().describe("Minutes between retries after no answer, busy or voicemail (default 5)."),
        confirm: z.boolean().describe("Must be true, set only after the user confirmed the time, message and number."),
        idempotency_key: idempotencyKey.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
    },
    handler(async (args) => {
      const { cfg } = ctx;
      const profile = ctx.profile;
      const scope = profile?.scope ?? "full";
      if (!cfg.enableCalls) {
        throw new VobizError("calls_disabled", "Outbound calling is disabled on this MCP server, so reminder calls cannot be placed. An administrator must set VOBIZ_ENABLE_CALLS=true.");
      }
      const tz = tzOf(ctx);
      const now = Date.now();
      const when = parseWhen(args.at, tz, now);
      if (!when) {
        throw new VobizError("invalid_input", `at must be ISO 8601 with an offset (e.g. 2026-10-21T06:00:00+05:30), a local time such as 2026-10-21T06:00 (read in ${tz}), or "now".`);
      }
      if (when.getTime() < now - 60_000) throw new VobizError("invalid_input", `That time (${formatLocal(when, tz)}) has already passed. Ask the user for a time in the future.`);
      if (when.getTime() > now + svc.limits.maxDaysAhead * 86400_000) {
        throw new VobizError("invalid_input", `Reminder calls can be scheduled at most ${svc.limits.maxDaysAhead} days ahead.`);
      }

      // Destination: the user's own number unless full scope allows another one.
      let to: string;
      if (scope === "assistant") {
        if (!profile?.callMeOn) throw new VobizError("not_allowed", "This connection has no number to call. Reconnect and enter your number under \"Call me on\".");
        if (args.to && digitsOnly(args.to) !== digitsOnly(profile.callMeOn)) {
          throw new VobizError(
            "not_allowed",
            `This connection may only call your own number (${toE164(profile.callMeOn)}). Reconnect with full access to call other numbers.`,
          );
        }
        to = toE164(profile.callMeOn);
      } else {
        const t = args.to ?? profile?.callMeOn;
        if (!t) throw new VobizError("invalid_input", "Pass `to`: the number to call in E.164 (no default number was set at sign-in).");
        to = toE164(t);
      }
      assertDestinationAllowed(cfg, to);

      let audio: AudioMeta | undefined;
      if (args.audio !== undefined) {
        if (args.audio_url) throw new VobizError("invalid_input", "Pass either audio (from the audio library) or audio_url, not both.");
        if (!ctx.media) throw new VobizError("invalid_input", "This server has no audio library. Pass audio_url with a public https MP3 or WAV link instead.");
        audio = await logged(ctx, "find audio", ctx.media.find(account(ctx).authId, args.audio));
        if (!audio) {
          throw new VobizError("not_found", `No audio named "${args.audio}" in this account's library. Use list_audio to see the saved files, or create_audio_upload_link to add one.`);
        }
      }

      const withAudio = audio ? ` (starting with the audio "${audio.name}")` : "";
      const intro = `${args.kind === "wake_up" ? "Wake-up" : "Reminder"} call to ${to} at ${formatLocal(when, tz)}${withAudio}: "${args.message}"`;
      if (args.confirm !== true) {
        throw new VobizError("confirmation_required", `Ask the user to confirm this ${intro}, then call schedule_reminder_call again with confirm: true.`);
      }

      let from: string;
      const chosen = args.from ?? profile?.callFrom;
      if (chosen) {
        from = toE164(chosen);
        if (cfg.allowedCallerIds.length && !cfg.allowedCallerIds.includes(digitsOnly(from))) {
          throw new VobizError("not_allowed", "This caller ID is not in the server's VOBIZ_ALLOWED_CALLER_IDS allowlist.");
        }
        await assertCallerIdOwned(ctx, from);
      } else {
        from = await firstVoiceNumber(ctx);
      }

      const r = await logged(ctx, "schedule", svc.schedule(
        account(ctx),
        {
          kind: args.kind ?? "reminder",
          message: args.message,
          at: when.toISOString(),
          timezone: tz,
          to,
          from,
          language: args.language ?? "en-US",
          voice: args.voice ?? "WOMAN",
          ...(args.audio_url ? { audioUrl: args.audio_url } : {}),
          ...(audio ? { audioId: audio.id } : {}),
          snoozeMinutes: args.snooze_minutes ?? 10,
          maxAttempts: args.max_attempts ?? 3,
          retryMinutes: args.retry_minutes ?? 5,
        },
        args.idempotency_key ? { idempotencyKey: args.idempotency_key } : undefined,
      ));
      return ok({
        ok: true,
        reminder_id: r.id,
        status: r.status,
        at_utc: r.at,
        at_local: formatLocal(r.at, r.timezone),
        timezone: r.timezone,
        to: r.to,
        from: r.from,
        message: r.message,
        snooze_minutes: r.snoozeMinutes,
        max_attempts: r.maxAttempts,
        ...(audio ? { audio: { id: audio.id, name: audio.name, duration_sec: audio.durationSec } } : {}),
        note: `Scheduled. Vobiz will call ${r.to} at ${formatLocal(r.at, r.timezone)} by itself; nothing else needs to run. The user can press 1 to snooze ${r.snoozeMinutes} minutes, 2 to confirm, 9 to stop. Use cancel_reminder_call with this reminder_id to cancel it.`,
      });
    }),
  );

  // ── list_reminder_calls ──────────────────────────────────────
  server.registerTool(
    "list_reminder_calls",
    {
      title: "List reminder calls",
      description: "List the reminder and wake-up calls scheduled on this Vobiz account, newest first, with their status and next call time in the user's timezone. Read-only.",
      inputSchema: {
        status: z.enum([...STATUSES, "active"]).optional().describe("Filter by status; active = scheduled, snoozed or calling."),
        limit: z.number().int().min(1).max(50).optional().describe("Max reminders to return (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async (args) => {
      const { authId } = account(ctx);
      const status = args.status === "active" ? ACTIVE : args.status ? [args.status] : undefined;
      const items = await logged(ctx, "list", svc.list(authId, { ...(status ? { status } : {}), limit: args.limit ?? 20 }));
      return ok({ ok: true, count: items.length, reminders: items.map(summary) });
    }),
  );

  // ── get_reminder_call ────────────────────────────────────────
  server.registerTool(
    "get_reminder_call",
    {
      title: "Get a reminder call",
      description: "Return ONE reminder call with every attempt so far and what happened on each (answered and confirmed, snoozed, not answered, busy, voicemail…). Read-only.",
      inputSchema: { reminder_id: reminderId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async ({ reminder_id }) => {
      const r = await logged(ctx, "get", svc.get(account(ctx).authId, reminder_id));
      if (!r) throw new VobizError("not_found", "No reminder call with this id on this account. Use list_reminder_calls to see them.");
      return ok({ ok: true, ...summary(r), language: r.language, voice: r.voice, snooze_minutes: r.snoozeMinutes, retry_minutes: r.retryMinutes, attempts: r.attempts.map((a) => attemptView(a, r.timezone)) });
    }),
  );

  // ── cancel_reminder_call ─────────────────────────────────────
  server.registerTool(
    "cancel_reminder_call",
    {
      title: "Cancel a reminder call",
      description: "Cancel ONE scheduled or snoozed reminder call so no further calls are placed for it. Needs confirm: true after the user agrees. Cancelling an already finished reminder changes nothing.",
      inputSchema: {
        reminder_id: reminderId,
        confirm: z.boolean().describe("Must be true, set only after the user confirmed cancelling this reminder."),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
    },
    handler(async ({ reminder_id, confirm }) => {
      const { authId } = account(ctx);
      const before = await logged(ctx, "get", svc.get(authId, reminder_id));
      if (!before) throw new VobizError("not_found", "No reminder call with this id on this account. Use list_reminder_calls to see them.");
      if (confirm !== true) {
        throw new VobizError("confirmation_required", `Ask the user to confirm cancelling the reminder call at ${formatLocal(before.at, before.timezone)} ("${before.message}"), then call cancel_reminder_call again with confirm: true.`);
      }
      if (!ACTIVE.includes(before.status)) {
        return ok({ ok: true, ...summary(before), cancelled: false, note: `This reminder is already ${before.status}; nothing was changed.` });
      }
      const r = await logged(ctx, "cancel", svc.cancel(authId, reminder_id));
      if (!r) throw new VobizError("not_found", "No reminder call with this id on this account.");
      return ok({ ok: true, ...summary(r), cancelled: r.status === "cancelled", note: r.status === "cancelled" ? "Cancelled. No further calls will be placed for this reminder." : `Reminder is ${r.status}.` });
    }),
  );

  // Audio library tools (same toolset): only when the hosted connector provides a MediaService.
  registerAudioTools(server, ctx);
}
