/**
 * MCP Server Card (draft extension, https://github.com/modelcontextprotocol/ext-server-card): a static JSON document
 * that lets a client discover and connect to the hosted connector before any MCP exchange. It names the server, its
 * version, the Streamable HTTP endpoint and the protocol versions the SDK speaks. It deliberately lists no tools:
 * those come from tools/list once connected.
 *
 * Served (no auth, public, cacheable for an hour) at
 *   GET <streamable-http-url>/server-card           the location the extension reserves, e.g. /mcp/server-card
 *   GET /.well-known/mcp/server-card.json           a site-wide alias some scanners look for
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Request, Response } from "express";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { SERVER_VERSION } from "./version.js";

export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
/** Reverse-DNS server name (exactly one slash). */
export const SERVER_CARD_NAME = "ai.vobiz/mcp";
/** At most 100 characters (schema maxLength). */
export const SERVER_CARD_DESCRIPTION = "Calls, call control, conferences, records, numbers, SIP and SMS on your own Vobiz account.";
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";

export interface ServerCard {
  $schema: string;
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { source: string; url: string };
  icons: { src: string; mimeType: string; sizes: string[] }[];
  remotes: { type: "streamable-http"; url: string; supportedProtocolVersions: string[] }[];
}

/** package.json `repository.url` as a browsable https URL (git+https://host/org/repo.git -> https://host/org/repo). */
function repositoryUrl(): string {
  const pkg = createRequire(import.meta.url)("../package.json") as { repository?: { url?: string } };
  return (pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
}

/** The card for one deployment: every URL comes from the config and the public base URL, never from a constant. */
export function buildServerCard(o: { cfg: Config; mcpUrl: URL; iconUrl: URL }): ServerCard {
  const repo = repositoryUrl();
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: SERVER_CARD_NAME,
    title: "Vobiz",
    description: SERVER_CARD_DESCRIPTION,
    version: SERVER_VERSION,
    websiteUrl: new URL(o.cfg.links.docs).href,
    repository: { source: /^https:\/\/github\.com\//.test(repo) ? "github" : "git", url: repo },
    icons: [{ src: o.iconUrl.href, mimeType: "image/svg+xml", sizes: ["any"] }],
    remotes: [{ type: "streamable-http", url: o.mcpUrl.href, supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] }],
  };
}

/**
 * An Express handler for the card: public (CORS *), cacheable for an hour, with an ETag honoured on If-None-Match.
 * The body is application/json unless the client asks for the extension's media type in Accept.
 */
export function serverCardHandler(card: ServerCard): (req: Request, res: Response) => void {
  const body = JSON.stringify(card, null, 2);
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  return (req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
      "Access-Control-Expose-Headers": "ETag",
      "Cache-Control": "public, max-age=3600",
      ETag: etag,
    });
    const ifNoneMatch = req.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return void res.status(304).end();
    const wantsCardType = (req.get("accept") ?? "").toLowerCase().includes(SERVER_CARD_MEDIA_TYPE);
    res.status(200).type(wantsCardType ? SERVER_CARD_MEDIA_TYPE : "application/json").send(body);
  };
}
