#!/usr/bin/env node
// Live check of a DEPLOYED hosted connector (default https://mcp.vobiz.ai; set VOBIZ_MCP_BASE to override).
// Runs the full OAuth flow in-process (register → consent → code → token → MCP → refresh) and only
// exercises read-only tools plus send_message to an opted-out test number (blocked, nothing is sent).
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { VOBIZ_AUTH_ID: id, VOBIZ_AUTH_TOKEN: token } = process.env;
if (!id || !token) {
  console.error("VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN not set: skipped.");
  process.exit(2);
}




const base = (process.env.VOBIZ_MCP_BASE ?? "https://mcp.vobiz.ai").replace(/\/+$/, "");
const CB = "https://claude.ai/api/mcp/auth_callback";
const step = (name, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
let failed = 0;
const must = (name, cond, detail) => (step(name, cond, detail), cond || failed++);

const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
must("protected resource metadata", prm.resource === `${base}/mcp`);
const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
must("401 + resource_metadata challenge", unauth.status === 401 && /resource_metadata=/.test(unauth.headers.get("www-authenticate") ?? ""));
const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none" }) })).json();
must("dynamic client registration", !!reg.client_id);
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: `${base}/mcp` });
const html = await (await fetch(`${base}/authorize?${q}`)).text();
const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
must("consent page", !!txn);
const bad = await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn, auth_id: id, auth_token: "wrong-token-123" }), redirect: "manual" });
must("wrong token rejected by Vobiz", bad.status === 200 && (await bad.text()).includes("did not accept"));
const login = await fetch(`${base}/oauth/login`, { method: "POST", body: new URLSearchParams({ txn, auth_id: id, auth_token: token }), redirect: "manual" });
const code = new URL(login.headers.get("location") ?? "https://x/").searchParams.get("code");
must("real credentials accepted, code issued", login.status === 302 && !!code);
const tok = await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: CB }) })).json();
must("token exchange", !!tok.access_token && !tok.access_token.includes(token));

const client = new Client({ name: "live-hosted", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }));
const { tools } = await client.listTools();
must("tools listed", tools.length > 40, `${tools.length} tools`);
must("every tool annotated for the directory", tools.every((t) => t.title && (t.annotations?.readOnlyHint || t.annotations?.destructiveHint)));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent ?? {};
const bal = await call("get_account_balance");
must("get_account_balance on the signed-in account", bal.ok === true, `${bal.balance?.available_balance} ${bal.balance?.currency}`);
const nums = await call("list_messaging_numbers");
must("list_messaging_numbers", nums.ok === true, `${nums.count} numbers`);
const from = nums.numbers?.[0]?.e164;
const optTo = "+14155550124";
must("add_opt_out", (await call("add_opt_out", { phone_number: optTo, reason: "mcp live test", confirm: true })).opted_out === true);
const sent = await call("send_message", { from, to: [optTo], text: "MCP live test (blocked by opt-out)", idempotency_key: `live-${Date.now()}`, confirm: true });
must("send_message refused for opted-out number (nothing sent)", sent.sent_count === 0 && sent.messages?.[0]?.errorCode === "opted_out");
must("remove_opt_out", (await call("remove_opt_out", { phone_number: optTo, confirm: true })).opted_out === false);
const skills = await call("list_vobiz_skills");
must("skills", skills.count >= 14, `${skills.count} skills`);
const prompts = await client.listPrompts();
must("prompts", prompts.prompts.length >= 14);
const res = await client.readResource({ uri: "vobiz://skills/vobiz-voice-xml" });
must("skill resource", String(res.contents[0].text).includes("vobiz-voice-xml"));
await client.close();

const ref = await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }) })).json();
must("refresh token", !!ref.access_token);

console.log(failed ? `${failed} FAILED` : "all hosted checks passed");
process.exit(failed ? 1 : 0);
