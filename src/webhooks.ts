/**
 * Verification and storage of Vobiz callbacks (answer/hangup/action URLs pointing at this server).
 *
 * Signing scheme, from callback-proxy/controllers/signature.go:45-80 and concepts/validating-callbacks.mdx:
 *   X-Vobiz-Signature-V3 = base64(HMAC-SHA256(auth_token, baseURL + "." + X-Vobiz-Signature-V3-Nonce))
 *   X-Vobiz-Signature-V2 = base64(HMAC-SHA256(auth_token, baseURL + X-Vobiz-Signature-V2-Nonce))
 * baseURL = scheme://host/path of the URL Vobiz was given (no query string). The request body is NOT
 * signed and the nonce is random (no timestamp), so this module also rejects reused nonces (replay)
 * and de-duplicates identical events (Vobiz retries).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type SignatureMode = "require" | "verify_if_present" | "off";

export interface VerifyResult {
  valid: boolean;
  present: boolean;
  version?: "v3" | "v2";
  reason?: string;
}

function header(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function safeEqualB64(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signV3(token: string, baseUrl: string, nonce: string): string {
  return createHmac("sha256", token).update(`${baseUrl}.${nonce}`).digest("base64");
}
export function signV2(token: string, baseUrl: string, nonce: string): string {
  return createHmac("sha256", token).update(`${baseUrl}${nonce}`).digest("base64");
}

/** baseURL as Vobiz signs it: the public URL of this endpoint without query string. */
export function baseUrlFor(publicUrl: string, path: string): string {
  const u = new URL(path, publicUrl.endsWith("/") ? publicUrl : publicUrl + "/");
  return `${u.protocol}//${u.host}${u.pathname}`;
}

export function verifySignature(
  headers: Record<string, string | string[] | undefined>,
  baseUrl: string,
  token: string,
): VerifyResult {
  const v3 = header(headers, "X-Vobiz-Signature-V3");
  const n3 = header(headers, "X-Vobiz-Signature-V3-Nonce");
  const v2 = header(headers, "X-Vobiz-Signature-V2");
  const n2 = header(headers, "X-Vobiz-Signature-V2-Nonce");
  if (v3 && n3) {
    return safeEqualB64(v3, signV3(token, baseUrl, n3))
      ? { valid: true, present: true, version: "v3" }
      : { valid: false, present: true, version: "v3", reason: "V3 signature mismatch" };
  }
  if (v2 && n2) {
    return safeEqualB64(v2, signV2(token, baseUrl, n2))
      ? { valid: true, present: true, version: "v2" }
      : { valid: false, present: true, version: "v2", reason: "V2 signature mismatch" };
  }
  return { valid: false, present: false, reason: "no X-Vobiz-Signature-V3/V2 headers" };
}

export function nonceOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  return header(headers, "X-Vobiz-Signature-V3-Nonce") ?? header(headers, "X-Vobiz-Signature-V2-Nonce");
}

/** Fields kept from a callback. Everything else (tokens, server internals) is dropped. */
const KEEP = [
  "Event", "CallUUID", "RequestUUID", "ALegRequestUUID", "ALegUUID", "Direction", "From", "To", "CallStatus",
  "CallerName", "SessionStart", "StartTime", "AnswerTime", "EndTime", "HangupCause", "HangupCauseCode",
  "HangupCauseName", "Duration", "BillDuration", "Digits", "InputType", "Speech", "RecordingID", "RecordUrl",
  "RecordFile", "RecordingDuration", "RecordingEndReason", "DialStatus", "DialAction", "DialBLegUUID",
  "DialBLegStatus", "DialHangupCause", "BridgedUUID", "STIRVerification", "STIRAttestation",
];

export interface StoredEvent {
  id: string;
  received_at: string;
  signature_verified: boolean;
  fields: Record<string, string>;
}

export function pickFields(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP) {
    const v = body[k];
    if (v !== undefined && v !== null && v !== "") out[k] = String(v).slice(0, 500);
  }
  return out;
}

export class EventStore {
  private events: StoredEvent[] = [];
  private seenEvents = new Map<string, number>();
  private seenNonces = new Map<string, number>();

  constructor(
    private readonly max = 500,
    private readonly ttlMs = 24 * 3600_000,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const t = this.now();
    for (const m of [this.seenEvents, this.seenNonces]) for (const [k, at] of m) if (t - at > this.ttlMs) m.delete(k);
  }

  /** True if this nonce was already used (replay). Records it otherwise. */
  nonceReused(nonce: string): boolean {
    this.prune();
    if (this.seenNonces.has(nonce)) return true;
    this.seenNonces.set(nonce, this.now());
    return false;
  }

  /** Stores an event unless an identical one was already received. Returns {duplicate}. */
  add(fields: Record<string, string>, verified: boolean, scope = "webhook"): { duplicate: boolean; event: StoredEvent } {
    this.prune();
    const id = createHash("sha256").update(scope + JSON.stringify(fields, Object.keys(fields).sort())).digest("hex").slice(0, 24);
    const existing = this.events.find((e) => e.id === id);
    if (this.seenEvents.has(id) && existing) return { duplicate: true, event: existing };
    const event: StoredEvent = { id, received_at: new Date(this.now()).toISOString(), signature_verified: verified, fields };
    this.seenEvents.set(id, this.now());
    this.events.push(event);
    if (this.events.length > this.max) this.events.shift();
    return { duplicate: false, event };
  }

  list(filter: { call_uuid?: string; event?: string; limit?: number } = {}): StoredEvent[] {
    return this.events
      .filter((e) => !filter.call_uuid || e.fields.CallUUID === filter.call_uuid || e.fields.RequestUUID === filter.call_uuid)
      .filter((e) => !filter.event || e.fields.Event === filter.event)
      .slice(-(filter.limit ?? 50))
      .reverse();
  }
}
