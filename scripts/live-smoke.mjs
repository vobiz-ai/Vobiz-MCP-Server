#!/usr/bin/env node
// Live READ-ONLY smoke test against the real Vobiz API using credentials from the environment
// (run with: npm run test:live, which loads .env). It never calls a tool that changes anything:
// calling and provisioning are forced off in the child server.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, VOBIZ_ENABLE_CALLS: "false", VOBIZ_ENABLE_PROVISIONING: "false", VOBIZ_ENABLE_MESSAGING: "false", VOBIZ_LOG_LEVEL: "silent" };
if (!env.VOBIZ_AUTH_ID || !env.VOBIZ_AUTH_TOKEN) {
  console.error("VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN not set: live smoke test skipped.");
  process.exit(2);
}

const client = new Client({ name: "live-smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "dist", "index.js")], env }));
const results = [];
async function check(name, args, summarize) {
  const started = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args });
    const d = r.structuredContent ?? {};
    results.push({ tool: name, result: r.isError ? `ERROR ${d.error}: ${d.message}` : "ok", detail: r.isError ? "" : summarize(d), ms: Date.now() - started });
    return r.isError ? undefined : d;
  } catch (e) {
    results.push({ tool: name, result: `CRASH ${e?.message}`, detail: "", ms: Date.now() - started });
  }
}

