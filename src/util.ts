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
    if (isPrivateHost(u.hostname)) throw new VobizError("not_allowed", `${field} must be a public internet address that Vobiz can reach.`);
    return;
  }
  if (!cfg.allowedUrlHosts.includes(u.host.toLowerCase())) {
    throw new VobizError(
      "not_allowed",
      `${field} host ${u.host} is not approved. Allowed hosts: ${cfg.allowedUrlHosts.join(", ") || "(none configured)"}. An administrator can add it to VOBIZ_ALLOWED_URL_HOSTS.`,
    );
  }
}

/** Loopback, private, link-local and .local/.internal hosts: never valid targets for Vobiz callbacks. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
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

/** Wraps a tool handler so every thrown error becomes a structured MCP tool error. */
export function handler<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}
