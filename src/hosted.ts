#!/usr/bin/env node
/**
 * Hosted, multi-tenant Vobiz MCP connector (e.g. https://mcp.vobiz.ai/mcp) for claude.ai, Claude Desktop,
 * Claude Code and other remote MCP clients.
 *
 *   POST /mcp                                   Streamable HTTP, Bearer token required
 *   GET  /.well-known/oauth-protected-resource/mcp   RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server     RFC 8414 metadata (PKCE S256, DCR, CIMD)
 *   /authorize, /token, /register, /revoke      OAuth 2.1 authorization server
 *   POST /oauth/login                           consent form: the user enters their Vobiz Auth ID + Auth Token
 *   GET|POST /answer                            default answer XML for make_call
 *   /jobs/fire, /r/:token/*                     reminder calls (when a reminders router is mounted)
 *   /upload/:token, /media/:token               audio library for reminder calls (when a media router is mounted)
 *   GET  /.well-known/openai-apps-challenge     OpenAI Apps domain verification (VOBIZ_OPENAI_APPS_CHALLENGE)
 *   GET  /health
 *
 * Each user signs in with their own Vobiz credentials. They are sealed (AES-256-GCM) inside the
 * access/refresh tokens, so the server keeps no credential database and every request acts only on
 * the signed-in account. Rotating the Auth Token in the Vobiz console revokes every token at once.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import type { ConnectionProfile, SharedState } from "./context.js";
import type { ReminderService } from "./reminders/types.js";
import { createReminderBackend, createReminderService, createRemindersRouter, reminderSignatureMode } from "./reminders/index.js";
import type { MediaService } from "./media/types.js";
import { createMediaBackend, createMediaService } from "./media/index.js";
import { createMediaRouter, mintMediaUrl, mintUploadUrl } from "./media/router.js";
import { createLogger, type Logger } from "./logger.js";
import { createServer, createSharedState } from "./server.js";
import { SERVER_VERSION } from "./version.js";
import { BRAND_BASE_CSS, VOBIZ_LOGO_SVG } from "./brand.js";
import { Sealer } from "./sealer.js";
import { COMMON_TIME_ZONES, DEFAULT_TIME_ZONE, isValidTimeZone } from "./tz.js";
export { Sealer };

/** Default exclusions (override with VOBIZ_HOSTED_EXCLUDED_TOOLS): tools that need this process to host callbacks for one account, or that buy things. */
export const HOSTED_EXCLUDED_TOOLS = ["buy_phone_number", "gather_dtmf", "get_gather_result", "list_webhook_events", "hold_call", "unhold_call"];

/** The only tools an "assistant" sign-in offers: reminder calls to the user's own number plus a few lookups. */
export const ASSISTANT_TOOLS = [
  "schedule_reminder_call",
  "list_reminder_calls",
  "get_reminder_call",
  "cancel_reminder_call",
  "get_account_balance",
  "list_phone_numbers",
  "get_call_status",
  "create_audio_upload_link",
  "import_audio_from_url",
  "list_audio",
  "delete_audio",
];

type Scope = ConnectionProfile["scope"];
const SCOPES: Scope[] = ["read", "assistant", "full"];
const E164_RE = /^\+[1-9]\d{6,14}$/;
/** Accepts "+91 98765-43210" style input; returns +digits, or undefined when it is not E.164. */
const e164 = (v: string): string | undefined => {
  const t = v.replace(/[\s().-]/g, "");
  return E164_RE.test(t) ? t : undefined;
};

const CODE_TTL = 300;
const TXN_TTL = 900;
const SCOPE = "vobiz";
const AUTH_ID_RE = /^(MA|SA)_[A-Za-z0-9]{4,40}$/;

interface Grant {
  authId: string;
  authToken: string;
  /** Always scope === "read"; kept for tokens issued before scopes existed. */
  readOnly: boolean;
  clientId: string;
  resource: string;
  scope?: Scope;
  callMeOn?: string;
  callFrom?: string;
  tz?: string;
}