await check("get_account_details", {}, (d) => `account fields: ${Object.keys(d.account ?? {}).length}`);
await check("get_account_balance", {}, (d) => `available ${d.balance?.available_balance} ${d.balance?.currency}`);
await check("get_concurrency", {}, (d) => `${d.concurrency?.concurrent_calls}/${d.concurrency?.max_concurrent}`);
await check("list_live_calls", { include_queued: true }, (d) => `live ${d.live_count}, queued ${d.queued_count}`);
const nums = await check("list_phone_numbers", { per_page: 2 }, (d) => `total ${d.pagination?.total}, has_more ${d.pagination?.has_more}`);
const first = nums?.numbers?.[0]?.e164;
if (first) {
  await check("get_phone_number_details", { phone_number: first }, (d) => `status ${d.number?.status}`);
  await check("get_number_health", { phone_number: first, days: 7 }, (d) => `spam ${d.health?.is_spam}`);
}
const cdrs = await check("list_call_records", { per_page: 3 }, (d) => `total ${d.pagination?.total}, next_page ${d.pagination?.next_page}`);
const uuid = cdrs?.records?.[0]?.uuid;
if (uuid) {
  await check("get_call_details", { call_uuid: uuid }, (d) => `outcome ${d.outcome} (${d.record?.hangup_cause})`);
  await check("get_call_status", { call_uuid: uuid }, (d) => `state ${d.state}`);
  await check("get_call_recording", { call_uuid: uuid }, (d) => `recordings ${d.count}`);
}
await check("list_recordings", { limit: 5 }, (d) => `count ${d.count}, total ${d.pagination?.total}`);
const trunks = await check("list_sip_trunks", { limit: 5 }, (d) => `count ${d.count}`);
if (trunks?.trunks?.[0]?.trunk_id) await check("get_sip_trunk", { trunk_id: trunks.trunks[0].trunk_id }, (d) => `status ${d.trunk?.trunk_status}`);
const apps = await check("list_applications", { limit: 5 }, (d) => `count ${d.count}, total ${d.pagination?.total}`);
if (apps?.applications?.[0]?.app_id) await check("get_application", { app_id: String(apps.applications[0].app_id) }, (d) => `name present: ${!!d.application?.app_name}`);
await check("list_webhooks", {}, (d) => `webhooks ${d.count}`);
await check("search_available_numbers", { country: "IN", per_page: 3 }, (d) => `available total ${d.pagination?.total}`);
// Messaging (read-only)
const sms = await check("list_messaging_numbers", {}, (d) => `messaging numbers ${d.count}`);
const smsFrom = sms?.numbers?.[0]?.e164;
const msgs = await check("list_messages", { limit: 3 }, (d) => `total ${d.pagination?.total}, has_more ${d.pagination?.has_more}`);
if (msgs?.messages?.[0]?.id) await check("get_message", { message_id: msgs.messages[0].id }, (d) => `status ${d.message?.status}`);
if (smsFrom) await check("preview_message_cost", { from: smsFrom, to: smsFrom, text: "x".repeat(170) }, (d) => `${d.preview?.segmentCount} segments, ${d.preview?.totalCost} ${d.preview?.currency}`);
const convs = await check("list_conversations", { limit: 3 }, (d) => `conversations ${d.count}`);
if (convs?.conversations?.[0]?.id) await check("get_conversation_messages", { conversation_id: convs.conversations[0].id, limit: 3 }, (d) => `messages ${d.count}`);
await check("list_opt_outs", { limit: 5 }, (d) => `opt-outs ${d.count}`);
await check("check_opt_out", { phone_number: "+14155550123" }, (d) => `opted_out ${d.opted_out}`);
const bcs = await check("list_broadcasts", { limit: 3 }, (d) => `broadcasts ${d.count}, total ${d.total}`);
if (bcs?.broadcasts?.[0]?.id) await check("get_broadcast", { broadcast_id: bcs.broadcasts[0].id }, (d) => `status ${d.broadcast?.status}`);
await check("get_message", { message_id: "00000000-0000-0000-0000-000000000000" }, () => "UNEXPECTED SUCCESS");
// Conferences, SIP, billing, sub-accounts (read-only)
const confs = await check("list_conferences", {}, (d) => `conferences ${d.count ?? d.conferences?.length}`);
if (confs?.conferences?.[0]) await check("get_conference", { conference_name: String(confs.conferences[0]) }, (d) => `members ${d.conference?.conference_member_count ?? "n/a"}`);
const eps = await check("list_sip_endpoints", { limit: 3 }, (d) => `endpoints ${d.count}, total ${d.pagination?.total}`);
if (eps?.endpoints?.[0]?.endpoint_id) await check("get_sip_endpoint", { endpoint_id: String(eps.endpoints[0].endpoint_id) }, (d) => `alias present: ${!!d.endpoint?.alias}`);
await check("list_trunk_credentials", { limit: 5 }, (d) => `credentials ${d.count}`);
await check("list_ip_acl_entries", { limit: 5 }, (d) => `ip acl ${d.count}`);
await check("list_origination_uris", { limit: 5 }, (d) => `origination uris ${d.count}`);
await check("list_transactions", { per_page: 3 }, (d) => `transactions ${d.transactions?.length}, total ${d.pagination?.total}`);
await check("list_transaction_types", {}, (d) => `types ${d.count ?? d.reference_types?.length}`);
const subs = await check("list_sub_accounts", {}, (d) => `sub-accounts ${d.count ?? d.sub_accounts?.length}`);
const sub = subs?.sub_accounts?.[0]?.auth_id ?? subs?.sub_accounts?.[0]?.sub_auth_id;
if (sub) {
  await check("get_sub_account", { sub_auth_id: sub }, (d) => `name present: ${!!d.sub_account?.name}`);
  await check("get_sub_account_kyc_status", { sub_auth_id: sub }, (d) => `kyc ${JSON.stringify(d.kyc ?? d.status ?? "").slice(0, 40)}`);
}
// Skills
await check("list_vobiz_skills", {}, (d) => `skills ${d.count}`);
await check("get_vobiz_skill", { name: "vobiz-voice-calls" }, (d) => `chars ${d.instructions?.length}`);
await check("generate_answer_xml", { actions: [{ type: "speak", text: "test" }, { type: "hangup" }] }, (d) => `xml bytes ${d.xml?.length}`);
// Expected refusals (safety): these must NOT reach Vobiz.
await check("make_call", { to: "+919812345678", from: first ?? "+919000000001", confirm: true }, () => "UNEXPECTED SUCCESS");
await check("buy_phone_number", { phone_number: "+919000000009", idempotency_key: "live-smoke-0001", confirm: true }, () => "UNEXPECTED SUCCESS");
await check("send_message", { from: smsFrom ?? "+14155550100", to: ["+14155550123"], text: "live smoke", idempotency_key: "live-smoke-0002", confirm: true }, () => "UNEXPECTED SUCCESS");

await client.close();
console.table(results);
const REFUSALS = ["make_call", "buy_phone_number", "send_message"];
const failures = results.filter((r) => r.result !== "ok" && !REFUSALS.includes(r.tool) && !(r.tool === "get_message" && r.result.startsWith("ERROR not_found")));
const unsafe = results.filter((r) => REFUSALS.includes(r.tool) && r.result === "ok");
const n = results.length - REFUSALS.length;
console.log(`read-only checks: ${n - failures.length}/${n} ok; safety refusals: ${unsafe.length ? "FAILED" : "ok"}`);
process.exit(failures.length || unsafe.length ? 1 : 0);
