#!/usr/bin/env node
/**
 * Hosted, multi-tenant Vobiz MCP connector (e.g. https://mcp.vobiz.ai/mcp) for claude.ai, Claude Desktop,
 * Claude Code and other remote MCP clients.
 *
 *   POST /mcp                                   Streamable HTTP, Bearer token required
 *   GET  /.well-known/oauth-protected-resource/mcp   RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server     RFC 8414 metadata (PKCE S256, DCR, CIMD)
 *   /authorize, /token, /register, /revoke      OAuth 2.1 authorization server (revoking a token ends its session)
 *   POST /oauth/login                           consent form: the user enters their Vobiz Auth ID + Auth Token
 *   GET  /favicon.svg, /favicon.ico             the Vobiz logomark for the server-rendered pages
 *   GET|POST /answer                            default answer XML for make_call
 *   /jobs/fire, /r/:token/*                     reminder calls (when a reminders router is mounted)
 *   /upload/:token, /media/:token               audio library for reminder calls (when a media router is mounted)
 *   /c/:token/answer|hangup                     make_call say/play call scripts (when call scripts are set)
 *   GET  /.well-known/openai-apps-challenge     OpenAI Apps domain verification (VOBIZ_OPENAI_APPS_CHALLENGE)
 *   GET  /health
 *
 * Each user signs in with their own Vobiz credentials. They are sealed (AES-256-GCM) inside the
 * access/refresh tokens, so the server keeps no credential database and every request acts only on
 * the signed-in account. Rotating the Auth Token in the Vobiz console revokes every token at once.
 *
 * The only OAuth state kept is credential-free (src/oauth/grants.ts): one record per sign-in (refresh-token family:
 * rotation, reuse detection, revocation, 90-day cap) and the ids of used authorization codes, in Firestore when a GCP
 * project is configured and in memory otherwise. Clients are classified as verified, local or unverified
 * (src/oauth/clients.ts) and the consent page says which (src/oauth/consent.ts).
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createHash } from "node:crypto";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
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
import { createCallScriptBackend, type CallScriptBackend } from "./callscript/index.js";
import { createLogger, type Logger } from "./logger.js";
import { createServer, createSharedState } from "./server.js";
import { SERVER_VERSION } from "./version.js";
import { VOBIZ_FAVICON_SVG } from "./brand.js";
import { Sealer } from "./sealer.js";
import { classifyClient, redirectUriProblem, verifiedCimdName, type TrustedClient } from "./oauth/clients.js";
import { CidrMatcher, fetchCidrList } from "./oauth/cidr.js";
import { FAMILY_MAX_AGE_MS, FirestoreGrantStore, MemoryGrantStore, authIdHash, familyExpired, type GrantFamily, type GrantStore } from "./oauth/grants.js";
import { ERROR_CSP, consentCsp, consentPage, defaultChoice, errorPage, esc, type Choice, type Scope } from "./oauth/consent.js";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "./tz.js";
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
/** Access tokens never live longer than a day, whatever VOBIZ_ACCESS_TOKEN_TTL_SEC says. */
export const MAX_ACCESS_TTL = 86400;
const FAMILY_CACHE_MS = 30_000;
const newId = () => randomBytes(16).toString("hex");
const AUTH_ID_RE = /^(MA|SA)_[A-Za-z0-9]{4,40}$/;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Failed credential attempts allowed per sign-in transaction. */
const MAX_LOGIN_ATTEMPTS = 5;

/** The sealed sign-in transaction carried by the consent form; `n` counts failed credential attempts. */
interface Txn {
  cid: string;
  redirect: string;
  state: string | null;
  challenge: string;
  resource: string;
  n?: number;
  exp: number;
}

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

