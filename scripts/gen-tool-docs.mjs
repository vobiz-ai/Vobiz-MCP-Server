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
// Hand-written examples appended after a tool's input table (kept here so regeneration does not drop them).
const EXAMPLES = {
  make_call: `### Examples

*"Call +919876543210 and play my alarm"*: \`play\` takes the name of a file in the audio library (or a direct https .mp3/.wav link). The call plays it, then hangs up.

\`\`\`json
{ "to": "+919876543210", "from": "+918012345678", "play": "Morning alarm", "confirm": true, "idempotency_key": "alarm-2026-10-20-0700" }
\`\`\`

*"Call +919876543210 and say 'Your table is ready'"*:

\`\`\`json
{ "to": "+919876543210", "from": "+918012345678", "say": "Your table is ready.", "language": "en-IN", "confirm": true, "idempotency_key": "table-ready-0042" }
\`\`\`

Both together play first by default (\`order: "say_then_play"\` reverses it). \`loop\` repeats the audio (0..10; 0 = until hangup, and speech then comes first). Page links (Pixabay, YouTube, Spotify, SoundCloud) are refused: \`play\` needs a direct audio file link. The result carries \`script\` (\`{ say, play: "library:<name>" | "url", loop }\`) and \`how_to\`. Without \`answer_url\`, \`say\` or \`play\`, the call uses the placeholder answer URL, which only speaks a short greeting and ends (\`script: { placeholder: true }\`). \`say\` / \`play\` are served by the hosted connector at \`/c/:token/answer\`; elsewhere, pass your own \`answer_url\`.
`,
};
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
  if (EXAMPLES[t.name]) md += `\n${EXAMPLES[t.name]}`;
}
writeFileSync(new URL("../docs/TOOLS.md", import.meta.url), md);
console.log(`wrote docs/TOOLS.md (${tools.length} tools)`);
await client.close();
