/**
 * Classifies a finished call from its hangup cause. Vobiz runs on FreeSWITCH, whose hangup cause
 * names follow Q.850; the SIP response that usually produces each cause is listed for reference.
 * These describe the CALL, separate from HTTP/API errors (an HTTP 404 is not a busy line).
 */
export type CallOutcome =
  | "answered"
  | "busy"
  | "no_answer"
  | "rejected"
  | "invalid_number"
  | "unreachable"
  | "network_failure"
  | "cancelled"
  | "not_allowed"
  | "failed"
  | "unknown";

const CAUSES: Record<string, { outcome: CallOutcome; sip?: number; retryable: boolean }> = {
  NORMAL_CLEARING: { outcome: "answered", retryable: false },
  USER_BUSY: { outcome: "busy", sip: 486, retryable: true },
  NO_ANSWER: { outcome: "no_answer", sip: 480, retryable: true },
  NO_USER_RESPONSE: { outcome: "no_answer", sip: 408, retryable: true },
  ALLOTTED_TIMEOUT: { outcome: "no_answer", retryable: true },
  CALL_REJECTED: { outcome: "rejected", sip: 603, retryable: false },
  UNALLOCATED_NUMBER: { outcome: "invalid_number", sip: 404, retryable: false },
  INVALID_NUMBER_FORMAT: { outcome: "invalid_number", sip: 484, retryable: false },
  NUMBER_CHANGED: { outcome: "invalid_number", sip: 410, retryable: false },
  NO_ROUTE_DESTINATION: { outcome: "unreachable", sip: 404, retryable: false },
  DESTINATION_OUT_OF_ORDER: { outcome: "unreachable", sip: 502, retryable: true },
  SUBSCRIBER_ABSENT: { outcome: "unreachable", sip: 480, retryable: true },
  NORMAL_TEMPORARY_FAILURE: { outcome: "network_failure", sip: 503, retryable: true },
  NETWORK_OUT_OF_ORDER: { outcome: "network_failure", sip: 500, retryable: true },
  RECOVERY_ON_TIMER_EXPIRE: { outcome: "network_failure", sip: 408, retryable: true },
  SWITCH_CONGESTION: { outcome: "network_failure", sip: 503, retryable: true },
  NORMAL_CIRCUIT_CONGESTION: { outcome: "network_failure", sip: 503, retryable: true },
  INCOMPATIBLE_DESTINATION: { outcome: "failed", sip: 488, retryable: false },
  ORIGINATOR_CANCEL: { outcome: "cancelled", sip: 487, retryable: false },
  LOSE_RACE: { outcome: "cancelled", retryable: false },
  OUTGOING_CALL_BARRED: { outcome: "not_allowed", sip: 403, retryable: false },
  CALL_AWARDED_DELIVERED: { outcome: "answered", retryable: false },
};

export function classifyHangup(cause: unknown, billsec?: unknown): {
  outcome: CallOutcome;
  typical_sip_code: number | null;
  retryable: boolean;
} {
  const c = typeof cause === "string" ? cause.toUpperCase() : "";
  const known = CAUSES[c];
  if (!known) return { outcome: c ? "failed" : "unknown", typical_sip_code: null, retryable: false };
  // NORMAL_CLEARING with zero billed seconds means the call ended without being answered.
  if (known.outcome === "answered" && typeof billsec === "number" && billsec === 0) {
    return { outcome: "no_answer", typical_sip_code: null, retryable: true };
  }
  return { outcome: known.outcome, typical_sip_code: known.sip ?? null, retryable: known.retryable };
}
