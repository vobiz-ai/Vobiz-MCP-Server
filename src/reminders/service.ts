/**
 * Reminder-call domain logic: validation and limits at schedule time, job delivery (places the call),
 * the VobizXML conversation (answer → key press) and the final outcome (hangup → retry or finish).
 *
 * Credentials never reach the store: the account's Auth ID / Auth Token ride only inside sealed tokens
 * (job: scheduler → /jobs/fire, ans: Vobiz → /r/:token/*). Every state change that must happen once
 * (claiming a job, recording a hangup) is a compare-and-set through ReminderStore.update(fn).
 * Logs carry reminder ids and attempt numbers only, never numbers, messages or tokens.
 */
import { randomBytes } from "node:crypto";
import { VobizClient } from "../client.js";
import { digitsOnly, type Config } from "../config.js";
import { VobizError, type ErrorKind } from "../errors.js";
import type { Logger } from "../logger.js";
import { classifyHangup } from "../outcomes.js";
import { assertDestinationAllowed } from "../policy.js";
import type { Sealer } from "../sealer.js";
import { toE164 } from "../util.js";
import { SPEAK_LANGS } from "../xml.js";
import { MemoryScheduler } from "./scheduler.js";
import {
  answerScript,
  confirmedScript,
  goodbyeScript,
  repromptScript,
  snoozedScript,
  snoozeLimitScript,
  stoppedScript,
} from "./script.js";
import type {
  AnswerPayload,
  Attempt,
  AttemptOutcome,
  HangupParams,
  JobPayload,
  Reminder,
  ReminderAccount,
  ReminderInput,
  ReminderLimits,
  ReminderService,
  ReminderStatus,
  ReminderStore,
  Scheduler,
} from "./types.js";

export const DEFAULT_LIMITS: ReminderLimits = { maxActive: 20, maxCallsPerDay: 10, maxDaysAhead: 30 };

/** Hard ceiling on calls for one reminder, snoozes included (each snooze opens a fresh retry window). */
export const MAX_TOTAL_ATTEMPTS = 10;

/** Premium-rate ranges never dialled by a reminder, on top of VOBIZ_BLOCKED_PREFIXES. Emergency and short codes fail the length check. */
export const REMINDER_BLOCKED_PREFIXES = ["1900", "1976", "449", "4487", "4470", "3389"];

const ACTIVE: ReminderStatus[] = ["scheduled", "snoozed", "calling"];
const ANSWER_TTL_SEC = 2 * 3600;
/** A job token stays valid this long after its due time (Cloud Tasks delivery retries). */
const JOB_GRACE_SEC = 3 * 86400;
/** API errors that a retry cannot fix. */
const FATAL_API: ErrorKind[] = ["auth_failed", "forbidden", "not_allowed", "invalid_input", "account_suspended", "missing_credentials"];
/** API errors where Vobiz certainly did not dial: the job is redelivered (HTTP 503 → Cloud Tasks retry). */
const TRANSIENT_API: ErrorKind[] = ["service_unavailable", "backend_error", "rate_limited"];
/** Memory backend: redeliveries of a transient failure (Cloud Tasks does this itself). */
const MEMORY_REDELIVERIES = 5;
const MEMORY_REDELIVERY_MS = 60_000;
const E164 = /^\+?[1-9]\d{7,14}$/;

export interface ReminderServiceOptions {
  store: ReminderStore;
  scheduler: Scheduler;
  sealer: Sealer;
  /** Public base URL of this server (answer/hangup URLs handed to Vobiz). */
  baseUrl: string;
  /** Server config: API base URL, timeout, destination policy, caller-ID checks. Credentials in it are ignored. */
  cfg: Config;
  log: Logger;
  fetchImpl?: typeof fetch;
  limits?: Partial<ReminderLimits>;
  now?: () => Date;
}

const invalid = (msg: string) => new VobizError("invalid_input", msg);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "Tue 21 Oct, 06:00 IST" in the reminder's timezone. */
export function formatLocalTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const zoneName = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(d).find((x) => x.type === "timeZoneName")?.value ?? "";
  let zone = zoneName("en-US");
  if (zone.startsWith("GMT") && zone !== "GMT") zone = zoneName("en-IN") || zone; // en-IN knows IST
  return `${p("weekday")} ${p("day")} ${p("month")}, ${p("hour")}:${p("minute")} ${zone}`.trim();
}

