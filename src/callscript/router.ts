/**
 * HTTP surface of make_call call scripts:
 *   ALL  /c/:token/answer    Vobiz answer URL → VobizXML (Play and/or Speak, then Hangup)
 *   POST /c/:token/hangup    Vobiz hangup URL → 200 {"ok":true}
 *
 * The sealed "scr" token is the whole state. Signatures follow the reminders router: X-Vobiz-Signature-V3/V2 is
 * verified with the Auth Token sealed in the token whenever present (verify_if_present) or always (require), with a
 * nonce replay cache. Every callback logs `calls: callback <leg> signature=<absent|valid|invalid>`, and the hangup
 * logs `calls: script hangup cause=… duration=…`; neither carries numbers, text or tokens.
 * Unknown or expired tokens get a polite "no longer active" script on the answer URL and 200 on the hangup URL:
 * Vobiz never sees a 4xx for a token problem.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { silentLogger, type Logger } from "../logger.js";
import { mintMediaUrl } from "../media/router.js";
import type { MediaService } from "../media/types.js";
import { NonceCache } from "../reminders/router.js";
import type { Sealer } from "../sealer.js";
import { baseUrlFor, nonceOf, verifySignature, type SignatureMode } from "../webhooks.js";
import { inactiveCallXml, openScript, SCRIPT_TTL_SEC, scriptXml } from "./service.js";
import type { CallScript } from "./types.js";

export interface CallScriptRouterOptions {
  /** Public base URL of this server, exactly as handed to Vobiz (signatures cover it). */
  baseUrl: string;
  sealer: Sealer;
  /** The audio library, for scripts that play a library file; without it such files are reported as unavailable. */
  media?: MediaService;
  log?: Logger;
  signatureMode: SignatureMode;
}

const MAX_BODY = "64kb";

/** Callback parameters: query string, plus a form-urlencoded or JSON body for POST. */
function params(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (o: unknown) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v).slice(0, 500);
    }
  };
  add(req.query);
  if (req.method === "POST") add(req.body);
  return out;
}

/** A log-safe token: letters, digits and _ . - only, at most 64 characters. */
const logSafe = (v: string | undefined) => (v ? v.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) : "-");

const xml = (res: Response, body: string) => res.status(200).type("text/xml; charset=utf-8").set("Cache-Control", "no-store").send(body);

export function createCallScriptRouter(o: CallScriptRouterOptions): Router {
  const router = express.Router();
  const log = o.log ?? silentLogger;
  const nonces = new NonceCache(undefined, (SCRIPT_TTL_SEC + 300) * 1000);
  const callbackBody = [express.urlencoded({ extended: false, limit: MAX_BODY }), express.json({ limit: MAX_BODY })];

  /** The script, "invalid_token" or "bad_signature"; logs one line per valid token. */
  function check(req: Request, leg: "answer" | "hangup"): CallScript | "invalid_token" | "bad_signature" {
    const token = String(req.params.token ?? "");
    const s = openScript(o.sealer, token);
    if (!s) return "invalid_token";
    const v = s.authToken
      ? verifySignature(req.headers, baseUrlFor(o.baseUrl, `/c/${token}/${leg}`), s.authToken)
      : { present: false, valid: false };
    log.info(`calls: callback ${leg} signature=${!v.present ? "absent" : v.valid ? "valid" : "invalid"}`);
    if (o.signatureMode === "off") return s;
    if (v.present && !v.valid) return "bad_signature";
    if (!v.present && o.signatureMode === "require") return "bad_signature";
    const nonce = v.present ? nonceOf(req.headers) : undefined;
    if (nonce && nonces.reused(`${leg}:${nonce}`)) return "bad_signature";
    return s;
  }

  /** The <Play> source: the external URL, or a fresh media URL for a library file that still exists. */
  async function playUrl(s: CallScript): Promise<string | "missing" | undefined> {
    if (!s.play) return undefined;
    if ("url" in s.play) return s.play.url;
    const { audioId } = s.play;
    if (!o.media) return "missing";
    try {
      const m = await o.media.find(s.authId, audioId);
      return m?.id === audioId ? mintMediaUrl(o.sealer, o.baseUrl, s.authId, audioId) : "missing";
    } catch {
      log.info("calls: script audio lookup failed");
      return "missing";
    }
  }

  router.all("/c/:token/answer", ...callbackBody, async (req: Request, res: Response) => {
    if (req.method !== "GET" && req.method !== "POST") return res.status(405).set("Allow", "GET, POST").end();
    const s = check(req, "answer");
    if (s === "bad_signature") return res.status(403).type("text/plain").send("invalid signature");
    if (s === "invalid_token") return xml(res, inactiveCallXml());
    try {
      return xml(res, scriptXml(s, await playUrl(s)));
    } catch {
      return xml(res, inactiveCallXml());
    }
  });

  router.post("/c/:token/hangup", ...callbackBody, (req: Request, res: Response) => {
    const s = check(req, "hangup");
    if (s === "bad_signature") return res.status(403).type("text/plain").send("invalid signature");
    if (s !== "invalid_token") {
      const p = params(req);
      log.info(`calls: script hangup cause=${logSafe(p.HangupCause || p.HangupCauseName)} duration=${logSafe(p.BillDuration || p.Duration)}`);
    }
    return res.status(200).set("Cache-Control", "no-store").json({ ok: true });
  });

  router.all("/c/:token/hangup", (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").end();
  });

  // Malformed bodies (bad JSON, too large) on these routes are client errors, never 500.
  router.use("/c", (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 400;
    res.status(status >= 400 && status < 500 ? status : 400).type("text/plain").send("bad request");
  });

  return router;
}
