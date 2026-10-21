/**
 * Tool-definition coverage report: starts the server in-process (every toolset, with fake reminder and media
 * services so the hosted-only tools register too), lists the tools exactly as a client sees them and prints
 *   - parameter description coverage (Glama's Parameter Semantics baseline needs >= 80% per tool)
 *   - parameters without a `.describe()`
 *   - descriptions that still end with "Read-only" (restates readOnlyHint, earns nothing)
 *   - tools without an outputSchema
 *
 * Usage (after `npm run build`):
 *   node scripts/tool-definition-coverage.mjs
 *   ONLY=list_sub_accounts,get_sub_account node scripts/tool-definition-coverage.mjs   # a subset
 * Informational only: it always exits 0. The deterministic TDQS checklist is `npm run tdqs:lint`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { silentLogger } from "../dist/logger.js";
import { createServer } from "../dist/server.js";

const reminders = { limits: { maxActive: 20, maxCallsPerDay: 10, maxDaysAhead: 30 } };
const media = { limits: { maxInputBytes: 1, maxDurationSec: 1, maxPerAccount: 1, maxUploadsPerDay: 1 } };
const server = createServer(loadConfig({ VOBIZ_LOG_LEVEL: "silent" }), silentLogger, undefined, { reminders, media, mediaUploads: { url: () => "x" } });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "tool-definition-coverage", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);
const { tools } = await client.listTools();
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

const undocumented = [];
const readOnlySuffix = [];
const noOutputSchema = [];
const lowCoverage = [];
let total = 0;
let withDesc = 0;
for (const t of tools) {
  if (only && !only.has(t.name)) continue;
  const props = t.inputSchema.properties ?? {};
  const n = Object.keys(props).length;
  const d = Object.values(props).filter((p) => p.description).length;
  total += n;
  withDesc += d;
  for (const [k, p] of Object.entries(props)) if (!p.description) undocumented.push(`${t.name}.${k}`);
  if (/Read-only\.?(\s|$)/.test(t.description ?? "")) readOnlySuffix.push(t.name);
  if (!t.outputSchema) noOutputSchema.push(t.name);
  const cov = n ? Math.round((100 * d) / n) : 100;
  if (cov < 80) lowCoverage.push(`${t.name} ${cov}%`);
}

console.log(`tools ${only ? only.size : tools.length} | params ${total} | described ${withDesc} (${total ? Math.round((100 * withDesc) / total) : 100}%)`);
console.log(`tools under 80% coverage (${lowCoverage.length}): ${lowCoverage.join(", ") || "none"}`);
console.log(`undocumented params (${undocumented.length}): ${undocumented.join(", ") || "none"}`);
console.log(`"Read-only" suffix (${readOnlySuffix.length}): ${readOnlySuffix.join(", ") || "none"}`);
console.log(`no outputSchema (${noOutputSchema.length}): ${noOutputSchema.join(", ") || "none"}`);
await client.close();