/** Refresh tokens carry their family and token id; access tokens carry the family (absent on tokens from before families). */
type RefreshGrant = Grant & { fam?: string; jti?: string };
type AccessGrant = Grant & { fam?: string };


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
  /**
   * DCR clients whose redirect URIs are all https on one of these hosts are shown as verified with this name
   * (default cfg.oauth.trustedClients, from VOBIZ_TRUSTED_CLIENTS). CIMD client_ids are accepted only from the fixed
   * VERIFIED_CIMD patterns (Claude, Claude Code, ChatGPT, Codex).
   */
  trustedClients?: TrustedClient[];
  /** Browser origins allowed to call /mcp (requests without Origin are always allowed). */
  allowedOrigins?: string[];
  /** Tool names the hosted connector never offers (default HOSTED_EXCLUDED_TOOLS). */
  excludeTools?: string[];
  /** Access / refresh token lifetimes in seconds (default 1 hour / 30 days). */
  accessTtlSec?: number;
  refreshTtlSec?: number;
  fetchImpl?: typeof fetch;
  /** POST /oauth/login attempts per client IP and per submitted Auth ID per 15 minutes (default cfg.oauth, 10 and 10). */
  loginLimits?: { perIp?: number; perAuthId?: number };
  /**
   * Shared egress ranges of hosted clients (default cfg.oauth.trustedEgressCidrs). Requests from them skip the SDK's
   * per-IP limits on /token and /register only.
   */
  trustedEgressCidrs?: string[];
  /** Refresh-token families and used codes (default: in memory; runHosted passes Firestore when configured). */
  grants?: GrantStore;
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
  /** make_call say/play: sealed call scripts served at /c/:token/answer|hangup. */
  callScripts?: CallScriptBackend;
}

