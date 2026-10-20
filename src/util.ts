import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, isIPv6 } from "node:net";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { VobizError, hintFor, isRetryable } from "./errors.js";

// ── Input schemas ───────────────────────────────────────────────

/** E.164 with or without the leading +. The backend strips formatting; we require clean digits. */
export const phoneNumber = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{6,14}$/, "must be an E.164 phone number such as +919876543210 (digits only, optional leading +)");

/** Call / request UUIDs. Restricting the charset also prevents path injection. */
export const callId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "must be a Vobiz call UUID (letters, digits, - and _ only)");

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD format")
  .refine((s) => !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s), {
    message: "is not a real calendar date",
  });

/** Client-chosen key that makes a costly operation safe to repeat. */
export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{8,128}$/, "must be 8-128 characters of letters, digits, _ . : -")
  .describe("Unique key for this intended operation (e.g. a UUID). Repeating it replays the first result instead of acting again.");

/**
 * Call-control URLs (answer, hangup, transfer, redirect, gather action) decide what happens on a live
 * call, so they must point at an approved host (VOBIZ_PUBLIC_URL, VOBIZ_DEFAULT_ANSWER_URL or
 * VOBIZ_ALLOWED_URL_HOSTS). This blocks a prompt-injected model from routing calls to an attacker.
 */
export function assertAllowedUrl(cfg: Config, url: string, field: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VobizError("invalid_input", `${field} is not a valid URL.`);
  }
  if (u.protocol !== "https:") throw new VobizError("invalid_input", `${field} must use https.`);
  if (u.username || u.password) throw new VobizError("invalid_input", `${field} must not contain credentials.`);
  if (cfg.allowAnyUrlHost) {
    if (isPrivateHostLiteral(u.hostname)) throw new VobizError("not_allowed", `${field} must be a public internet address that Vobiz can reach.`);
    return;
  }
  if (!cfg.allowedUrlHosts.includes(u.host.toLowerCase())) {
    throw new VobizError(
      "not_allowed",
      `${field} host ${u.host} is not approved. Allowed hosts: ${cfg.allowedUrlHosts.join(", ") || "(none configured)"}. An administrator can add it to VOBIZ_ALLOWED_URL_HOSTS.`,
    );
  }
}

// ── Host and IP address checks ──────────────────────────────────

/** IPv4 ranges that are never a public internet host (RFC 6890 special-purpose registry and friends). */
const V4_DENY: [number, number][] = (
  [
    ["0.0.0.0", 8], // "this" network
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // carrier-grade NAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local (cloud metadata lives here)
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // TEST-NET-1 (documentation)
    ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // TEST-NET-2
    ["203.0.113.0", 24], // TEST-NET-3
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved, includes 255.255.255.255
  ] as const
).map(([a, bits]) => [v4ToInt(a)!, bits]);

/** Dotted-quad IPv4 to an unsigned 32-bit integer, or undefined when it is not one. */
function v4ToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return undefined;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function v4Public(n: number): boolean {
  return !inV4(n, V4_DENY);
}

/** IPv6 text (no brackets, no zone) to 8 hextets, or undefined when it is not one. */
function v6ToHextets(ip: string): number[] | undefined {
  if (!isIPv6(ip)) return undefined;
  let s = ip.toLowerCase();
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    if (n === undefined) return undefined;
    s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill("0");
  const parts = [...h, ...fill, ...t].map((x) => parseInt(x, 16));
  return parts.length === 8 && parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? parts : undefined;
}

