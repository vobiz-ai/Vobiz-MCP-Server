import type { VobizClient } from "./client.js";
import type { Config } from "./config.js";
import type { FlowStore } from "./flows.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { EventStore } from "./webhooks.js";
import type { Logger } from "./logger.js";
import type { ReminderService } from "./reminders/types.js";
import type { MediaService } from "./media/types.js";
import type { CallScriptBackend } from "./callscript/types.js";

/** How the audio tools hand out upload links (hosted connector: sealed one-time /upload/:token URLs). */
export interface MediaUploads {
  /** A one-time upload URL for this account, valid 15 minutes; `name` prefills the name field on the page. */
  url(authId: string, name?: string): string;
  /** False when audio conversion (ffmpeg) is not installed: uploads and imports are refused with a clear message. */
  available?: () => Promise<boolean>;
}

/** What the user chose at sign-in on the hosted connector (absent in stdio and single-account HTTP mode). */
export interface ConnectionProfile {
  /** read = read-only tools; assistant = reminder calls to callMeOn plus a few lookups; full = every tool. */
  scope: "read" | "assistant" | "full";
  /** The user's own number, E.164: where reminder calls go (forced in assistant scope). */
  callMeOn?: string;
  /** Caller ID for reminder calls, E.164; blank = the first voice number on the account. */
  callFrom?: string;
  /** IANA timezone used to read and describe reminder times. */
  timezone?: string;
}

export interface ToolContext {
  client: VobizClient;
  cfg: Config;
  log: Logger;
  /** Process-local guard against runaway call initiation by the AI client. */
  callLimiter: SlidingWindowLimiter;
  /** Hourly cap on call initiations (VOBIZ_MAX_CALLS_PER_HOUR). */
  hourlyCallLimiter: SlidingWindowLimiter;
  /** Daily cap on number purchases. */
  purchaseLimiter: SlidingWindowLimiter;
  /** Per-minute and per-hour caps on messages sent (counted per recipient). */
  messageLimiter: SlidingWindowLimiter;
  hourlyMessageLimiter: SlidingWindowLimiter;
  idempotency: IdempotencyStore;
  /** Hosted XML flows and received callbacks: present only in HTTP mode with VOBIZ_PUBLIC_URL. */
  flows?: FlowStore;
  events?: EventStore;
  /** When true, only read-only tools are registered. */
  readOnly: boolean;
  /** Server-side reminder calls: present only on the hosted connector. */
  reminders?: ReminderService;
  /** The account's audio library for reminder calls: present only on the hosted connector. */
  media?: MediaService;
  mediaUploads?: MediaUploads;
  /** make_call `say` / `play`: this server hosts the call's VobizXML (hosted connector only). */
  callScripts?: CallScriptBackend;
  profile?: ConnectionProfile;
}

/** Shared mutable state that must survive across MCP sessions in one process (HTTP mode). */
export interface SharedState {
  callLimiter: SlidingWindowLimiter;
  hourlyCallLimiter: SlidingWindowLimiter;
  purchaseLimiter: SlidingWindowLimiter;
  messageLimiter: SlidingWindowLimiter;
  hourlyMessageLimiter: SlidingWindowLimiter;
  idempotency: IdempotencyStore;
  flows?: FlowStore;
  events?: EventStore;
}

export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if a hit would currently be allowed (does not record one). */
  wouldAllow(n = 1): boolean {
    const t = this.now();
    return this.hits.filter((h) => t - h < this.windowMs).length + n <= this.max;
  }

  /** Records `n` hits if they all fit under the limit. */
  tryAcquireMany(n: number): boolean {
    if (!this.wouldAllow(n)) return false;
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    for (let i = 0; i < n; i++) this.hits.push(t);
    return true;
  }

  /** Returns true and records a hit if under the limit. */
  tryAcquire(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }
}
