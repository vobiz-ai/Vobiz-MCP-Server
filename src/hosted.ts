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
 *   GET  /health
 *
 * Each user signs in with their own Vobiz credentials. They are sealed (AES-256-GCM) inside the
 * access/refresh tokens, so the server keeps no credential database and every request acts only on
 * the signed-in account. Rotating the Auth Token in the Vobiz console revokes every token at once.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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
import type { SharedState } from "./context.js";
import { createLogger, type Logger } from "./logger.js";
import { createServer, createSharedState } from "./server.js";
import { SERVER_VERSION } from "./version.js";

/** Default exclusions (override with VOBIZ_HOSTED_EXCLUDED_TOOLS): tools that need this process to host callbacks for one account, or that buy things. */
export const HOSTED_EXCLUDED_TOOLS = ["buy_phone_number", "gather_dtmf", "get_gather_result", "list_webhook_events", "hold_call", "unhold_call"];

const CODE_TTL = 300;
const TXN_TTL = 900;
const SCOPE = "vobiz";
const AUTH_ID_RE = /^(MA|SA)_[A-Za-z0-9]{4,40}$/;

type Kind = "client" | "txn" | "code" | "access" | "refresh";
interface Grant {
  authId: string;
  authToken: string;
  readOnly: boolean;
  clientId: string;
  resource: string;
}

/** Authenticated encryption for every token this server hands out. */
export class Sealer {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash("sha256").update(`vobiz-mcp-hosted:${secret}`).digest();
  }
  seal(kind: Kind, payload: Record<string, unknown>, ttlSec: number): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(kind));
    const body = Buffer.concat([c.update(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })), c.final()]);
    return `vbz${kind[0]}_` + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
  }
  open<T = Record<string, unknown>>(kind: Kind, token: string): (T & { exp: number }) | undefined {
    const prefix = `vbz${kind[0]}_`;
    if (typeof token !== "string" || !token.startsWith(prefix) || token.length > 8192) return undefined;
    try {
      const raw = Buffer.from(token.slice(prefix.length), "base64url");
      const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(kind));
      d.setAuthTag(raw.subarray(12, 28));
      const v = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
      return v.exp > Math.floor(Date.now() / 1000) ? v : undefined;
    } catch {
      return undefined;
    }
  }
}

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
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function consentPage(o: { txn: string; clientName: string; redirectHost: string; error?: string; links: Config["links"] }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your Vobiz account</title><style>
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--fg:#111;--muted:#5b5b66;--line:#dcdce3;--accent:#4f46e5;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f12;--card:#18181d;--fg:#f2f2f5;--muted:#a0a0ad;--line:#2c2c35;--accent:#8b85ff;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;max-width:440px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 14px;color:var(--muted)}label{display:block;font-weight:600;margin:14px 0 6px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font:inherit}
.row{display:flex;gap:8px;align-items:flex-start;margin-top:14px}.row label{margin:0;font-weight:400}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:600 15px system-ui;cursor:pointer}
.err{color:var(--err);margin-top:10px}.fine{font-size:13px;margin-top:16px}a{color:var(--accent)}
</style></head><body><main>
<h1>Connect your Vobiz account</h1>
<p><strong>${esc(o.clientName)}</strong> (${esc(o.redirectHost)}) wants to use your Vobiz account through the Vobiz MCP server.</p>
<form method="post" action="/oauth/login" autocomplete="off">
<input type="hidden" name="txn" value="${esc(o.txn)}">
<label for="auth_id">Auth ID</label><input id="auth_id" name="auth_id" type="text" placeholder="MA_XXXXXXXX" required pattern="(MA|SA)_[A-Za-z0-9]+">
<label for="auth_token">Auth Token</label><input id="auth_token" name="auth_token" type="password" required>
<div class="row"><input id="read_only" name="read_only" type="checkbox" value="1"><label for="read_only">Read-only access (no calls, messages or account changes)</label></div>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ""}
<button type="submit">Allow access</button>
</form>
<p class="fine">Find your Auth ID and Auth Token on the <a href="${esc(o.links.console)}" target="_blank" rel="noopener">Vobiz console</a> overview page. They are encrypted inside the access token issued to this app and are not stored by the server. Rotate your Auth Token in the console at any time to revoke access. <a href="${esc(o.links.privacy)}" target="_blank" rel="noopener">Privacy policy</a>.</p>
</main></body></html>`;
}

export function createHostedApp(o: HostedOptions): express.Express {
  const { cfg, log } = o;
  const seal = new Sealer(o.secret);
  const base = o.baseUrl.replace(/\/+$/, "");
  const mcpUrl = new URL(`${base}/mcp`);
  const cimdHosts = new Set((o.cimdHosts ?? ["claude.ai"]).map((h) => h.toLowerCase()));
  const allowedOrigins = new Set(o.allowedOrigins ?? ["https://claude.ai", "https://claude.com"]);
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
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
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
      return issue({ authId: c.authId, authToken: c.authToken, readOnly: c.readOnly, clientId: client.client_id, resource: c.resource });
    },
    async exchangeRefreshToken(client, refreshToken) {
      const g = seal.open<Grant>("refresh", refreshToken);
      if (!g || g.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
      return issue({ authId: g.authId, authToken: g.authToken, readOnly: g.readOnly, clientId: g.clientId, resource: g.resource });
    },
    async verifyAccessToken(token): Promise<AuthInfo> {
      const g = seal.open<Grant>("access", token);
      if (!g) throw new InvalidTokenError("Invalid or expired access token");
      return { token, clientId: g.clientId, scopes: [SCOPE], expiresAt: g.exp, resource: new URL(g.resource), extra: { authId: g.authId, authToken: g.authToken, readOnly: g.readOnly } };
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
  };
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(asMeta));
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
    const again = (error: string) =>
      res
        .status(200)
        .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        .type("html")
        .send(consentPage({ txn: String(req.body.txn), clientName: client.client_name ?? "An MCP client", redirectHost: new URL(t.redirect).host, error, links: cfg.links }));
    if (!AUTH_ID_RE.test(authId) || authToken.length < 8 || authToken.length > 256) return again("Enter a valid Auth ID (MA_… or SA_…) and Auth Token.");
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
    log.info(`oauth: account connected (status ${status})`);
    const code = seal.seal(
      "code",
      { cid: t.cid, redirect: t.redirect, challenge: t.challenge, resource: t.resource, authId, authToken, readOnly: req.body?.read_only === "1", jti: randomBytes(12).toString("hex") },
      CODE_TTL,
    );
    const to = new URL(t.redirect);
    to.searchParams.set("code", code);
    if (t.state) to.searchParams.set("state", t.state);
    res.redirect(302, to.href);
  });

  // MCP endpoint.
  const originOk = (origin: string | undefined) => !origin || allowedOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl });
  app.all("/mcp", (req, res, next) => (originOk(req.headers.origin) ? next() : res.status(403).json({ error: "origin_not_allowed" })), bearer, express.json({ limit: "1mb" }), async (req, res) => {
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    const extra = req.auth?.extra as { authId: string; authToken: string; readOnly: boolean };
    const server = createServer(accountCfg(extra), log, o.fetchImpl, {
      readOnly: extra.readOnly,
      shared: tenantState(extra.authId),
      excludeTools,
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

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}

async function main(): Promise<void> {
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
  const app = createHostedApp({
    cfg,
    log,
    baseUrl,
    secret,
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
  main().catch((err) => {
    process.stderr.write(`[vobiz-mcp] fatal error during startup: ${err instanceof Error ? err.message : "unknown"}\n`);
    process.exit(1);
  });
}
