/**
 * Error categories returned to the AI client. Each maps to an actionable message;
 * raw backend bodies, headers and stack traces are never surfaced.
 */
export type ErrorKind =
  | "invalid_input"
  | "missing_credentials"
  | "auth_failed"
  | "forbidden"
  | "insufficient_balance"
  | "not_found"
  | "account_suspended"
  | "rate_limited"
  | "service_unavailable"
  | "backend_error"
  | "timeout"
  | "network_error"
  | "outcome_unknown"
  | "unexpected_response"
  | "calls_disabled"
  | "confirmation_required"
  | "not_allowed"
  | "call_not_active"
  | "idempotency_conflict"
  | "in_progress"
  | "duplicate_blocked"
  | "unsupported"
  | "provisioning_disabled"
  | "spending_limit"
  | "messaging_disabled"
  | "opted_out"
  | "internal_error";

/** Whether an agent may retry the same request (after a pause for rate limits / outages). */
const RETRYABLE: Partial<Record<ErrorKind, boolean>> = {
  rate_limited: true,
  service_unavailable: true,
  backend_error: true,
  timeout: true,
  network_error: true,
  in_progress: true,
};

export function isRetryable(kind: ErrorKind): boolean {
  return RETRYABLE[kind] === true;
}

export class VobizError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly status?: number,
    public readonly apiId?: string,
  ) {
    super(message);
    this.name = "VobizError";
  }
}

/** Pull a human-readable message out of the several error shapes Vobiz services use. */
export function extractBackendMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, 300) : undefined;
  const b = body as Record<string, unknown>;
  // api-voice / backend-apis: {"api_id","error":"..."}
  // account-service: {"error":"HTTPError","message":"..."}; prefer the sentence over the class name.
  if (typeof b.error === "string" && typeof b.message === "string" && !/\s/.test(b.error)) return b.message;
  if (typeof b.error === "string") return b.error;
  // gateway: {"error":{"code","message"}}
  if (b.error && typeof b.error === "object" && typeof (b.error as Record<string, unknown>).message === "string") {
    return (b.error as Record<string, unknown>).message as string;
  }
  if (Array.isArray(b.errors) && b.errors.length) return b.errors.map(String).join("; ");
  if (typeof b.message === "string") return b.message;
  if (typeof b.detail === "string") return b.detail;
  return undefined;
}

export function kindForStatus(status: number, message = ""): ErrorKind {
  const m = message.toLowerCase();
  if (status === 400 && m.includes("rate limit")) return "rate_limited";
  if (status === 400) return "invalid_input";
  if (status === 401) return "auth_failed";
  if (status === 402 || m.includes("insufficient balance")) return "insufficient_balance";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 410) return "account_suspended";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "service_unavailable";
  if (status >= 500) return "backend_error";
  return "unexpected_response";
}

const HINTS: Partial<Record<ErrorKind, string>> = {
  auth_failed: "Check VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN.",
  forbidden: "The authenticated account is not allowed to perform this operation or access this resource.",
  insufficient_balance: "Add balance to the account, then try again.",
  rate_limited: "Wait before retrying.",
  service_unavailable: "The Vobiz service is temporarily unavailable. Try again later.",
  account_suspended: "The account is suspended or locked. Contact Vobiz support.",
};

export function hintFor(kind: ErrorKind): string | undefined {
  return HINTS[kind];
}