/** What the sign-in form chose; also the form values echoed back when it is shown again with an error. */
interface Choice {
  scope: Scope;
  callMeOn: string;
  callFrom: string;
  tz: string;
}
const DEFAULT_CHOICE: Choice = { scope: "full", callMeOn: "", callFrom: "", tz: DEFAULT_TIME_ZONE };

/** Grant fields carried from the code into every access/refresh token; older tokens without a scope map from readOnly. */
const profileOf = (g: Pick<Grant, "readOnly" | "scope" | "callMeOn" | "callFrom" | "tz">) => {
  const scope: Scope = g.scope && SCOPES.includes(g.scope) ? g.scope : g.readOnly ? "read" : "full";
  return { scope, readOnly: scope === "read", callMeOn: g.callMeOn, callFrom: g.callFrom, tz: g.tz || DEFAULT_TIME_ZONE };
};

export interface HostedOptions {
  cfg: Config;
  log: Logger;
  /** Public https base URL of this deployment, no trailing slash, e.g. https://mcp.vobiz.ai */
  baseUrl: string;
  /** >= 32 characters; keep it stable across restarts and replicas. */
  secret: string;
  /** Hosts allowed to serve OAuth Client ID Metadata Documents. */
  cimdHosts?: string[];
  /** Browser origins allowed to call /mcp (requests without Origin are always allowed). */
  allowedOrigins?: string[];
  /** Tool names the hosted connector never offers (default HOSTED_EXCLUDED_TOOLS). */
  excludeTools?: string[];
  /** Access / refresh token lifetimes in seconds (default 1 hour / 30 days). */
  accessTtlSec?: number;
  refreshTtlSec?: number;
  fetchImpl?: typeof fetch;
  /** Server-side reminder calls; the reminder tools are offered only when this is set. */
  reminders?: ReminderService;
  /** Express router serving /jobs/fire and /r/:token/* for reminder calls, mounted before the 404 handler. */
  remindersRouter?: express.Router;
  /** The audio library for reminder calls; the audio tools are offered only when this (and reminders) is set. */
  media?: MediaService;
  /** Express router serving /upload/:token and /media/:token, mounted before the 404 handler. */
  mediaRouter?: express.Router;
  /** False while audio conversion (ffmpeg) is unavailable: upload links and URL imports are then refused. */
  mediaAvailable?: () => Promise<boolean>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * CSP for the consent page: inline styles, IBM Plex Sans from Google Fonts, no scripts. Browsers apply form-action to
 * the redirect that follows the form post, so it must allow the client's registered redirect origin as well as 'self'
 * (otherwise the 302 back to e.g. https://claude.ai/api/mcp/auth_callback is silently blocked).
 */
function consentCsp(redirectUri: string): string {
  let origin = "";
  try {
    const u = new URL(redirectUri);
    origin = u.protocol === "https:" || u.protocol === "http:" ? u.origin : `${u.protocol}`;
  } catch {
    /* unparsable redirect: 'self' only */
  }
  return `default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self' ${origin}; frame-ancestors 'none'; base-uri 'none'`.replace(/\s+;/g, ";");
}

/** Sign-in page in the Vobiz brand: IBM Plex Sans, Vobiz Red #E83C00 / Orange #E86A00 / Dark Grey #100703, official lockup. */
function consentPage(o: { txn: string; clientName: string; redirectHost: string; error?: string; links: Config["links"]; values?: Choice }): string {
  const v = o.values ?? DEFAULT_CHOICE;
  const radio = (scope: Scope, title: string, text: string) =>
    `<label class="opt" for="scope_${scope}"><input id="scope_${scope}" name="scope" type="radio" value="${scope}"${v.scope === scope ? " checked" : ""}><span><strong>${title}</strong>${text}</span></label>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Connect your Vobiz account · Vobiz MCP Server</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&display=swap">
<style>
${BRAND_BASE_CSS}
ul.scope{list-style:none;margin:0 0 24px;padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius);display:grid;gap:8px}
ul.scope li{display:flex;gap:10px;align-items:flex-start;font-size:14px}
ul.scope li::before{content:"";flex:0 0 8px;height:8px;margin-top:7px;border-radius:2px 8px 2px 2px;background:var(--red)}
label{display:block;font-weight:500;font-size:14px;margin:16px 0 6px}
input[type=text],input[type=password]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius);background:var(--input);color:var(--fg);font:inherit;transition:border-color .15s,box-shadow .15s}
input[type=text]::placeholder{color:var(--muted);font-weight:300}
input[type=text]:focus,input[type=password]:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px var(--ring)}
.check{display:flex;gap:10px;align-items:flex-start;margin-top:18px;font-size:14px;color:var(--muted)}
.check input{accent-color:var(--red);width:16px;height:16px;margin:3px 0 0;flex:0 0 auto}
.check label{margin:0;font-weight:400;color:var(--muted)}
.check strong{color:var(--fg);font-weight:500}
fieldset{border:0;margin:20px 0 0;padding:0;display:grid;gap:8px}
legend{font-weight:500;font-size:14px;padding:0;margin:0 0 8px}
.opt{display:flex;gap:10px;align-items:flex-start;margin:0;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius);font-weight:400;font-size:14px;color:var(--muted);cursor:pointer;transition:border-color .15s}
.opt input{accent-color:var(--red);width:16px;height:16px;margin:3px 0 0;flex:0 0 auto}
.opt strong{display:block;color:var(--fg);font-weight:500}
.opt:has(input:checked){border-color:var(--red)}
.opt:has(input:focus-visible){box-shadow:0 0 0 3px var(--ring)}
.profile{margin-top:4px}
form:has(#scope_read:checked) .profile{display:none}
.hint{display:block;font-weight:300;font-size:13px;color:var(--muted);margin:4px 0 0}
input[type=tel]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius);background:var(--input);color:var(--fg);font:inherit;transition:border-color .15s,box-shadow .15s}
input[type=tel]::placeholder{color:var(--muted);font-weight:300}
input[type=tel]:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px var(--ring)}
</style></head><body>
<div class="brand">${VOBIZ_LOGO_SVG}</div>
<main>
<p class="eyebrow">Vobiz MCP Server</p>
<h1>Connect your Vobiz account</h1>
<p class="lead"><strong>${esc(o.clientName)}</strong> (${esc(o.redirectHost)}) is asking to use your Vobiz account.</p>
<ul class="scope">
<li>Read your calls, call records, numbers, SIP trunks, messages and balance</li>
<li>Place calls, send messages or change settings only after you confirm each one</li>
<li>Schedule reminder and wake-up calls that Vobiz places at the time you ask, with your own audio if you add some</li>
</ul>
<form method="post" action="/oauth/login" autocomplete="off">
<input type="hidden" name="txn" value="${esc(o.txn)}">
<label for="auth_id">Auth ID</label><input id="auth_id" name="auth_id" type="text" placeholder="MA_XXXXXXXX" required pattern="(MA|SA)_[A-Za-z0-9]+" spellcheck="false" autocapitalize="off">
<label for="auth_token">Auth Token</label><input id="auth_token" name="auth_token" type="password" required>
<fieldset><legend>Access</legend>
${radio("full", "Full access", "Every tool. Calls, messages and account changes only after you confirm each one.")}
${radio("assistant", "Personal assistant", "Only reminder and wake-up calls to your own number, plus your balance, numbers and call status.")}
${radio("read", "Read-only", "No calls, messages, reminders or account changes.")}
</fieldset>
<div class="profile">
<label for="call_me_on">Call me on <span class="hint">Your own number in E.164, e.g. +919876543210. Reminder calls go here. Required for personal assistant.</span></label><input id="call_me_on" name="call_me_on" type="tel" placeholder="+919876543210" value="${esc(v.callMeOn)}" pattern="\\+?[0-9]{7,15}" inputmode="tel" autocomplete="tel">
<label for="call_from">Call from <span class="hint">Optional: a voice number on your Vobiz account. Blank = your first voice number.</span></label><input id="call_from" name="call_from" type="tel" placeholder="+918012345678" value="${esc(v.callFrom)}" pattern="\\+?[0-9]{7,15}" inputmode="tel">
<label for="timezone">Timezone <span class="hint">Used to read and say reminder times.</span></label><input id="timezone" name="timezone" type="text" list="tz_list" value="${esc(v.tz)}" spellcheck="false" autocapitalize="off">
<datalist id="tz_list">${COMMON_TIME_ZONES.map((z) => `<option value="${z}"></option>`).join("")}</datalist>
</div>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ""}
<button type="submit">Allow access</button>
</form>
<p class="fine">Your Auth ID and Auth Token are on the <a href="${esc(o.links.console)}" target="_blank" rel="noopener">Vobiz console</a> overview page. They are encrypted inside the access token issued to this app and never stored by Vobiz MCP Server. Rotate your Auth Token in the console at any time to revoke access.</p>
</main>
<footer><a href="${esc(o.links.privacy)}" target="_blank" rel="noopener">Privacy policy</a> · <a href="${esc(o.links.docs)}" target="_blank" rel="noopener">Documentation</a></footer>
</body></html>`;
}

export function createHostedApp(o: HostedOptions): express.Express {
  const { cfg, log } = o;
  const seal = new Sealer(o.secret);
  const base = o.baseUrl.replace(/\/+$/, "");
  const mcpUrl = new URL(`${base}/mcp`);
  // ChatGPT's CIMD client id is https://chatgpt.com/oauth/client.json.
  const cimdHosts = new Set((o.cimdHosts ?? ["claude.ai", "chatgpt.com"]).map((h) => h.toLowerCase()));
  const allowedOrigins = new Set(o.allowedOrigins ?? ["https://claude.ai", "https://claude.com", "https://chatgpt.com", "https://chat.openai.com"]);
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const ACCESS_TTL = o.accessTtlSec ?? 3600;
  const REFRESH_TTL = o.refreshTtlSec ?? 30 * 24 * 3600;
  const excludeTools = o.excludeTools ?? HOSTED_EXCLUDED_TOOLS;
  const usedCodes = new Map<string, number>();
  const cimdCache = new Map<string, { at: number; client: OAuthClientInformationFull }>();
  const tenants = new Map<string, SharedState>();
  const accountCfg = (g: Pick<Grant, "authId" | "authToken">): Config => ({ ...cfg, authId: g.authId, authToken: g.authToken });

  /** Per-account limiters and idempotency records (bounded LRU). */
  const tenantState = (authId: string): SharedState => {
    let s = tenants.get(authId);
    if (s) {
      tenants.delete(authId);
    } else {
      s = createSharedState(cfg);
      if (tenants.size >= 5000) tenants.delete(tenants.keys().next().value as string);
    }
    tenants.set(authId, s);
    return s;
  };

  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId) {
      if (clientId.startsWith("https://")) return fetchCimd(clientId);
      const c = seal.open<{ c: OAuthClientInformationFull }>("client", clientId);
      return c ? { ...c.c, client_id: clientId } : undefined;
    },
    // Stateless dynamic registration: the client record is sealed into its own client_id.
    async registerClient(client) {
      const keep: Partial<OAuthClientInformationFull> = {
        redirect_uris: client.redirect_uris,
        client_name: client.client_name,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: client.grant_types,
        response_types: client.response_types,
        client_secret: client.client_secret,
        client_secret_expires_at: client.client_secret_expires_at,
      };
      const clientId = seal.seal("client", { c: keep }, 10 * 365 * 24 * 3600);
      return { ...client, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) };
    },
  };

  async function fetchCimd(url: string): Promise<OAuthClientInformationFull | undefined> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if (u.protocol !== "https:" || !cimdHosts.has(u.hostname.toLowerCase())) return undefined;
    const hit = cimdCache.get(url);
    if (hit && Date.now() - hit.at < 3600_000) return hit.client;
    try {
      const res = await fetchImpl(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      const text = await res.text();
      if (text.length > 64 * 1024) return undefined;
      const doc = JSON.parse(text) as Partial<OAuthClientInformationFull>;
      if (doc.client_id !== url || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length) return undefined;
      const client = { ...doc, client_id: url, token_endpoint_auth_method: "none" } as OAuthClientInformationFull;
      cimdCache.set(url, { at: Date.now(), client });
      return client;
    } catch {
      return undefined;
    }
  }

  const issue = (g: Grant): OAuthTokens => ({
    access_token: seal.seal("access", { ...g }, ACCESS_TTL),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: seal.seal("refresh", { ...g }, REFRESH_TTL),
    scope: SCOPE,
  });

  const provider: OAuthServerProvider = {
    clientsStore,
    async authorize(client, params: AuthorizationParams, res) {
      const txn = seal.seal(
        "txn",
        { cid: client.client_id, redirect: params.redirectUri, state: params.state ?? null, challenge: params.codeChallenge, resource: params.resource?.href ?? mcpUrl.href },
        TXN_TTL,
      );
      res.setHeader("Content-Security-Policy", consentCsp(params.redirectUri));
      res.status(200).type("html").send(consentPage({ txn, clientName: client.client_name ?? "An MCP client", redirectHost: new URL(params.redirectUri).host, links: cfg.links }));
    },
    async challengeForAuthorizationCode(client, code) {
      const c = seal.open<{ cid: string; challenge: string }>("code", code);
      if (!c || c.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
      return c.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const c = seal.open<Grant & { cid: string; redirect: string; jti: string }>("code", code);
      if (!c || c.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
      if (redirectUri && redirectUri !== c.redirect) throw new InvalidGrantError("redirect_uri does not match the authorization request");
      if (usedCodes.has(c.jti)) throw new InvalidGrantError("Authorization code was already used");
      usedCodes.set(c.jti, c.exp);
      for (const [k, exp] of usedCodes) if (exp * 1000 < Date.now()) usedCodes.delete(k);
      return issue({ authId: c.authId, authToken: c.authToken, clientId: client.client_id, resource: c.resource, ...profileOf(c) });
    },
    async exchangeRefreshToken(client, refreshToken) {
      const g = seal.open<Grant>("refresh", refreshToken);
      if (!g || g.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
      return issue({ authId: g.authId, authToken: g.authToken, clientId: g.clientId, resource: g.resource, ...profileOf(g) });
    },
    async verifyAccessToken(token): Promise<AuthInfo> {
      const g = seal.open<Grant>("access", token);
      if (!g) throw new InvalidTokenError("Invalid or expired access token");
      const p = profileOf(g);
      return {
        token,
        clientId: g.clientId,
        scopes: [SCOPE],
        expiresAt: g.exp,
        resource: new URL(g.resource),
        extra: { authId: g.authId, authToken: g.authToken, readOnly: p.readOnly, scope: p.scope, callMeOn: p.callMeOn, callFrom: p.callFrom, tz: p.tz },
      };
    },
  };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => res.json({ ok: true, version: SERVER_VERSION }));
  const answerXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Speak>${esc(process.env.VOBIZ_ANSWER_TEXT?.trim() || "Hello from Vobiz.")}</Speak>\n</Response>\n`;
  app.all("/answer", (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();
    res.type("text/xml").set("Cache-Control", "no-store").send(answerXml);
  });

  // Authorization server metadata, extended with Client ID Metadata Document support.
  const asMeta = {
    ...createOAuthMetadata({ provider, issuerUrl: new URL(base), scopesSupported: [SCOPE], serviceDocumentationUrl: new URL(cfg.links.docs) }),
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // RFC 9207: every authorization response carries iss (ChatGPT checks it).
    authorization_response_iss_parameter_supported: true,
  };
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(asMeta));
  // OpenAI Apps domain verification: the token from the OpenAI platform, served verbatim.
  app.get("/.well-known/openai-apps-challenge", (_req, res) =>
    cfg.openaiAppsChallenge ? res.type("text/plain").set("Cache-Control", "no-store").send(cfg.openaiAppsChallenge) : res.status(404).json({ error: "not_found" }),
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(base),
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "Vobiz",
      serviceDocumentationUrl: new URL(cfg.links.docs),
    }),
  );

  // Consent form submission: verify the credentials with Vobiz, then redirect back with a code.
  app.post("/oauth/login", express.urlencoded({ extended: false, limit: "8kb" }), async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const t = seal.open<{ cid: string; redirect: string; state: string | null; challenge: string; resource: string }>("txn", String(req.body?.txn ?? ""));
    if (!t) return res.status(400).type("text").send("This sign-in link has expired. Go back to your app and connect again.");
    const client = await clientsStore.getClient(t.cid);
    if (!client) return res.status(400).type("text").send("Unknown client. Go back to your app and connect again.");
    const authId = String(req.body?.auth_id ?? "").trim();
    const authToken = String(req.body?.auth_token ?? "").trim();
    const field = (k: string) => String(req.body?.[k] ?? "").trim().slice(0, 64);
    const rawScope = field("scope");
    // Older form: a read_only checkbox and no scope radio.
    const scope: Scope = SCOPES.includes(rawScope as Scope) ? (rawScope as Scope) : req.body?.read_only === "1" ? "read" : "full";
    const values: Choice = { scope, callMeOn: field("call_me_on"), callFrom: field("call_from"), tz: field("timezone") || DEFAULT_TIME_ZONE };
    const again = (error: string) =>
      res
        .status(200)
        .set("Content-Security-Policy", consentCsp(t.redirect))
        .type("html")
        .send(consentPage({ txn: String(req.body.txn), clientName: client.client_name ?? "An MCP client", redirectHost: new URL(t.redirect).host, error, links: cfg.links, values }));
    if (!AUTH_ID_RE.test(authId) || authToken.length < 8 || authToken.length > 256) return again("Enter a valid Auth ID (MA_… or SA_…) and Auth Token.");
    if (!isValidTimeZone(values.tz)) return again("Enter a timezone such as Asia/Kolkata or America/New_York.");
    let callMeOn: string | undefined;
    let callFrom: string | undefined;
    if (scope !== "read") {
      callMeOn = values.callMeOn ? e164(values.callMeOn) : undefined;
      if (values.callMeOn && !callMeOn) return again("Enter \"Call me on\" in E.164, e.g. +919876543210.");
      if (scope === "assistant" && !callMeOn) return again("Personal assistant needs your number under \"Call me on\".");
      callFrom = values.callFrom ? e164(values.callFrom) : undefined;
      if (values.callFrom && !callFrom) return again("Enter \"Call from\" in E.164, e.g. +918012345678, or leave it blank.");
    }
    let status = 0;
    try {
      const r = await fetchImpl(`${cfg.baseUrl}/api/v1/Account/${encodeURIComponent(authId)}/numbers?per_page=1`, {
        headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      status = r.status;
      await r.body?.cancel().catch(() => {});
    } catch {
      return again("Vobiz could not be reached to check these credentials. Try again in a moment.");
    }
    if (status === 401 || status === 403) return again("Vobiz did not accept this Auth ID and Auth Token. Check them on the console overview page.");
    if (status >= 500 || status === 0) return again("Vobiz could not check these credentials right now. Try again in a moment.");
    log.info(`oauth: account connected (status ${status}, scope ${scope})`);
    const code = seal.seal(
      "code",
      {
        cid: t.cid,
        redirect: t.redirect,
        challenge: t.challenge,
        resource: t.resource,
        authId,
        authToken,
        readOnly: scope === "read",
        scope,
        ...(callMeOn ? { callMeOn } : {}),
        ...(callFrom ? { callFrom } : {}),
        tz: values.tz,
        jti: randomBytes(12).toString("hex"),
      },
      CODE_TTL,
    );
    const to = new URL(t.redirect);
    to.searchParams.set("code", code);
    if (t.state) to.searchParams.set("state", t.state);
    to.searchParams.set("iss", asMeta.issuer);
    res.redirect(302, to.href);
  });

  // MCP endpoint.
  const originOk = (origin: string | undefined) => !origin || allowedOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl });
  app.all("/mcp", (req, res, next) => (originOk(req.headers.origin) ? next() : res.status(403).json({ error: "origin_not_allowed" })), bearer, express.json({ limit: "1mb" }), async (req, res) => {
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    const extra = req.auth?.extra as { authId: string; authToken: string; readOnly: boolean; scope: Scope; callMeOn?: string; callFrom?: string; tz: string };
    const profile: ConnectionProfile = { scope: extra.scope, callMeOn: extra.callMeOn, callFrom: extra.callFrom, timezone: extra.tz };
    const server = createServer(accountCfg(extra), log, o.fetchImpl, {
      readOnly: extra.readOnly,
      shared: tenantState(extra.authId),
      excludeTools,
      ...(extra.scope === "assistant" ? { includeTools: ASSISTANT_TOOLS } : {}),
      ...(o.reminders ? { reminders: o.reminders } : {}),
      ...(o.media
        ? {
            media: o.media,
            mediaUploads: { url: (authId: string, name?: string) => mintUploadUrl(seal, base, authId, name), ...(o.mediaAvailable ? { available: o.mediaAvailable } : {}) },
          }
        : {}),
      profile,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      log.info("mcp request failed");
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  // Reminder-call job delivery and Vobiz callbacks (/jobs/fire, /r/:token/*), authenticated by sealed tokens.
  if (o.remindersRouter) app.use(o.remindersRouter);
  // Audio library: the upload page and PUT (/upload/:token) and the <Play> source for Vobiz (/media/:token).
  if (o.mediaRouter) app.use(o.mediaRouter);

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}

export async function runHosted(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig({ VOBIZ_ALLOW_ANY_URL_HOST: "true", ...process.env, VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[vobiz-mcp] configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(cfg.logLevel);
  const baseUrl = process.env.VOBIZ_HOSTED_URL?.trim().replace(/\/+$/, "") ?? "";
  const secret = process.env.VOBIZ_HOSTED_SECRET?.trim() ?? "";
  if (!/^https:\/\//.test(baseUrl)) {
    process.stderr.write("[vobiz-mcp] VOBIZ_HOSTED_URL must be the public https base URL, e.g. https://mcp.vobiz.ai\n");
    process.exit(1);
  }
  if (secret.length < 32) {
    process.stderr.write("[vobiz-mcp] VOBIZ_HOSTED_SECRET must be at least 32 characters and stable across restarts\n");
    process.exit(1);
  }
  if (!cfg.defaultAnswerUrl) cfg.defaultAnswerUrl = `${baseUrl}/answer`;
  const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  const ttl = (name: string, fallback: number) => {
    const v = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(v) || v < 60 || v > 365 * 24 * 3600) {
      process.stderr.write(`[vobiz-mcp] ${name} must be a whole number of seconds between 60 and 31536000\n`);
      process.exit(1);
    }
    return v;
  };
  // Reminder calls: scheduled on this server (Cloud Tasks + Firestore when configured, else in-process memory).
  let reminders: ReminderService | undefined;
  let remindersRouter: express.Router | undefined;
  let media: MediaService | undefined;
  let mediaRouter: express.Router | undefined;
  let mediaAvailable: (() => Promise<boolean>) | undefined;
  if (cfg.reminders.enabled) {
    const r = cfg.reminders;
    const backend = createReminderBackend(
      {
        VOBIZ_GCP_PROJECT: r.gcpProject,
        VOBIZ_TASKS_LOCATION: r.tasksLocation,
        VOBIZ_TASKS_QUEUE: r.tasksQueue,
        VOBIZ_FIRESTORE_DATABASE: r.firestoreDatabase,
        VOBIZ_FIRESTORE_COLLECTION: r.firestoreCollection,
        VOBIZ_MAX_ACTIVE_REMINDERS: String(r.maxActive),
        VOBIZ_MAX_REMINDER_CALLS_PER_DAY: String(r.maxCallsPerDay),
      },
      log,
      { baseUrl },
    );
    const sealer = new Sealer(secret);
    // Audio library for reminder calls: Cloud Storage when VOBIZ_MEDIA_BUCKET is set, else local disk.
    const m = cfg.media;
    const mediaBackend = createMediaBackend(
      {
        ...(m.bucket ? { VOBIZ_MEDIA_BUCKET: m.bucket } : {}),
        ...(m.dir ? { VOBIZ_MEDIA_DIR: m.dir } : {}),
        VOBIZ_MEDIA_MAX_INPUT_MB: String(m.maxInputMb),
        VOBIZ_MEDIA_MAX_DURATION_SEC: String(m.maxDurationSec),
        VOBIZ_MEDIA_MAX_PER_ACCOUNT: String(m.maxPerAccount),
        VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY: String(m.maxUploadsPerDay),
      },
      log,
    );
    const library = createMediaService({ store: mediaBackend.store, processor: mediaBackend.processor, limits: mediaBackend.limits, log });
    media = library;
    mediaAvailable = () => mediaBackend.processor.available();
    if (!(await mediaAvailable().catch(() => false))) {
      log.info("media: WARNING ffmpeg/ffprobe not found; audio uploads and URL imports are refused until they are installed (set VOBIZ_FFMPEG / VOBIZ_FFPROBE or add them to PATH).");
    }
    mediaRouter = createMediaRouter(library, { baseUrl, sealer, log, links: cfg.links });
    reminders = createReminderService({
      store: backend.store,
      scheduler: backend.scheduler,
      sealer,
      baseUrl,
      cfg,
      log,
      limits: backend.limits,
      mediaUrl: (account, audioId) => mintMediaUrl(sealer, baseUrl, account.authId, audioId),
      mediaExists: async (authId, id) => (await library.find(authId, id))?.id === id,
    });
    // Reminder callbacks: VOBIZ_WEBHOOK_SIGNATURE when the operator set it, else verify_if_present (see docs/HOSTING.md).
    remindersRouter = createRemindersRouter(reminders, {
      baseUrl,
      signatureMode: reminderSignatureMode(process.env.VOBIZ_WEBHOOK_SIGNATURE, cfg.webhookSignature),
      sealer,
      log,
    });
  }
  const app = createHostedApp({
    cfg,
    log,
    baseUrl,
    secret,
    reminders,
    remindersRouter,
    media,
    mediaRouter,
    mediaAvailable,
    cimdHosts: list(process.env.VOBIZ_CIMD_HOSTS),
    allowedOrigins: list(process.env.VOBIZ_ALLOWED_ORIGINS),
    excludeTools: process.env.VOBIZ_HOSTED_EXCLUDED_TOOLS === undefined ? undefined : (list(process.env.VOBIZ_HOSTED_EXCLUDED_TOOLS) ?? []),
    accessTtlSec: ttl("VOBIZ_ACCESS_TOKEN_TTL_SEC", 3600),
    refreshTtlSec: ttl("VOBIZ_REFRESH_TOKEN_TTL_SEC", 30 * 24 * 3600),
  });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST?.trim() || "0.0.0.0";
  const server = app.listen(port, host, () => {
    process.stderr.write(`[vobiz-mcp] hosted connector v${SERVER_VERSION} on http://${host}:${port}, public URL ${baseUrl}/mcp\n`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHosted().catch((err) => {
    process.stderr.write(`[vobiz-mcp] fatal error during startup: ${err instanceof Error ? err.message : "unknown"}\n`);
    process.exit(1);
  });
}
