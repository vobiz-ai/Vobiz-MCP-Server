/**
 * Fires reminder jobs at a time.
 *
 *   MemoryScheduler      setTimeout in this process (tests, single replica; lost on restart)
 *   CloudTasksScheduler  one Cloud Tasks HTTP task per job → POST `${baseUrl}/jobs/fire` with the sealed job token
 *
 * Job ids are deterministic (`${reminderId}-${attempt}`), so scheduling the same job twice is a no-op.
 */
import type { Logger } from "../logger.js";
import type { ScheduledJob, Scheduler } from "./types.js";

/** setTimeout's largest delay; longer waits are chained. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function assertJob(job: ScheduledJob): void {
  if (!JOB_ID_RE.test(job.id)) throw new Error("job id must match [A-Za-z0-9_-]{1,100}");
  if (!(job.at instanceof Date) || Number.isNaN(job.at.getTime())) throw new Error("job.at must be a valid Date");
}

export class MemoryScheduler implements Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Receives the job payload when it is due. Set by createReminderService when left empty. */
  onFire?: (payload: string) => unknown;
  private readonly log?: Logger;

  constructor(o: { onFire?: (payload: string) => unknown; log?: Logger } = {}) {
    this.onFire = o.onFire;
    this.log = o.log;
  }

  /** Number of jobs waiting (tests, diagnostics). */
  get size(): number {
    return this.timers.size;
  }
  has(jobId: string): boolean {
    return this.timers.has(jobId);
  }

  async schedule(job: ScheduledJob): Promise<void> {
    assertJob(job);
    if (this.timers.has(job.id)) return; // same id = same job (Cloud Tasks ALREADY_EXISTS semantics)
    this.arm(job);
  }

  private arm(job: ScheduledJob): void {
    const delay = Math.max(0, job.at.getTime() - Date.now());
    const t = setTimeout(
      () => {
        if (delay > MAX_TIMER_MS) return this.arm(job); // not due yet: chain another timer
        this.timers.delete(job.id);
        void Promise.resolve()
          .then(() => this.onFire?.(job.payload))
          .catch(() => this.log?.info(`reminder job ${job.id} handler failed`));
      },
      Math.min(delay, MAX_TIMER_MS),
    );
    t.unref?.();
    this.timers.set(job.id, t);
  }

  async cancel(jobId: string): Promise<void> {
    const t = this.timers.get(jobId);
    if (t) clearTimeout(t);
    this.timers.delete(jobId);
  }

  /** Clears every timer (tests, shutdown). */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

// ── Cloud Tasks ───────────────────────────────────────────────────

/** The subset of CloudTasksClient used here (structural, so tests can pass a fake). */
export interface CloudTasksLike {
  createTask(req: { parent: string; task: Record<string, unknown> }): Promise<unknown>;
  deleteTask(req: { name: string }): Promise<unknown>;
}

export interface CloudTasksSchedulerOptions {
  project: string;
  location: string;
  queue: string;
  /** Public base URL of this server; tasks POST to `${baseUrl}/jobs/fire`. */
  baseUrl: string;
  /** Injected client (tests). Otherwise @google-cloud/tasks is imported on first use. */
  client?: CloudTasksLike;
  log?: Logger;
}

const ALREADY_EXISTS = 6;
const NOT_FOUND = 5;
const codeOf = (err: unknown) => (err && typeof err === "object" ? (err as { code?: unknown }).code : undefined);

export class CloudTasksScheduler implements Scheduler {
  private clientPromise?: Promise<CloudTasksLike>;
  readonly parent: string;
  private readonly fireUrl: string;

  constructor(private readonly o: CloudTasksSchedulerOptions) {
    this.parent = `projects/${o.project}/locations/${o.location}/queues/${o.queue}`;
    this.fireUrl = `${o.baseUrl.replace(/\/+$/, "")}/jobs/fire`;
    if (o.client) this.clientPromise = Promise.resolve(o.client);
  }

  private client(): Promise<CloudTasksLike> {
    this.clientPromise ??= import("@google-cloud/tasks").then(({ CloudTasksClient }) => new CloudTasksClient() as unknown as CloudTasksLike);
    return this.clientPromise;
  }

  taskName(jobId: string): string {
    return `${this.parent}/tasks/${jobId}`;
  }

  async schedule(job: ScheduledJob): Promise<void> {
    assertJob(job);
    const ms = job.at.getTime();
    const task = {
      name: this.taskName(job.id),
      scheduleTime: { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 },
      httpRequest: {
        httpMethod: "POST",
        url: this.fireUrl,
        headers: { "Content-Type": "text/plain" },
        body: Buffer.from(job.payload, "utf8").toString("base64"),
      },
    };
    try {
      await (await this.client()).createTask({ parent: this.parent, task });
    } catch (err) {
      if (codeOf(err) === ALREADY_EXISTS) return; // deterministic name: this job is already queued (or ran)
      this.o.log?.info(`Cloud Tasks createTask failed for job ${job.id} (code ${String(codeOf(err) ?? "?")})`);
      throw err;
    }
  }

  async cancel(jobId: string): Promise<void> {
    try {
      await (await this.client()).deleteTask({ name: this.taskName(jobId) });
    } catch (err) {
      if (codeOf(err) === NOT_FOUND) return;
      throw err;
    }
  }
}
