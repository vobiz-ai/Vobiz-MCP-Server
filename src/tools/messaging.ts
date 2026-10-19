/**
 * SMS, MMS and RCS over the Vobiz Messaging API (https://api.vobiz.ai/api/v1/sms, camelCase JSON).
 * Reading is always available; sending and opt-out changes need VOBIZ_ENABLE_MESSAGING=true and confirm: true.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { digitsOnly } from "../config.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { IdempotencyStore, withIdempotency } from "../idempotency.js";
import { handler, idempotencyKey, ok, phoneNumber, toE164 } from "../util.js";

type Rec = Record<string, unknown>;
const SMS = "/api/v1/sms";

const channel = z.enum(["sms", "mms", "rcs"]);
const messageId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{6,64}$/, "must be a Vobiz message ID (letters, digits, - and _ only)");
const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, "must be an ISO 8601 date or timestamp, e.g. 2026-11-01T09:00:00Z");
const limit = (max: number) => z.number().int().min(1).max(max).optional();
const offset = z.number().int().min(0).max(1_000_000).optional();

const ZERO_TIME = /^0001-01-01/;

/** Keeps message objects tidy for the model: unset timestamps become null and internal routing fields are dropped. */
export function cleanMessage(m: unknown): unknown {
  if (!m || typeof m !== "object" || Array.isArray(m)) return m;
  const out: Rec = {};
  for (const [k, v] of Object.entries(m as Rec)) {
    if (k === "provider" || k === "providerMessageId" || k === "accountId") continue;
    if (typeof v === "string" && ZERO_TIME.test(v)) out[k] = null;
    else if (k === "errorMessage" && typeof v === "string") out[k] = v.replace(/^[a-z][a-z0-9_-]*:\s*/, "");
    else out[k] = v;
  }
  return out;
}

async function sms<T = Rec>(ctx: ToolContext, method: "GET" | "POST" | "DELETE", path: string, route: string, opts: { query?: Rec; body?: Rec; sideEffect?: boolean } = {}) {
  ctx.client.authId; // missing_credentials before any I/O
  try {
    return await ctx.client.request<T>(method, SMS + path, {
      query: opts.query as Record<string, string | number | boolean | undefined>,
      body: opts.body,
      sideEffect: opts.sideEffect,
      route,
    });
  } catch (err) {
    // A lookup of an ID that is not on this account can come back as a 500; report it as not found.
    if (err instanceof VobizError && err.kind === "backend_error" && /\{id\}|\{phone\}/.test(route)) {
      throw new VobizError("not_found", "Nothing with this ID was found on this Vobiz account.", err.status);
    }
    if (err instanceof VobizError && (err.kind === "backend_error" || err.kind === "service_unavailable")) {
      throw new VobizError(err.kind, "The Vobiz Messaging API could not complete the request. Try again shortly.", err.status, err.apiId);
    }
    throw err;
  }
}

function assertMessagingEnabled(ctx: ToolContext): void {
  if (!ctx.cfg.enableMessaging) {
    throw new VobizError(
      "messaging_disabled",
      "Sending messages and changing opt-outs is disabled on this MCP server. An administrator must set VOBIZ_ENABLE_MESSAGING=true.",
    );
  }
}

function assertRecipientAllowed(ctx: ToolContext, to: string): void {
  const cc = ctx.cfg.messaging.allowedCountryCodes;
  if (cc.length && !cc.some((c) => digitsOnly(to).startsWith(c))) {
    throw new VobizError(
      "not_allowed",
      `Messages to ${toE164(to)} are not allowed by this server (allowed country codes: ${cc.map((c) => "+" + c).join(", ")}). An administrator can change VOBIZ_MESSAGING_ALLOWED_COUNTRY_CODES.`,
    );
  }
}

async function assertSenderOwned(ctx: ToolContext, from: string): Promise<void> {
  const res = await sms<{ numbers?: Rec[] }>(ctx, "GET", "/numbers", "GET sms/numbers");
  const list = Array.isArray(res.data?.numbers) ? res.data.numbers : [];
  if (!list.some((n) => typeof n.e164 === "string" && digitsOnly(n.e164) === digitsOnly(from))) {
    throw new VobizError(
      "not_allowed",
      `${toE164(from)} is not a messaging number on this Vobiz account. Use list_messaging_numbers to see the numbers you can send from.`,
    );
  }
}

