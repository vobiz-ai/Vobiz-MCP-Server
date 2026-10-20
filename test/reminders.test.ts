import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/logger.js";
import { Sealer } from "../src/sealer.js";
import { signV3 } from "../src/webhooks.js";
import {
  CloudTasksScheduler,
  FirestoreStore,
  MAX_TIMER_MS,
  MemoryScheduler,
  MemoryStore,
  createReminderBackend,
  createReminderService,
  createRemindersRouter,
  formatLocalTime,
  type Reminder,
  type ReminderInput,
  type ScheduledJob,
} from "../src/reminders/index.js";
import { answerScript, inactiveScript, menuText, noResponseText, snoozedScript } from "../src/reminders/script.js";
import type { FirestoreLike } from "../src/reminders/store.js";
import { AUTH_ID, OWN_NUMBER, acct, json, mockFetch, ownNumberRoute, testConfig, type Route } from "./helpers.js";

const TOKEN = "test-token-not-real";
const ACCOUNT = { authId: AUTH_ID, authToken: TOKEN };
const PUBLIC = "https://mcp.example.test";
const TO = "+919876543210";
const T0 = new Date("2026-10-20T10:00:00.000Z");

const sealer = new Sealer("s".repeat(40));

/** MemoryScheduler that records jobs and never fires on its own (tests deliver payloads by hand). */
class RecScheduler extends MemoryScheduler {
  jobs: ScheduledJob[] = [];
  cancelled: string[] = [];
  constructor() {
    super({ onFire: () => undefined });
  }
  override async schedule(job: ScheduledJob) {
    this.jobs.push(job);
    return super.schedule(job);
  }
  override async cancel(id: string) {
    this.cancelled.push(id);
    return super.cancel(id);
  }
  last(): ScheduledJob {
    return this.jobs[this.jobs.length - 1];
  }
}

const callOk: Route = { method: "POST", path: acct("/Call/"), respond: () => json(201, { request_uuid: "req-1", message: "call fired", api_id: "a1" }) };

function input(over: Partial<ReminderInput> = {}): ReminderInput {
  return {
    kind: "reminder",
    message: "Take your medicine",
    at: "2026-10-20T12:00:00.000Z",
    timezone: "Asia/Kolkata",
    to: TO,
    from: OWN_NUMBER,
    language: "en-IN",
    voice: "WOMAN",
    snoozeMinutes: 10,
    maxAttempts: 3,
    retryMinutes: 5,
    ...over,
  };
}

function setup(o: { routes?: Route[]; env?: Record<string, string>; limits?: Record<string, number> } = {}) {
  let clock = T0.getTime();
  const fetch = mockFetch(o.routes ?? [ownNumberRoute, callOk]);
  const store = new MemoryStore();
  const scheduler = new RecScheduler();
  const service = createReminderService({
    store,
    scheduler,
    sealer,
    baseUrl: PUBLIC,
    cfg: testConfig({ VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined, ...o.env }),
    log: silentLogger,
    fetchImpl: fetch.impl,
    limits: o.limits,
    now: () => new Date(clock),
  });
  const advance = (ms: number) => (clock += ms);
  const posts = () => fetch.calls.filter((c) => c.method === "POST");
  /** Fires the last queued job and returns the ans token from the placed call. */
  const fireLast = async () => {
    const res = await service.fire(scheduler.last().payload);
    const body = posts().at(-1)?.body as Record<string, string> | undefined;
    const ans = body?.answer_url ? /\/r\/([^/]+)\/answer$/.exec(body.answer_url)?.[1] : undefined;
    return { res, ans: ans as string };
  };
  return { service, store, scheduler, fetch, advance, posts, fireLast };
}

// ── script ──────────────────────────────────────────────────────

describe("reminder scripts", () => {
  const r = { kind: "wake_up" as const, message: `Gym <Dial>+1900</Dial> & "eat"`, language: "en-IN", voice: "MAN" as const, snoozeMinutes: 1 };

  it("builds the answer XML with everything user-supplied escaped", () => {
    expect(answerScript({ ...r, audioUrl: "https://cdn.example.com/a.mp3?x=1&y=2" }, { actionUrl: `${PUBLIC}/r/vbzn_abc/input`, retryInMinutes: 5 }))
      .toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <Response>
          <Play>https://cdn.example.com/a.mp3?x=1&amp;y=2</Play>
          <Gather action="https://mcp.example.test/r/vbzn_abc/input" method="POST" inputType="dtmf" numDigits="1" finishOnKey="none" executionTimeout="10">
              <Speak language="en-IN" voice="MAN">Good morning! This is your Vobiz wake-up call. Gym &lt;Dial&gt;+1900&lt;/Dial&gt; &amp; &quot;eat&quot; Press 1 to snooze for 1 minute, 2 to confirm, 9 to stop these calls.</Speak>
          </Gather>
          <Speak language="en-IN" voice="MAN">No response. I will call again in 5 minutes. Goodbye.</Speak>
      </Response>
      "
    `);
  });

  it("uses the reminder intro and omits the retry line when none will follow", () => {
    const x = answerScript({ ...r, kind: "reminder", message: "Call mum" }, { actionUrl: "https://h/r/t/input", retryInMinutes: null });
    expect(x).toContain("Hello. This is your reminder call from Vobiz. Call mum");
    expect(x).toContain(">No response. Goodbye.</Speak>");
    expect(x).not.toContain("<Play>");
    expect(menuText(10)).toBe("Press 1 to snooze for 10 minutes, 2 to confirm, 9 to stop these calls.");
    expect(noResponseText(1)).toBe("No response. I will call again in 1 minute. Goodbye.");
  });

  it("builds the snooze and inactive replies", () => {
    expect(snoozedScript(r, 10)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <Response>
          <Speak language="en-IN" voice="MAN">Snoozed. I will call you again in 10 minutes. Goodbye.</Speak>
          <Hangup/>
      </Response>
      "
    `);
    expect(inactiveScript()).toContain("<Speak>This reminder is no longer active.</Speak>\n    <Hangup/>");
  });

  it("formats local times in the reminder timezone", () => {
    expect(formatLocalTime("2026-10-21T00:30:00.000Z", "Asia/Kolkata")).toBe("Wed 21 Oct, 06:00 IST");
    expect(formatLocalTime("2026-10-21T00:30:00.000Z", "UTC")).toBe("Wed 21 Oct, 00:30 UTC");
  });
});

