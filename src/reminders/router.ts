/**
 * HTTP surface of reminder calls:
 *   POST /jobs/fire          Cloud Tasks delivery (text/plain body = sealed job token)
 *   ALL  /r/:token/answer    Vobiz answer URL  → VobizXML
 *   POST /r/:token/input     Gather action     → VobizXML
 *   POST /r/:token/hangup    Vobiz hangup URL  → 204
 *
 * The sealed token makes each URL unguessable; on top of that, a Vobiz signature (X-Vobiz-Signature-V3/V2)
 * is verified with the Auth Token inside the token whenever the headers are present. Bad input never
 * produces a 500: unknown tokens get a polite "no longer active" call script (answer/input) or 400 (hangup).
 */
import express, { type Request, type Response, type Router } from "express";
import type { Sealer } from "../sealer.js";
import { EventStore, baseUrlFor, nonceOf, verifySignature, type SignatureMode } from "../webhooks.js";
import { inactiveScript } from "./script.js";
import type { AnswerPayload, HangupParams, ReminderService } from "./types.js";

export interface RemindersRouterOptions {
  /** Public base URL of this server, exactly as handed to Vobiz (signatures cover it). */
  baseUrl: string;
  signatureMode: SignatureMode;
  sealer: Sealer;
}

const MAX_BODY = "64kb";
const TOKEN_RE = /^vbzn_[A-Za-z0-9_-]{20,8000}$/;

/** Callback parameters: query string, plus a form-urlencoded or JSON body for POST (as src/http.ts). */
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

const xml = (res: Response, body: string) => res.status(200).type("text/xml; charset=utf-8").set("Cache-Control", "no-store").send(body);

export function createRemindersRouter(service: ReminderService, o: RemindersRouterOptions): Router {
  const router = express.Router();
  const nonces = new EventStore(1, 24 * 3600_000);
  const callbackBody = [
    express.urlencoded({ extended: false, limit: MAX_BODY }),
    express.json({ limit: MAX_BODY }),
  ];

  /** "ok" | "invalid_token" | "bad_signature" for a Vobiz callback on /r/:token/<leg>. */
  function check(req: Request, leg: string): "ok" | "invalid_token" | "bad_signature" {
    const token = String(req.params.token ?? "");
    if (!TOKEN_RE.test(token)) return "invalid_token";
    const a = o.sealer.open<AnswerPayload>("ans", token);
    if (!a || typeof a.authToken !== "string") return "invalid_token";
    if (o.signatureMode === "off") return "ok";
    const v = verifySignature(req.headers, baseUrlFor(o.baseUrl, `/r/${token}/${leg}`), a.authToken);
    if (v.present && !v.valid) return "bad_signature";
    if (!v.present && o.signatureMode === "require") return "bad_signature";
    const nonce = v.present ? nonceOf(req.headers) : undefined;
    if (nonce && nonces.nonceReused(`${leg}:${nonce}`)) return "bad_signature";
    return "ok";
  }

  router.post("/jobs/fire", express.text({ type: () => true, limit: "16kb" }), async (req: Request, res: Response) => {
    const token = typeof req.body === "string" ? req.body.trim() : "";
    // Cloud Tasks retries every non-2xx, so only a transient failure answers 503.
    const result = await service.fire(token).catch(() => ({ fired: false, reason: "transient" }));
    res.status(result.reason === "transient" ? 503 : 200).set("Cache-Control", "no-store").json(result);
  });

  router.all("/r/:token/answer", ...callbackBody, async (req: Request, res: Response) => {
    if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();
    const c = check(req, "answer");
    if (c === "bad_signature") return res.status(403).type("text/plain").send("invalid signature");
    if (c === "invalid_token") return xml(res, inactiveScript());
    try {
      return xml(res, (await service.answerXml(String(req.params.token))) ?? inactiveScript());
    } catch {
      return res.status(503).type("text/plain").send("temporarily unavailable");
    }
  });

  router.post("/r/:token/input", ...callbackBody, async (req: Request, res: Response) => {
    const c = check(req, "input");
    if (c === "bad_signature") return res.status(403).type("text/plain").send("invalid signature");
    if (c === "invalid_token") return xml(res, inactiveScript());
    try {
      const p = params(req);
      return xml(res, (await service.inputXml(String(req.params.token), p.Digits ?? "", p.Speech ?? "")) ?? inactiveScript());
    } catch {
      return res.status(503).type("text/plain").send("temporarily unavailable");
    }
  });

  router.post("/r/:token/hangup", ...callbackBody, async (req: Request, res: Response) => {
    const c = check(req, "hangup");
    if (c === "bad_signature") return res.status(403).type("text/plain").send("invalid signature");
    if (c === "invalid_token") return res.status(400).type("text/plain").send("invalid token");
    try {
      await service.hangup(String(req.params.token), params(req) as HangupParams);
      return res.status(204).end();
    } catch {
      return res.status(503).type("text/plain").send("temporarily unavailable");
    }
  });

  // Malformed bodies (bad JSON, too large) are client errors, never 500.
  router.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 400;
    res.status(status >= 400 && status < 500 ? status : 400).type("text/plain").send("bad request");
  });

  return router;
}