export function registerMessagingTools(server: McpServer, ctx: ToolContext): void {
  const { cfg } = ctx;

  // ── send_message ─────────────────────────────────────────────
  server.registerTool(
    "send_message",
    {
      title: "Send an SMS, MMS or RCS message",
      description:
        "Send a real SMS, MMS or RCS message through Vobiz (POST /api/v1/sms/messages). Each recipient becomes its own message and is billed. " +
        "Required: `from`, `to`, `idempotency_key`, and `confirm: true` after the user approved the exact sender, recipients and text. " +
        "For sms/mms, `from` is one of your Vobiz messaging numbers (see list_messaging_numbers); for rcs it is your RCS sender name. " +
        "Use preview_message_cost first to show the price and segment count. Opted-out recipients are refused by Vobiz (opted_out). " +
        "status `scheduled` = held until scheduled_at; `sent` = handed to the network; delivery receipts update it to `delivered` or `failed` (check get_message). " +
        "Repeating an idempotency_key never sends twice.",
      inputSchema: {
        from: z.string().trim().min(2).max(64).describe("Sender: an E.164 Vobiz messaging number (sms/mms), or your RCS sender name (rcs)."),
        to: z.array(phoneNumber).min(1).max(100).describe("Recipient numbers in E.164, e.g. ['+14155550123']. Capped by VOBIZ_MAX_RECIPIENTS_PER_SEND."),
        text: z.string().max(1600).optional().describe("Message body. Required for sms and rcs. Long SMS are split into billed segments."),
        channel: channel.optional().describe("sms (default), mms or rcs."),
        media_urls: z.array(z.string().url().startsWith("https://")).max(10).optional().describe("Public https media URLs (MMS up to 10; RCS sends the first)."),
        title: z.string().max(80).optional().describe("MMS subject line."),
        scheduled_at: isoTimestamp.optional().describe("Send later at this RFC 3339 time, e.g. 2026-11-01T09:00:00Z."),
        failover_to_sms: z.boolean().optional().describe("RCS only: send the text as SMS if RCS cannot be delivered."),
        tag: z.string().max(100).optional().describe("Your label, stored on every message; filter list_messages by it."),
        dlt_entity_id: z.string().max(64).optional().describe("India TRAI DLT Principal Entity ID."),
        dlt_header_id: z.string().max(64).optional().describe("India TRAI DLT sender header ID."),
        dlt_template_id: z.string().max(64).optional().describe("India TRAI DLT content template ID; text must match it."),
        idempotency_key: idempotencyKey,
        confirm: z.boolean().describe("Must be true, set only after the user explicitly approved this send."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      assertMessagingEnabled(ctx);
      const ch = a.channel ?? (a.media_urls?.length ? "mms" : "sms");
      const to = [...new Set(a.to.map(toE164))];
      if (to.length > cfg.messaging.maxRecipientsPerSend) {
        throw new VobizError(
          "not_allowed",
          `This server sends to at most ${cfg.messaging.maxRecipientsPerSend} recipients per request (VOBIZ_MAX_RECIPIENTS_PER_SEND). Use a Vobiz broadcast for larger audiences.`,
        );
      }
      if ((ch === "sms" || ch === "rcs") && !a.text) throw new VobizError("invalid_input", `text is required for ${ch} messages.`);
      if (ch === "mms" && !a.text && !a.media_urls?.length) throw new VobizError("invalid_input", "An MMS needs text or media_urls.");
      if (a.confirm !== true) {
        throw new VobizError(
          "confirmation_required",
          `Ask the user to confirm sending this ${ch.toUpperCase()} from ${a.from} to ${to.join(", ")}, then call send_message again with confirm: true.`,
        );
      }
      for (const r of to) assertRecipientAllowed(ctx, r);
      const body: Rec = { from: ch === "rcs" ? a.from : toE164(a.from), to, channel: ch, idempotencyKey: a.idempotency_key };
      if (a.text) body.text = a.text;
      if (a.media_urls?.length) body.mediaUrls = a.media_urls;
      if (a.title) body.title = a.title;
      if (a.scheduled_at) body.scheduledAt = a.scheduled_at;
      if (a.failover_to_sms !== undefined) body.failoverToSms = a.failover_to_sms;
      if (a.tag) body.tag = a.tag;
      if (a.dlt_entity_id) body.dltEntityId = a.dlt_entity_id;
      if (a.dlt_header_id) body.dltHeaderId = a.dlt_header_id;
      if (a.dlt_template_id) body.dltTemplateId = a.dlt_template_id;

      const fingerprint = IdempotencyStore.fingerprint({ op: "send_message", ...body, idempotencyKey: undefined });
      return ok(
        await withIdempotency(ctx.idempotency, `msg:${a.idempotency_key}`, fingerprint, async () => {
          if (ch !== "rcs" && cfg.messaging.verifySender) await assertSenderOwned(ctx, a.from);
          if (!ctx.messageLimiter.wouldAllow(to.length) || !ctx.hourlyMessageLimiter.wouldAllow(to.length)) {
            throw new VobizError(
              "rate_limited",
              `This MCP server sends at most ${cfg.messaging.maxMessagesPerMinute} messages per minute and ${cfg.messaging.maxMessagesPerHour} per hour.`,
            );
          }
          ctx.messageLimiter.tryAcquireMany(to.length);
          ctx.hourlyMessageLimiter.tryAcquireMany(to.length);
          // One request per recipient so every message ID and status comes back.
          const messages: Rec[] = [];
          const statuses: number[] = [];
          for (const [i, recipient] of to.entries()) {
            const one = { ...body, to: [recipient], idempotencyKey: to.length === 1 ? a.idempotency_key : `${a.idempotency_key}:${i + 1}` };
            try {
              const res = await sms<Rec>(ctx, "POST", "/messages", "POST sms/messages", { body: one, sideEffect: true });
              statuses.push(res.status);
              messages.push(cleanMessage(res.data ?? {}) as Rec);
            } catch (err) {
              if (err instanceof VobizError && err.status === 422) {
                messages.push({ to: recipient, status: "not_sent", errorCode: "opted_out", errorMessage: "The recipient has opted out of this channel." });
                continue;
              }
              if (!messages.length) throw err;
              // Earlier recipients were already sent: report them instead of hiding them behind an error.
              const unknown = err instanceof VobizError && err.kind === "outcome_unknown";
              messages.push({
                to: recipient,
                status: unknown ? "unknown" : "not_sent",
                errorCode: err instanceof VobizError ? err.kind : "internal_error",
                errorMessage: unknown ? "It is unknown whether this message was sent. Check list_messages before sending again." : err instanceof Error ? err.message : "",
              });
            }
          }
          const sent = messages.filter((m) => !["not_sent", "failed", "unknown"].includes(String(m.status)));
          return {
            ok: sent.length === messages.length,
            sent_count: sent.length,
            not_sent_count: messages.length - sent.length,
            messages,
            note:
              sent.length === messages.length
                ? "Sent means handed to the network, not delivered. Use get_message to follow delivery."
                : "Some recipients were not sent; see status, errorCode and errorMessage on each message. Do not resend to opted-out numbers.",
            http_statuses: statuses,
          };
        }),
      );
    }),
  );

  // ── preview_message_cost ─────────────────────────────────────
  server.registerTool(
    "preview_message_cost",
    {
      title: "Preview message cost",
      description:
        "Price one message before sending: segment count, unit cost, total cost and currency for a sender, recipient and text (GET /api/v1/sms/messages/cost-preview). Sends nothing. Read-only.",
      inputSchema: {
        from: phoneNumber.describe("Your Vobiz messaging number, E.164."),
        to: phoneNumber.describe("Recipient, E.164."),
        text: z.string().max(1600).optional().describe("Message body; its length decides the segment count."),
        channel: z.enum(["sms", "mms"]).optional().describe("sms (default) or mms."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const res = await sms(ctx, "GET", "/messages/cost-preview", "GET sms/messages/cost-preview", {
        query: { from: toE164(a.from), to: toE164(a.to), text: a.text, channel: a.channel },
      });
      return ok({ ok: true, preview: res.data ?? {} });
    }),
  );

  // ── list_messages / get_message ──────────────────────────────
  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      description:
        "List SMS, MMS and RCS messages on this account, newest first, with filters (status, channel, direction in/out, to, from, tag, date range) and limit/offset paging. Read-only.",
      inputSchema: {
        status: z.enum(["scheduled", "sent", "delivered", "failed", "received", "unknown"]).optional(),
        channel: channel.optional(),
        direction: z.enum(["in", "out"]).optional().describe("in = received, out = sent."),
        to: phoneNumber.optional(),
        from: z.string().trim().max(64).optional(),
        tag: z.string().max(100).optional(),
        start_date: isoTimestamp.optional().describe("Created at or after, ISO 8601."),
        end_date: isoTimestamp.optional().describe("Created at or before, ISO 8601."),
        limit: limit(100).describe("Page size, 1-100 (default 20)."),
        offset,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const lim = a.limit ?? cfg.defaultPageSize;
      const off = a.offset ?? 0;
      const res = await sms<Rec>(ctx, "GET", "/messages", "GET sms/messages", {
        query: {
          status: a.status,
          channel: a.channel,
          direction: a.direction,
          to: a.to ? toE164(a.to) : undefined,
          from: a.from,
          tag: a.tag,
          startDate: a.start_date,
          endDate: a.end_date,
          limit: lim,
          offset: off,
        },
      });
      const messages = (Array.isArray(res.data?.messages) ? res.data.messages : []).map(cleanMessage);
      const total = typeof res.data?.total === "number" ? res.data.total : null;
      const hasMore = total !== null ? off + messages.length < total : messages.length === lim;
      return ok({ ok: true, count: messages.length, messages, pagination: { limit: lim, offset: off, total, has_more: hasMore, next_offset: hasMore ? off + lim : null } });
    }),
  );

  server.registerTool(
    "get_message",
    {
      title: "Get a message",
      description: "Return one message by ID with its current status, error details and status history (sent → delivered / failed). Read-only.",
      inputSchema: { message_id: messageId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ message_id }) => {
      const res = await sms(ctx, "GET", `/messages/${encodeURIComponent(message_id)}`, "GET sms/messages/{id}");
      return ok({ ok: true, message: cleanMessage(res.data ?? {}) });
    }),
  );

  // ── conversations ────────────────────────────────────────────
  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description: "List message threads (one per pair of numbers and channel), most recently active first, with message and unread counts. Read-only.",
      inputSchema: { limit: limit(100).describe("Page size, 1-100 (default 20)."), offset },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const res = await sms<unknown>(ctx, "GET", "/conversations", "GET sms/conversations", { query: { limit: a.limit ?? cfg.defaultPageSize, offset: a.offset ?? 0 } });
      const list = (Array.isArray(res.data) ? res.data : []).map(cleanMessage);
      return ok({ ok: true, count: list.length, conversations: list });
    }),
  );

  server.registerTool(
    "get_conversation_messages",
    {
      title: "Get conversation messages",
      description: "Return the messages of one conversation (from list_conversations or a message's conversationId), oldest first. Read-only.",
      inputSchema: { conversation_id: messageId.describe("Conversation ID."), limit: limit(100).describe("Page size, 1-100 (default 50)."), offset },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const res = await sms<unknown>(ctx, "GET", `/conversations/${encodeURIComponent(a.conversation_id)}/messages`, "GET sms/conversations/{id}/messages", {
        query: { limit: a.limit ?? 50, offset: a.offset ?? 0 },
      });
      const list = (Array.isArray(res.data) ? res.data : []).map(cleanMessage);
      return ok({ ok: true, conversation_id: a.conversation_id, count: list.length, messages: list });
    }),
  );

  // ── numbers and broadcasts (read-only) ───────────────────────
  server.registerTool(
    "list_messaging_numbers",
    {
      title: "List messaging numbers",
      description: "List the numbers on this account that can send and receive SMS/MMS, with capabilities and their latest message. Use one as send_message `from`. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      const res = await sms<Rec>(ctx, "GET", "/numbers", "GET sms/numbers");
      const numbers = (Array.isArray(res.data?.numbers) ? res.data.numbers : []).map((n) => {
        const c = cleanMessage(n) as Rec;
        if (c.lastMessage) c.lastMessage = cleanMessage(c.lastMessage);
        return c;
      });
      return ok({ ok: true, count: numbers.length, numbers });
    }),
  );

  server.registerTool(
    "list_broadcasts",
    {
      title: "List broadcasts",
      description: "List bulk-message broadcasts on this account with status (draft, scheduled, running, paused, completed, cancelled) and delivery stats. Read-only.",
      inputSchema: { limit: limit(500).describe("Page size, 1-500 (default 50)."), offset },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const res = await sms<Rec>(ctx, "GET", "/broadcasts", "GET sms/broadcasts", { query: { limit: a.limit ?? 50, offset: a.offset ?? 0 } });
      const list = (Array.isArray(res.data?.broadcasts) ? res.data.broadcasts : []).map(cleanMessage);
      return ok({ ok: true, count: list.length, total: res.data?.total ?? null, broadcasts: list });
    }),
  );

  server.registerTool(
    "get_broadcast",
    {
      title: "Get a broadcast",
      description: "Return one broadcast with its template, schedule, send rate and stats (total, sent, delivered, failed). Read-only.",
      inputSchema: { broadcast_id: messageId.describe("Broadcast ID.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ broadcast_id }) => {
      const res = await sms(ctx, "GET", `/broadcasts/${encodeURIComponent(broadcast_id)}`, "GET sms/broadcasts/{id}");
      return ok({ ok: true, broadcast: cleanMessage(res.data ?? {}) });
    }),
  );

  // ── opt-outs ─────────────────────────────────────────────────
  const optChannel = channel.optional().describe("sms (default; also covers mms), mms or rcs.");

  server.registerTool(
    "check_opt_out",
    {
      title: "Check opt-out",
      description: "Check whether a phone number has opted out of messages on a channel. Vobiz refuses sends to opted-out numbers. Read-only.",
      inputSchema: { phone_number: phoneNumber, channel: optChannel },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const res = await sms<Rec>(ctx, "GET", `/opt-outs/${encodeURIComponent(toE164(a.phone_number))}`, "GET sms/opt-outs/{phone}", { query: { channel: a.channel ?? "sms" } });
      return ok({ ok: true, phone_number: toE164(a.phone_number), channel: a.channel ?? "sms", opted_out: res.data?.optedOut === true });
    }),
  );

  server.registerTool(
    "list_opt_outs",
    {
      title: "List opt-outs",
      description: "List numbers that opted out (by STOP keyword or added manually), with channel, reason and source. Read-only.",
      inputSchema: { limit: limit(100).describe("Page size, 1-100 (default 20)."), offset },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const res = await sms<unknown>(ctx, "GET", "/opt-outs", "GET sms/opt-outs", { query: { limit: a.limit ?? cfg.defaultPageSize, offset: a.offset ?? 0 } });
      const list = (Array.isArray(res.data) ? res.data : []).map(cleanMessage);
      return ok({ ok: true, count: list.length, opt_outs: list });
    }),
  );

  server.registerTool(
    "add_opt_out",
    {
      title: "Add an opt-out",
      description:
        "Block a phone number from receiving messages on a channel (for example after a customer asks to stop). Requires confirm: true and VOBIZ_ENABLE_MESSAGING=true. Safe to repeat.",
      inputSchema: {
        phone_number: phoneNumber,
        channel: optChannel,
        reason: z.string().max(200).optional().describe("Note stored on the record, e.g. 'customer request'."),
        confirm: z.boolean().describe("Must be true after the user approved blocking this number."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      assertMessagingEnabled(ctx);
      if (a.confirm !== true) throw new VobizError("confirmation_required", `Ask the user to confirm blocking ${toE164(a.phone_number)}, then call again with confirm: true.`);
      await sms(ctx, "POST", "/opt-outs", "POST sms/opt-outs", { body: { phoneNumber: toE164(a.phone_number), channel: a.channel ?? "sms", reason: a.reason ?? "manual" } });
      return ok({ ok: true, phone_number: toE164(a.phone_number), channel: a.channel ?? "sms", opted_out: true });
    }),
  );

  server.registerTool(
    "remove_opt_out",
    {
      title: "Remove an opt-out",
      description:
        "Allow messages to a number again. Only do this when the person has explicitly opted back in (for example by texting START); messaging someone who opted out breaks consent rules. " +
        "Requires confirm: true and VOBIZ_ENABLE_MESSAGING=true.",
      inputSchema: {
        phone_number: phoneNumber,
        channel: optChannel,
        confirm: z.boolean().describe("Must be true after the user confirmed this person opted back in."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      assertMessagingEnabled(ctx);
      if (a.confirm !== true) {
        throw new VobizError("confirmation_required", `Ask the user to confirm ${toE164(a.phone_number)} opted back in, then call again with confirm: true.`);
      }
      await sms(ctx, "DELETE", `/opt-outs/${encodeURIComponent(toE164(a.phone_number))}`, "DELETE sms/opt-outs/{phone}", { query: { channel: a.channel ?? "sms" } });
      return ok({ ok: true, phone_number: toE164(a.phone_number), channel: a.channel ?? "sms", opted_out: false });
    }),
  );
}
