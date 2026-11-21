// Derived from google-research/harness2, Copyright 2026 Google LLC, Apache-2.0
import { createHash } from "node:crypto";
import type { HarnessTree } from "@harnex/interfaces";
import { ExperienceEntrySchema, type ExperienceEntry, type HarnessPatchOp } from "@harnex/protocol";
import { assertNoGraderVerdicts, assertNoLeakPaths } from "./context.ts";
import { hasExperience } from "./reflector.ts";
import { normalizeHarnessPath } from "./tree.ts";

function segment(value: string): string {
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) return value;
  const name = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "entry";
  return `${name}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

const libraryPrefix = (domain: string) => `meta/domains/${segment(domain)}`;
const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export function readDomainLibrary(tree: HarnessTree, domain: string): HarnessTree {
  const prefix = `${libraryPrefix(domain)}/`;
  return Object.fromEntries(Object.entries(tree).filter(([path]) => path.startsWith(prefix) && /\/(INDEX|EXPERIENCE)\.md$/.test(path)).map(([path, content]) => [path.slice(prefix.length), content]));
}

export function experiencePatchOps(tree: HarnessTree, taskId: string, entry?: ExperienceEntry): HarnessPatchOp[] {
  if (!hasExperience(entry)) return [];
  const data = ExperienceEntrySchema.parse(entry);
  const root = libraryPrefix(data.domain);
  const relative = `harnesses/${segment(taskId)}/EXPERIENCE.md`;
  const path = normalizeHarnessPath(`${root}/${relative}`);
  const body = [
    `# ${singleLine(taskId)}`, "", "## Transferable lesson",
    ...(["cue", "lesson", "evidence", "confidence"] as const).map(key => `- **${key}**: ${singleLine(data[key])}`),
    ...(data.editsSummary ? ["", "## What each edit did", data.editsSummary.trim()] : []), "",
  ].join("\n");
  const entries = { ...readDomainLibrary(tree, data.domain), [relative]: body };
  const rows = Object.keys(entries).filter(name => /^harnesses\/[a-z0-9-][a-z0-9_-]*\/EXPERIENCE\.md$/.test(name)).sort().map(name => {
    const cue = /^- \*\*cue\*\*: (.+)$/m.exec(entries[name]!)?.[1];
    return `- [${name.split("/")[1]}](${name})${cue ? ` — ${cue}` : ""}`;
  });
  const index = normalizeHarnessPath(`${root}/INDEX.md`);
  const contents = `# Library — ${singleLine(data.domain)}\n\n${rows.join("\n")}\n`;
  assertNoLeakPaths([path, index]);
  assertNoGraderVerdicts({ [path]: body, [index]: contents });
  return [{ path: index, op: "upsert", content: contents }, { path, op: "upsert", content: body }];
}
