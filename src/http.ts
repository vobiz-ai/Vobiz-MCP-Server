#!/usr/bin/env node
/**
 * HTTP entry point for remote MCP clients (e.g. a claude.ai custom connector through a tunnel).
 *
 *   POST/GET/DELETE /mcp/<secret>        Streamable HTTP transport (current MCP spec)
 *   GET  /sse/<secret>                   Legacy SSE transport (stream)
 *   POST /message/<secret>?sessionId=…   Legacy SSE transport (client → server messages)
 *   GET|POST /answer                     Vobiz answer XML for calls placed by make_call
 *   GET  /health                         Liveness probe (no data)
 *
 * The MCP endpoints sit behind a long random path secret (VOBIZ_HTTP_SECRET), because anyone who
 * can reach them can act on the Vobiz account. Tools that act on calls are omitted unless
 * VOBIZ_REMOTE_ALLOW_CALLS=true.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createServer, createSharedState } from "./server.js";
import { baseUrlFor, nonceOf, pickFields, verifySignature } from "./webhooks.js";

export interface HttpOptions {
  cfg: Config;
  log: Logger;
  secret: string;
  readOnly: boolean;
  answerText: string;
  fetchImpl?: typeof fetch;
}

const MAX_SSE_SESSIONS = 20;

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string);

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_CALLBACK_BODY = 64 * 1024;

/** Callback parameters: query string for GET, form-urlencoded or JSON body for POST. undefined = too large. */
async function readParams(req: http.IncomingMessage, url: URL): Promise<Record<string, unknown> | undefined> {
  const out: Record<string, unknown> = Object.fromEntries(url.searchParams);
  if (req.method !== "POST") return out;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_CALLBACK_BODY) return undefined;
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return out;
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) Object.assign(out, j);
    } catch {
      /* ignore malformed JSON: no fields */
    }
  } else {
    Object.assign(out, Object.fromEntries(new URLSearchParams(raw)));
  }
  return out;
}

