/**
 * Vobiz Agent Skills bundled with the server (skills/<name>/SKILL.md, synced from the Vobiz docs).
 * Exposed three ways so every MCP client can use them:
 *   - tools  list_vobiz_skills / get_vobiz_skill (work in every client, including ones without resources)
 *   - resources  vobiz://skills/<name> (+ vobiz://skills/index)
 *   - prompts  one per skill, e.g. vobiz-voice-calls, with an optional `task` argument
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VobizError } from "./errors.js";
import { handler, ok } from "./util.js";

export interface Skill {
  name: string;
  description: string;
  /** Full SKILL.md, frontmatter included. */
  content: string;
  /** SKILL.md without frontmatter. */
  body: string;
  /** Other files shipped with the skill (relative paths), e.g. references/*.md. */
  files: string[];
}

const DEFAULT_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

function frontmatterField(md: string, key: string): string | undefined {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1];
  const line = fm && new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm)?.[1];
  return line?.trim().replace(/^["']|["']$/g, "");
}

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`, `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

export function loadSkills(dir = DEFAULT_DIR): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${e.name}/SKILL.md`;
    if (!e.isDirectory() || !existsSync(file)) continue;
    const content = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    out.push({
      name: frontmatterField(content, "name") ?? e.name,
      description: frontmatterField(content, "description") ?? "",
      content,
      body: content.replace(/^---\n[\s\S]*?\n---\n*/, ""),
      files: walk(`${dir}/${e.name}`).filter((f) => f !== "SKILL.md"),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Splits a skill body into `## ` sections so an agent can load only the part it needs. */
function sections(body: string): { heading: string; text: string }[] {
  const parts = body.split(/^(?=## )/m);
  return parts.map((p) => ({ heading: (/^## (.+)$/m.exec(p)?.[1] ?? "Overview").trim(), text: p.trim() }));
}

export function registerSkills(server: McpServer, skills: Skill[] = loadSkills()): void {
  if (!skills.length) return;
  const byName = new Map(skills.map((s) => [s.name, s]));
  const names = skills.map((s) => s.name) as [string, ...string[]];
  const index = () =>
    skills.map((s) => ({ name: s.name, description: s.description, uri: `vobiz://skills/${s.name}`, sections: sections(s.body).map((x) => x.heading) }));

  server.registerTool(
    "list_vobiz_skills",
    {
      title: "List Vobiz skills",
      description:
        "List the Vobiz Agent Skills bundled with this server: expert playbooks for each Vobiz product (voice calls, VobizXML, SIP trunking, phone numbers, CDRs, " +
        "audio streams, AI voice agents, SMS/MMS/RCS, WhatsApp, sub-accounts, Partner API, Plivo migration, solution scoping). " +
        "Each one can be loaded with get_vobiz_skill when planning a multi-step task or writing integration code. Read-only, no API call.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async () => ok({ ok: true, count: skills.length, skills: index() })),
  );

  server.registerTool(
    "get_vobiz_skill",
    {
      title: "Load a Vobiz skill",
      description:
        "Return the instructions of one Vobiz Agent Skill (endpoints, request shapes, VobizXML rules, pitfalls). Pass `section` to load only one `##` section " +
        "(names come from list_vobiz_skills). Read-only, no API call.",
      inputSchema: {
        name: z.enum(names).describe("Skill name from list_vobiz_skills, e.g. vobiz-voice-calls."),
        section: z.string().max(200).optional().describe("Optional `##` heading to return instead of the whole skill (case-insensitive prefix match)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async ({ name, section }) => {
      const s = byName.get(name);
      if (!s) throw new VobizError("not_found", `No skill named ${name}. Use list_vobiz_skills.`);
      if (section) {
        const want = section.toLowerCase();
        const hit = sections(s.body).find((x) => x.heading.toLowerCase().startsWith(want));
        if (!hit) {
          throw new VobizError("not_found", `Skill ${name} has no section "${section}". Sections: ${sections(s.body).map((x) => x.heading).join(", ")}.`);
        }
        return ok({ ok: true, name, description: s.description, section: hit.heading, instructions: hit.text });
      }
      return ok({ ok: true, name, description: s.description, instructions: s.body, files: s.files });
    }),
  );

  server.registerResource(
    "vobiz-skills-index",
    "vobiz://skills/index",
    { title: "Vobiz skills index", description: "Every bundled Vobiz Agent Skill with its description and sections.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(index(), null, 2) }] }),
  );

  server.registerResource(
    "vobiz-skill",
    new ResourceTemplate("vobiz://skills/{name}", {
      list: async () => ({
        resources: skills.map((s) => ({ uri: `vobiz://skills/${s.name}`, name: s.name, title: s.name, description: s.description, mimeType: "text/markdown" })),
      }),
      complete: { name: (v) => names.filter((n) => n.startsWith(v)) },
    }),
    { title: "Vobiz skill", description: "One Vobiz Agent Skill (SKILL.md).", mimeType: "text/markdown" },
    async (uri, { name }) => {
      const s = byName.get(String(name));
      if (!s) throw new VobizError("not_found", `No skill named ${String(name)}.`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: s.content }] };
    },
  );

  for (const s of skills) {
    server.registerPrompt(
      s.name,
      {
        title: s.name.replace(/^vobiz-/, "Vobiz ").replace(/-/g, " "),
        description: s.description,
        argsSchema: { task: z.string().optional().describe("What you want to build or do, e.g. 'call +919876543210 and play a message'.") },
      },
      ({ task }) => ({
        description: s.description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Follow this Vobiz skill. Use the vobiz MCP tools for live account operations and confirm any action that spends money or contacts a real person before running it.\n\n` +
                `<skill name="${s.name}">\n${s.body}\n</skill>` +
                (task ? `\n\nTask: ${task}` : ""),
            },
          },
        ],
      }),
    );
  }
}
