import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Token kinds sealed by the hosted connector. Each kind is bound into the AEAD tag, so a token of one kind
 * can never be opened as another.
 *   client/txn/code/access/refresh  OAuth (hosted.ts)
 *   job                              a scheduled reminder-call job (Cloud Tasks payload)
 *   ans                              per-call context behind /r/:token/answer|input|hangup
 *   upl                              a one-time audio upload link (/upload/:token)
 *   med                              a short-lived audio URL handed to Vobiz in <Play> (/media/:token)
 *   scr                              a one-off call script behind /c/:token/answer|hangup (make_call say/play)
 */
export type SealKind = "client" | "txn" | "code" | "access" | "refresh" | "job" | "ans" | "upl" | "med" | "scr";

const PREFIX: Record<SealKind, string> = {
  client: "vbzc_",
  txn: "vbzt_",
  code: "vbzo_",
  access: "vbza_",
  refresh: "vbzr_",
  job: "vbzj_",
  ans: "vbzn_",
  upl: "vbzu_",
  med: "vbzm_",
  scr: "vbzs_",
};

/** Authenticated encryption (AES-256-GCM) for every token this server hands out. */
export class Sealer {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash("sha256").update(`vobiz-mcp-hosted:${secret}`).digest();
  }
  seal(kind: SealKind, payload: Record<string, unknown>, ttlSec: number): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(kind));
    const body = Buffer.concat([c.update(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })), c.final()]);
    return PREFIX[kind] + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
  }
  open<T = Record<string, unknown>>(kind: SealKind, token: string): (T & { exp: number }) | undefined {
    const prefix = PREFIX[kind];
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
