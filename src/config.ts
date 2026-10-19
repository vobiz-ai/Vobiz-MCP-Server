/**
 * Runtime configuration, read only from environment variables.
 * Credentials are never hardcoded and never logged.
 */
import type { CallPolicy } from "./policy.js";

export interface Config {
  /** Account Auth ID (MA_... or SA_...). Every request is scoped to this account. */
  authId?: string;
  authToken?: string;
  baseUrl: string;
  timeoutMs: number;
  /** Outbound calling is off unless explicitly enabled. */
  enableCalls: boolean;
  defaultAnswerUrl?: string;
  /** Digits-only E.164 numbers; empty means no allowlist. */
  allowedDestinations: string[];
  allowedCallerIds: string[];
  /** Check that `from` is an active, voice-enabled number on this account before calling. */
  verifyCallerId: boolean;
  maxCallsPerMinute: number;
  /** Page size used by list tools when the caller does not pass one. */
  defaultPageSize: number;
  logLevel: "silent" | "info" | "debug";
  /** "production" tightens a few defaults; anything else is treated as development. */
  environment: "production" | "development";
  policy: CallPolicy;
  /** Identical calls (same from/to) inside this window are refused unless a new idempotency_key is given. */
  duplicateCallWindowSec: number;
  idempotencyFile?: string;
  /** Number purchases and trunk/number/application changes are off unless explicitly enabled. */
  enableProvisioning: boolean;
  /** Highest first charge (setup + monthly fee) a single number purchase may cost. 0 = purchases refused. */
  maxNumberCost: number;
  maxNumberPurchasesPerDay: number;
  /** Public base URL of this server (HTTP mode), used for hosted XML flows and callbacks. */
  publicUrl?: string;
  /** Hosts that call-control URLs (answer, transfer, redirect, gather action) may point to. */
  allowedUrlHosts: string[];
  /** Accept call-control URLs on any public https host (hosted multi-tenant mode, where every user runs their own app). */
  allowAnyUrlHost: boolean;
  /** How callbacks to this server are authenticated (X-Vobiz-Signature-V3/V2). */
  webhookSignature: "require" | "verify_if_present" | "off";
  /** Only these tool groups are registered (VOBIZ_TOOLSETS); empty = all. */
  toolsets: string[];
  /** Register read-only tools only (VOBIZ_READ_ONLY). */
  readOnly: boolean;
  /** Public links shown to users (consent page, OAuth metadata, instructions). */
  links: { console: string; privacy: string; docs: string; docsMcp: string };
  /** SMS, MMS and RCS sending and opt-out changes are off unless explicitly enabled. */
  enableMessaging: boolean;
  messaging: {
    /** Country calling codes (digits) messages may go to; empty = any. */
    allowedCountryCodes: string[];
    maxRecipientsPerSend: number;
    maxMessagesPerMinute: number;
    maxMessagesPerHour: number;
    /** Check that an SMS/MMS `from` is a messaging number on this account before sending. */
    verifySender: boolean;
  };
}

export class ConfigError extends Error {}

