#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServer, SERVER_VERSION, TOOLSET_NAMES } from "./server.js";

const HELP = `Vobiz MCP server ${SERVER_VERSION} (stdio)

Usage: npx -y @vobiz/mcp            run over stdio for an MCP client
       npx -y @vobiz/mcp http       single-account Streamable HTTP server
       npx -y @vobiz/mcp hosted     hosted multi-tenant connector (OAuth)

Required: VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN
Enable actions: VOBIZ_ENABLE_CALLS, VOBIZ_ENABLE_MESSAGING, VOBIZ_ENABLE_PROVISIONING
Limit tools: VOBIZ_TOOLSETS=${TOOLSET_NAMES.join(",")}   VOBIZ_READ_ONLY=true
All settings: https://github.com/vobiz-ai/Vobiz-MCP-Server#configuration
`;

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (arg === "http") return (await import("./http.js")).runHttp();
  if (arg === "hosted") return (await import("./hosted.js")).runHosted();
  let cfg;
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
  if (!cfg.authId || !cfg.authToken) {
    log.info("VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN not set: tools will return missing_credentials.");
  }
  log.info(`starting against ${cfg.baseUrl}; outbound calling ${cfg.enableCalls ? "ENABLED" : "disabled"}`);
  const server = createServer(cfg, log);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[vobiz-mcp] fatal error during startup: ${err instanceof Error ? err.message : "unknown"}\n`);
  process.exit(1);
});