// ── stores ──────────────────────────────────────────────────────

const rec = (id: string, over: Partial<Reminder> = {}): Reminder => ({
  ...input(),
  id,
  authId: AUTH_ID,
  status: "scheduled",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  nextAt: "2026-10-20T12:00:00.000Z",
  attempts: [],
  ...over,
});

describe("MemoryStore", () => {
  it("creates, lists newest first, filters, isolates accounts and drops unknown fields", async () => {
    const s = new MemoryStore();
    await s.create(rec("r_a", { createdAt: "2026-10-20T10:00:00.000Z" }));
    await s.create(rec("r_b", { createdAt: "2026-10-20T11:00:00.000Z", status: "done", idempotencyKey: "k1" }));
    await s.create({ ...rec("r_c"), authId: "MA_OTHER", authToken: "secret" } as unknown as Reminder);
    await expect(s.create(rec("r_a"))).rejects.toThrow();
    expect((await s.list(AUTH_ID)).map((r) => r.id)).toEqual(["r_b", "r_a"]);
    expect((await s.list(AUTH_ID, { status: ["done"] })).map((r) => r.id)).toEqual(["r_b"]);
    expect((await s.list(AUTH_ID, { limit: 1 })).map((r) => r.id)).toEqual(["r_b"]);
    expect(await s.get(AUTH_ID, "r_c")).toBeUndefined();
    expect(JSON.stringify(await s.get("MA_OTHER", "r_c"))).not.toContain("secret");
    expect((await s.findByIdempotencyKey(AUTH_ID, "k1"))?.id).toBe("r_b");
    expect(await s.findByIdempotencyKey("MA_OTHER", "k1")).toBeUndefined();
  });

  it("update merges, supports compare-and-set and returns copies", async () => {
    const s = new MemoryStore();
    await s.create(rec("r_a"));
    expect(await s.update(AUTH_ID, "missing", { status: "done" })).toBeUndefined();
    expect((await s.update(AUTH_ID, "r_a", { status: "calling" }))?.status).toBe("calling");
    expect(await s.update(AUTH_ID, "r_a", (cur) => (cur.status === "scheduled" ? { status: "done" } : undefined))).toBeUndefined();
    const got = await s.get(AUTH_ID, "r_a");
    got!.attempts.push({ n: 1, scheduledFor: "x" });
    expect((await s.get(AUTH_ID, "r_a"))?.attempts).toEqual([]);
    expect((await s.get(AUTH_ID, "r_a"))?.status).toBe("calling");
  });
});

/** In-memory imitation of the Firestore API surface FirestoreStore uses. */
function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const snap = (d?: Record<string, unknown>) => ({ exists: !!d, data: () => (d ? structuredClone(d) : undefined) });
  const query = (filters: [string, unknown][], order?: string, lim = Infinity): any => ({
    where: (f: string, _op: string, v: unknown) => query([...filters, [f, v]], order, lim),
    orderBy: (f: string) => query(filters, f, lim),
    limit: (n: number) => query(filters, order, n),
    get: async () => {
      let rows = [...docs.values()].filter((d) => filters.every(([f, v]) => d[f] === v));
      if (order) rows = rows.sort((a, b) => String(b[order]).localeCompare(String(a[order])));
      return { docs: rows.slice(0, lim).map((d) => snap(d)) };
    },
  });
  const db: FirestoreLike & { docs: typeof docs; collections: string[] } = {
    docs,
    collections: [],
    collection: (name: string) => {
      db.collections.push(name);
      return Object.assign(query([]), {
        doc: (id: string) => ({
          id,
          get: async () => snap(docs.get(id)),
          create: async (d: Record<string, unknown>) => {
            if (docs.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
            docs.set(id, structuredClone(d));
          },
        }),
      });
    },
    runTransaction: async (fn: any) =>
      fn({ get: (ref: any) => ref.get(), set: (ref: any, d: Record<string, unknown>) => docs.set(ref.id, structuredClone(d)) }),
  };
  return db;
}