/** Documentation ranges (RFC 5737, RFC 3849): unroutable, but used as examples by SIP tooling and tests. */
const V4_DOC: [number, number][] = [["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24]].map(([a, b]) => [v4ToInt(a as string)!, b as number]);
const inV4 = (n: number, list: [number, number][]) => list.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
const isDocumentationIp = (ip: string) => {
  const n = v4ToInt(ip);
  if (n !== undefined) return inV4(n, V4_DOC);
  const h = v6ToHextets(ip);
  return !!h && h[0] === 0x2001 && h[1] === 0x0db8;
};

const embeddedV4 = (hi: number, lo: number) => ((hi << 16) | lo) >>> 0;

/**
 * True only for a globally routable unicast address. IPv6 must sit in 2000::/3, which already leaves out
 * ::, ::1, fc00::/7, fe80::/10, fec0::/10 and ff00::/8; inside it 2001::/23 (incl. Teredo and 2001:db8::/32
 * documentation) is refused. IPv4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16)
 * addresses are judged by the IPv4 address they carry. Anything that does not parse is not public.
 */
export function isPublicIp(ip: string): boolean {
  const n4 = v4ToInt(ip);
  if (n4 !== undefined) return v4Public(n4);
  const h = v6ToHextets(ip);
  if (!h) return false;
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && h[5] === 0xffff) return v4Public(embeddedV4(h[6], h[7])); // ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return v4Public(embeddedV4(h[6], h[7])); // NAT64 well-known prefix
  if (h[0] === 0x2002) return v4Public(embeddedV4(h[1], h[2])); // 6to4
  if ((h[0] & 0xe000) !== 0x2000) return false; // outside global unicast 2000::/3
  if (h[0] === 0x2001 && h[1] < 0x200) return false; // 2001::/23 IETF protocol assignments (Teredo, ORCHID, benchmarking)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // documentation
  return true;
}

/** Host names that only ever mean this machine or a private network. Expects a lower-case name with no trailing dot. */
function privateName(h: string): boolean {
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal";
}

/** Lower-cases, drops IPv6 brackets and trailing dots, and canonicalises IPv4 shorthands (127.1, 0x7f000001) the way a URL parser does. */
function canonicalHost(hostname: string): string {
  let h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (h && !isIP(h)) {
    try {
      const parsed = new URL(`https://${h}/`).hostname.replace(/^\[|\]$/g, "");
      if (isIP(parsed)) h = parsed;
    } catch {
      // not a valid host at all: judged as a name below
    }
  }
  return h;
}

/**
 * Synchronous check on the host text only: loopback, private, link-local, reserved IP literals and
 * localhost/.local/.internal names. No DNS, so a public-looking name may still resolve to a private address:
 * use it for URLs Vobiz fetches (callbacks), and resolvePublicHost for anything this server fetches itself.
 */
export function isPrivateHostLiteral(hostname: string): boolean {
  const h = canonicalHost(hostname);
  if (!h) return true;
  if (isIP(h)) return !isPublicIp(h);
  return privateName(h);
}

/**
 * @deprecated Legacy literal check for SIP, sub-account and media-tool fields: the same as isPrivateHostLiteral
 * except that documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32) pass, as
 * those callers have always accepted them. New code should use isPrivateHostLiteral or resolvePublicHost.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = canonicalHost(hostname);
  if (h && isIP(h) && isDocumentationIp(h)) return false;
  return isPrivateHostLiteral(hostname);
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemLookup: HostLookup = (h) => dnsLookup(h, { all: true, verbatim: true });

/**
 * Resolves a host for a request this server is about to make and vets EVERY address it resolves to.
 * Returns the vetted addresses (connect to one of these, never re-resolve), or a reason:
 *   "private"      the name or any resolved address is not a public internet host
 *   "unresolvable" DNS gave no answer
 * IP literals (including bracketed IPv6) skip DNS.
 */
export async function resolvePublicHost(
  hostname: string,
  lookup: HostLookup = systemLookup,
): Promise<{ ok: true; addresses: ResolvedAddress[] } | { ok: false; reason: "private" | "unresolvable" }> {
  const h = canonicalHost(hostname);
  if (!h) return { ok: false, reason: "private" };
  const fam = isIP(h);
  if (fam) return isPublicIp(h) ? { ok: true, addresses: [{ address: h, family: fam as 4 | 6 }] } : { ok: false, reason: "private" };
  // Single-label names resolve through search domains to internal hosts (e.g. "metadata").
  if (privateName(h) || !h.includes(".")) return { ok: false, reason: "private" };
  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(h);
  } catch {
    return { ok: false, reason: "unresolvable" };
  }
  if (!Array.isArray(answers) || !answers.length) return { ok: false, reason: "unresolvable" };
  const addresses: ResolvedAddress[] = [];
  for (const a of answers) {
    const address = String(a?.address ?? "").replace(/%.*$/, "");
    const family = isIP(address);
    if (!family || !isPublicIp(address)) return { ok: false, reason: "private" };
    addresses.push({ address, family: family as 4 | 6 });
  }
  return { ok: true, addresses };
}

export function toE164(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return "+" + digits;
}

/**
 * Reads a list field from a backend response. Go services serialize an empty
 * (nil) slice as `null`, so a missing or null field means "no items".
 * Returns undefined only when the field holds something other than a list.
 */
export function listField<T = Record<string, unknown>>(body: unknown, key: string): T[] | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const v = (body as Record<string, unknown>)[key];
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? (v as T[]) : undefined;
}

export const PAGINATION_NOTE =
  "Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls.";

/** Normalised pagination block so clients can page without keeping any server-side setting. */
export function pageInfo(page: number, perPage: number, returned: number, total: unknown): Record<string, unknown> {
  const t = typeof total === "number" ? total : null;
  const hasMore = t !== null ? page * perPage < t : returned === perPage;
  return { page, per_page: perPage, total: t, returned, has_more: hasMore, next_page: hasMore ? page + 1 : null };
}

// ── Redaction ───────────────────────────────────────────────────

const SECRET_KEYS = new Set([
  "auth_secret",
  "auth_token",
  "password",
  "sip_password",
  "secret",
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "private_key",
]);

/** Deep-copies `value`, replacing secret fields (and any `extraKeys`) with "[redacted]". */
export function redact<T>(value: T, extraKeys: string[] = []): T {
  const keys = new Set([...SECRET_KEYS, ...extraKeys]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = keys.has(k.toLowerCase()) && val !== null && val !== "" ? "[redacted]" : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

// ── Tool results ────────────────────────────────────────────────

export function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function fail(err: unknown): CallToolResult {
  const e =
    err instanceof VobizError
      ? err
      : new VobizError("internal_error", "Unexpected internal error while handling the request.");
  const body: Record<string, unknown> = { ok: false, error: e.kind, message: e.message, retryable: isRetryable(e.kind) };
  if (e.status !== undefined) body.http_status = e.status;
  if (e.apiId) body.api_id = e.apiId;
  const hint = hintFor(e.kind);
  if (hint) body.hint = hint;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

/**
 * Log-safe description of an unexpected error: its name (or VobizError kind) plus at most 120 characters of
 * its message, with the query string and fragment of any http(s) URL removed (signed URLs, tokens).
 */
export function safeErrorText(err: unknown): string {
  const name = err instanceof VobizError ? err.kind : err instanceof Error ? err.name || "Error" : typeof err;
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const msg = raw
    .replace(/(https?:\/\/[^\s?#]*)[?#][^\s]*/gi, "$1")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 120);
  return msg ? `${name}: ${msg}` : name;
}

/** Wraps a tool handler so every thrown error becomes a structured MCP tool error (the request `extra` is passed through). */
export function handler<A, E = unknown>(fn: (args: A, extra: E) => Promise<CallToolResult>): (args: A, extra: E) => Promise<CallToolResult> {
  return async (args: A, extra: E) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return fail(err);
    }
  };
}
