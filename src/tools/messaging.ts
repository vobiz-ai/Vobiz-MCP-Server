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
import { acquireMessageRate, sharedOf } from "../guard/capacity.js";
import { CONFIRM_NOTE, requireApproval, supportsFormElicitation, type ToolExtra } from "../guard/confirm.js";
import { UNTRUSTED_DESCRIPTION, markUntrusted, withUntrustedNotice } from "../guard/untrusted.js";
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
const offset = (what: string) =>
  z.number().int().min(0).max(1_000_000).optional().describe(`Number of ${what} to skip before the page starts (default 0). Add the page size to it for the next page.`);

const ZERO_TIME = /^0001-01-01/;

// ── Output schema building blocks ───────────────────────────────
const untrustedOut = {
  notice: z.string().optional().describe("Reminder that message bodies and names were written by third parties."),
  untrusted_fields: z.array(z.string()).optional().describe("Names of the fields that hold third-party text."),
};
const messageItem = z
  .unknown()
  .describe("One message: id, direction (in/out), channel, from, to, text, mediaUrls, status, errorCode, errorMessage, tag, conversationId, scheduledAt, createdAt, updatedAt, with untrusted: true.");
const offsetPage = z
  .object({
    limit: z.number().optional().describe("Page size that was applied."),
    offset: z.number().optional().describe("Offset that was applied."),
    total: z.number().nullable().optional().describe("Total matching messages, or null when Vobiz did not report it."),
    has_more: z.boolean().optional().describe("True when another page exists."),
    next_offset: z.number().nullable().optional().describe("Offset to pass for the next page, or null on the last page."),
  })
  .passthrough();
const optOutResult = (optedOut: boolean) =>
  z
    .object({
      ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
      phone_number: z.string().optional().describe("The number, normalised to E.164."),
      channel: z.string().optional().describe("Channel the change applies to: sms, mms or rcs."),
      opted_out: z.literal(optedOut).optional().describe(optedOut ? "Always true: the number is now blocked." : "Always false: the number can be messaged again."),
    })
    .passthrough();

