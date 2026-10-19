#!/usr/bin/env node
// Copies the Vobiz Agent Skills from the docs repository into skills/ (npm run skills:sync).
// Source defaults to ../mintlify-docs/.mintlify/skills; pass a different folder as the first argument.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(process.argv[2] ?? path.join(root, "..", "..", "mintlify-docs", ".mintlify", "skills"));
const dest = path.join(root, "skills");
if (!existsSync(src)) {
  console.error(`skills source not found: ${src}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest);
const names = [];
for (const dir of readdirSync(src, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const file = path.join(src, dir.name, "SKILL.md");
  if (!existsSync(file)) continue;
  const name = /^name:\s*(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error(`${file}: missing or invalid name`);
  cpSync(path.join(src, dir.name), path.join(dest, name), { recursive: true });
  names.push(name);
}
writeFileSync(path.join(dest, "README.md"), `# Bundled Vobiz Agent Skills\n\nCopied from the Vobiz docs (\`.mintlify/skills\`) by \`npm run skills:sync\`. Do not edit here; edit the docs copy and re-sync.\n\n${names.sort().map((n) => `- \`${n}\``).join("\n")}\n`);
console.log(`synced ${names.length} skills from ${src}`);