export function createHttpHandler(opts: HttpOptions): http.RequestListener {
  const { cfg, log } = opts;
  const shared = createSharedState(cfg, true);
  const newServer = () => createServer(cfg, log, opts.fetchImpl, { readOnly: opts.readOnly, shared });
  const sse = new Map<string, SSEServerTransport>();
  const answerXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Speak>${escapeXml(opts.answerText)}</Speak>\n</Response>\n`;

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/health" && req.method === "GET") return json(res, 200, { ok: true });

      if (url.pathname === "/answer" && (req.method === "GET" || req.method === "POST")) {
        req.resume(); // Vobiz posts call parameters; we don't need them
        res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(answerXml);
      }

      // ── Vobiz-facing endpoints: hosted flows, Gather callbacks, webhooks ──
      const isFlow = parts[0] === "xml" && (parts[1] === "flow" || parts[1] === "gather") && parts.length === 3 && /^[0-9a-f]{32}$/.test(parts[2]);
      const isWebhook = url.pathname === "/webhooks/vobiz";
      if (isFlow || isWebhook) {
        if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
        if (!shared.flows || !shared.events || !cfg.authToken) {
          return json(res, 503, { error: "hosting_unavailable", message: "Set VOBIZ_PUBLIC_URL and credentials to serve Vobiz callbacks." });
        }
        const body = await readParams(req, url);
        if (body === undefined) return json(res, 413, { error: "body_too_large" });

        // Signature: Vobiz signs the URL it was given (our public URL + path), not the body.
        let verified = false;
        if (cfg.webhookSignature !== "off") {
          const v = verifySignature(req.headers, baseUrlFor(cfg.publicUrl as string, url.pathname), cfg.authToken);
          if (v.present && !v.valid) {
            log.info(`rejected ${parts[0]}/${parts[1] ?? ""} callback: ${v.reason}`);
            return json(res, 401, { error: "invalid_signature" });
          }
          if (!v.present && cfg.webhookSignature === "require") {
            log.info(`rejected ${parts[0]}/${parts[1] ?? ""} callback: unsigned`);
            return json(res, 401, { error: "signature_required" });
          }
          verified = v.valid;
          const nonce = nonceOf(req.headers);
          if (verified && nonce && shared.events.nonceReused(nonce)) {
            log.info("rejected callback: reused signature nonce (replay)");
            return json(res, 409, { error: "replayed_request" });
          }
        }

        const fields = pickFields(body);
        if (isWebhook) {
          const r = shared.events.add(fields, verified);
          return json(res, 200, { ok: true, duplicate: r.duplicate, id: r.event.id });
        }
        const id = parts[2];
        if (parts[1] === "flow") {
          const xml = shared.flows.getXml(id);
          if (!xml) return json(res, 404, { error: "not_found" });
          shared.events.add({ ...fields, Event: fields.Event ?? "FlowFetched", FlowId: id }, verified, "flow");
          res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(xml);
        }
        const { duplicate } = shared.events.add({ ...fields, Event: "GatherInput", FlowId: id }, verified, "gather");
        const next = duplicate
          ? shared.flows.recordGatherReplay(id)
          : shared.flows.recordGather(id, {
              digits: fields.Digits ?? "",
              input_type: fields.InputType ?? null,
              speech: fields.Speech ?? null,
              call_uuid: fields.CallUUID ?? null,
              received_at: new Date().toISOString(),
              signature_verified: verified,
            });
        if (!next) return json(res, 404, { error: "not_found" });
        res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(next);
      }

      const [route, secret] = parts;
      if (!["mcp", "sse", "message"].includes(route ?? "") || parts.length !== 2 || !secretMatches(secret, opts.secret)) {
        // Same answer for a wrong secret and an unknown path: nothing to probe.
        return json(res, 404, { error: "not_found" });
      }

      if (route === "mcp") {
        // Stateless Streamable HTTP: a fresh server + transport per request.
        const server = newServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      if (route === "sse" && req.method === "GET") {
        if (sse.size >= MAX_SSE_SESSIONS) return json(res, 503, { error: "too_many_sessions" });
        const transport = new SSEServerTransport(`/message/${opts.secret}`, res);
        sse.set(transport.sessionId, transport);
        const server = newServer();
        res.on("close", () => {
          sse.delete(transport.sessionId);
          server.close().catch(() => {});
        });
        log.info(`sse session opened (${sse.size} active)`);
        await server.connect(transport);
        return;
      }

      if (route === "message" && req.method === "POST") {
        const transport = sse.get(url.searchParams.get("sessionId") ?? "");
        if (!transport) return json(res, 404, { error: "unknown_session" });
        await transport.handlePostMessage(req, res);
        return;
      }

      json(res, 405, { error: "method_not_allowed" });
    } catch {
      log.info(`http handler error on /${parts[0] ?? ""}`);
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      else res.end();
    }
  };
}

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[vobiz-mcp] configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(cfg.logLevel);

  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write("[vobiz-mcp] PORT must be a valid TCP port\n");
    process.exit(1);
  }

  let secret = process.env.VOBIZ_HTTP_SECRET?.trim() ?? "";
  if (secret && !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) {
    process.stderr.write("[vobiz-mcp] VOBIZ_HTTP_SECRET must be 32-128 characters of A-Z a-z 0-9 _ -\n");
    process.exit(1);
  }
  const secretFromEnv = !!secret;
  if (!secret && cfg.environment === "production") {
    process.stderr.write("[vobiz-mcp] VOBIZ_HTTP_SECRET is required when VOBIZ_ENV=production\n");
    process.exit(1);
  }
  if (!secret) {
    secret = randomBytes(24).toString("hex");
    log.info("VOBIZ_HTTP_SECRET not set: generated a one-off secret for this run (set it in .env to keep the URL stable).");
  }

  const readOnly = !["1", "true", "yes", "on"].includes((process.env.VOBIZ_REMOTE_ALLOW_CALLS ?? "").trim().toLowerCase());
  const publicUrl = cfg.publicUrl;
  if (!cfg.defaultAnswerUrl && publicUrl) cfg.defaultAnswerUrl = `${publicUrl}/answer`;
  const answerText = process.env.VOBIZ_ANSWER_TEXT?.trim() || "Connecting your call via Vobiz operational MCP.";

  const host = process.env.HOST?.trim() || "127.0.0.1";
  const server = http.createServer(createHttpHandler({ cfg, log, secret, readOnly, answerText }));
  server.listen(port, host, () => {
    const base = publicUrl || `http://localhost:${port}`;
    // The secret URLs go to the operator's terminal only (stderr), never to logs of requests.
    process.stderr.write(
      [
        `[vobiz-mcp] HTTP server listening on http://${host}:${port}`,
        `[vobiz-mcp] calls tools: ${readOnly ? "OFF (read-only; set VOBIZ_REMOTE_ALLOW_CALLS=true to enable)" : "ON"}; outbound calling ${cfg.enableCalls ? "enabled" : "disabled"}`,
        // A configured secret is never echoed (logs may be collected); a generated one must be shown once.
        `[vobiz-mcp] Streamable HTTP: ${base}/mcp/${secretFromEnv ? "<VOBIZ_HTTP_SECRET>" : secret}`,
        `[vobiz-mcp] SSE (legacy):    ${base}/sse/${secretFromEnv ? "<VOBIZ_HTTP_SECRET>" : secret}`,
        `[vobiz-mcp] Answer XML:      ${base}/answer`,
        `[vobiz-mcp] Keep these MCP URLs private: anyone with them can use this Vobiz account.`,
        "",
      ].join("\n"),
    );
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("[vobiz-mcp] fatal error during startup\n");
    process.exit(1);
  });
}
