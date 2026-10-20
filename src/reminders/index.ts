/**
 * Reminder-call backend selection and the module's public surface.
 *
 * VOBIZ_GCP_PROJECT + VOBIZ_TASKS_LOCATION + VOBIZ_TASKS_QUEUE set → Cloud Tasks + Firestore (durable, multi-replica).
 * Otherwise → in-process timers + memory (single replica; reminders are lost on restart).
 * The Google clients are imported lazily, on first use, so the npm/stdio server never loads them.
 */
import type { Logger } from "../logger.js";
import { CloudTasksScheduler, MemoryScheduler } from "./scheduler.js";
import { DEFAULT_LIMITS } from "./service.js";
import { FirestoreStore, MemoryStore } from "./store.js";
import type { ReminderLimits, ReminderStore, Scheduler } from "./types.js";

export * from "./types.js";
export { MemoryStore, FirestoreStore, accountHash, ACTIVE_STATUSES } from "./store.js";
export { MemoryScheduler, CloudTasksScheduler, MAX_TIMER_MS } from "./scheduler.js";
export { createReminderService, formatLocalTime, DEFAULT_LIMITS, MAX_TOTAL_ATTEMPTS, ANSWER_TTL_SEC, type ReminderServiceOptions } from "./service.js";
export { createRemindersRouter, reminderSignatureMode, NonceCache, MAX_NONCES, type RemindersRouterOptions } from "./router.js";
export * as scripts from "./script.js";

export interface ReminderBackend {
  mode: "gcp" | "memory";
  store: ReminderStore;
  scheduler: Scheduler;
  /** From VOBIZ_MAX_ACTIVE_REMINDERS / VOBIZ_MAX_REMINDER_CALLS_PER_DAY, else the defaults. */
  limits: ReminderLimits;
}

function intEnv(name: string, v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/**
 * Picks the backend from the environment. `baseUrl` (the public URL Cloud Tasks posts to) comes from
 * VOBIZ_PUBLIC_URL unless passed; it is required for the GCP backend.
 */
export function createReminderBackend(env: NodeJS.ProcessEnv, log: Logger, o: { baseUrl?: string } = {}): ReminderBackend {
  const v = (k: string) => env[k]?.trim() || undefined;
  const limits: ReminderLimits = {
    maxActive: intEnv("VOBIZ_MAX_ACTIVE_REMINDERS", env.VOBIZ_MAX_ACTIVE_REMINDERS, DEFAULT_LIMITS.maxActive, 1, 1000),
    maxCallsPerDay: intEnv("VOBIZ_MAX_REMINDER_CALLS_PER_DAY", env.VOBIZ_MAX_REMINDER_CALLS_PER_DAY, DEFAULT_LIMITS.maxCallsPerDay, 1, 1000),
    maxDaysAhead: DEFAULT_LIMITS.maxDaysAhead,
  };
  const project = v("VOBIZ_GCP_PROJECT");
  const location = v("VOBIZ_TASKS_LOCATION");
  const queue = v("VOBIZ_TASKS_QUEUE");
  if (project && location && queue) {
    const baseUrl = (o.baseUrl ?? v("VOBIZ_PUBLIC_URL"))?.replace(/\/+$/, "");
    if (!baseUrl) throw new Error("VOBIZ_PUBLIC_URL is required for the Cloud Tasks reminder backend");
    log.info(`reminders: Cloud Tasks queue ${queue} (${location}) + Firestore`);
    return {
      mode: "gcp",
      limits,
      scheduler: new CloudTasksScheduler({ project, location, queue, baseUrl, log }),
      store: new FirestoreStore({
        projectId: project,
        databaseId: v("VOBIZ_FIRESTORE_DATABASE") ?? "(default)",
        collection: v("VOBIZ_FIRESTORE_COLLECTION") ?? "reminders",
      }),
    };
  }
  log.info("reminders: WARNING in-memory scheduler and store (single replica only; scheduled reminders are lost on restart). Set VOBIZ_GCP_PROJECT, VOBIZ_TASKS_LOCATION and VOBIZ_TASKS_QUEUE for durable reminders.");
  return { mode: "memory", limits, scheduler: new MemoryScheduler({ log }), store: new MemoryStore() };
}