/** Message fields a third party can write (inbound bodies, MMS subjects, RCS sender names, carrier error text). */
export const MESSAGE_UNTRUSTED_FIELDS = ["text", "title", "from", "errorMessage", "lastMessage"];
const untrustedMessage = (m: unknown) => markUntrusted(cleanMessage(m));

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
        confirm: z.boolean().describe("Must be true, set only after the user explicitly approved this send." + CONFIRM_NOTE),
      },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True only when every recipient was handed to the network; false when any recipient was not sent, or when the result is an error."),
          sent_count: z.number().optional().describe("Recipients whose message was accepted (status scheduled or sent)."),
          not_sent_count: z.number().optional().describe("Recipients refused or failed; see their errorCode (e.g. opted_out)."),
          messages: z
            .array(z.unknown())
            .optional()
            .describe("One entry per recipient, in the order given: id, to, status (scheduled, sent, not_sent, unknown), errorCode and errorMessage when not sent."),
          note: z.string().optional().describe("What the statuses mean and what to do next."),
          http_statuses: z.array(z.number()).optional().describe("HTTP status Vobiz returned for each accepted recipient."),
        })
        .passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async (a, extra: ToolExtra) => {
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
      const fallback = `Ask the user to confirm sending this ${ch.toUpperCase()} from ${a.from} to ${to.join(", ")}, then call send_message again with confirm: true.`;
      if (a.confirm !== true && !supportsFormElicitation(server.server.getClientCapabilities())) throw new VobizError("confirmation_required", fallback);
      for (const r of to) assertRecipientAllowed(ctx, r);
      const preview = a.text ? ` "${a.text.length > 120 ? a.text.slice(0, 117) + "..." : a.text}"` : "";
      await requireApproval(server, extra, {
        confirmed: a.confirm,
        message: `Send a real, billed ${ch.toUpperCase()} from ${a.from} to ${to.length} recipient${to.length > 1 ? "s" : ""} (${to.join(", ")})${preview}${a.media_urls?.length ? ` with ${a.media_urls.length} media file(s)` : ""}${a.scheduled_at ? `, scheduled for ${a.scheduled_at}` : ""}. Each recipient is billed per segment. Approve?`,
        fallback,
      });
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
          await acquireMessageRate(ctx, to.length);
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
        }, { shared: sharedOf(ctx) }),
      );
    }),
  );

  // ── preview_message_cost ─────────────────────────────────────
  server.registerTool(
    "preview_message_cost",
    {
      title: "Preview message cost",
      description:
        "Price one message before sending (GET /api/v1/sms/messages/cost-preview): segment count, unit cost, total cost, currency and destination country for a sender, recipient and text. " +
        "Sends nothing and is not billed. Use it before send_message to show the user the price; the real charge is per recipient and per segment, so multiply by the number of recipients. RCS cannot be previewed.",
      inputSchema: {
        from: phoneNumber.describe("Your Vobiz messaging number, E.164 (see list_messaging_numbers)."),
        to: phoneNumber.describe("Recipient, E.164; its country decides the unit price."),
        text: z.string().max(1600).optional().describe("Message body; its length and characters decide the segment count."),
        channel: z.enum(["sms", "mms"]).optional().describe("Channel to price: sms (default) or mms."),
      },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          preview: z
            .object({
              channel: z.string().optional().describe("Channel that was priced."),
              segmentCount: z.number().optional().describe("Billable segments the text splits into."),
              unitCost: z.number().optional().describe("Price of one segment."),
              totalCost: z.number().optional().describe("unitCost multiplied by segmentCount, for this one recipient."),
              currency: z.string().optional().describe("ISO currency of the prices."),
              country: z.string().optional().describe("Destination country derived from the recipient number."),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
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
        "List the SMS, MMS and RCS messages on this account, sent and received, newest first (GET /api/v1/sms/messages). " +
        "Every filter is an exact match and omitted filters are not applied: combine status, channel, direction, to, from, tag and a start/end time to find messages you did not keep the id of, for example the other recipients of a multi-recipient send (filter by tag). " +
        "Page with limit (default 20, max 100) and offset; pagination.total and next_offset say when to stop. " +
        "For one message with its status history use get_message; for threads grouped by contact use list_conversations." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: {
        status: z
          .enum(["scheduled", "sent", "delivered", "failed", "received", "unknown"])
          .optional()
          .describe("Only messages in this state: scheduled (held until scheduledAt), sent (handed to the network), delivered (receipt confirmed), failed (see errorCode/errorMessage), received (inbound) or unknown (no receipt yet)."),
        channel: channel.optional().describe("Only messages on the channel actually used: sms, mms or rcs. An SMS that was upgraded to MMS appears under mms."),
        direction: z.enum(["in", "out"]).optional().describe("in = received on one of your numbers, out = sent by you. Omit for both."),
        to: phoneNumber.optional().describe("Recipient number, E.164, exact match. For inbound messages this is your own number."),
        from: z.string().trim().max(64).optional().describe("Sender, exact match: one of your numbers in E.164, or your RCS sender name for RCS. For inbound messages this is the contact's number."),
        tag: z.string().max(100).optional().describe("Only messages whose tag equals this value exactly (the tag given to send_message)."),
        start_date: isoTimestamp.optional().describe("Only messages created at or after this ISO 8601 time, e.g. 2026-10-01T00:00:00Z."),
        end_date: isoTimestamp.optional().describe("Only messages created up to this ISO 8601 time; combine with start_date for a range."),
        limit: limit(100).describe("Page size, 1-100 (default 20)."),
        offset: offset("messages"),
      },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          count: z.number().optional().describe("Messages on this page."),
          messages: z.array(messageItem).optional().describe("Messages on this page, newest first."),
          pagination: offsetPage.optional(),
          ...untrustedOut,
        })
        .passthrough(),
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
      const messages = (Array.isArray(res.data?.messages) ? res.data.messages : []).map(untrustedMessage);
      const total = typeof res.data?.total === "number" ? res.data.total : null;
      const hasMore = total !== null ? off + messages.length < total : messages.length === lim;
      return ok(
        withUntrustedNotice(
          { ok: true, count: messages.length, messages, pagination: { limit: lim, offset: off, total, has_more: hasMore, next_offset: hasMore ? off + lim : null } },
          MESSAGE_UNTRUSTED_FIELDS,
        ),
      );
    }),
  );

  server.registerTool(
    "get_message",
    {
      title: "Get a message",
      description:
        "Return one message by message_id (GET /api/v1/sms/messages/{id}) with its current status, errorCode/errorMessage and statusHistory, the list of every status change oldest first. " +
        "Use it to follow a send from sent to delivered or failed; it is the only tool that returns the history. An id that is not on this account returns the not_found error. " +
        "To find messages without an id use list_messages." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: { message_id: messageId.describe("Message id as returned by send_message (messages[].id), list_messages or get_conversation_messages.") },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          message: z
            .unknown()
            .optional()
            .describe("The message: id, direction, channel, from, to, text, mediaUrls, status, errorCode, errorMessage, tag, conversationId, createdAt, plus statusHistory (status, errorCode, createdAt per change), with untrusted: true."),
          ...untrustedOut,
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ message_id }) => {
      const res = await sms(ctx, "GET", `/messages/${encodeURIComponent(message_id)}`, "GET sms/messages/{id}");
      return ok(withUntrustedNotice({ ok: true, message: untrustedMessage(res.data ?? {}) }, MESSAGE_UNTRUSTED_FIELDS));
    }),
  );

  // ── conversations ────────────────────────────────────────────
  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description:
        "List message threads on this account, most recently active first (GET /api/v1/sms/conversations). A conversation is the thread between one of your numbers and one contact on one channel; Vobiz creates it with the first message in either direction and tracks messageCount, unreadCount and lastMessageAt. " +
        "Page with limit (default 20, max 100) and offset; the end is reached when a page returns fewer than limit (there is no total). " +
        "To read a thread use get_conversation_messages with its id; to search individual messages across threads use list_messages." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: { limit: limit(100).describe("Page size, 1-100 (default 20)."), offset: offset("conversations") },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          count: z.number().optional().describe("Conversations on this page."),
          conversations: z
            .array(z.unknown())
            .optional()
            .describe("Threads on this page, most recently active first: id, participantA, participantB, channel, lastMessageAt, messageCount, unreadCount, lastReadAt, createdAt, with untrusted: true."),
          ...untrustedOut,
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const res = await sms<unknown>(ctx, "GET", "/conversations", "GET sms/conversations", { query: { limit: a.limit ?? cfg.defaultPageSize, offset: a.offset ?? 0 } });
      const list = (Array.isArray(res.data) ? res.data : []).map(untrustedMessage);
      return ok(withUntrustedNotice({ ok: true, count: list.length, conversations: list }, MESSAGE_UNTRUSTED_FIELDS));
    }),
  );

  server.registerTool(
    "get_conversation_messages",
    {
      title: "Get conversation messages",
      description:
        "Return the messages of one conversation in both directions, newest first (GET /api/v1/sms/conversations/{id}/messages); reverse the page to show it as a chat. " +
        "Entries carry status, errorCode and text but no statusHistory: use get_message for one message's history. Page with limit (default 50, max 100) and offset; an unknown conversation_id returns the not_found error. " +
        "Find ids with list_conversations or from the conversationId on any message." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: {
        conversation_id: messageId.describe("Conversation id from list_conversations, or the conversationId field on any message."),
        limit: limit(100).describe("Page size, 1-100 (default 50)."),
        offset: offset("messages"),
      },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          conversation_id: z.string().optional().describe("Echo of the conversation that was read."),
          count: z.number().optional().describe("Messages on this page."),
          messages: z.array(messageItem).optional().describe("Messages on this page, newest first, without statusHistory."),
          ...untrustedOut,
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (a) => {
      const res = await sms<unknown>(ctx, "GET", `/conversations/${encodeURIComponent(a.conversation_id)}/messages`, "GET sms/conversations/{id}/messages", {
        query: { limit: a.limit ?? 50, offset: a.offset ?? 0 },
      });
      const list = (Array.isArray(res.data) ? res.data : []).map(untrustedMessage);
      return ok(withUntrustedNotice({ ok: true, conversation_id: a.conversation_id, count: list.length, messages: list }, MESSAGE_UNTRUSTED_FIELDS));
    }),
  );

  // ── numbers and broadcasts (read-only) ───────────────────────
  server.registerTool(
    "list_messaging_numbers",
    {
      title: "List messaging numbers",
      description:
        "List the numbers on this account that are routed for SMS/MMS, sorted by country code then number (GET /api/v1/sms/numbers): e164, channels, capabilities, US 10DLC or toll-free registration state, a `sendable` summary (international, usDomestic) and the last message each sent. " +
        "Not paginated: every messaging number is returned. Pick one as send_message `from` and check sendable.usDomestic before messaging US recipients. " +
        "For every phone number on the account, including voice-only ones, use list_phone_numbers." +
        UNTRUSTED_DESCRIPTION,
      inputSchema: {},
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          count: z.number().optional().describe("Number of messaging numbers on the account."),
          numbers: z
            .array(z.unknown())
            .optional()
            .describe("Each number: e164, countryCode, channels, type, capabilities, tollFree, registration (kind, status, campaign), sendable (international, usDomestic), lastMessage (status, to, createdAt, marked untrusted)."),
          ...untrustedOut,
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      const res = await sms<Rec>(ctx, "GET", "/numbers", "GET sms/numbers");
      const numbers = (Array.isArray(res.data?.numbers) ? res.data.numbers : []).map((n) => {
        const c = cleanMessage(n) as Rec;
        if (c.lastMessage) c.lastMessage = untrustedMessage(c.lastMessage);
        return c;
      });
      return ok(withUntrustedNotice({ ok: true, count: numbers.length, numbers }, ["lastMessage"]));
    }),
  );

  server.registerTool(
    "list_broadcasts",
    {
      title: "List broadcasts",
      description:
        "List the bulk-message broadcasts on this account, newest first (GET /api/v1/sms/broadcasts), each with its status (draft, scheduled, running, paused, completed, cancelled or failed) and freshly counted stats (total, pending, sent, delivered, failed, optedOut, skipped). " +
        "Page with limit (default 50, max 500) and offset; `total` is the account-wide count, so page until offset reaches it. " +
        "For one broadcast's template, schedule and send rate use get_broadcast. This server only reads broadcasts; they are created and launched in the Vobiz console.",
      inputSchema: { limit: limit(500).describe("Page size, 1-500 (default 50)."), offset: offset("broadcasts") },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          count: z.number().optional().describe("Broadcasts on this page."),
          total: z.unknown().optional().describe("Account-wide number of broadcasts, or null when Vobiz did not report it."),
          broadcasts: z
            .array(z.unknown())
            .optional()
            .describe("Broadcasts on this page, newest first: id, name, from, channel, template, status, pauseReason, scheduledAt, ratePerSecond, tag, stats, createdAt, startedAt, completedAt."),
        })
        .passthrough(),
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
      description:
        "Return one broadcast by broadcast_id (GET /api/v1/sms/broadcasts/{id}): name, sender, template with {{variable}} placeholders, status and pauseReason, scheduledAt, ratePerSecond, tag, DLT ids and freshly counted stats (total, pending, sent, delivered, failed, optedOut, skipped). " +
        "Poll it while a broadcast is running to follow progress. An id that is not on this account returns the not_found error; find ids with list_broadcasts.",
      inputSchema: { broadcast_id: messageId.describe("Broadcast id, as listed by list_broadcasts or shown in the Vobiz console.") },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          broadcast: z
            .unknown()
            .optional()
            .describe("The broadcast: id, name, from, channel, template, status, pauseReason, scheduledAt, ratePerSecond, tag, dltEntityId, dltHeaderId, dltTemplateId, columns, stats, createdAt, startedAt, completedAt."),
        })
        .passthrough(),
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
      description:
        "Check whether ONE phone number is on this account's opt-out list for a channel (GET /api/v1/sms/opt-outs/{phone}) and return opted_out true or false. " +
        "Call it before send_message to skip a blocked contact instead of handling the opted_out refusal. A number Vobiz has never seen is simply not opted out, so the answer is always definite. " +
        "To list every blocked number use list_opt_outs; to change the list use add_opt_out or remove_opt_out.",
      inputSchema: { phone_number: phoneNumber.describe("The number to check, E.164 (leading + optional)."), channel: optChannel },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          phone_number: z.string().optional().describe("The number, normalised to E.164."),
          channel: z.string().optional().describe("Channel that was checked: sms, mms or rcs."),
          opted_out: z.boolean().optional().describe("True when send_message would refuse this number on this channel."),
        })
        .passthrough(),
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
      description:
        "List the numbers that opted out of messages from this account, newest first (GET /api/v1/sms/opt-outs): phoneNumber, channel, reason, source (inbound = a STOP keyword reply, manual = added through the API or console) and syncedToProvider. " +
        "Page with limit (default 20, max 100) and offset; the end is reached when a page returns fewer than limit (there is no total). " +
        "To test one number use check_opt_out; to block or unblock use add_opt_out or remove_opt_out.",
      inputSchema: { limit: limit(100).describe("Page size, 1-100 (default 20)."), offset: offset("entries") },
      outputSchema: z
        .object({
          ok: z.boolean().optional().describe("True on success; false when the result is an error (then error, message and retryable are set)."),
          count: z.number().optional().describe("Entries on this page."),
          opt_outs: z
            .array(z.unknown())
            .optional()
            .describe("Entries on this page, newest first: id, phoneNumber, channel, reason, source (inbound or manual), syncedToProvider, createdAt."),
        })
        .passthrough(),
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
        "Block a phone number from receiving messages from this account on a channel (POST /api/v1/sms/opt-outs), for example after a customer asks to stop; send_message then refuses it with opted_out. " +
        "Requires VOBIZ_ENABLE_MESSAGING=true on the server and confirm: true after the user approved blocking this number. Adding a number that is already blocked succeeds without change. " +
        "The reverse is remove_opt_out; to look before changing, use check_opt_out.",
      inputSchema: {
        phone_number: phoneNumber.describe("The number to block, E.164 (leading + optional)."),
        channel: optChannel,
        reason: z.string().max(200).optional().describe("Note stored on the record, e.g. 'customer request' (default 'manual')."),
        confirm: z.boolean().describe("Must be true after the user approved blocking this number."),
      },
      outputSchema: optOutResult(true),
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
        "Allow messages to a number again by deleting it from this account's opt-out list on a channel (DELETE /api/v1/sms/opt-outs/{phone}); the reverse of add_opt_out. " +
        "Only do this when the person has explicitly opted back in (for example by texting START): messaging someone who opted out breaks consent rules. " +
        "Requires VOBIZ_ENABLE_MESSAGING=true on the server and confirm: true. Check the current state first with check_opt_out.",
      inputSchema: {
        phone_number: phoneNumber.describe("The number to unblock, E.164 (leading + optional)."),
        channel: optChannel,
        confirm: z.boolean().describe("Must be true after the user confirmed this person opted back in."),
      },
      outputSchema: optOutResult(false),
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