function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function intIn(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalid(`${name} must be a whole number from ${min} to ${max}.`);
  return v;
}

/** One E.164 number, nothing that Vobiz would expand (`<` lists, sip: URIs). */
function singleNumber(v: unknown, field: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (/[<>,;@]|sip:/i.test(s)) throw invalid(`${field} must be ONE phone number in E.164 (no lists, no SIP addresses).`);
  if (!E164.test(s)) throw invalid(`${field} must be a phone number in E.164 such as +919876543210.`);
  return toE164(s);
}

/** Attempts in the current retry window: since the last snooze, so a snoozed reminder gets its retries again. */
function windowCount(r: Reminder, n: number): number {
  const lastSnooze = r.attempts.filter((a) => a.n < n && a.outcome === "snoozed").reduce((m, a) => Math.max(m, a.n), 0);
  return n - lastSnooze;
}
function canRetry(r: Reminder, n: number): boolean {
  return windowCount(r, n) < r.maxAttempts && n < MAX_TOTAL_ATTEMPTS;
}

function withAttempt(r: Reminder, n: number, patch: Partial<Attempt>): Attempt[] {
  return r.attempts.map((a) => (a.n === n ? { ...a, ...patch } : a));
}

const isAccount = (p: Partial<ReminderAccount> | undefined): p is ReminderAccount =>
  !!p && typeof p.authId === "string" && !!p.authId && typeof p.authToken === "string" && !!p.authToken;