export function createHostedApp(o: HostedOptions): express.Express {
  const { cfg, log } = o;
  const seal = new Sealer(o.secret);
  const base = o.baseUrl.replace(/\/+$/, "");
  const mcpUrl = new URL(`${base}/mcp`);
  const trusted = o.trustedClients ?? cfg.oauth.trustedClients;
  const loginLimits = { perIp: o.loginLimits?.perIp ?? cfg.oauth.loginMaxPerIp, perAuthId: o.loginLimits?.perAuthId ?? cfg.oauth.loginMaxPerAuthId };

  /** The cheapest authenticated Vobiz call: the HTTP status, or "network" when Vobiz could not be reached. */
  async function checkVobiz(authId: string, authToken: string): Promise<number | "network"> {
    try {
      const r = await fetchImpl(`${cfg.baseUrl}/api/v1/Account/${encodeURIComponent(authId)}/numbers?per_page=1`, {
        headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      await r.body?.cancel().catch(() => {});
      return r.status;
    } catch {
      return "network";
    }
  }
  const allowedOrigins = new Set(o.allowedOrigins ?? ["https://claude.ai", "https://claude.com", "https://chatgpt.com", "https://chat.openai.com"]);
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const ACCESS_TTL = Math.min(o.accessTtlSec ?? 3600, MAX_ACCESS_TTL);
  const REFRESH_TTL = o.refreshTtlSec ?? 30 * 24 * 3600;
  const excludeTools = o.excludeTools ?? HOSTED_EXCLUDED_TOOLS;
  const grants = o.grants ?? new MemoryGrantStore();
  const egress = new CidrMatcher(o.trustedEgressCidrs ?? cfg.oauth.trustedEgressCidrs);
  /** Claude's and ChatGPT's backends call /token and /register for all their users from a few shared IPs. */
  const skipForTrustedEgress = { skip: (req: Request) => egress.has(req.ip) };
  /** Family revocation as seen by verifyAccessToken, cached briefly so /mcp does not read the store on every call. */
  const familyCache = new Map<string, { at: number; usable: boolean }>();
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
    // Redirect URIs must be https or loopback http, with no fragment or wildcard; private-use schemes are refused.
    async registerClient(client) {
      if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.length || client.redirect_uris.length > 10) {
        throw new InvalidClientMetadataError("redirect_uris must list 1 to 10 URIs");
      }
      for (const uri of client.redirect_uris) {
        const problem = redirectUriProblem(uri);
        if (problem) throw new InvalidClientMetadataError(problem);
      }
      const clientName = typeof client.client_name === "string" ? client.client_name.slice(0, 256) : undefined;
      const keep: Partial<OAuthClientInformationFull> = {
        redirect_uris: client.redirect_uris,
        client_name: clientName,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: client.grant_types,
        response_types: client.response_types,
        client_secret: client.client_secret,
        client_secret_expires_at: client.client_secret_expires_at,
      };
      const clientId = seal.seal("client", { c: keep }, 10 * 365 * 24 * 3600);
      return { ...client, client_name: clientName, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) };
    },
  };

  async function fetchCimd(url: string): Promise<OAuthClientInformationFull | undefined> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    // Only the exact client_id URLs of the clients we verify (VERIFIED_CIMD); any other https client_id is refused.
    if (u.href !== url || !verifiedCimdName(url)) return undefined;
    const hit = cimdCache.get(url);
    if (hit && Date.now() - hit.at < 3600_000) return hit.client;
    try {
      const res = await fetchImpl(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      const text = await res.text();
      if (text.length > 64 * 1024) return undefined;
      const doc = JSON.parse(text) as Partial<OAuthClientInformationFull>;
      if (doc.client_id !== url || !Array.isArray(doc.redirect_uris)) return undefined;
      const redirectUris = doc.redirect_uris.filter((r) => !redirectUriProblem(r));
      if (!redirectUris.length) return undefined;
      const client = { ...doc, redirect_uris: redirectUris, client_id: url, token_endpoint_auth_method: "none" } as OAuthClientInformationFull;
      cimdCache.set(url, { at: Date.now(), client });
      return client;
    } catch {
      return undefined;
    }
  }

  /** Access + refresh token for one generation of a family; the refresh token never outlives the family. */
  const issue = (g: Grant, family: Pick<GrantFamily, "id" | "createdAt">, jti: string): OAuthTokens => {
    const left = Math.floor((family.createdAt + FAMILY_MAX_AGE_MS - Date.now()) / 1000);
    const grant: Grant = { authId: g.authId, authToken: g.authToken, clientId: g.clientId, resource: g.resource, ...profileOf(g) };
    return {
      access_token: seal.seal("access", { ...grant, fam: family.id }, Math.max(1, Math.min(ACCESS_TTL, left))),
      token_type: "Bearer",
      expires_in: Math.max(1, Math.min(ACCESS_TTL, left)),
      refresh_token: seal.seal("refresh", { ...grant, fam: family.id, jti }, Math.max(1, Math.min(REFRESH_TTL, left))),
      scope: SCOPE,
    };
  };
  /** Legacy refresh tokens (issued before families) are migrated into a family keyed by a hash of the token, once. */
  const legacyFamilyId = (token: string) => `l${createHash("sha256").update(token).digest("hex").slice(0, 40)}`;
  const familyUsable = async (fam: string): Promise<boolean> => {
    const hit = familyCache.get(fam);
    if (hit && Date.now() - hit.at < FAMILY_CACHE_MS) return hit.usable;
    let usable = true;
    try {
      const f = await grants.get(fam);
      // A family missing from the store (memory store after a restart) does not block a still-valid access token.
      usable = !f || (!f.revokedAt && !familyExpired(f));
    } catch {
      log.info("oauth: grant store unavailable while checking an access token; allowing it");
      return true;
    }
    if (familyCache.size > 10_000) familyCache.clear();
    familyCache.set(fam, { at: Date.now(), usable });
    return usable;
  };
  const revokeFamily = async (fam: string, seed?: GrantFamily) => {
    await grants.revoke(fam, Date.now(), seed);
    familyCache.set(fam, { at: Date.now(), usable: false });
  };

  /**
   * RFC 8707: a `resource` must name this MCP server (the /mcp URL or its origin; scheme and host compare
   * case-insensitively). A missing resource is tolerated (some clients omit it) and means this server.
   */
  const resourceOk = (v: string | undefined): boolean => {
    if (v === undefined) return true;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return false;
    }
    return u.origin === mcpUrl.origin && !u.search && !u.hash && !u.username && ["/", "/mcp", "/mcp/"].includes(u.pathname);
  };

  const sendError = (res: Response, status: number, title: string, message: string) =>
    res.status(status).set({ "Content-Security-Policy": ERROR_CSP, "X-Frame-Options": "DENY", "Cache-Control": "no-store" }).type("html").send(errorPage({ title, message, links: cfg.links }));

  /** The consent page: framing denied, and Referrer-Policy same-origin so the form post carries our Origin (no-referrer would send "null"). */
  const sendConsent = (res: Response, view: Parameters<typeof consentPage>[0]) =>
    res
      .status(200)
      .set({ "Content-Security-Policy": consentCsp(view.redirectUri), "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "Cache-Control": "no-store" })
      .type("html")
      .send(consentPage(view));

  const provider: OAuthServerProvider = {
    clientsStore,
    async authorize(client, params: AuthorizationParams, res) {
      const txn = seal.seal(
        "txn",
        // The resource was checked by validateAuthorize; tokens are always bound to the canonical /mcp URL.
        { cid: client.client_id, redirect: params.redirectUri, state: params.state ?? null, challenge: params.codeChallenge, resource: mcpUrl.href },
        TXN_TTL,
      );
      sendConsent(res, { txn, client: classifyClient(client, trusted), redirectUri: params.redirectUri, links: cfg.links });
    },
    async challengeForAuthorizationCode(client, code) {
      const c = seal.open<{ cid: string; challenge: string }>("code", code);
      if (!c || c.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
      return c.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      if (resource && !resourceOk(resource.href)) throw new InvalidTargetError("resource must be this MCP server's URL");
      const c = seal.open<Grant & { cid: string; redirect: string; jti: string }>("code", code);
      if (!c || c.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
      if (redirectUri && redirectUri !== c.redirect) throw new InvalidGrantError("redirect_uri does not match the authorization request");
      // Single use across every replica: the code's jti is recorded in the grant store.
      if (!(await grants.consumeCode(c.jti, c.exp * 1000))) throw new InvalidGrantError("Authorization code was already used");
      const family: GrantFamily = { id: newId(), authIdHash: authIdHash(c.authId), clientId: client.client_id, currentJti: newId(), prevJti: null, rotatedAt: null, createdAt: Date.now(), revokedAt: null };
      if (!(await grants.create(family))) throw new ServerError("Could not start a session; try again");
      return issue({ ...c, clientId: client.client_id }, family, family.currentJti);
    },
    async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
      if (resource && !resourceOk(resource.href)) throw new InvalidTargetError("resource must be this MCP server's URL");
      const g = seal.open<RefreshGrant>("refresh", refreshToken);
      if (!g || g.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
      const now = Date.now();
      let fam = g.fam;
      let jti = g.jti;
      if (!fam || !jti) {
        fam = legacyFamilyId(refreshToken);
        jti = "legacy";
        await grants.create({ id: fam, authIdHash: authIdHash(g.authId), clientId: g.clientId, currentJti: jti, prevJti: null, rotatedAt: null, createdAt: now, revokedAt: null });
      }
      const current = await grants.get(fam);
      if (!current || current.revokedAt) throw new InvalidGrantError("This session has ended; connect again");
      if (familyExpired(current, now)) {
        await revokeFamily(fam);
        throw new InvalidGrantError("This session is older than 90 days; connect again");
      }
      const replay = jti !== current.currentJti && !(jti === current.prevJti && current.rotatedAt && now - current.rotatedAt <= 60_000);
      if (!replay) {
        // Re-check the sealed credentials with Vobiz: a rotated or revoked Auth Token ends the session here.
        const status = await checkVobiz(g.authId, g.authToken);
        const transient = status === "network" || status === 429 || (typeof status === "number" && status >= 500);
        if (!transient && (status as number) >= 200 && (status as number) <= 299) {
          if (current.unverifiedAt) await grants.setUnverified(fam, null);
        } else if (transient) {
          if (current.unverifiedAt) throw new ServerError("Vobiz could not be reached to re-check this session; try again shortly");
          log.info(`oauth: refresh allowed once without a credential re-check (Vobiz ${status === "network" ? "unreachable" : `status ${status}`})`);
          await grants.setUnverified(fam, now);
        } else {
          await revokeFamily(fam);
          throw new InvalidGrantError("Vobiz no longer accepts this account's credentials; connect again");
        }
      }
      const out = await grants.rotate(fam, jti, newId(), now);
      if (out.kind === "rotated" || out.kind === "grace") return issue(g, out.family, out.family.currentJti);
      if (out.kind === "reuse") {
        familyCache.set(fam, { at: Date.now(), usable: false });
        log.info("oauth: refresh token reuse detected; session revoked");
      }
      throw new InvalidGrantError("Invalid or expired refresh token");
    },
    async verifyAccessToken(token): Promise<AuthInfo> {
      const g = seal.open<AccessGrant>("access", token);
      if (!g) throw new InvalidTokenError("Invalid or expired access token");
      if (g.fam && !(await familyUsable(g.fam))) throw new InvalidTokenError("This session was revoked");
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
    // RFC 7009: revoking either token ends its whole family. Unknown, expired or foreign tokens succeed silently.
    async revokeToken(client, request) {
      const order = request.token_type_hint === "access_token" ? (["access", "refresh"] as const) : (["refresh", "access"] as const);
      for (const kind of order) {
        const g = seal.open<RefreshGrant>(kind, request.token);
        if (!g) continue;
        if (g.clientId !== client.client_id) return;
        if (g.fam) {
          await revokeFamily(g.fam);
        } else if (kind === "refresh") {
          const id = legacyFamilyId(request.token);
          await revokeFamily(id, { id, authIdHash: authIdHash(g.authId), clientId: g.clientId, currentJti: "legacy", prevJti: null, rotatedAt: null, createdAt: Date.now(), revokedAt: null });
        }
        log.info("oauth: session revoked by the client");
        return;
      }
    },
  };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  // Security headers on every response. Pages that need another Referrer-Policy (the consent page) override it.
  app.use((_req, res, next) => {
    res.set({
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, version: SERVER_VERSION }));
  app.get("/favicon.svg", (_req, res) => res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(VOBIZ_FAVICON_SVG));
  app.get("/favicon.ico", (_req, res) => res.redirect(301, "/favicon.svg"));
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
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // RFC 9207: every authorization response carries iss (ChatGPT checks it).
    authorization_response_iss_parameter_supported: true,
  };
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(asMeta));
  // Protected resource metadata (RFC 9728), served here rather than by the SDK so it can say tokens go in the header only.
  const prm = {
    resource: mcpUrl.href,
    authorization_servers: [asMeta.issuer],
    scopes_supported: [SCOPE],
    resource_name: "Vobiz",
    resource_documentation: new URL(cfg.links.docs).href,
    bearer_methods_supported: ["header"],
  };
  app.get(new URL(getOAuthProtectedResourceMetadataUrl(mcpUrl)).pathname, (_req, res) => res.set("Access-Control-Allow-Origin", "*").json(prm));
  // OpenAI Apps domain verification: the token from the OpenAI platform, served verbatim.
  app.get("/.well-known/openai-apps-challenge", (_req, res) =>
    cfg.openaiAppsChallenge ? res.type("text/plain").set("Cache-Control", "no-store").send(cfg.openaiAppsChallenge) : res.status(404).json({ error: "not_found" }),
  );
  /**
   * Runs before the SDK's /authorize handler. Once client_id and redirect_uri check out (otherwise the SDK answers
   * with its own 400), the remaining parameters are validated here so that errors carry `iss` (RFC 9207) and
   * `state`, and so that only verified clients ever get an error redirect: local and unverified clients get a
   * plain error page instead, which stops /authorize being used as an open redirector.
   */
  const validateAuthorize: express.RequestHandler = async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "POST") return next();
    const p = ((req.method === "POST" ? req.body : req.query) ?? {}) as Record<string, unknown>;
    /** The parameter as a string, undefined when absent, null when repeated or not a string. */
    const str = (k: string): string | null | undefined => (p[k] === undefined ? undefined : typeof p[k] === "string" ? (p[k] as string) : null);
    const clientId = str("client_id");
    if (!clientId) return next();
    let client: OAuthClientInformationFull | undefined;
    try {
      client = await clientsStore.getClient(clientId);
    } catch {
      return next();
    }
    if (!client) return next();
    let redirect = str("redirect_uri");
    if (redirect === null) return next();
    if (redirect === undefined) {
      if (client.redirect_uris.length !== 1) return next();
      redirect = client.redirect_uris[0]!;
    } else if (!client.redirect_uris.some((r) => redirectUriMatches(redirect as string, r))) {
      return next();
    }
    if (redirectUriProblem(redirect)) return sendError(res, 400, "This app cannot connect", "This app's redirect URL is not allowed. Redirect URLs must use https, or http on localhost.");
    const cls = classifyClient(client, trusted);
    const state = str("state");
    const fail = (error: string, description: string) => {
      if (cls.kind !== "verified") return sendError(res, 400, "This sign-in link is not valid", `${description} (${error}).`);
      const to = new URL(redirect as string);
      to.searchParams.set("error", error);
      to.searchParams.set("error_description", description);
      if (typeof state === "string" && state) to.searchParams.set("state", state);
      to.searchParams.set("iss", asMeta.issuer);
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, to.href);
    };
    const responseType = str("response_type");
    if (responseType === undefined || responseType === null) return fail("invalid_request", "response_type is required");
    if (responseType !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    if (state === null) return fail("invalid_request", "state must be a single value");
    const challenge = str("code_challenge");
    if (!challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) return fail("invalid_request", "A PKCE code_challenge is required");
    if (str("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
    if (str("scope") === null) return fail("invalid_request", "scope must be a single value");
    const resource = str("resource");
    if (resource === null || !resourceOk(resource)) return fail("invalid_target", "resource must be this MCP server's URL");
    next();
  };
  app.use("/authorize", express.urlencoded({ extended: false, limit: "8kb" }), validateAuthorize);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(base),
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "Vobiz",
      serviceDocumentationUrl: new URL(cfg.links.docs),
      // /authorize keeps the SDK's per-IP limit: it is the user's own browser.
      tokenOptions: { rateLimit: skipForTrustedEgress },
      clientRegistrationOptions: { rateLimit: skipForTrustedEgress },
    }),
  );

  // Consent form submission: verify the credentials with Vobiz, then redirect back with a code.
  // Guarded by a same-origin check, two rate limiters (per client IP and per submitted Auth ID) and an attempt
  // counter sealed into the transaction.
  const limitHandler: express.RequestHandler = (_req, res) =>
    sendError(res, 429, "Too many sign-in attempts", "Too many sign-in attempts. Wait 15 minutes, then go back to your app and connect again.");
  const loginByIp = rateLimit({ windowMs: LOGIN_WINDOW_MS, limit: loginLimits.perIp, standardHeaders: "draft-7", legacyHeaders: false, handler: limitHandler });
  const loginByAuthId = rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: loginLimits.perAuthId,
    standardHeaders: false,
    legacyHeaders: false,
    skip: (req) => !String(req.body?.auth_id ?? "").trim(),
    keyGenerator: (req) => `aid:${String(req.body?.auth_id ?? "").trim().toUpperCase().slice(0, 64)}`,
    handler: limitHandler,
  });
  const baseOrigin = new URL(base).origin;
  /** Only our own consent page may post the form: Sec-Fetch-Site same-origin (or absent on old browsers), Origin ours if sent. */
  const sameOrigin: express.RequestHandler = (req, res, next) => {
    const site = req.get("sec-fetch-site");
    const origin = req.get("origin");
    if ((site && site !== "same-origin") || (origin !== undefined && origin !== baseOrigin)) {
      return sendError(res, 403, "Sign-in blocked", "This sign-in form was not submitted from the Vobiz sign-in page.");
    }
    next();
  };
  app.post("/oauth/login", express.urlencoded({ extended: false, limit: "8kb" }), sameOrigin, loginByIp, loginByAuthId, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const t = seal.open<Txn>("txn", String(req.body?.txn ?? ""));
    if (!t) return sendError(res, 400, "This sign-in link has expired", "This sign-in link has expired.");
    const client = await clientsStore.getClient(t.cid);
    if (!client) return sendError(res, 400, "Unknown app", "This app is not registered any more.");
    const cls = classifyClient(client, trusted);
    const attempts = t.n ?? 0;
    if (attempts >= MAX_LOGIN_ATTEMPTS) return sendError(res, 429, "Too many sign-in attempts", "Too many failed attempts for this sign-in link.");
    const authId = String(req.body?.auth_id ?? "").trim();
    const authToken = String(req.body?.auth_token ?? "").trim();
    const field = (k: string) => String(req.body?.[k] ?? "").trim().slice(0, 64);
    const rawScope = field("scope");
    // Older form: a read_only checkbox and no scope radio. Without either, the page's own default for this client.
    const scope: Scope = SCOPES.includes(rawScope as Scope) ? (rawScope as Scope) : req.body?.read_only === "1" ? "read" : defaultChoice(cls).scope;
    const values: Choice = { scope, callMeOn: field("call_me_on"), callFrom: field("call_from"), tz: field("timezone") || DEFAULT_TIME_ZONE };
    const again = (error: string, txn = String(req.body.txn)) => sendConsent(res, { txn, client: cls, redirectUri: t.redirect, error, links: cfg.links, values });
    /** A failed credential attempt: count it in a re-sealed transaction (same expiry). */
    const failed = (error: string) => {
      const left = t.exp - Math.floor(Date.now() / 1000);
      if (attempts + 1 >= MAX_LOGIN_ATTEMPTS || left <= 0) return sendError(res, 429, "Too many sign-in attempts", "Too many failed attempts for this sign-in link.");
      const { exp: _exp, ...rest } = t;
      return again(error, seal.seal("txn", { ...rest, n: attempts + 1 }, left));
    };
    if (!AUTH_ID_RE.test(authId) || authToken.length < 8 || authToken.length > 256) return failed("Enter a valid Auth ID (MA_… or SA_…) and Auth Token.");
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
    // Fail closed: only a 2xx from Vobiz signs the user in.
    const status = await checkVobiz(authId, authToken);
    if (status === "network") return again("Vobiz could not be reached to check these credentials. Try again in a moment.");
    if (status === 401 || status === 403 || status === 404) return failed("Vobiz did not accept this Auth ID and Auth Token. Check them on the console overview page.");
    if (status === 429) return again("Vobiz is receiving too many requests right now. Wait a minute and try again.");
    if (status < 200 || status > 299) return again(`Vobiz could not check these credentials right now (status ${status}). Try again in a moment.`);
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
      ...(o.callScripts ? { callScripts: o.callScripts } : {}),
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
  // make_call say/play: the call's VobizXML (/c/:token/answer) and hangup acknowledgement.
  if (o.callScripts) app.use(o.callScripts.router);

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
  if (process.env.VOBIZ_CIMD_HOSTS?.trim()) {
    log.info("oauth: VOBIZ_CIMD_HOSTS is no longer used (CIMD client_ids are matched exactly against the Claude, Claude Code, ChatGPT and Codex URLs); remove it");
  }
  if (cfg.oauth.trustedClients.length) log.info(`oauth: ${cfg.oauth.trustedClients.length} trusted client host(s) from VOBIZ_TRUSTED_CLIENTS`);
  const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  const ttl = (name: string, fallback: number, max = 365 * 24 * 3600) => {
    const v = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(v) || v < 60 || v > max) {
      process.stderr.write(`[vobiz-mcp] ${name} must be a whole number of seconds between 60 and ${max}\n`);
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
  const callScripts = createCallScriptBackend({
    baseUrl,
    sealer: new Sealer(secret),
    media,
    log,
    signatureMode: reminderSignatureMode(process.env.VOBIZ_WEBHOOK_SIGNATURE, cfg.webhookSignature),
  });
  // Shared client egress ranges that skip the per-IP limits on /token and /register: configured list plus an optional
  // published list fetched now (e.g. OpenAI's https://openai.com/chatgpt-connectors.json).
  let trustedEgressCidrs = cfg.oauth.trustedEgressCidrs;
  if (cfg.oauth.trustedEgressUrl) {
    const got = await fetchCidrList(cfg.oauth.trustedEgressUrl);
    if (got.error) log.info(`oauth: WARNING could not load VOBIZ_TRUSTED_EGRESS_URL (${got.error}); using the ${trustedEgressCidrs.length} configured ranges only`);
    else trustedEgressCidrs = [...new Set([...trustedEgressCidrs, ...got.cidrs])];
  }
  log.info(`oauth: ${trustedEgressCidrs.length} trusted client egress range(s) skip the per-IP limits on /token and /register`);
  // Refresh-token families and used codes: Firestore (shared by every replica) when a GCP project is configured.
  const grants: GrantStore = cfg.reminders.gcpProject
    ? new FirestoreGrantStore({ projectId: cfg.reminders.gcpProject, databaseId: cfg.reminders.firestoreDatabase })
    : new MemoryGrantStore();
  log.info(
    grants.kind === "firestore"
      ? `oauth: grant store Firestore (${cfg.reminders.firestoreDatabase}, collections oauth_grants and oauth_codes)`
      : "oauth: grant store in memory (single replica only; every session ends on restart)",
  );
  const app = createHostedApp({
    cfg,
    log,
    baseUrl,
    secret,
    grants,
    trustedEgressCidrs,
    reminders,
    remindersRouter,
    media,
    mediaRouter,
    mediaAvailable,
    callScripts,
    allowedOrigins: list(process.env.VOBIZ_ALLOWED_ORIGINS),
    excludeTools: process.env.VOBIZ_HOSTED_EXCLUDED_TOOLS === undefined ? undefined : (list(process.env.VOBIZ_HOSTED_EXCLUDED_TOOLS) ?? []),
    accessTtlSec: ttl("VOBIZ_ACCESS_TOKEN_TTL_SEC", 3600, MAX_ACCESS_TTL),
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