describe("FirestoreStore", () => {
  it("keys documents by account hash, stores the hash for listing and never stores the token", async () => {
    const db = fakeFirestore();
    const s = new FirestoreStore({ db, collection: "reminders_test" });
    const hash = createHash("sha256").update(AUTH_ID).digest("hex").slice(0, 16);
    await s.create({ ...rec("r_a", { idempotencyKey: "k" }), authToken: TOKEN } as unknown as Reminder);
    await s.create(rec("r_b", { createdAt: "2026-10-20T11:00:00.000Z", status: "done" }));
    expect([...db.docs.keys()]).toEqual([`${hash}_r_a`, `${hash}_r_b`]);
    expect(db.docs.get(`${hash}_r_a`)?.account).toBe(hash);
    expect(JSON.stringify([...db.docs.values()])).not.toContain(TOKEN);
    expect(db.collections.every((c) => c === "reminders_test")).toBe(true);

    expect((await s.get(AUTH_ID, "r_a"))).not.toHaveProperty("account");
    expect((await s.list(AUTH_ID)).map((r) => r.id)).toEqual(["r_b", "r_a"]);
    expect((await s.list(AUTH_ID, { status: ["scheduled"] })).map((r) => r.id)).toEqual(["r_a"]);
    expect((await s.findByIdempotencyKey(AUTH_ID, "k"))?.id).toBe("r_a");
    expect(await s.get("MA_OTHER", "r_a")).toBeUndefined();

    const u = await s.update(AUTH_ID, "r_a", (cur) => ({ attempts: [...cur.attempts, { n: 1, scheduledFor: "t", digits: undefined }], status: "calling" }));
    expect(u?.status).toBe("calling");
    expect(db.docs.get(`${hash}_r_a`)?.attempts).toEqual([{ n: 1, scheduledFor: "t" }]);
    expect(await s.update(AUTH_ID, "r_a", () => undefined)).toBeUndefined();
    expect(await s.update(AUTH_ID, "nope", { status: "done" })).toBeUndefined();
  });
});

// ── schedulers ──────────────────────────────────────────────────

describe("MemoryScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("fires at the time, de-duplicates ids and cancels", async () => {
    vi.useFakeTimers({ now: T0 });
    const fired: string[] = [];
    const s = new MemoryScheduler({ onFire: (p) => void fired.push(p) });
    await s.schedule({ id: "r_a-1", at: new Date(T0.getTime() + 1000), payload: "p1" });
    await s.schedule({ id: "r_a-1", at: new Date(T0.getTime() + 10), payload: "dup" });
    await s.schedule({ id: "r_b-1", at: new Date(T0.getTime() + 2000), payload: "p2" });
    await s.cancel("r_b-1");
    await s.cancel("unknown");
    await expect(s.schedule({ id: "bad id!", at: new Date(), payload: "x" })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toEqual(["p1"]);
    expect(s.size).toBe(0);
  });

  it("chains delays longer than setTimeout allows", async () => {
    vi.useFakeTimers({ now: T0 });
    const fired: string[] = [];
    const s = new MemoryScheduler({ onFire: (p) => void fired.push(p) });
    await s.schedule({ id: "r_long-1", at: new Date(T0.getTime() + MAX_TIMER_MS + 5000), payload: "late" });
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
    expect(fired).toEqual([]);
    expect(s.has("r_long-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toEqual(["late"]);
  });
});

describe("CloudTasksScheduler", () => {
  const mk = (impl: Partial<{ createTask: any; deleteTask: any }> = {}) => {
    const created: any[] = [];
    const deleted: string[] = [];
    const client = {
      createTask: impl.createTask ?? (async (req: any) => void created.push(req)),
      deleteTask: impl.deleteTask ?? (async (req: any) => void deleted.push(req.name)),
    };
    const s = new CloudTasksScheduler({ project: "p1", location: "asia-south1", queue: "q1", baseUrl: `${PUBLIC}/`, client });
    return { s, created, deleted };
  };

  it("creates a named HTTP task that POSTs the payload to /jobs/fire", async () => {
    const { s, created } = mk();
    await s.schedule({ id: "r_x-2", at: new Date("2026-10-21T00:30:00.250Z"), payload: "vbzj_abc" });
    expect(created).toEqual([
      {
        parent: "projects/p1/locations/asia-south1/queues/q1",
        task: {
          name: "projects/p1/locations/asia-south1/queues/q1/tasks/r_x-2",
          scheduleTime: { seconds: Date.parse("2026-10-21T00:30:00Z") / 1000, nanos: 250_000_000 },
          httpRequest: {
            httpMethod: "POST",
            url: `${PUBLIC}/jobs/fire`,
            headers: { "Content-Type": "text/plain" },
            body: Buffer.from("vbzj_abc").toString("base64"),
          },
        },
      },
    ]);
  });

  it("tolerates ALREADY_EXISTS and NOT_FOUND, rethrows other errors", async () => {
    const dup = mk({ createTask: async () => Promise.reject(Object.assign(new Error("exists"), { code: 6 })) });
    await expect(dup.s.schedule({ id: "r_x-1", at: new Date(), payload: "p" })).resolves.toBeUndefined();
    const down = mk({
      createTask: async () => Promise.reject(Object.assign(new Error("unavailable"), { code: 14 })),
      deleteTask: async () => Promise.reject(Object.assign(new Error("perm"), { code: 7 })),
    });
    await expect(down.s.schedule({ id: "r_x-1", at: new Date(), payload: "p" })).rejects.toThrow("unavailable");
    await expect(down.s.cancel("r_x-1")).rejects.toThrow("perm");
    const gone = mk({ deleteTask: async () => Promise.reject(Object.assign(new Error("nf"), { code: 5 })) });
    await expect(gone.s.cancel("r_x-1")).resolves.toBeUndefined();
    const ok = mk();
    await ok.s.cancel("r_x-3");
    expect(ok.deleted).toEqual(["projects/p1/locations/asia-south1/queues/q1/tasks/r_x-3"]);
  });
});

