#!/usr/bin/env node
// Regenerates docs/TOOLS.md from the live tool registry (npm run docs:tools).
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { silentLogger } from "../dist/logger.js";
import { createServer } from "../dist/server.js";

// The reminder tools register only when a ReminderService is present (hosted connector); a stub with the
// default limits is enough to list them. Nothing is ever scheduled here.
const reminders = { limits: { maxActive: 20, maxCallsPerDay: 10, maxDaysAhead: 30 } };
// Likewise the audio library tools need a MediaService (limits only) and upload-link minting; nothing is stored.
const media = { limits: { maxInputBytes: 15 * 1024 * 1024, maxDurationSec: 300, maxPerAccount: 50, maxUploadsPerDay: 20 } };
const mediaUploads = { url: () => "https://mcp.vobiz.ai/upload/vbzu_example" };
const server = createServer(loadConfig({ VOBIZ_LOG_LEVEL: "silent" }), silentLogger, undefined, { reminders, media, mediaUploads });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "docs", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);
const { tools } = await client.listTools();
const kind = (t) => (t.annotations?.readOnlyHint ? "read-only" : t.annotations?.destructiveHint ? "**write, destructive**" : "write");
let md = `# Vobiz MCP tool reference\n\nGenerated from the tool registry (${tools.length} tools). Regenerate with \`npm run docs:tools\`.\n\n`;
md += "| Tool | Kind | Required inputs |\n|---|---|---|\n";
for (const t of tools) md += `| \`${t.name}\` | ${kind(t)} | ${(t.inputSchema.required ?? []).map((r) => `\`${r}\``).join(", ") || "—"} |\n`;
for (const t of tools) {
  md += `\n## ${t.name}\n\n${t.description}\n\n| Input | Type | Required | Notes |\n|---|---|---|---|\n`;
  for (const [k, v] of Object.entries(t.inputSchema.properties ?? {})) {
    const type = v.enum ? v.enum.map((e) => `\`${e}\``).join(" \| ") : v.type ?? (v.anyOf ? v.anyOf.map((x) => x.type ?? (x.const !== undefined ? JSON.stringify(x.const) : "")).join("\|") : "object");
    const extra = [v.description, v.pattern ? `pattern \`${v.pattern}\`` : "", v.minimum !== undefined ? `min ${v.minimum}` : "", v.maximum !== undefined ? `max ${v.maximum}` : ""].filter(Boolean).join("; ");
    md += `| \`${k}\` | ${type} | ${(t.inputSchema.required ?? []).includes(k) ? "yes" : ""} | ${extra.replace(/\|/g, "\|")} |\n`;
  }
}
writeFileSync(new URL("../docs/TOOLS.md", import.meta.url), md);
console.log(`wrote docs/TOOLS.md (${tools.length} tools)`);
await client.close();
