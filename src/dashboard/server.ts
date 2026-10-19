#!/usr/bin/env node
/**
 * Local read-only dashboard for the Vobiz Operational MCP server.
 *
 * Browser ──HTTP (127.0.0.1 only, per-run token)──▶ this process ──MCP stdio──▶ vobiz-mcp (dist/index.js) ──▶ api.vobiz.ai
 *
 * The dashboard is an ordinary MCP client: it lists and calls the same tools Claude uses,
 * so validation, tenant scoping, redaction and error mapping are identical. Only read-only
 * tools are reachable from the browser, and the child server is started with calling disabled.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const READ_ONLY_TOOLS = new Set([
  "get_call_status",
  "get_call_details",
  "list_call_records",
  "list_live_calls",
  "get_call_recording",
  "list_recordings",
  "list_phone_numbers",
  "get_phone_number_details",
  "get_number_health",
  "get_account_details",
  "get_account_balance",
  "get_concurrency",
  "list_sip_trunks",
  "get_sip_trunk",
]);

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: unknown }>;
  info(): { connected: boolean; server?: string; version?: string };
}

const MAX_BODY = 16 * 1024;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const here = path.dirname(fileURLToPath(import.meta.url));
// dist/dashboard/server.js → <repo>/dashboard/public
export const PUBLIC_DIR = path.resolve(here, "..", "..", "dashboard", "public");

const STATIC: Record<string, { file: string; type: string }> = {
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.cdnfonts.com; font-src https://fonts.cdnfonts.com; " +
    "img-src 'self' data:; media-src https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export function createDashboardHandler(opts: {
  caller: ToolCaller;
  token: string;
  port: number;
  authId?: string;
  publicDir?: string;
}): http.RequestListener {
  const publicDir = opts.publicDir ?? PUBLIC_DIR;
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
    res.end(body);
  };
  const sendJson = (res: http.ServerResponse, status: number, body: unknown) =>
    send(res, status, JSON.stringify(body), "application/json; charset=utf-8");

  return async (req, res) => {
    try {
      // DNS-rebinding guard: only answer to our own loopback host names.
      if (!req.headers.host || !allowedHosts.has(req.headers.host)) {
        return sendJson(res, 421, { error: "misdirected_request" });
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = await readFile(path.join(publicDir, "index.html"), "utf8");
        return send(
          res,
          200,
          html.replace("__DASHBOARD_TOKEN__", opts.token).replace("__AUTH_ID__", escapeHtml(opts.authId ?? "not configured")),
          "text/html; charset=utf-8",
        );
      }
      if (req.method === "GET" && STATIC[url.pathname]) {
        const s = STATIC[url.pathname];
        return send(res, 200, await readFile(path.join(publicDir, s.file)), s.type);
      }

      if (url.pathname.startsWith("/api/")) {
        // CSRF guard: a per-run secret only our page knows, sent as a custom header.
        if (req.headers["x-dashboard-token"] !== opts.token) return sendJson(res, 403, { error: "forbidden" });

        if (req.method === "GET" && url.pathname === "/api/health") {
          return sendJson(res, 200, { ...opts.caller.info(), auth_id: opts.authId ?? null });
        }

        const m = url.pathname.match(/^\/api\/tools\/([a-z_]+)$/);
        if (req.method === "POST" && m) {
          const name = m[1];
          if (!READ_ONLY_TOOLS.has(name)) return sendJson(res, 403, { error: "tool_not_allowed", tool: name });
          if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
            return sendJson(res, 415, { error: "json_required" });
          }
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > MAX_BODY) return sendJson(res, 413, { error: "body_too_large" });
            chunks.push(chunk as Buffer);
          }
          let args: unknown = {};
          const raw = Buffer.concat(chunks).toString("utf8");
          if (raw) {
            try {
              args = JSON.parse(raw);
            } catch {
              return sendJson(res, 400, { error: "invalid_json" });
            }
          }
          if (!args || typeof args !== "object" || Array.isArray(args)) return sendJson(res, 400, { error: "invalid_args" });
          const result = await opts.caller.callTool(name, args as Record<string, unknown>);
          return sendJson(res, 200, result);
        }
      }

      sendJson(res, 404, { error: "not_found" });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: "dashboard_error", message: "The dashboard could not complete the request." });
      else res.end();
    }
  };
}

/** Starts vobiz-mcp as a child MCP server (calling disabled) and wraps it as a ToolCaller. */
export async function connectToOpsServer(): Promise<ToolCaller & { close(): Promise<void> }> {
  const entry = path.resolve(here, "..", "index.js");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.VOBIZ_ENABLE_CALLS = "false";

  const client = new Client({ name: "vobiz-mcp-dashboard", version: "1.0.0" });
  let connected = false;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "inherit" });
  transport.onclose = () => {
    connected = false;
  };
  await client.connect(transport);
  connected = true;

  return {
    async callTool(name, args) {
      if (!connected) {
        return { isError: true, data: { ok: false, error: "service_unavailable", message: "The Vobiz MCP server is not running. Restart the dashboard." } };
      }
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };
      let data = r.structuredContent;
      if (data === undefined) {
        try {
          data = JSON.parse(r.content?.[0]?.text ?? "{}");
        } catch {
          data = { ok: !r.isError, message: r.content?.[0]?.text ?? "" };
        }
      }
      return { isError: !!r.isError, data };
    },
    info() {
      const v = client.getServerVersion();
      return { connected, server: v?.name, version: v?.version };
    },
    close: () => client.close(),
  };
}

async function main(): Promise<void> {
  const port = Number(process.env.DASHBOARD_PORT ?? 5178);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    process.stderr.write("[dashboard] DASHBOARD_PORT must be between 1024 and 65535\n");
    process.exit(1);
  }
  const caller = await connectToOpsServer();
  const token = randomBytes(24).toString("hex");
  const server = http.createServer(
    createDashboardHandler({ caller, token, port, authId: process.env.VOBIZ_AUTH_ID?.trim() || undefined }),
  );
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[dashboard] Vobiz Ops dashboard on http://127.0.0.1:${port}  (read-only, local only)\n`);
  });
  const stop = async () => {
    server.close();
    await caller.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[dashboard] failed to start: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exit(1);
  });
}