// ── service ─────────────────────────────────────────────────────

describe("ReminderService.schedule", () => {
  it("stores the reminder without credentials and queues attempt 1", async () => {
    const t = setup();
    const r = await t.service.schedule(ACCOUNT, input({ message: "  Take\nyour medicine " }), { clientId: "c1" });
    expect(r).toMatchObject({ status: "scheduled", nextAt: "2026-10-20T12:00:00.000Z", attempts: [], message: "Take your medicine", clientId: "c1" });
    expect(r.id).toMatch(/^r_[A-Za-z0-9_-]{16}$/);
    expect(JSON.stringify(await t.store.list(AUTH_ID))).not.toContain(TOKEN);
    const job = t.scheduler.last();
    expect(job.id).toBe(`${r.id}-1`);
    expect(job.at.toISOString()).toBe("2026-10-20T12:00:00.000Z");
    expect(sealer.open("job", job.payload)).toMatchObject({ rid: r.id, n: 1, authId: AUTH_ID, authToken: TOKEN });
    const lookup = t.fetch.calls[0];
    expect(lookup.url.pathname).toBe(acct("/numbers"));
    expect(lookup.url.searchParams.get("search")).toBe(OWN_NUMBER);
    expect(lookup.headers["X-Auth-Token"]).toBe(TOKEN);
  });

  it.each([
    ["a < list", { to: `${TO}<+919876543211` }, "ONE phone number"],
    ["a SIP URI", { to: "sip:alice@example.com" }, "ONE phone number"],
    ["an emergency short code", { to: "112" }, "E.164"],
    ["a past time", { at: "2026-10-20T09:58:00.000Z" }, "in the past"],
    ["more than 30 days ahead", { at: "2026-11-20T10:00:01.000Z" }, "within 30 days"],
    ["a bad timezone", { timezone: "Mars/Olympus" }, "IANA"],
    ["an empty message", { message: "   " }, "1 to 400"],
    ["a long message", { message: "x".repeat(401) }, "1 to 400"],
    ["an unknown language", { language: "xx-XX" }, "language"],
    ["too many attempts", { maxAttempts: 6 }, "maxAttempts"],
    ["an http audio URL", { audioUrl: "http://x.example/a.mp3" }, "audioUrl"],
  ])("rejects %s", async (_n, over, msg) => {
    const t = setup();
    await expect(t.service.schedule(ACCOUNT, input(over as Partial<ReminderInput>))).rejects.toMatchObject({ kind: "invalid_input", message: expect.stringContaining(msg) });
    expect(t.scheduler.jobs).toEqual([]);
  });

  it("accepts a time up to 60 s in the past as now", async () => {
    const t = setup();
    const r = await t.service.schedule(ACCOUNT, input({ at: "2026-10-20T09:59:30.000Z" }));
    expect(r.at).toBe(T0.toISOString());
  });

  it("applies the destination policy and blocks premium ranges", async () => {
    await expect(setup().service.schedule(ACCOUNT, input({ to: "+14155550100" }))).rejects.toMatchObject({ kind: "not_allowed" });
    const open = setup({ env: { VOBIZ_ALLOWED_COUNTRY_CODES: "" } });
    await expect(open.service.schedule(ACCOUNT, input({ to: "+19005550100" }))).rejects.toMatchObject({ kind: "not_allowed", message: expect.stringContaining("premium") });
  });

  it("requires the caller ID to be an active number on the account", async () => {
    const t = setup({ routes: [{ method: "GET", path: acct("/numbers"), respond: () => json(200, { items: [] }) }] });
    await expect(t.service.schedule(ACCOUNT, input())).rejects.toMatchObject({ kind: "not_allowed" });
    expect(await t.store.list(AUTH_ID)).toEqual([]);
  });

  it("enforces active and per-destination daily limits", async () => {
    const t = setup({ limits: { maxActive: 2 } });
    await t.service.schedule(ACCOUNT, input());
    await t.service.schedule(ACCOUNT, input({ to: "+919876543211" }));
    await expect(t.service.schedule(ACCOUNT, input())).rejects.toMatchObject({ kind: "rate_limited" });

    const d = setup({ limits: { maxCallsPerDay: 1 } });
    await d.service.schedule(ACCOUNT, input());
    await expect(d.service.schedule(ACCOUNT, input({ at: "2026-10-20T13:00:00.000Z" }))).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(d.service.schedule(ACCOUNT, input({ at: "2026-10-21T13:00:00.000Z" }))).resolves.toBeTruthy();
  });

  it("replays an idempotency key and refuses it for a different reminder", async () => {
    const t = setup();
    const a = await t.service.schedule(ACCOUNT, input(), { idempotencyKey: "wake-1" });
    const b = await t.service.schedule(ACCOUNT, input(), { idempotencyKey: "wake-1" });
    expect(b.id).toBe(a.id);
    expect(t.scheduler.jobs).toHaveLength(1);
    await expect(t.service.schedule(ACCOUNT, input({ message: "other" }), { idempotencyKey: "wake-1" })).rejects.toMatchObject({ kind: "idempotency_conflict" });
  });

  it("marks the reminder failed when the job cannot be queued", async () => {
    const t = setup();
    t.scheduler.schedule = async () => Promise.reject(new Error("queue down"));
    await expect(t.service.schedule(ACCOUNT, input())).rejects.toMatchObject({ kind: "service_unavailable" });
    expect((await t.store.list(AUTH_ID))[0].status).toBe("failed");
  });
});

