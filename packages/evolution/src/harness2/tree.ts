// Derived from google-research/harness2, Copyright 2026 Google LLC, Apache-2.0
import type { HarnessTree } from "@harnex/interfaces";
import { isHighPrivilegeHarnessPath, type FileDiff, type HarnessPatchOp } from "@harnex/protocol";

const ALWAYS_ON = ["systemprompt.md", "guardrails.md", "memory/LongTermMEMORY.md"];
const ALWAYS_ON_MAX = 32_000;
const SKILL = /^skills\/([a-z0-9][a-z0-9_-]*)\/SKILL\.md$/;
const EDITABLE = /^(?:(?:tool_descriptions|sandbox_policies)\/[^/]+|skills\/[a-z0-9][a-z0-9_-]*\/scripts\/[^/]+|(?:scripts|hooks)\/[^/]+\.ts|sub_agents\/(?:[^/]+|[^/]+\/AGENT\.md)|mcp\/servers\.json|meta\/.+)$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?:\.|$)/i;

export function normalizeRelativePath(path: string): string {
  const norm = path.replaceAll("\\", "/");
  const parts = norm.split("/");
  if (!norm || norm.startsWith("/") || norm.endsWith("/") || parts.includes("..")) {
    throw new Error(`Path escapes root or is not a file: ${JSON.stringify(path)}`);
  }
  const segments = parts.filter(part => part && part !== ".");
  if (!segments.length || segments.some(part => /[<>:"|?*\u0000-\u001f\u007f]|^[ ]|[ .]$|~\d/i.test(part) || WINDOWS_DEVICE.test(part))) {
    throw new Error(`Invalid portable path: ${JSON.stringify(path)}`);
  }
  const folded = segments.map(part => part.toLowerCase());
  if (folded.some((part, i) => part === ".git" || part === ".harnex" || part === "src-tauri" || part === ".ssh" || part === "trust.json"
      || (part === "packages" && ["protocol", "interfaces"].includes(folded[i + 1] ?? "")))) {
    throw new Error(`Path touches an immutable L0 zone: ${JSON.stringify(path)}`);
  }
  return segments.join("/");
}

function editable(path: string): boolean {
  return ALWAYS_ON.includes(path) || SKILL.test(path) || EDITABLE.test(path);
}

export function normalizeHarnessPath(path: string, migration = false): string {
  const norm = normalizeRelativePath(path);
  if (!editable(norm) && !(migration && norm === "manifest.json")) throw new Error(`Path is outside the editable harness surface: ${norm}`);
  return norm;
}

export function normalizePaths(paths: Iterable<string>): string[] {
  const seen = new Map<string, { path: string; file: boolean }>();
  return Array.from(paths, input => {
    const path = normalizeRelativePath(input);
    const parts = path.split("/");
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i]!;
      const key = current.normalize("NFC").toLowerCase();
      const file = i === parts.length - 1;
      const prior = seen.get(key);
      if (prior && (file || prior.file || prior.path !== current)) throw new Error(`Conflicting paths: ${prior.path}, ${path}`);
      seen.set(key, { path: current, file });
    }
    return path;
  });
}

export function normalizeTree(tree: HarnessTree): HarnessTree {
  const entries = Object.entries(tree);
  return Object.fromEntries(normalizePaths(entries.map(([path]) => path)).map((path, i) => {
    const content = entries[i]![1];
    if (typeof content !== "string") throw new Error(`Expected text at ${path}`);
    return [path, content];
  }));
}

export function editableTree(snapshot: HarnessTree, migration = false): HarnessTree {
  return Object.fromEntries(Object.entries(normalizeTree(snapshot)).filter(([path]) => editable(path) || (migration && path === "manifest.json")));
}

function alwaysOn(tree: HarnessTree): string {
  return ALWAYS_ON.map(path => tree[path] ?? "").join("\n\n");
}

function skillEntries(tree: HarnessTree) {
  return Object.entries(tree).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([path, content]) => {
    const name = SKILL.exec(path)?.[1];
    if (!name) return [];
    const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)?.[1] ?? "";
    return [{ path, name, description: /^description:[ \t]*(.+)$/m.exec(frontmatter)?.[1]?.trim(), declaredName: /^name:[ \t]*(.+)$/m.exec(frontmatter)?.[1]?.trim() }];
  });
}

