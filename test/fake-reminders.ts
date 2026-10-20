import type { Reminder, ReminderAccount, ReminderInput, ReminderService, ReminderStatus } from "../src/reminders/types.js";

/** In-memory ReminderService for tool and hosted tests: records what the tools pass, never places calls. */
export class FakeReminders implements ReminderService {
  readonly limits = { maxActive: 20, maxCallsPerDay: 10, maxDaysAhead: 30 };
  readonly items = new Map<string, Reminder>();
  readonly scheduled: { account: ReminderAccount; input: ReminderInput; opts?: { idempotencyKey?: string; clientId?: string } }[] = [];
  private seq = 0;

  async schedule(account: ReminderAccount, input: ReminderInput, opts?: { idempotencyKey?: string; clientId?: string }): Promise<Reminder> {
    this.scheduled.push({ account, input, opts });
    if (opts?.idempotencyKey) {
      const hit = [...this.items.values()].find((r) => r.authId === account.authId && r.idempotencyKey === opts.idempotencyKey);
      if (hit) return hit;
    }
    const now = new Date().toISOString();
    const r: Reminder = {
      ...input,
      id: `r_fake${++this.seq}`,
      authId: account.authId,
      status: "scheduled",
      createdAt: now,
      updatedAt: now,
      nextAt: input.at,
      attempts: [{ n: 1, scheduledFor: input.at }],
      ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    };
    this.items.set(`${account.authId}/${r.id}`, r);
    return r;
  }
  async list(authId: string, opts?: { status?: ReminderStatus[]; limit?: number }): Promise<Reminder[]> {
    return [...this.items.values()]
      .filter((r) => r.authId === authId && (!opts?.status || opts.status.includes(r.status)))
      .reverse()
      .slice(0, opts?.limit ?? 100);
  }
  async get(authId: string, id: string): Promise<Reminder | undefined> {
    return this.items.get(`${authId}/${id}`);
  }
  async cancel(authId: string, id: string): Promise<Reminder | undefined> {
    const r = this.items.get(`${authId}/${id}`);
    if (!r) return undefined;
    if (["scheduled", "snoozed", "calling"].includes(r.status)) Object.assign(r, { status: "cancelled", nextAt: null });
    return r;
  }
  async fire(): Promise<{ fired: boolean; reason?: string }> {
    return { fired: false, reason: "fake" };
  }
  async answerXml(): Promise<string | undefined> {
    return undefined;
  }
  async inputXml(): Promise<string | undefined> {
    return undefined;
  }
  async hangup(): Promise<void> {}
  async sweepStale(): Promise<number> {
    return 0;
  }
}
