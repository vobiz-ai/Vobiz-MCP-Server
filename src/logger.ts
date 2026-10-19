import type { Config } from "./config.js";

/**
 * Logs go to stderr only: stdout carries the MCP stdio protocol.
 * Callers pass route labels, never headers, tokens or phone numbers.
 */
export interface Logger {
  info(msg: string): void;
  debug(msg: string): void;
}

export function createLogger(level: Config["logLevel"]): Logger {
  const write = (lvl: string, msg: string) => process.stderr.write(`[vobiz-mcp] ${lvl} ${msg}\n`);
  return {
    info: (msg) => {
      if (level !== "silent") write("info", msg);
    },
    debug: (msg) => {
      if (level === "debug") write("debug", msg);
    },
  };
}

export const silentLogger: Logger = { info: () => {}, debug: () => {} };