function namesSkill(body: string, name: string): boolean {
  return new RegExp(`(?:^|[^\\w-])${name}(?=$|[^\\w-])`, "i").test(body);
}

export function untriggeredSkills(tree: HarnessTree): { path: string; name: string }[] {
  const body = alwaysOn(tree);
  return skillEntries(tree).filter(({ name }) => !namesSkill(body, name)).map(({ path, name }) => ({ path, name }));
}

export function autotrigger(tree: HarnessTree, alwaysOnMax = ALWAYS_ON_MAX): string[] {
  const norm = normalizeTree(tree);
  const repaired: string[] = [];
  for (const { name, description } of skillEntries(norm)) {
    if (namesSkill(alwaysOn(norm), name)) continue;
    const line = `Use the \`${name}\` skill when ${description?.replace(/\.$/, "") || `the ${name} workflow applies`}.`;
    const previous = norm["systemprompt.md"];
    norm["systemprompt.md"] = [previous?.trimEnd(), line].filter(Boolean).join("\n");
    if (alwaysOn(norm).length > alwaysOnMax) {
      if (previous === undefined) delete norm["systemprompt.md"];
      else norm["systemprompt.md"] = previous;
      continue;
    }
    tree["systemprompt.md"] = norm["systemprompt.md"];
    repaired.push(name);
  }
  return repaired;
}

