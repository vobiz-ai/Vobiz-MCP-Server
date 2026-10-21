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

  // Output shapes: every field optional so validation never fails; ok is a boolean because clients validate error results too.
  const okOut = z.boolean().optional().describe("true on success; false (with error and message) when the tool failed.");

  server.registerTool(
    "list_vobiz_skills",
    {
      title: "List Vobiz skills",
      description:
        "List the Vobiz Agent Skills bundled with this server: documentation playbooks (Markdown reference text synced from the Vobiz docs) that explain how to build on each Vobiz product with the REST API and VobizXML. " +
        "Each entry gives the skill's name, one-line description, resource URI and its `##` section headings; read the text with get_vobiz_skill before planning a multi-step task or writing integration code. " +
        "The skills are reading material only: a skill about a product does not mean this server has operational tools for it, and the live-account tools are the other tools in this list. " +
        "Local lookup, no Vobiz API request.",
      inputSchema: {},
      outputSchema: z
        .object({
          ok: okOut,
          count: z.number().optional().describe("Number of bundled skills."),
          skills: z
            .array(
              z
                .object({
                  name: z.string().optional().describe("Skill name to pass to get_vobiz_skill, e.g. vobiz-voice-calls."),
                  description: z.string().optional().describe("One line on what the skill covers."),
                  uri: z.string().optional().describe("Resource URI of the same text (vobiz://skills/<name>) for clients that read resources."),
                  sections: z.array(z.string()).optional().describe("The skill's `##` headings, usable as the section argument of get_vobiz_skill."),
                })
                .passthrough(),
            )
            .optional()
            .describe("The bundled skills, sorted by name."),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async () => ok({ ok: true, count: skills.length, skills: index() })),
  );

  server.registerTool(
    "get_vobiz_skill",
    {
      title: "Load a Vobiz skill",
      description:
        "Return the Markdown text of one bundled Vobiz Agent Skill: a documentation playbook with endpoints, request shapes, VobizXML rules and pitfalls to read before building something on Vobiz. " +
        "Pass `section` to get one `##` section instead of the whole text; an unknown section fails with not_found and the error lists the available headings. " +
        "It returns text and performs nothing on the account; use list_vobiz_skills to see which skills and sections exist, and the operational tools for live actions. " +
        "Local lookup, no Vobiz API request.",
      inputSchema: {
        name: z.enum(names).describe("Skill name from list_vobiz_skills, e.g. vobiz-voice-calls."),
        section: z.string().max(200).optional().describe("Optional `##` heading to return instead of the whole skill (case-insensitive prefix match on the headings list_vobiz_skills shows)."),
      },
      outputSchema: z
        .object({
          ok: okOut,
          name: z.string().optional().describe("The skill that was loaded."),
          description: z.string().optional().describe("Its one-line description."),
          section: z.string().optional().describe("The matched heading, present only when section was passed."),
          instructions: z.string().optional().describe("The skill text (whole body, or the one section) as Markdown."),
          files: z.array(z.string()).optional().describe("Other files shipped with the skill (relative paths such as references/*.md); present only for the whole skill."),
        })
        .passthrough(),
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