export function createReminderService(opts: ReminderServiceOptions): ReminderService {
  const { store, scheduler, sealer, cfg, log } = opts;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const limits: ReminderLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());
  const iso = (d: Date = now()) => d.toISOString();

  const client = (a: ReminderAccount) => new VobizClient({ ...cfg, authId: a.authId, authToken: a.authToken }, log, opts.fetchImpl);

  const openAns = (token: string): AnswerPayload | undefined => {
    const a = sealer.open<AnswerPayload>("ans", token);
    return a && isAccount(a) && typeof a.rid === "string" && Number.isInteger(a.n) && a.n >= 1 ? a : undefined;
  };

  /** Seals and queues attempt n. On failure the reminder is marked failed (nothing else would call). */
  async function queueAttempt(r: Reminder, account: ReminderAccount, n: number, at: Date): Promise<boolean> {
    const ttl = Math.max(0, Math.ceil((at.getTime() - now().getTime()) / 1000)) + JOB_GRACE_SEC;
    const payload = sealer.seal("job", { rid: r.id, n, authId: account.authId, authToken: account.authToken } satisfies JobPayload, ttl);
    try {
      await scheduler.schedule({ id: `${r.id}-${n}`, at, payload });
      return true;
    } catch {
      log.info(`reminder ${r.id}: could not queue attempt ${n}`);
      await store.update(r.authId, r.id, { status: "failed", nextAt: null, updatedAt: iso() }).catch(() => undefined);
      return false;
    }
  }

  async function assertCallerIdOwned(account: ReminderAccount, from: string): Promise<void> {
    const res = await client(account).request<{ items?: Record<string, unknown>[] }>("GET", `/api/v1/Account/${encodeURIComponent(account.authId)}/numbers`, {
      query: { search: from, per_page: 25 },
      route: "GET numbers?search",
    });
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    const match = items.find((n) => typeof n.e164 === "string" && digitsOnly(n.e164) === digitsOnly(from));
    if (!match) {
      throw new VobizError("not_allowed", "The caller ID is not a phone number on this Vobiz account. Use list_phone_numbers to see the numbers you can call from.");
    }
    const voiceOff =
      match.voice_enabled === false || (match.capabilities as Record<string, unknown> | undefined)?.voice === false || match.is_blocked === true;
    if (match.status !== "active" || voiceOff) {
      throw new VobizError("not_allowed", `The caller ID exists on this account but cannot place calls (status: ${String(match.status)}).`);
    }
  }

  function validate(input: ReminderInput): ReminderInput {
    if (!input || typeof input !== "object") throw invalid("Missing reminder details.");
    if (input.kind !== "wake_up" && input.kind !== "reminder") throw invalid("kind must be wake_up or reminder.");
    const message = typeof input.message === "string" ? input.message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
    if (message.length < 1 || message.length > 400) throw invalid("message must be 1 to 400 characters.");
    const atMs = typeof input.at === "string" ? Date.parse(input.at) : NaN;
    if (!Number.isFinite(atMs)) throw invalid("at must be an ISO 8601 date-time.");
    const t = now().getTime();
    if (atMs < t - 60_000) throw invalid("at is in the past. Ask the user for a future time.");
    if (atMs > t + limits.maxDaysAhead * 86400_000) throw invalid(`at must be within ${plural(limits.maxDaysAhead, "day")} from now.`);
    if (!validTimeZone(input.timezone)) throw invalid("timezone must be an IANA timezone such as Asia/Kolkata.");
    const to = singleNumber(input.to, "to");
    const from = singleNumber(input.from, "from");
    if (!(SPEAK_LANGS as readonly string[]).includes(input.language)) throw invalid(`language must be one of ${SPEAK_LANGS.join(", ")}.`);
    if (input.voice !== "WOMAN" && input.voice !== "MAN") throw invalid("voice must be WOMAN or MAN.");
    if (input.audioUrl !== undefined) {
      let ok = false;
      try {
        const u = new URL(input.audioUrl);
        ok = u.protocol === "https:" && /\.(mp3|wav)$/i.test(u.pathname);
      } catch {
        ok = false;
      }
      if (!ok) throw invalid("audioUrl must be an https link to an .mp3 or .wav file.");
    }
    return {
      kind: input.kind,
      message,
      at: new Date(Math.max(atMs, t)).toISOString(),
      timezone: input.timezone,
      to,
      from,
      language: input.language,
      voice: input.voice,
      snoozeMinutes: intIn(input.snoozeMinutes, 1, 60, "snoozeMinutes"),
      maxAttempts: intIn(input.maxAttempts, 1, 5, "maxAttempts"),
      retryMinutes: intIn(input.retryMinutes, 1, 30, "retryMinutes"),
      ...(input.audioUrl ? { audioUrl: input.audioUrl } : {}),
    };
  }

  function assertDestination(to: string): void {
    assertDestinationAllowed(cfg, to);
    const d = digitsOnly(to);
    const blocked = REMINDER_BLOCKED_PREFIXES.find((p) => d.startsWith(p));
    if (blocked) throw new VobizError("not_allowed", `Reminder calls to premium-rate numbers (+${blocked}…) are not allowed.`);
  }

  async function assertLimits(account: ReminderAccount, input: ReminderInput): Promise<void> {
    const recent = await store.list(account.authId, { limit: 500 });
    const active = recent.filter((r) => ACTIVE.includes(r.status)).length;
    if (active >= limits.maxActive) {
      throw new VobizError("rate_limited", `This account already has ${active} active reminder calls (limit ${limits.maxActive}). Cancel one first.`);
    }
    const day = input.at.slice(0, 10);
    const to = digitsOnly(input.to);
    let calls = 0;
    for (const r of recent) {
      if (digitsOnly(r.to) !== to) continue;
      calls += r.attempts.filter((a) => (a.startedAt ?? a.scheduledFor).slice(0, 10) === day).length;
      if ((r.status === "scheduled" || r.status === "snoozed") && r.nextAt?.slice(0, 10) === day) calls += 1;
    }
    if (calls >= limits.maxCallsPerDay) {
      throw new VobizError("rate_limited", `At most ${limits.maxCallsPerDay} reminder calls a day may go to one number (UTC day ${day}).`);
    }
  }

  // ── public API ─────────────────────────────────────────────────

  async function schedule(account: ReminderAccount, raw: ReminderInput, o: { idempotencyKey?: string; clientId?: string } = {}): Promise<Reminder> {
    if (!isAccount(account)) throw new VobizError("missing_credentials", "Vobiz credentials are required to schedule a reminder call.");
    const input = validate(raw);
    if (o.idempotencyKey !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(o.idempotencyKey)) {
      throw invalid("idempotency_key may use letters, digits and _ . : - (max 128).");
    }
    if (o.idempotencyKey) {
      const existing = await store.findByIdempotencyKey(account.authId, o.idempotencyKey);
      if (existing) {
        const same = existing.message === input.message && existing.at === input.at && digitsOnly(existing.to) === digitsOnly(input.to);
        if (!same) throw new VobizError("idempotency_conflict", "This idempotency_key was already used for a different reminder call.");
        return existing;
      }
    }
    assertDestination(input.to);
    if (cfg.allowedCallerIds.length && !cfg.allowedCallerIds.includes(digitsOnly(input.from))) {
      throw new VobizError("not_allowed", "This caller ID is not in the server's VOBIZ_ALLOWED_CALLER_IDS allowlist.");
    }
    await assertLimits(account, input);
    if (cfg.verifyCallerId) await assertCallerIdOwned(account, input.from);

    const ts = iso();
    const r: Reminder = {
      ...input,
      id: "r_" + randomBytes(12).toString("base64url"),
      authId: account.authId,
      ...(o.clientId ? { clientId: o.clientId } : {}),
      status: "scheduled",
      createdAt: ts,
      updatedAt: ts,
      nextAt: input.at,
      attempts: [],
      ...(o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : {}),
    };
    await store.create(r);
    if (!(await queueAttempt(r, account, 1, new Date(input.at)))) {
      throw new VobizError("service_unavailable", "The reminder could not be scheduled right now. Try again in a minute.");
    }
    log.info(`reminder ${r.id} scheduled`);
    return r;
  }

  async function cancel(authId: string, id: string): Promise<Reminder | undefined> {
    const updated = await store.update(authId, id, (cur) =>
      ACTIVE.includes(cur.status) ? { status: "cancelled", nextAt: null, updatedAt: iso() } : undefined,
    );
    if (!updated) return store.get(authId, id); // unknown (undefined) or already finished (unchanged)
    await scheduler
      .cancel(`${id}-${updated.attempts.length + 1}`)
      .catch((err: unknown) => log.info(`reminder ${id}: job cancel failed, the job is ignored when it fires (${err instanceof Error ? err.message : String(err)})`));
    log.info(`reminder ${id} cancelled`);
    return updated;
  }

  async function fire(jobToken: string): Promise<{ fired: boolean; reason?: string }> {
    const job = sealer.open<JobPayload>("job", jobToken);
    if (!job || !isAccount(job) || typeof job.rid !== "string" || !Number.isInteger(job.n) || job.n < 1) {
      return { fired: false, reason: "invalid_token" };
    }
    const account: ReminderAccount = { authId: job.authId, authToken: job.authToken };
    const n = job.n;
    let r: Reminder | undefined;
    let before = undefined as Pick<Reminder, "status" | "nextAt"> | undefined; // set inside the claim
    try {
      r = await store.update(job.authId, job.rid, (cur) => {
        if (!((cur.status === "scheduled" || cur.status === "snoozed") && cur.attempts.length === n - 1)) return undefined;
        before = { status: cur.status, nextAt: cur.nextAt };
        return {
          status: "calling",
          nextAt: null,
          updatedAt: iso(),
          attempts: [...cur.attempts, { n, scheduledFor: cur.nextAt ?? iso(), startedAt: iso() }],
        };
      });
      if (!r) {
        const cur = await store.get(job.authId, job.rid);
        return { fired: false, reason: cur ? "stale" : "not_found" };
      }
    } catch {
      log.info(`reminder ${job.rid}: store unavailable on fire`);
      return { fired: false, reason: "transient" };
    }

    const ans = sealer.seal("ans", { rid: r.id, n, authId: account.authId, authToken: account.authToken } satisfies AnswerPayload, ANSWER_TTL_SEC);
    const body = {
      from: digitsOnly(r.from),
      to: toE164(r.to),
      answer_url: `${baseUrl}/r/${ans}/answer`,
      answer_method: "POST",
      hangup_url: `${baseUrl}/r/${ans}/hangup`,
      hangup_method: "POST",
      ring_timeout: "45",
      time_limit: 180,
      // No answering-machine detection: a short "hello" is easily taken for a machine, and the call would be cut
      // before the XML runs. A pickup without a key press is classified as no_input from the hangup callback instead.
      caller_name: "Vobiz reminder",
    };
    try {
      const res = await client(account).request<Record<string, unknown>>("POST", `/api/v1/Account/${encodeURIComponent(account.authId)}/Call/`, {
        body,
        sideEffect: true,
        route: "POST Call/ (reminder)",
      });
      const requestUuid = typeof res.data?.request_uuid === "string" ? res.data.request_uuid : undefined;
      if (requestUuid) {
        await store.update(r.authId, r.id, (cur) => ({ attempts: withAttempt(cur, n, { requestUuid }), updatedAt: iso() })).catch(() => undefined);
      }
      log.info(`reminder ${r.id} attempt ${n} placed`);
      return { fired: true };
    } catch (err) {
      const kind: ErrorKind = err instanceof VobizError ? err.kind : "internal_error";
      log.info(`reminder ${r.id} attempt ${n} call failed (${kind})`);
      if (TRANSIENT_API.includes(kind) && before) {
        // Vobiz said no before dialling (5xx / 429): undo the claim so the job's redelivery can place the call.
        const prev = before;
        const undone = await store
          .update(r.authId, r.id, (cur) =>
            cur.status === "calling" && cur.attempts.length === n && !cur.attempts[n - 1]?.requestUuid
              ? { status: prev.status, nextAt: prev.nextAt, attempts: cur.attempts.slice(0, n - 1), updatedAt: iso() }
              : undefined,
          )
          .catch(() => undefined);
        if (undone) return { fired: false, reason: "transient" };
      }
      const retry = !FATAL_API.includes(kind) && canRetry(r, n);
      const nextAt = new Date(now().getTime() + r.retryMinutes * 60_000);
      const updated = await store
        .update(r.authId, r.id, (cur) =>
          cur.status === "calling" && cur.attempts.length === n
            ? {
                attempts: withAttempt(cur, n, { outcome: "failed", hangupCause: `api_error:${kind}`, endedAt: iso() }),
                status: retry ? "scheduled" : "failed",
                nextAt: retry ? nextAt.toISOString() : null,
                updatedAt: iso(),
              }
            : undefined,
        )
        .catch(() => undefined);
      if (updated && retry && (await queueAttempt(updated, account, n + 1, nextAt))) return { fired: false, reason: "call_failed_retry_scheduled" };
      return { fired: false, reason: "call_failed" };
    }
  }

  /** The current attempt of an active call, or undefined. */
  async function current(token: string): Promise<{ a: AnswerPayload; r: Reminder } | undefined> {
    const a = openAns(token);
    if (!a) return undefined;
    const r = await store.get(a.authId, a.rid);
    if (!r || r.status !== "calling" || r.attempts.length !== a.n) return undefined;
    return { a, r };
  }

  const inputUrl = (token: string) => `${baseUrl}/r/${token}/input`;

  async function answerXml(token: string): Promise<string | undefined> {
    const c = await current(token);
    if (!c) return undefined;
    return answerScript(c.r, { actionUrl: inputUrl(token), retryInMinutes: canRetry(c.r, c.a.n) ? c.r.retryMinutes : null });
  }

  async function inputXml(token: string, digits: string): Promise<string | undefined> {
    const c = await current(token);
    if (!c) return undefined;
    const { a, r } = c;
    const n = a.n;
    const d = typeof digits === "string" ? digits.trim().slice(0, 8) : "";
    const isCurrent = (cur: Reminder) => cur.status === "calling" && cur.attempts.length === n;
    const decide = (outcome: AttemptOutcome, status: ReminderStatus, nextAt: string | null = null) =>
      store.update(r.authId, r.id, (cur) =>
        isCurrent(cur) ? { attempts: withAttempt(cur, n, { digits: d, outcome }), status, nextAt, updatedAt: iso() } : undefined,
      );

    if (d === "1") {
      if (n >= MAX_TOTAL_ATTEMPTS) {
        if (!(await decide("snoozed", "done"))) return undefined;
        log.info(`reminder ${r.id} snooze refused (attempt ceiling)`);
        return snoozeLimitScript(r);
      }
      const at = new Date(now().getTime() + r.snoozeMinutes * 60_000);
      const updated = await decide("snoozed", "snoozed", at.toISOString());
      if (!updated) return undefined;
      await queueAttempt(updated, { authId: a.authId, authToken: a.authToken }, n + 1, at);
      log.info(`reminder ${r.id} snoozed on attempt ${n}`);
      return snoozedScript(r, r.snoozeMinutes);
    }
    if (d === "2") {
      if (!(await decide("confirmed", "done"))) return undefined;
      log.info(`reminder ${r.id} confirmed`);
      return confirmedScript(r);
    }
    if (d === "9") {
      if (!(await decide("stopped", "stopped"))) return undefined;
      log.info(`reminder ${r.id} stopped by the callee`);
      return stoppedScript(r);
    }
    // Anything else: repeat the menu once, then say goodbye (the hangup then counts as no input).
    const att = r.attempts[n - 1];
    const retryInMinutes = canRetry(r, n) ? r.retryMinutes : null;
    const updated = await store.update(r.authId, r.id, (cur) =>
      isCurrent(cur) ? { attempts: withAttempt(cur, n, { ...(d ? { digits: d } : {}), reprompted: true }), updatedAt: iso() } : undefined,
    );
    if (!updated) return undefined;
    return att?.reprompted ? goodbyeScript(r, retryInMinutes) : repromptScript(r, { actionUrl: inputUrl(token), retryInMinutes });
  }

  async function hangup(token: string, p: HangupParams): Promise<void> {
    const a = openAns(token);
    if (!a) return;
    const params = p ?? {};
    const r = await store.get(a.authId, a.rid);
    const att = r?.attempts[a.n - 1];
    if (!r || !att || att.n !== a.n || att.endedAt) return; // unknown, or this attempt was already recorded
    const n = a.n;

    const cause = String(params.HangupCauseName || params.HangupCause || "").slice(0, 64);
    const bill = Number(params.BillDuration);
    const billsec = params.BillDuration !== undefined && params.BillDuration !== "" && Number.isFinite(bill) ? bill : undefined;
    const machine =
      /MACHINE_DETECTED/i.test(cause) || /MACHINE_DETECTED/i.test(String(params.HangupCause ?? "")) || String(params.HangupCauseCode ?? "") === "9100";
    const decided = att.outcome === "confirmed" || att.outcome === "snoozed" || att.outcome === "stopped";

    let outcome: AttemptOutcome;
    let retryable = false;
    if (decided) outcome = att.outcome as AttemptOutcome;
    else if (machine) [outcome, retryable] = ["voicemail", true];
    else {
      const c = classifyHangup(cause, billsec);
      switch (c.outcome) {
        case "answered":
          [outcome, retryable] = ["no_input", true];
          break;
        case "busy":
          [outcome, retryable] = ["busy", true];
          break;
        case "no_answer":
        case "cancelled":
          [outcome, retryable] = ["no_answer", true];
          break;
        case "rejected":
          outcome = "rejected";
          break;
        case "unreachable":
        case "network_failure":
          [outcome, retryable] = ["failed", c.retryable];
          break;
        case "unknown":
          // No cause at all: answered if billed, otherwise treat as unanswered.
          [outcome, retryable] = billsec && billsec > 0 ? ["no_input", true] : ["no_answer", true];
          break;
        default:
          outcome = "failed";
      }
    }

    const retry = !decided && retryable && canRetry(r, n);
    const nextAt = new Date(now().getTime() + r.retryMinutes * 60_000);
    const updated = await store.update(r.authId, r.id, (cur) => {
      const x = cur.attempts[n - 1];
      if (!x || x.endedAt) return undefined; // repeated callback: already recorded
      const attempts = withAttempt(cur, n, {
        outcome,
        endedAt: iso(),
        ...(cause ? { hangupCause: cause } : {}),
        ...(billsec !== undefined ? { billsec } : {}),
        ...(params.CallUUID ? { callUuid: String(params.CallUUID).slice(0, 64) } : {}),
      });
      const owns = !decided && cur.status === "calling" && cur.attempts.length === n;
      if (!owns) return { attempts, updatedAt: iso() };
      return { attempts, status: retry ? "scheduled" : "failed", nextAt: retry ? nextAt.toISOString() : null, updatedAt: iso() };
    });
    if (!updated) return;
    log.info(`reminder ${r.id} attempt ${n} ended (${outcome})`);
    if (retry && updated.status === "scheduled" && updated.attempts.length === n) {
      await queueAttempt(updated, { authId: a.authId, authToken: a.authToken }, n + 1, nextAt);
    }
  }

  const service: ReminderService = {
    limits,
    schedule,
    list: (authId, o) => store.list(authId, o),
    get: (authId, id) => store.get(authId, id),
    cancel,
    fire: (t) => fire(t).catch(() => ({ fired: false, reason: "transient" })),
    answerXml,
    inputXml,
    hangup,
  };

  // Single-process backend: deliver due jobs straight to fire().
  if (scheduler instanceof MemoryScheduler && !scheduler.onFire) {
    scheduler.onFire = async function deliver(payload: string, tries = 0): Promise<void> {
      const res = await service.fire(payload);
      if (res.reason === "transient" && tries < MEMORY_REDELIVERIES) {
        setTimeout(() => void deliver(payload, tries + 1), MEMORY_REDELIVERY_MS).unref?.();
      }
    } as (payload: string) => Promise<void>;
  }
  return service;
}
