/**
 * Who is asking to connect. Every client is classified at /authorize time:
 *
 *   verified    the display name is fixed by Vobiz, never taken from the client:
 *               - a Client ID Metadata Document (CIMD) URL from VERIFIED_CIMD (Claude, Claude Code, ChatGPT, Codex);
 *               - a dynamically registered (DCR) client whose redirect URIs are all Claude's or all ChatGPT's callback;
 *               - a DCR client whose redirect URIs are all https on a host in VOBIZ_TRUSTED_CLIENTS (operator allowlist).
 *   local       every redirect URI is loopback (localhost, 127.0.0.1, [::1], any port): an app on the user's computer.
 *   unverified  anything else. The consent page shows a warning banner with the full redirect URI.
 *
 * Self-asserted client names are shown only for local/unverified clients, sanitised, and never when they borrow a
 * brand word (Claude, Anthropic, ChatGPT, OpenAI, Codex, Vobiz).
 */

export type ClientKind = "verified" | "local" | "unverified";

export interface ClientClass {
  kind: ClientKind;
  /** Safe to render (still HTML-escape it, inside <bdi>). */
  name: string;
  verifiedBy?: "cimd" | "redirect" | "operator";
}

export interface TrustedClient {
  /** Lowercase redirect hostname. */
  host: string;
  name: string;
}

export const GENERIC_CLIENT_NAME = "An MCP client";
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const ID = "[A-Za-z0-9_-]{1,128}";
/** Exact CIMD client_id patterns we accept and the name we show for each. Codex comes before ChatGPT on purpose. */
export const VERIFIED_CIMD: { re: RegExp; name: string }[] = [
  { re: /^https:\/\/claude\.ai\/oauth\/mcp-oauth-client-metadata$/, name: "Claude" },
  { re: /^https:\/\/claude\.ai\/oauth\/claude-code-client-metadata$/, name: "Claude Code" },
  { re: new RegExp(`^https://chatgpt\\.com/oauth/codex/(?:${ID}/)?client\\.json$`), name: "Codex" },
  { re: new RegExp(`^https://chatgpt\\.com/oauth/(?:(?!codex/)${ID}/)?client\\.json$`), name: "ChatGPT" },
];

const CHATGPT_CALLBACK_RE = new RegExp(`^https://chatgpt\\.com/(?:connector_platform_oauth_redirect|connector/oauth/${ID})$`);

/** The fixed display name for a verified CIMD client_id, or undefined when it is not one of ours. */
export function verifiedCimdName(clientId: string): string | undefined {
  return VERIFIED_CIMD.find((v) => v.re.test(clientId))?.name;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

export function isLoopbackRedirect(uri: string): boolean {
  const u = parse(uri);
  return !!u && (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.has(u.hostname);
}

/**
 * Why a redirect URI is not acceptable, or undefined when it is. MCP: redirect URIs MUST be https or loopback.
 * Private-use schemes (myapp://) are refused: no supported client uses them.
 */
export function redirectUriProblem(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri || uri.length > 2048) return "redirect_uri must be a URL of at most 2048 characters";
  if (uri.includes("*")) return "redirect_uri must not contain wildcards";
  if (uri.includes("#")) return "redirect_uri must not contain a fragment";
  const u = parse(uri);
  if (!u) return "redirect_uri must be a valid URL";
  if (u.username || u.password) return "redirect_uri must not contain credentials";
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname) ? undefined : "redirect_uri must use https (http is allowed only for localhost, 127.0.0.1 and [::1])";
  return "redirect_uri must use https or a loopback http address (custom schemes are not supported; email support@vobiz.ai to request one)";
}

// Cc/Cf cover the bidi controls; they are listed explicitly too so the intent is plain. Line/paragraph separators go as well.
const STRIP_RE = /[\p{Cc}\p{Cf}\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/gu;
const BRAND_RE = /claude|anthropic|chatgpt|openai|codex|vobiz/i;

/** Trim, strip control/format/bidi characters, collapse whitespace, cap at `max` code points. */
export function cleanText(raw: unknown, max = 64): string {
  const s = String(raw ?? "").replace(STRIP_RE, "").replace(/\s+/g, " ").trim();
  return [...s].slice(0, max).join("").trim();
}

/** A self-asserted client name made safe to display; brand words and empty names become GENERIC_CLIENT_NAME. */
export function sanitizeClientName(raw: unknown): string {
  const s = cleanText(raw);
  if (!s) return GENERIC_CLIENT_NAME;
  // Compare without accents, spaces or punctuation so "Cláude", "Open AI" and "C.h.a.t.G.P.T" are caught too.
  const probe = s.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
  return BRAND_RE.test(probe) || BRAND_RE.test(s) ? GENERIC_CLIENT_NAME : s;
}

/**
 * Parses VOBIZ_TRUSTED_CLIENTS: comma-separated `redirect-host=Display Name` entries, e.g.
 * `app.example.com=Example App,tools.acme.io=Acme Tools`. Throws on a malformed entry.
 */
export function parseTrustedClients(v: string | undefined): TrustedClient[] {
  if (!v?.trim()) return [];
  const out: TrustedClient[] = [];
  for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const host = (eq > 0 ? entry.slice(0, eq) : "").trim().toLowerCase();
    const name = cleanText(eq > 0 ? entry.slice(eq + 1) : "");
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host) || !name) {
      throw new Error("VOBIZ_TRUSTED_CLIENTS entries must look like app.example.com=Example App");
    }
    if (host === "claude.ai" || host === "chatgpt.com") throw new Error("VOBIZ_TRUSTED_CLIENTS must not list claude.ai or chatgpt.com (they are verified already)");
    out.push({ host, name });
  }
  return out;
}

interface ClientLike {
  client_id: string;
  redirect_uris?: string[];
  client_name?: string;
}

export function classifyClient(client: ClientLike, trusted: TrustedClient[] = []): ClientClass {
  const cimd = verifiedCimdName(client.client_id);
  if (cimd) return { kind: "verified", name: cimd, verifiedBy: "cimd" };
  const uris = (client.redirect_uris ?? []).map(String);
  if (uris.length) {
    if (uris.every((u) => u === CLAUDE_CALLBACK)) return { kind: "verified", name: "Claude", verifiedBy: "redirect" };
    if (uris.every((u) => CHATGPT_CALLBACK_RE.test(u))) return { kind: "verified", name: "ChatGPT", verifiedBy: "redirect" };
    const parsed = uris.map(parse);
    if (parsed.every((u) => u?.protocol === "https:" && !u.username && !u.password)) {
      const hosts = new Set(parsed.map((u) => u!.hostname.toLowerCase()));
      const t = hosts.size === 1 ? trusted.find((x) => hosts.has(x.host)) : undefined;
      if (t) return { kind: "verified", name: t.name, verifiedBy: "operator" };
    }
    if (uris.every(isLoopbackRedirect)) return { kind: "local", name: sanitizeClientName(client.client_name) };
  }
  return { kind: "unverified", name: sanitizeClientName(client.client_name) };
}