const AUTH_ID_RE = /^(MA|SA)_[A-Za-z0-9]+$/;

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function int(name: string, v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function digitsOnly(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

function prefixList(name: string, v: string | undefined, fallback: string[]): string[] {
  if (v === undefined) return fallback;
  const out = v.split(",").map((s) => s.trim().replace(/^\+/, "")).filter(Boolean);
  for (const p of out) if (!/^\d{1,15}$/.test(p)) throw new ConfigError(`${name} entries must be digits (e.g. 91 or +91)`);
  return out;
}

function hostOf(u?: string): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function num(name: string, v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be a number between ${min} and ${max}`);
  return n;
}

function signatureMode(v: string | undefined): Config["webhookSignature"] {
  const m = (v?.trim().toLowerCase() || "require") as Config["webhookSignature"];
  if (!["require", "verify_if_present", "off"].includes(m)) {
    throw new ConfigError("VOBIZ_WEBHOOK_SIGNATURE must be require, verify_if_present or off");
  }
  return m;
}

function httpsLink(name: string, v: string | undefined, fallback: string): string {
  const u = v?.trim() || fallback;
  if (!/^https:\/\/[^\s]+$/.test(u)) throw new ConfigError(`${name} must be an https URL`);
  return u;
}

function list(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => digitsOnly(s))
    .filter((s) => s.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authId = env.VOBIZ_AUTH_ID?.trim() || undefined;
  const authToken = env.VOBIZ_AUTH_TOKEN?.trim() || undefined;
  if (authId && !AUTH_ID_RE.test(authId)) {
    throw new ConfigError("VOBIZ_AUTH_ID must look like MA_XXXXXX or SA_XXXXXX");
  }

  const baseUrl = (env.VOBIZ_BASE_URL?.trim() || "https://api.vobiz.ai").replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError("VOBIZ_BASE_URL is not a valid URL");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new ConfigError("VOBIZ_BASE_URL must use https (http is allowed only for localhost)");
  }

  const defaultAnswerUrl = env.VOBIZ_DEFAULT_ANSWER_URL?.trim() || undefined;
  if (defaultAnswerUrl) {
    try {
      new URL(defaultAnswerUrl);
    } catch {
      throw new ConfigError("VOBIZ_DEFAULT_ANSWER_URL is not a valid URL");
    }
  }

  const environment: Config["environment"] = env.VOBIZ_ENV?.trim().toLowerCase() === "production" ? "production" : "development";
  if (environment === "production" && isLocal) {
    throw new ConfigError("VOBIZ_ENV=production cannot use a localhost VOBIZ_BASE_URL");
  }
  const publicUrl = env.VOBIZ_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  if (publicUrl) {
    let pu: URL;
    try {
      pu = new URL(publicUrl);
    } catch {
      throw new ConfigError("VOBIZ_PUBLIC_URL is not a valid URL");
    }
    if (pu.protocol !== "https:") throw new ConfigError("VOBIZ_PUBLIC_URL must use https (Vobiz must reach it over the internet)");
  }

  const logLevel = (env.VOBIZ_LOG_LEVEL?.trim() || "info") as Config["logLevel"];
  if (!["silent", "info", "debug"].includes(logLevel)) {
    throw new ConfigError("VOBIZ_LOG_LEVEL must be silent, info or debug");
  }

  return {
    authId,
    authToken,
    baseUrl,
    timeoutMs: int("VOBIZ_TIMEOUT_MS", env.VOBIZ_TIMEOUT_MS, 15000, 1000, 120000),
    enableCalls: bool(env.VOBIZ_ENABLE_CALLS, false),
    defaultAnswerUrl,
    allowedDestinations: list(env.VOBIZ_ALLOWED_DESTINATIONS),
    allowedCallerIds: list(env.VOBIZ_ALLOWED_CALLER_IDS),
    verifyCallerId: bool(env.VOBIZ_VERIFY_CALLER_ID, true),
    maxCallsPerMinute: int("VOBIZ_MAX_CALLS_PER_MINUTE", env.VOBIZ_MAX_CALLS_PER_MINUTE, 5, 1, 1000),
    defaultPageSize: int("VOBIZ_DEFAULT_PAGE_SIZE", env.VOBIZ_DEFAULT_PAGE_SIZE, 20, 1, 100),
    logLevel,
    environment,
    policy: {
      maxCallDurationSec: int("VOBIZ_MAX_CALL_DURATION_SEC", env.VOBIZ_MAX_CALL_DURATION_SEC, 600, 10, 86400),
      maxCallsPerHour: int("VOBIZ_MAX_CALLS_PER_HOUR", env.VOBIZ_MAX_CALLS_PER_HOUR, 30, 1, 100000),
      maxConcurrentCalls: int("VOBIZ_MAX_CONCURRENT_CALLS", env.VOBIZ_MAX_CONCURRENT_CALLS, 3, 1, 10000),
      // Empty (default) = any country; calling itself stays off until VOBIZ_ENABLE_CALLS=true and every call is confirmed.
      allowedCountryCodes: prefixList("VOBIZ_ALLOWED_COUNTRY_CODES", env.VOBIZ_ALLOWED_COUNTRY_CODES, []),
      blockedPrefixes: prefixList("VOBIZ_BLOCKED_PREFIXES", env.VOBIZ_BLOCKED_PREFIXES, []),
      minBalance: num("VOBIZ_MIN_BALANCE", env.VOBIZ_MIN_BALANCE, 0, -1e12, 1e12),
      // Empty (default) = the account's primary wallet, whatever its currency.
      balanceCurrency: (env.VOBIZ_BALANCE_CURRENCY?.trim() ?? "").toUpperCase(),
      checkBalance: bool(env.VOBIZ_CHECK_BALANCE, true),
    },
    duplicateCallWindowSec: int("VOBIZ_DUPLICATE_CALL_WINDOW_SEC", env.VOBIZ_DUPLICATE_CALL_WINDOW_SEC, 120, 0, 86400),
    idempotencyFile: env.VOBIZ_IDEMPOTENCY_FILE?.trim() || undefined,
    enableProvisioning: bool(env.VOBIZ_ENABLE_PROVISIONING, false),
    maxNumberCost: num("VOBIZ_MAX_NUMBER_COST", env.VOBIZ_MAX_NUMBER_COST, 0, 0, 1e9),
    maxNumberPurchasesPerDay: int("VOBIZ_MAX_NUMBER_PURCHASES_PER_DAY", env.VOBIZ_MAX_NUMBER_PURCHASES_PER_DAY, 1, 0, 1000),
    publicUrl,
    toolsets: (env.VOBIZ_TOOLSETS ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t && t !== "all"),
    readOnly: bool(env.VOBIZ_READ_ONLY, false),
    links: {
      console: httpsLink("VOBIZ_CONSOLE_URL", env.VOBIZ_CONSOLE_URL, "https://console.vobiz.ai"),
      privacy: httpsLink("VOBIZ_PRIVACY_URL", env.VOBIZ_PRIVACY_URL, "https://vobiz.ai/privacy"),
      docs: httpsLink("VOBIZ_DOCS_URL", env.VOBIZ_DOCS_URL, "https://vobiz.ai/docs/resources/account-mcp"),
      docsMcp: httpsLink("VOBIZ_DOCS_MCP_URL", env.VOBIZ_DOCS_MCP_URL, "https://vobiz.ai/docs/mcp"),
    },
    enableMessaging: bool(env.VOBIZ_ENABLE_MESSAGING, false),
    messaging: {
      allowedCountryCodes: prefixList("VOBIZ_MESSAGING_ALLOWED_COUNTRY_CODES", env.VOBIZ_MESSAGING_ALLOWED_COUNTRY_CODES, []),
      maxRecipientsPerSend: int("VOBIZ_MAX_RECIPIENTS_PER_SEND", env.VOBIZ_MAX_RECIPIENTS_PER_SEND, 10, 1, 100),
      maxMessagesPerMinute: int("VOBIZ_MAX_MESSAGES_PER_MINUTE", env.VOBIZ_MAX_MESSAGES_PER_MINUTE, 20, 1, 10000),
      maxMessagesPerHour: int("VOBIZ_MAX_MESSAGES_PER_HOUR", env.VOBIZ_MAX_MESSAGES_PER_HOUR, 200, 1, 1000000),
      verifySender: bool(env.VOBIZ_VERIFY_SENDER, true),
    },
    webhookSignature: signatureMode(env.VOBIZ_WEBHOOK_SIGNATURE),
    allowAnyUrlHost: bool(env.VOBIZ_ALLOW_ANY_URL_HOST, false),
    allowedUrlHosts: [
      ...new Set(
        [
          hostOf(publicUrl),
          hostOf(defaultAnswerUrl),
          ...(env.VOBIZ_ALLOWED_URL_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()),
        ].filter((h): h is string => !!h),
      ),
    ],
  };
}
