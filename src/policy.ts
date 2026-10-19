/**
 * Server-side cost and safety policy for outbound calling. Enforced here, never left to the model.
 */
import { digitsOnly, type Config } from "./config.js";
import { VobizError } from "./errors.js";

export interface CallPolicy {
  maxCallDurationSec: number;
  maxCallsPerHour: number;
  maxConcurrentCalls: number;
  /** Country calling codes (digits) allowed as destinations; empty = any. */
  allowedCountryCodes: string[];
  /** Digit prefixes (full number incl. country code) that may never be dialled. */
  blockedPrefixes: string[];
  /** Refuse to call when available balance is at or below this (prepaid accounts). */
  minBalance: number;
  balanceCurrency: string;
  checkBalance: boolean;
}

/** Validates a destination against allowlists, country codes and blocked prefixes. Throws not_allowed. */
export function assertDestinationAllowed(cfg: Config, to: string): void {
  const digits = digitsOnly(to);
  const p = cfg.policy;
  if (cfg.allowedDestinations.length && !cfg.allowedDestinations.includes(digits)) {
    throw new VobizError("not_allowed", "This destination is not in the server's VOBIZ_ALLOWED_DESTINATIONS allowlist.");
  }
  if (p.allowedCountryCodes.length && !p.allowedCountryCodes.some((cc) => digits.startsWith(cc))) {
    throw new VobizError(
      "not_allowed",
      `Calls to this country are not allowed by this server (allowed country codes: ${p.allowedCountryCodes.map((c) => "+" + c).join(", ")}). An administrator can change VOBIZ_ALLOWED_COUNTRY_CODES.`,
    );
  }
  const blocked = p.blockedPrefixes.find((bp) => digits.startsWith(bp));
  if (blocked) {
    throw new VobizError("not_allowed", `Destinations starting with +${blocked} are blocked by VOBIZ_BLOCKED_PREFIXES.`);
  }
}

/** Resolves the effective time_limit: never above the server maximum. */
export function effectiveTimeLimit(cfg: Config, requested?: number): number {
  const max = cfg.policy.maxCallDurationSec;
  if (requested !== undefined && requested > max) {
    throw new VobizError(
      "not_allowed",
      `time_limit ${requested}s exceeds this server's maximum call duration of ${max}s (VOBIZ_MAX_CALL_DURATION_SEC).`,
    );
  }
  return requested ?? max;
}
