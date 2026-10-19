/**
 * Voice applications: XML generation, hosted flows, DTMF gathering, received callbacks and
 * the places Vobiz webhooks are configured (Applications and SIP trunks).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { VobizError } from "../errors.js";
import { assertAllowedUrl, callId, handler, listField, ok } from "../util.js";
import { buildResponseXml, xmlAction, xmlActions, type XmlAction } from "../xml.js";
import { callAction } from "./control.js";

type Rec = Record<string, unknown>;

function needHosting(ctx: ToolContext): asserts ctx is ToolContext & Required<Pick<ToolContext, "flows" | "events">> {
  if (!ctx.flows || !ctx.events) {
    throw new VobizError(
      "unsupported",
      "Hosted flows and callbacks need the HTTP server (npm run start:http) with VOBIZ_PUBLIC_URL set to its public https address. In stdio mode use generate_answer_xml without host and serve the XML yourself.",
    );
  }
}

export function registerVoiceTools(server: McpServer, ctx: ToolContext): void {
  const checkUrl = (u: string, f: string) => assertAllowedUrl(ctx.cfg, u, f);

  // ── generate_answer_xml ──────────────────────────────────────
  server.registerTool(
    "generate_answer_xml",
    {
      title: "Generate Vobiz call XML",
      description:
        "Build a validated Vobiz XML document from a list of actions: speak, play, wait, gather (DTMF/speech), record, dial (number or sip_uri), redirect, hangup. " +
        "Text is XML-escaped; callback/redirect URLs must be on approved hosts; actions after redirect/hangup are rejected. " +
        "With host: true (HTTP mode) the server also serves it and returns a URL usable as make_call answer_url or transfer_call aleg_url. Pure generation otherwise (no API call).",
      inputSchema: {
        actions: xmlActions.describe("Ordered actions, e.g. [{type:'speak',text:'Hello'},{type:'hangup'}]"),
        host: z.boolean().optional().describe("Serve the XML from this server and return its URL (HTTP mode only)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async ({ actions, host }) => {
      if (!host) {
        const xml = buildResponseXml(actions as XmlAction[], { checkUrl });
        return ok({ ok: true, xml, hosted: false });
      }
      needHosting(ctx);
      const id = ctx.flows.newId();
      const xml = buildResponseXml(actions as XmlAction[], { checkUrl, defaultGatherAction: ctx.flows.gatherUrl(id) });
      ctx.flows.create({ kind: "xml", xml }, id);
      return ok({ ok: true, xml, hosted: true, flow_id: id, url: ctx.flows.flowUrl(id), method: "POST" });
    }),
  );

  // ── gather_dtmf ──────────────────────────────────────────────
  server.registerTool(
    "gather_dtmf",
    {
      title: "Collect keypad input",
      description:
        "Create a hosted IVR step that plays a prompt and collects DTMF digits (Vobiz <Gather>). Digits are posted back to this server, verified and stored; read them with get_gather_result. " +
        "Give call_uuid (+ confirm: true) to move a LIVE call into it now (transfer), or use the returned url as make_call answer_url. HTTP mode with VOBIZ_PUBLIC_URL only.",
      inputSchema: {
        prompt_text: z.string().trim().min(1).max(1000).optional().describe("Spoken prompt, e.g. 'Press 1 for sales'."),
        prompt_audio_url: z.string().url().optional().describe("Or an https .mp3/.wav prompt."),
        language: z.string().optional(),
        num_digits: z.number().int().min(1).max(32).optional(),
        execution_timeout: z.number().int().min(5).max(60).optional().describe("Seconds to wait for input (default 15)."),
        digit_end_timeout: z.union([z.number().int().min(2).max(10), z.literal("auto")]).optional(),
        finish_on_key: z.enum(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "none"]).optional(),
        then: z.array(xmlAction).max(10).optional().describe("XML actions to run after input is received (default: 'Thank you' and hang up)."),
        call_uuid: callId.optional().describe("Live call to move into this step now."),
        confirm: z.boolean().optional().describe("Required (true) with call_uuid: this replaces the live call's current flow."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      needHosting(ctx);
      if (!a.prompt_text && !a.prompt_audio_url) throw new VobizError("invalid_input", "Give prompt_text or prompt_audio_url.");
      if (a.call_uuid && a.confirm !== true) {
        throw new VobizError("confirmation_required", "Moving a live call replaces its current flow. Ask the user, then call again with confirm: true.");
      }
      const prompt: XmlAction[] = [];
      if (a.prompt_text) prompt.push({ type: "speak", text: a.prompt_text, ...(a.language ? { language: a.language as never } : {}) });
      if (a.prompt_audio_url) prompt.push({ type: "play", url: a.prompt_audio_url });
      const id = ctx.flows.newId();
      const xml = buildResponseXml(
        [
          {
            type: "gather",
            input_type: "dtmf",
            num_digits: a.num_digits,
            execution_timeout: a.execution_timeout,
            digit_end_timeout: a.digit_end_timeout,
            finish_on_key: a.finish_on_key,
            prompt: prompt as never,
          },
        ],
        { checkUrl, defaultGatherAction: ctx.flows.gatherUrl(id) },
      );
      const afterXml = a.then?.length ? buildResponseXml(a.then as XmlAction[], { checkUrl }) : undefined;
      ctx.flows.create({ kind: "xml", xml, afterXml }, id);
      const url = ctx.flows.flowUrl(id);
      let transferred = false;
      if (a.call_uuid) {
        await callAction(ctx, "POST", a.call_uuid, "", "POST Call/{uuid}/ (gather)", { body: { legs: "aleg", aleg_url: url, aleg_method: "POST" } });
        transferred = true;
      }
      return ok({
        ok: true,
        flow_id: id,
        url,
        transferred,
        xml,
        note: "Poll get_gather_result with flow_id. Digits arrive after the caller presses keys (or an empty result on timeout).",
      });
    }),
  );

  server.registerTool(
    "get_gather_result",
    {
      title: "Get collected keypad input",
      description: "Return the DTMF input received for a gather_dtmf / hosted flow (digits, call_uuid, whether the callback signature was verified). Read-only.",
      inputSchema: { flow_id: z.string().regex(/^[0-9a-f]{32}$/, "must be a flow_id from gather_dtmf") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async ({ flow_id }) => {
      needHosting(ctx);
      const r = ctx.flows.results(flow_id);
      if (!r.exists) throw new VobizError("not_found", "No hosted flow with this ID (it may have expired after 24h or the server restarted).");
      return ok({ ok: true, flow_id, received: r.results.length > 0, results: r.results, status: r.results.length ? "input_received" : "waiting" });
    }),
  );

  // ── list_webhook_events ──────────────────────────────────────
  server.registerTool(
    "list_webhook_events",
    {
      title: "List received Vobiz callbacks",
      description:
        "List callbacks Vobiz delivered to this server's /webhooks/vobiz endpoint and hosted flows (call answered/hung up, Gather digits, recording events), newest first. " +
        "Duplicates are collapsed and unsigned/invalid requests are rejected per VOBIZ_WEBHOOK_SIGNATURE. HTTP mode only. Read-only.",
      inputSchema: {
        call_uuid: callId.optional(),
        event: z.string().regex(/^[A-Za-z]{2,40}$/).optional().describe("e.g. StartApp, Hangup, Redirect"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async (f) => {
      needHosting(ctx);
      const events = ctx.events.list(f);
      return ok({ ok: true, count: events.length, events, endpoint: `${ctx.cfg.publicUrl}/webhooks/vobiz` });
    }),
  );

  // ── list_webhooks ────────────────────────────────────────────
  server.registerTool(
    "list_webhooks",
    {
      title: "List configured webhooks",
      description:
        "Vobiz webhooks are configured on Applications (answer/hangup/fallback/message URLs, used for inbound calls on linked numbers) " +
        "and on SIP trunks (webhook_url: CallInitiated and Hangup events, optional recording.completed). This lists all of them. Per-call URLs are set in make_call. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      const [apps, trunks] = await Promise.all([
        ctx.client.request<Rec>("GET", ctx.client.accountPath("/Application/"), { query: { limit: 20 }, route: "GET Application/" }),
        ctx.client.request<Rec>("GET", ctx.client.accountPath("/trunks"), { query: { limit: 100 }, route: "GET trunks" }),
      ]);
      const appList = (listField(apps.data, "objects") ?? []) as Rec[];
      const trunkList = (listField(trunks.data, "objects") ?? []) as Rec[];
      const webhooks = [
        ...appList.flatMap((a) =>
          (["answer_url", "hangup_url", "fallback_answer_url", "message_url", "sip_transfer_url"] as const)
            .filter((k) => typeof a[k] === "string" && a[k])
            .map((k) => ({ source: "application", id: a.app_id ?? null, name: a.app_name ?? null, kind: k, url: a[k], method: a[k.replace("_url", "_method").replace("fallback_answer_method", "fallback_method")] ?? null })),
        ),
        ...trunkList
          .filter((t) => typeof t.webhook_url === "string" && t.webhook_url)
          .map((t) => ({
            source: "sip_trunk",
            id: t.trunk_id ?? null,
            name: t.name ?? null,
            kind: "webhook_url",
            url: t.webhook_url,
            method: t.webhook_method ?? null,
            events: ["CallInitiated", "Hangup", ...(t.recording_webhook_enabled ? ["recording.completed"] : [])],
          })),
      ];
      return ok({
        ok: true,
        count: webhooks.length,
        webhooks,
        how_to_change: "Use update_application (answer/hangup URLs) or update_sip_trunk (webhook_url). Webhooks live on these objects, so there is nothing separate to create or delete.",
        application_list_truncated: appList.length === 20,
      });
    }),
  );
}