describe("ReminderService.fire", () => {
  it("places the call with the exact body and ignores a second delivery", async () => {
    const t = setup();
    const r = await t.service.schedule(ACCOUNT, input());
    t.advance(2 * 3600_000);
    const { res, ans } = await t.fireLast();
    expect(res).toEqual({ fired: true });
    const post = t.posts()[0];
    expect(post.url.pathname).toBe(acct("/Call/"));
    expect(post.body).toEqual({
      from: OWN_NUMBER.slice(1),
      to: TO,
      answer_url: `${PUBLIC}/r/${ans}/answer`,
      answer_method: "POST",
      hangup_url: `${PUBLIC}/r/${ans}/hangup`,
      hangup_method: "POST",
      ring_timeout: "45",
      time_limit: 180,
      caller_name: "Vobiz reminder",
    });
    expect(sealer.open("ans", ans)).toMatchObject({ rid: r.id, n: 1, authToken: TOKEN });
    const after = await t.service.get(AUTH_ID, r.id);
    expect(after).toMatchObject({ status: "calling", nextAt: null });
    expect(after?.attempts).toEqual([{ n: 1, scheduledFor: "2026-10-20T12:00:00.000Z", startedAt: "2026-10-20T12:00:00.000Z", requestUuid: "req-1" }]);

    expect(await t.service.fire(t.scheduler.last().payload)).toEqual({ fired: false, reason: "stale" });
    expect(t.posts()).toHaveLength(1);
  });

  it("reports invalid tokens, unknown and cancelled reminders without calling", async () => {
    const t = setup();
    expect(await t.service.fire("garbage")).toEqual({ fired: false, reason: "invalid_token" });
    expect(await t.service.fire(sealer.seal("ans", { rid: "r_x", n: 1, ...ACCOUNT }, 60))).toEqual({ fired: false, reason: "invalid_token" });
    expect(await t.service.fire(sealer.seal("job", { rid: "r_missing", n: 1, ...ACCOUNT }, 60))).toEqual({ fired: false, reason: "not_found" });
    const r = await t.service.schedule(ACCOUNT, input());
    expect((await t.service.cancel(AUTH_ID, r.id))?.status).toBe("cancelled");
    expect(t.scheduler.cancelled).toEqual([`${r.id}-1`]);
    expect(await t.service.fire(t.scheduler.last().payload)).toEqual({ fired: false, reason: "stale" });
    expect(t.posts()).toEqual([]);
  });

  it("rolls the claim back on a Vobiz 5xx so the redelivered job can call", async () => {
    let fail = true;
    const t = setup({
      routes: [ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => (fail ? json(503, { error: "down" }) : json(201, { request_uuid: "req-2" })) }],
    });
    const r = await t.service.schedule(ACCOUNT, input());
    expect(await t.service.fire(t.scheduler.last().payload)).toEqual({ fired: false, reason: "transient" });
    expect(await t.service.get(AUTH_ID, r.id)).toMatchObject({ status: "scheduled", attempts: [], nextAt: "2026-10-20T12:00:00.000Z" });
    fail = false;
    expect(await t.service.fire(t.scheduler.last().payload)).toEqual({ fired: true });
  });

  it("schedules a retry when the outcome is unknown and fails on a non-retryable API error", async () => {
    const t = setup({ routes: [ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => "network" }] });
    const r = await t.service.schedule(ACCOUNT, input());
    expect(await t.service.fire(t.scheduler.last().payload)).toEqual({ fired: false, reason: "call_failed_retry_scheduled" });
    expect(t.scheduler.last().id).toBe(`${r.id}-2`);
    expect(t.scheduler.last().at.toISOString()).toBe("2026-10-20T10:05:00.000Z");
    expect((await t.service.get(AUTH_ID, r.id))?.attempts[0]).toMatchObject({ outcome: "failed", hangupCause: "api_error:outcome_unknown" });

    const bad = setup({ routes: [ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => json(400, { error: "invalid from" }) }] });
    const r2 = await bad.service.schedule(ACCOUNT, input());
    expect(await bad.service.fire(bad.scheduler.last().payload)).toEqual({ fired: false, reason: "call_failed" });
    expect((await bad.service.get(AUTH_ID, r2.id))?.status).toBe("failed");
  });
});