export function validateTree(tree: HarnessTree, alwaysOnMax = ALWAYS_ON_MAX): HarnessTree {
  const norm = normalizeTree(tree);
  const body = alwaysOn(norm);
  if (body.length > alwaysOnMax) throw new Error(`Always-on harness exceeds ${alwaysOnMax} characters`);
  for (const [path, content] of Object.entries(norm)) {
    normalizeHarnessPath(path);
    if (path === "mcp/servers.json") {
      const value: unknown = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be a JSON object`);
    }
    if (path.endsWith(".ts") && /^(?:scripts|hooks|skills)\//.test(path)) {
      try { new Bun.Transpiler({ loader: "ts" }).transformSync(content); }
      catch { throw new Error(`Invalid TypeScript at ${path}`); }
    }
    const skillScript = /^(skills\/[^/]+)\/scripts\//.exec(path)?.[1];
    if (skillScript && !Object.hasOwn(norm, `${skillScript}/SKILL.md`)) throw new Error(`Missing ${skillScript}/SKILL.md`);
    if (ALWAYS_ON.includes(path) || SKILL.test(path)) {
      for (const match of content.matchAll(/\bbun(?:\s+run)?[ \t]+(?:\.\/)?((?:skills\/[\w-]+\/)?scripts\/[\w.-]+\.ts)\b/g)) {
        const ref = match[1]!;
        if (!Object.hasOwn(norm, ref) && !(SKILL.test(path) && Object.hasOwn(norm, `${path.slice(0, -8)}${ref}`))) {
          throw new Error(`${path} references missing script ${ref}`);
        }
      }
    }
  }
  for (const { path, name, description, declaredName } of skillEntries(norm)) {
    if (!description || (declaredName && declaredName !== name)) throw new Error(`Invalid skill frontmatter at ${path}`);
    if (!namesSkill(body, name)) throw new Error(`Skill ${name} has no always-on trigger`);
  }
  return norm;
}

export function diffSummary(before: HarnessTree, after: HarnessTree) {
  const a = normalizeTree(before);
  const b = normalizeTree(after);
  return {
    added: Object.keys(b).filter(path => !Object.hasOwn(a, path)).sort(),
    removed: Object.keys(a).filter(path => !Object.hasOwn(b, path)).sort(),
    modified: Object.keys(a).filter(path => Object.hasOwn(b, path) && a[path] !== b[path]).sort(),
    alwaysOnCharDelta: alwaysOn(b).length - alwaysOn(a).length,
  };
}

export function fileLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export interface LineChange { oldStart: number; oldEnd: number; newStart: number; newEnd: number }

/** Zero-based ranges, with exclusive ends; anchor insertions at an empty old range. */
export function lineChanges(before: string, after: string): LineChange[] {
  const a = fileLines(before);
  const b = fileLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (endA === start && endB === start) return [];
  const width = endB - start + 1;
  const cells = (endA - start + 1) * width;
  // Bound diff work on generated files; use a single replacement for large unmatched ranges.
  if (cells > 1_000_000) return [{ oldStart: start, oldEnd: endA, newStart: start, newEnd: endB }];
  const lcs = new Uint32Array(cells);
  const ix = (i: number, j: number) => (i - start) * width + j - start;
  for (let i = endA - 1; i >= start; i--) for (let j = endB - 1; j >= start; j--) {
    lcs[ix(i, j)] = a[i] === b[j] ? 1 + lcs[ix(i + 1, j + 1)]! : Math.max(lcs[ix(i + 1, j)]!, lcs[ix(i, j + 1)]!);
  }
  const changes: LineChange[] = [];
  let i = start;
  let j = start;
  while (i < endA || j < endB) {
    if (i < endA && j < endB && a[i] === b[j]) { i++; j++; continue; }
    const oldStart = i;
    const newStart = j;
    do {
      if (j === endB || (i < endA && lcs[ix(i + 1, j)]! >= lcs[ix(i, j + 1)]!)) i++;
      else j++;
    } while ((i < endA || j < endB) && !(i < endA && j < endB && a[i] === b[j]));
    changes.push({ oldStart, oldEnd: i, newStart, newEnd: j });
  }
  return changes;
}

export function computeFileDiffs(before: HarnessTree, after: HarnessTree, migration = false): FileDiff[] {
  const a = normalizeTree(before);
  const b = normalizeTree(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(path => {
    if (a[path] === b[path]) return [];
    normalizeHarnessPath(path, migration);
    const oldText = a[path] ?? "";
    const newText = b[path] ?? "";
    const oldLines = fileLines(oldText);
    const newLines = fileLines(newText);
    const emit = (lines: string[], prefix: string) => lines.map(line => prefix + line + (line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n")).join("");
    const range = (start: number, end: number) => `${start + (end > start ? 1 : 0)},${end - start}`;
    const hunks = lineChanges(oldText, newText).map(({ oldStart, oldEnd, newStart, newEnd }) =>
      `@@ -${range(oldStart, oldEnd)} +${range(newStart, newEnd)} @@\n` +
      emit(oldLines.slice(oldStart, oldEnd), "-") + emit(newLines.slice(newStart, newEnd), "+")
    ).join("");
    return [{ path, changeType: !Object.hasOwn(a, path) ? "added" : !Object.hasOwn(b, path) ? "deleted" : "modified",
      before: oldText, after: newText, isHighPrivilege: isHighPrivilegeHarnessPath(path),
      unifiedDiff: `--- ${Object.hasOwn(a, path) ? `a/${path}` : "/dev/null"}\n+++ ${Object.hasOwn(b, path) ? `b/${path}` : "/dev/null"}\n${hunks}` }];
  });
}

export function treeToPatchOps(before: HarnessTree, after: HarnessTree, migration = false): HarnessPatchOp[] {
  const diffs = computeFileDiffs(before, after, migration);
  normalizePaths(diffs.map(diff => diff.path));
  return diffs.map(diff => diff.changeType === "deleted"
    ? { path: diff.path, op: "delete" }
    : { path: diff.path, op: "upsert", content: diff.after });
}

export function applyPatchOps(tree: HarnessTree, ops: readonly HarnessPatchOp[], migration = false): HarnessTree {
  const next = normalizeTree(tree);
  const paths = normalizePaths(ops.map(op => normalizeHarnessPath(op.path, migration)));
  ops.forEach((op, i) => {
    const path = paths[i]!;
    if (op.op === "delete") delete next[path];
    else if (op.op === "upsert" && typeof op.content === "string") Object.defineProperty(next, path, { value: op.content, enumerable: true, configurable: true, writable: true });
    else throw new Error(`Invalid patch operation at ${path}`);
  });
  return normalizeTree(next);
}

export function diversity(trees: Record<string, HarnessTree>) {
  const entries = Object.values(trees).map(tree => Object.entries(normalizeTree(tree)).sort());
  const sets = entries.map(tree => new Set(tree.flatMap(([path, body]) =>
    body.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.stringify([path, line])))));
  let sum = 0;
  let pairs = 0;
  for (const [i, a] of sets.entries()) for (const b of sets.slice(i + 1)) {
    const common = [...a].filter(line => b.has(line)).length;
    const union = a.size + b.size - common;
    sum += union ? common / union : 1;
    pairs++;
  }
  return { n: sets.length, n_distinct: new Set(entries.map(entry => JSON.stringify(entry))).size,
    mean_line_jaccard: pairs ? Number((sum / pairs).toFixed(4)) : 1 };
}
