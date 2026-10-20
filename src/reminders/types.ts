/**
 * Reminder calls ("call me at 6 to wake me up"): shared contracts between the domain module
 * (src/reminders/*), the MCP tools (src/tools/reminders.ts) and the hosted connector (src/hosted.ts).
 *
 * Scheduling lives on this server, never in the AI client: the client calls schedule once, this server
 * fires the call at the right time, builds the VobizXML when the call is answered, handles snooze /
 * confirm / stop, and retries when nobody picks up.
 *
 * Credentials are never written to the store. They travel only inside sealed tokens (job and ans).
 */

export type ReminderKind = "wake_up" | "reminder";

export type ReminderStatus =
  | "scheduled" // a job is queued for nextAt
  | "calling" // a call for the current attempt is in progress
  | "snoozed" // the user pressed snooze; a job is queued for nextAt
  | "done" // the user confirmed (pressed 2)
  | "stopped" // the user pressed 9 on the call
  | "cancelled" // cancelled from the MCP client
  | "failed"; // attempts exhausted or a non-retryable failure

export type AttemptOutcome =
  | "confirmed" // pressed 2
  | "snoozed" // pressed 1
  | "stopped" // pressed 9
  | "no_input" // answered, no key press
  | "no_answer"
  | "busy"
  | "voicemail" // answering machine detected
  | "rejected"
  | "failed";

/** Vobiz credentials of the account the call is billed to. Sealed into tokens only. */
export interface ReminderAccount {
  authId: string;
  authToken: string;
}

export interface ReminderInput {
  kind: ReminderKind;
  /** What the call says after the fixed intro. Plain text, already validated (1..400 chars). */
  message: string;
  /** When to call, ISO 8601 in UTC (e.g. 2026-10-21T00:30:00.000Z). */
  at: string;
  /** IANA timezone used to describe times back to the user, e.g. Asia/Kolkata. */
  timezone: string;
  /** Destination, E.164. */
  to: string;
  /** Caller ID, E.164: a Vobiz number on the account. */
  from: string;
  /** Speak language (see SPEAK_LANGS in src/xml.ts), default en-US. */
  language: string;
  voice: "WOMAN" | "MAN";
  /** Press 1 → call again after this many minutes (1..60). */
  snoozeMinutes: number;
  /** Total call attempts including retries (1..5). */
  maxAttempts: number;
  /** No answer / busy / voicemail / no input → retry after this many minutes (1..30). */
  retryMinutes: number;
  /** Optional https MP3/WAV played before the spoken message (phase 2: user audio). */
  audioUrl?: string;
}

export interface Attempt {
  /** 1-based attempt number. */
  n: number;
  scheduledFor: string;
  startedAt?: string;
  requestUuid?: string;
  callUuid?: string;
  /** Digit pressed on this attempt, if any. */
  digits?: string;
  outcome?: AttemptOutcome;
  hangupCause?: string;
  billsec?: number;
  endedAt?: string;
}

export interface Reminder extends ReminderInput {
  /** URL-safe id, e.g. r_8f2k…; unique per account. */
  id: string;
  authId: string;
  /** OAuth client that created it (informational). */
  clientId?: string;
  status: ReminderStatus;
  createdAt: string;
  updatedAt: string;
  /** Next scheduled call time (UTC ISO) while scheduled/snoozed, else null. */
  nextAt: string | null;
  attempts: Attempt[];
  idempotencyKey?: string;
}

/** Durable reminder records. Implementations: MemoryStore (tests, single process) and FirestoreStore (hosted). */
export interface ReminderStore {
  create(r: Reminder): Promise<void>;
  get(authId: string, id: string): Promise<Reminder | undefined>;
  /** Newest first. */
  list(authId: string, opts?: { status?: ReminderStatus[]; limit?: number }): Promise<Reminder[]>;
  /** Shallow merge; returns the stored record or undefined if missing. */
  update(authId: string, id: string, patch: Partial<Reminder>): Promise<Reminder | undefined>;
  findByIdempotencyKey(authId: string, key: string): Promise<Reminder | undefined>;
}

export interface ScheduledJob {
  /** Deterministic, [A-Za-z0-9_-]{1,100}: `${reminderId}-${attempt}`; used for de-duplication. */
  id: string;
  at: Date;
  /** Opaque sealed "job" token; delivered back unchanged to ReminderService.fire(). */
  payload: string;
}

/** Fires a job at a time. Implementations: MemoryScheduler (setTimeout) and CloudTasksScheduler (HTTP task → POST /jobs/fire). */
export interface Scheduler {
  schedule(job: ScheduledJob): Promise<void>;
  /** Best effort; a fired job for a cancelled reminder is ignored by the service anyway. */
  cancel(jobId: string): Promise<void>;
}

/** Sealed into every job token. */
export interface JobPayload extends ReminderAccount {
  rid: string;
  /** Attempt number this job fires. */
  n: number;
}

/** Sealed into the per-call token behind /r/:token/answer|input|hangup. */
export interface AnswerPayload extends ReminderAccount {
  rid: string;
  n: number;
}

export interface ReminderLimits {
  /** Active (scheduled/snoozed/calling) reminders per account. */
  maxActive: number;
  /** Reminder call attempts per destination per UTC day. */
  maxCallsPerDay: number;
  /** How far ahead a reminder may be scheduled, in days (Cloud Tasks allows 30). */
  maxDaysAhead: number;
}

/** Callback parameters Vobiz posts to the hangup URL (subset used here). */
export interface HangupParams {
  CallUUID?: string;
  RequestUUID?: string;
  HangupCause?: string;
  HangupCauseName?: string;
  HangupCauseCode?: string;
  BillDuration?: string;
  Duration?: string;
  AnswerTime?: string;
  [k: string]: string | undefined;
}

export interface ReminderService {
  readonly limits: ReminderLimits;
  schedule(account: ReminderAccount, input: ReminderInput, opts?: { idempotencyKey?: string; clientId?: string }): Promise<Reminder>;
  list(authId: string, opts?: { status?: ReminderStatus[]; limit?: number }): Promise<Reminder[]>;
  get(authId: string, id: string): Promise<Reminder | undefined>;
  cancel(authId: string, id: string): Promise<Reminder | undefined>;
  /** Job delivery (POST /jobs/fire). Places the call for the attempt, or ignores a stale job. Never throws to the caller. */
  fire(jobToken: string): Promise<{ fired: boolean; reason?: string }>;
  /** VobizXML for the answered call (GET|POST /r/:token/answer); undefined when the token is invalid or the reminder is no longer active. */
  answerXml(ansToken: string): Promise<string | undefined>;
  /** VobizXML after a key press (POST /r/:token/input). */
  inputXml(ansToken: string, digits: string): Promise<string | undefined>;
  /** Final call outcome (POST /r/:token/hangup): classifies, records the attempt and schedules a retry when due. */
  hangup(ansToken: string, params: HangupParams): Promise<void>;
}