describe("ReminderService call flow", () => {
  it("answers with the message and menu; rejects tokens for other attempts", async () => {
    const t = setup();
    await t.service.schedule(ACCOUNT, input({ message: "Pay rent & bills" }));
    const { ans } = await t.fireLast();
    const xml = await t.service.answerXml(ans);
    expect(xml).toContain("Pay rent &amp; bills Press 1 to snooze for 10 minutes");
    expect(xml).toContain(`action="${PUBLIC}/r/${ans}/input"`);
    expect(xml).toContain("I will call again in 5 minutes.");
    expect(await t.service.answerXml("vbzn_bogus")).toBeUndefined();
    expect(await t.service.answerXml(sealer.seal("ans", { rid: "r_x", n: 1, ...ACCOUNT }, 60))).toBeUndefined();
  });

  it("1 snoozes: queues the next attempt and the hangup keeps the snooze", async () => {
    const t = setup();
    const r = await t.service.schedule(ACCOUNT, input());
    const { ans } = await t.fireLast();
    expect(await t.service.inputXml(ans, "1")).toContain("Snoozed. I will call you again in 10 minutes.");
    expect(t.scheduler.last().id).toBe(`${r.id}-2`);
    expect(t.scheduler.last().at.toISOString()).toBe("2026-10-20T10:10:00.000Z");
    await t.service.hangup(ans, { HangupCause: "NORMAL_CLEARING", BillDuration: "12", CallUUID: "call-1" });
    const after = await t.service.get(AUTH_ID, r.id);
    expect(after).toMatchObject({ status: "snoozed", nextAt: "2026-10-20T10:10:00.000Z" });
    expect(after?.attempts[0]).toMatchObject({ digits: "1", outcome: "snoozed", hangupCause: "NORMAL_CLEARING", billsec: 12, callUuid: "call-1" });
    expect(t.scheduler.jobs).toHaveLength(2);
    // The snoozed attempt fires as attempt 2.
    t.advance(10 * 60_000);
    expect((await t.fireLast()).res).toEqual({ fired: true });
    expect((await t.service.get(AUTH_ID, r.id))?.attempts).toHaveLength(2);
  });

  it("2 confirms and 9 stops", async () => {
    const t = setup();
    const a = await t.service.schedule(ACCOUNT, input());
    const { ans } = await t.fireLast();
    expect(await t.service.inputXml(ans, "2")).toContain("Your reminder is confirmed.");
    await t.service.hangup(ans, { HangupCause: "NORMAL_CLEARING", BillDuration: "8" });
    expect(await t.service.get(AUTH_ID, a.id)).toMatchObject({ status: "done", attempts: [{ outcome: "confirmed", digits: "2" }] });
    expect(await t.service.inputXml(ans, "2")).toBeUndefined(); // call no longer active

    const b = await t.service.schedule(ACCOUNT, input({ to: "+919876543211" }));
    const s = await t.fireLast();
    expect(await t.service.inputXml(s.ans, "9")).toContain("I will not call you about this again.");
    expect((await t.service.get(AUTH_ID, b.id))?.status).toBe("stopped");
    expect(t.scheduler.jobs).toHaveLength(2);
  });

  it("re-prompts once on an invalid key, then says goodbye", async () => {
    const t = setup();
    const r = await t.service.schedule(ACCOUNT, input({ message: "Standup" }));
    const { ans } = await t.fireLast();
    const first = await t.service.inputXml(ans, "5");
    expect(first).toContain("Sorry, that is not an option. Standup Press 1");
    expect(first).toContain("<Gather");
    const second = await t.service.inputXml(ans, "7");
    expect(second).toContain("I will call again in 5 minutes. Goodbye.</Speak>\n    <Hangup/>");
    expect(second).not.toContain("<Gather");
    await t.service.hangup(ans, { HangupCause: "NORMAL_CLEARING", BillDuration: "30" });
    expect(await t.service.get(AUTH_ID, r.id)).toMatchObject({ status: "scheduled", attempts: [{ outcome: "no_input", digits: "7", reprompted: true }] });
  });

  it("retries no input / busy / voicemail until attempts run out, idempotent on repeated hangups", async () => {
    const t = setup();
    const r = await t.service.schedule(ACCOUNT, input({ maxAttempts: 3 }));
    let { ans } = await t.fireLast();
    await t.service.hangup(ans, { HangupCause: "NORMAL_CLEARING", BillDuration: "40" });
    await t.service.hangup(ans, { HangupCause: "NORMAL_CLEARING", BillDuration: "40" });
    expect(t.scheduler.jobs.map((j) => j.id)).toEqual([`${r.id}-1`, `${r.id}-2`]);
    expect(await t.service.get(AUTH_ID, r.id)).toMatchObject({ status: "scheduled", nextAt: "2026-10-20T10:05:00.000Z" });

    ({ ans } = await t.fireLast());
    await t.service.hangup(ans, { HangupCause: "MACHINE_DETECTED", HangupCauseCode: "9100", BillDuration: "3" });
    ({ ans } = await t.fireLast());
    expect(await t.service.answerXml(ans)).toContain(">No response. Goodbye.</Speak>"); // last attempt: no retry promised
    await t.service.hangup(ans, { HangupCauseName: "USER_BUSY", BillDuration: "0" });
    const done = await t.service.get(AUTH_ID, r.id);
    expect(done).toMatchObject({ status: "failed", nextAt: null });
    expect(done?.attempts.map((a) => a.outcome)).toEqual(["no_input", "voicemail", "busy"]);
    expect(t.scheduler.jobs).toHaveLength(3);
  });

  it("treats hangup cause code 9100 as voicemail, and rejected / invalid numbers as final", async () => {
    const t = setup();
    const a = await t.service.schedule(ACCOUNT, input());
    let { ans } = await t.fireLast();
    await t.service.hangup(ans, { HangupCause: "NORMAL_CLEARING", HangupCauseCode: "9100", BillDuration: "0" });
    expect((await t.service.get(AUTH_ID, a.id))?.attempts[0].outcome).toBe("voicemail");

    const b = await t.service.schedule(ACCOUNT, input({ to: "+919876543211" }));
    ({ ans } = await t.fireLast());
    await t.service.hangup(ans, { HangupCause: "CALL_REJECTED" });
    expect(await t.service.get(AUTH_ID, b.id)).toMatchObject({ status: "failed", attempts: [{ outcome: "rejected" }] });

    const c = await t.service.schedule(ACCOUNT, input({ to: "+919876543212" }));
    ({ ans } = await t.fireLast());
    await t.service.hangup(ans, { HangupCause: "UNALLOCATED_NUMBER" });
    expect(await t.service.get(AUTH_ID, c.id)).toMatchObject({ status: "failed", attempts: [{ outcome: "failed", hangupCause: "UNALLOCATED_NUMBER" }] });
    await t.service.hangup("not-a-token", {});
  });

  it("a snooze opens a fresh retry window", async () => {
    const t = setup();
    const r = await t.service.schedule(ACCOUNT, input({ maxAttempts: 1 }));
    let { ans } = await t.fireLast();
    await t.service.inputXml(ans, "1");
    await t.service.hangup(ans, { HangupCause: "NORMAL_CLEARING", BillDuration: "5" });
    ({ ans } = await t.fireLast());
    await t.service.hangup(ans, { HangupCause: "NO_ANSWER", BillDuration: "0" });
    expect(await t.service.get(AUTH_ID, r.id)).toMatchObject({ status: "failed" });
    expect(t.scheduler.jobs).toHaveLength(2);
  });

  it("cancel is idempotent and leaves finished reminders alone", async () => {
    const t = setup();
    expect(await t.service.cancel(AUTH_ID, "r_missing")).toBeUndefined();
    const r = await t.service.schedule(ACCOUNT, input());
    await t.service.cancel(AUTH_ID, r.id);
    expect((await t.service.cancel(AUTH_ID, r.id))?.status).toBe("cancelled");
    expect(t.scheduler.cancelled).toEqual([`${r.id}-1`]);
    expect((await t.service.list(AUTH_ID, { status: ["cancelled"] })).map((x) => x.id)).toEqual([r.id]);
  });

  it("delivers due jobs itself on the memory backend", async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const fetch = mockFetch([ownNumberRoute, callOk]);
      const scheduler = new MemoryScheduler();
      const service = createReminderService({
        store: new MemoryStore(),
        scheduler,
        sealer,
        baseUrl: PUBLIC,
        cfg: testConfig(),
        log: silentLogger,
        fetchImpl: fetch.impl,
      });
      const r = await service.schedule(ACCOUNT, input({ at: new Date(T0.getTime() + 60_000).toISOString() }));
      await vi.advanceTimersByTimeAsync(61_000);
      expect((await service.get(AUTH_ID, r.id))?.status).toBe("calling");
      expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── router ──────────────────────────────────────────────────────

describe("reminders router", () => {
  let base = "";
  let close: () => void = () => {};
  let t: ReturnType<typeof setup>;
  let callStatus = 201;

  beforeEach(async () => {
    callStatus = 201;
    t = setup({ routes: [ownNumberRoute, { method: "POST", path: acct("/Call/"), respond: () => json(callStatus, callStatus < 300 ? { request_uuid: "req-1" } : { error: "x" }) }] });
    const app = express();
    app.use(createRemindersRouter(t.service, { baseUrl: PUBLIC, signatureMode: "verify_if_present", sealer }));
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => srv.close();
  });
  afterEach(() => close());

  const fire = (body: string) => fetch(`${base}/jobs/fire`, { method: "POST", headers: { "Content-Type": "text/plain" }, body });

  it("POST /jobs/fire answers 200 for fired, invalid and stale jobs and 503 only when transient", async () => {
    let r = await fire("vbzj_nonsense");
    expect([r.status, await r.json()]).toEqual([200, { fired: false, reason: "invalid_token" }]);
    await t.service.schedule(ACCOUNT, input());
    const payload = t.scheduler.last().payload;
    callStatus = 503;
    r = await fire(payload);
    expect([r.status, await r.json()]).toEqual([503, { fired: false, reason: "transient" }]);
    callStatus = 201;
    r = await fire(payload);
    expect([r.status, await r.json()]).toEqual([200, { fired: true }]);
    r = await fire(payload);
    expect([r.status, await r.json()]).toEqual([200, { fired: false, reason: "stale" }]);
  });

  it("serves the answer XML (GET or POST), and a polite script for unknown tokens", async () => {
    await t.service.schedule(ACCOUNT, input({ message: "Dentist at 4" }));
    const { ans } = await t.fireLast();
    for (const method of ["GET", "POST"]) {
      const r = await fetch(`${base}/r/${ans}/answer`, { method });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/xml");
      expect(await r.text()).toContain("Dentist at 4");
    }
    const bad = await fetch(`${base}/r/vbzn_${"A".repeat(40)}/answer`, { method: "POST" });
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("This reminder is no longer active.");
    expect((await fetch(`${base}/r/x/answer`, { method: "PUT" })).status).toBe(405);
  });

  it("verifies the Vobiz signature with the account token when present", async () => {
    await t.service.schedule(ACCOUNT, input());
    const { ans } = await t.fireLast();
    const url = `${PUBLIC}/r/${ans}/answer`;
    const forged = await fetch(`${base}/r/${ans}/answer`, {
      method: "POST",
      headers: { "X-Vobiz-Signature-V3": signV3("wrong-token", url, "n1"), "X-Vobiz-Signature-V3-Nonce": "n1" },
    });
    expect(forged.status).toBe(403);
    const good = await fetch(`${base}/r/${ans}/answer`, {
      method: "POST",
      headers: { "X-Vobiz-Signature-V3": signV3(TOKEN, url, "n2"), "X-Vobiz-Signature-V3-Nonce": "n2" },
    });
    expect(good.status).toBe(200);
    const replay = await fetch(`${base}/r/${ans}/answer`, {
      method: "POST",
      headers: { "X-Vobiz-Signature-V3": signV3(TOKEN, url, "n2"), "X-Vobiz-Signature-V3-Nonce": "n2" },
    });
    expect(replay.status).toBe(403);
  });

  it("handles form-encoded input and JSON hangups; bad input is never a 500", async () => {
    const r0 = await t.service.schedule(ACCOUNT, input());
    const { ans } = await t.fireLast();
    const input2 = await fetch(`${base}/r/${ans}/input`, { method: "POST", body: new URLSearchParams({ Digits: "2", CallUUID: "c1" }) });
    expect(input2.status).toBe(200);
    expect(await input2.text()).toContain("Your reminder is confirmed.");
    const h = await fetch(`${base}/r/${ans}/hangup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ HangupCause: "NORMAL_CLEARING", BillDuration: "9", CallUUID: "c1" }),
    });
    expect(h.status).toBe(204);
    expect((await t.service.get(AUTH_ID, r0.id))?.attempts[0]).toMatchObject({ outcome: "confirmed", billsec: 9, callUuid: "c1" });

    expect((await fetch(`${base}/r/vbzn_bad/hangup`, { method: "POST" })).status).toBe(400);
    const junk = await fetch(`${base}/r/${ans}/hangup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    expect(junk.status).toBe(400);
    const big = await fetch(`${base}/r/${ans}/input`, { method: "POST", body: new URLSearchParams({ Digits: "x".repeat(70_000) }) });
    expect(big.status).toBe(413);
    const lost = await fetch(`${base}/r/vbzn_bad/input`, { method: "POST", body: new URLSearchParams({ Digits: "1" }) });
    expect([lost.status, await lost.text()]).toEqual([200, inactiveScript()]);
  });
});

// ── backend selection ───────────────────────────────────────────

describe("createReminderBackend", () => {
  it("uses memory unless the Cloud Tasks queue is configured", () => {
    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(m), debug: () => {} };
    const mem = createReminderBackend({ VOBIZ_MAX_ACTIVE_REMINDERS: "5" }, log);
    expect(mem.mode).toBe("memory");
    expect(mem.store).toBeInstanceOf(MemoryStore);
    expect(mem.scheduler).toBeInstanceOf(MemoryScheduler);
    expect(mem.limits).toEqual({ maxActive: 5, maxCallsPerDay: 10, maxDaysAhead: 30 });
    expect(logs.join()).toContain("lost on restart");

    const env = { VOBIZ_GCP_PROJECT: "p1", VOBIZ_TASKS_LOCATION: "asia-south1", VOBIZ_TASKS_QUEUE: "reminders", VOBIZ_PUBLIC_URL: PUBLIC };
    const gcp = createReminderBackend(env, log);
    expect(gcp.mode).toBe("gcp");
    expect(gcp.store).toBeInstanceOf(FirestoreStore);
    expect((gcp.scheduler as CloudTasksScheduler).parent).toBe("projects/p1/locations/asia-south1/queues/reminders");
    expect(() => createReminderBackend({ ...env, VOBIZ_PUBLIC_URL: "" }, log)).toThrow("VOBIZ_PUBLIC_URL");
    expect(() => createReminderBackend({ VOBIZ_MAX_REMINDER_CALLS_PER_DAY: "0" }, log)).toThrow();
  });
});
