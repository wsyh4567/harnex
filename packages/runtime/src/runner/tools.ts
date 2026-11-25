import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HarnessTree, LlmToolCall, LlmToolDef, RustBridge, TaskRunRequest } from "@harnex/interfaces";
import { IMMUTABLE_L0_PATH_PATTERNS, GoalItemSchema, type ExecResult, type GoalItem, type UntrustedSourceTag } from "@harnex/protocol";

const path = { type: "string" }, text = { type: "string" }, args = { type: "array", items: text };
const integer = { type: "integer" }, bool = { type: "boolean" };
const def = (name: string, description: string, properties: Record<string, unknown>, required: string[]): LlmToolDef => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});

const DEFAULT_READ_LINES = 250;
const MAX_SEARCH_FILES = 600;
const MAX_GREP_FILE_BYTES = 512 * 1024;
const SKIP_WALK_DIRS = new Set([".git", "node_modules", ".harnex", "dist", "target", ".vite"]);

const readTools = [
  def("read_file", "Read a UTF-8 file (optional 1-indexed line offset & limit)", { path, offset: integer, limit: integer }, ["path"]),
  def("list_files", "List directory entries", { path }, ["path"]),
  def("find_files", "Find workspace files by glob or substring", { path, pattern: text, maxResults: integer }, []),
  def("grep_files", "Search text/regex in workspace files", { query: text, path, isRegex: bool, caseSensitive: bool, glob: text, maxMatches: integer }, ["query"]),
  def("set_goals", "Update run goals", { goals: { type: "array", items: {
    type: "object", properties: { id: text, title: text, status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] }, detail: text },
    required: ["id", "title", "status"],
  } } }, ["goals"]),
];
const effectTools = [
  def("edit_file", "Apply exact non-overlapping {oldText,newText} edits via L0", {
    path,
    edits: { type: "array", items: { type: "object", properties: { oldText: text, newText: text }, required: ["oldText", "newText"], additionalProperties: false } },
  }, ["path", "edits"]),
  def("write_file", "Write a file via L0", { path, content: text }, ["path", "content"]),
  def("delete_file", "Delete a file via L0", { path }, ["path"]),
  def("shell", "Run a command in L0 sandbox", { command: text, args, cwd: path }, ["command"]),
  def("run_script", "Run a pinned harness script via L0", { scriptPath: path, args }, ["scriptPath"]),
];

export function toolsFor(mode: TaskRunRequest["mode"]): LlmToolDef[] {
  return mode === "ask" ? [] : mode === "plan" ? readTools : [...readTools, ...effectTools];
}

function protectedPath(path: string): boolean {
  const norm = path.replaceAll("\\", "/").toLowerCase(), segments = norm.split("/");
  return segments.includes(".harnex") || IMMUTABLE_L0_PATH_PATTERNS.some((raw) => {
    const pattern = raw.replace(/\/$/, "");
    return pattern.includes("/") ? `/${norm}/`.includes(`/${pattern}/`) : segments.includes(pattern);
  });
}

async function workspaceReadPath(workspace: string, path: string): Promise<{ root: string; actual: string }> {
  if (isAbsolute(path) || /[:\0]/.test(path) || path.split(/[\\/]/).includes("..") || protectedPath(path)) {
    throw new Error("Path is outside readable workspace scope");
  }
  const root = await realpath(workspace);
  const actual = await realpath(resolve(root, path));
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || protectedPath(rel)) {
    throw new Error("Path is outside readable workspace scope");
  }
  return { root, actual };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(relPath: string, pattern?: string): boolean {
  if (!pattern || !pattern.trim()) return true;
  const norm = relPath.replaceAll("\\", "/");
  const trimmed = pattern.trim();
  if (/[*?]/.test(trimmed)) {
    const re = globToRegExp(trimmed);
    const basename = norm.split("/").pop() ?? norm;
    return re.test(norm) || (!trimmed.includes("/") && re.test(basename));
  }
  return norm.toLowerCase().includes(trimmed.toLowerCase());
}

async function walkWorkspaceFiles(
  root: string,
  startDir: string,
  includeDirs: boolean,
  maxEntries: number,
): Promise<{ entries: Array<{ rel: string; isDir: boolean; abs: string }>; truncated: boolean }> {
  const out: Array<{ rel: string; isDir: boolean; abs: string }> = [];
  const queue: string[] = [startDir];
  let visitedFiles = 0;
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    let dirEntries;
    try {
      dirEntries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    dirEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of dirEntries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && SKIP_WALK_DIRS.has(entry.name)) continue;
      const abs = resolve(current, entry.name);
      const rel = relative(root, abs).replaceAll("\\", "/");
      if (!rel || protectedPath(rel)) continue;

      if (entry.isDirectory()) {
        if (includeDirs) {
          out.push({ rel: `${rel}/`, isDir: true, abs });
          if (out.length >= maxEntries) {
            truncated = true;
            return { entries: out, truncated };
          }
        }
        queue.push(abs);
      } else if (entry.isFile()) {
        visitedFiles += 1;
        out.push({ rel, isDir: false, abs });
        if (out.length >= maxEntries || visitedFiles >= MAX_SEARCH_FILES) {
          truncated = true;
          return { entries: out, truncated };
        }
      }
    }
  }
  return { entries: out, truncated };
}

function normalizeEditArgs(raw: Record<string, unknown>): {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
} {
  const argsObj: Record<string, unknown> = { ...raw };
  if (typeof argsObj.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(argsObj.edits);
      if (Array.isArray(parsed)) argsObj.edits = parsed;
      else if (parsed && typeof parsed === "object") argsObj.edits = [parsed];
    } catch {
      // let Zod report invalid schema
    }
  } else if (argsObj.edits && !Array.isArray(argsObj.edits) && typeof argsObj.edits === "object") {
    argsObj.edits = [argsObj.edits];
  }
  if (argsObj.edits === undefined && typeof argsObj.oldText === "string" && typeof argsObj.newText === "string") {
    argsObj.edits = [{ oldText: argsObj.oldText, newText: argsObj.newText }];
  }

  return z
    .object({
      path: z.string().min(1),
      edits: z
        .array(z.object({ oldText: z.string().min(1), newText: z.string() }))
        .min(1)
        .max(50),
    })
    .parse(argsObj);
}

export function applyTargetedEdits(
  originalRaw: string,
  edits: readonly { oldText: string; newText: string }[],
): { content: string; firstChangedLine: number; diffSummary: string } {
  const hasBom = originalRaw.startsWith("\uFEFF");
  const withoutBom = hasBom ? originalRaw.slice(1) : originalRaw;
  const usesCrlf = withoutBom.includes("\r\n");
  const normalized = withoutBom.replace(/\r\n/g, "\n");

  const located = edits.map((edit, idx) => {
    const oldNorm = edit.oldText.replace(/\r\n/g, "\n");
    const newNorm = edit.newText.replace(/\r\n/g, "\n");
    const first = normalized.indexOf(oldNorm);
    if (first === -1) {
      throw new Error(`Edit #${idx + 1}: oldText not found in file`);
    }
    const second = normalized.indexOf(oldNorm, first + 1);
    if (second !== -1) {
      throw new Error(`Edit #${idx + 1}: oldText matched multiple locations; provide more surrounding context`);
    }
    return { start: first, end: first + oldNorm.length, oldNorm, newNorm };
  });

  const sortedAsc = [...located].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sortedAsc.length; i++) {
    if (sortedAsc[i]!.start < sortedAsc[i - 1]!.end) {
      throw new Error("Overlapping edits are not allowed; merge nearby changes into a single edit");
    }
  }

  const firstChangedLine = normalized.slice(0, sortedAsc[0]!.start).split("\n").length;
  let updated = normalized;
  for (const item of [...sortedAsc].reverse()) {
    updated = `${updated.slice(0, item.start)}${item.newNorm}${updated.slice(item.end)}`;
  }

  const diffChunks = sortedAsc.map((item) => {
    const lineNo = normalized.slice(0, item.start).split("\n").length;
    const removed = item.oldNorm.split("\n").map((l) => `- ${l}`).join("\n");
    const added = item.newNorm.split("\n").map((l) => `+ ${l}`).join("\n");
    return `@@ L${lineNo} @@\n${removed}\n${added}`;
  });

  const restoredLineEndings = usesCrlf ? updated.replace(/\n/g, "\r\n") : updated;
  return {
    content: hasBom ? `\uFEFF${restoredLineEndings}` : restoredLineEndings,
    firstChangedLine,
    diffSummary: diffChunks.join("\n"),
  };
}

interface ToolOutcome {
  output: string;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  status: "completed" | "failed" | "denied";
  sourceTags?: UntrustedSourceTag[];
  changedFile?: { path: string; content?: string };
  goals?: GoalItem[];
}

function resultOf(result: ExecResult): ToolOutcome {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    output,
    error: result.ok ? undefined : result.deniedReason ?? `L0 exited with status ${result.exitCode}`,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    status: result.ok ? "completed" : result.deniedReason ? "denied" : "failed",
  };
}

const required = z.string().min(1);
const pathArgs = z.object({ path: required });

export async function runTool(call: LlmToolCall, request: TaskRunRequest, tree: HarnessTree, bridge: RustBridge,
  sourceTags: UntrustedSourceTag[], readLimit: number,
): Promise<ToolOutcome> {
  if (!toolsFor(request.mode).some((tool) => tool.name === call.name)) {
    return { status: "denied", output: "", error: `Tool ${call.name} is unavailable in ${request.mode} mode` };
  }
  const intent = { threadId: request.threadId, workspaceRoot: request.workspacePath,
    sandboxMode: request.dryRunShadow ? "cow-shadow" as const : "workspace-write" as const, sourceTags };
  switch (call.name) {
    case "set_goals": {
      const { goals } = z.object({ goals: z.array(GoalItemSchema).max(40) }).parse(call.arguments);
      if (new Set(goals.map((goal) => goal.id)).size !== goals.length) throw new Error("Goal IDs must be unique");
      return { status: "completed", output: `Updated ${goals.length} goals`, goals };
    }
    case "list_files": {
      const { path } = pathArgs.parse(call.arguments);
      const { root, actual } = await workspaceReadPath(request.workspacePath, path);
      const entries = await readdir(actual, { withFileTypes: true });
      const output = entries.filter(({ name }) => !protectedPath(relative(root, resolve(actual, name))))
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort().join("\n");
      return { status: "completed", output, sourceTags: ["external_file"] };
    }
    case "find_files": {
      const parsed = z.object({
        path: z.string().min(1).default("."),
        pattern: z.string().optional(),
        maxResults: z.number().int().min(1).max(200).default(100),
      }).parse(call.arguments);
      const { root, actual } = await workspaceReadPath(request.workspacePath, parsed.path);
      const walked = await walkWorkspaceFiles(root, actual, true, MAX_SEARCH_FILES);
      const matched = walked.entries
        .filter((e) => matchesPattern(e.rel, parsed.pattern))
        .slice(0, parsed.maxResults);
      const lines = matched.map((e) => e.rel);
      if (walked.truncated || matched.length >= parsed.maxResults) {
        lines.push(`[Results capped at ${matched.length}; narrow path or pattern for more.]`);
      }
      return { status: "completed", output: lines.join("\n") || "(no matching files)", sourceTags: ["external_file"] };
    }
    case "grep_files": {
      const parsed = z.object({
        query: required,
        path: z.string().min(1).default("."),
        isRegex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        glob: z.string().optional(),
        maxMatches: z.number().int().min(1).max(200).default(60),
      }).parse(call.arguments);
      const { root, actual } = await workspaceReadPath(request.workspacePath, parsed.path);
      const regex = parsed.isRegex
        ? new RegExp(parsed.query, parsed.caseSensitive ? "" : "i")
        : new RegExp(parsed.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), parsed.caseSensitive ? "" : "i");

      const walked = await walkWorkspaceFiles(root, actual, false, MAX_SEARCH_FILES);
      const matches: string[] = [];
      let hitCap = false;

      for (const file of walked.entries) {
        if (!matchesPattern(file.rel, parsed.glob)) continue;
        const fd = await open(file.abs, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        try {
          const stat = await fd.stat();
          if (!stat.isFile() || stat.size > MAX_GREP_FILE_BYTES) continue;
          const buf = Buffer.alloc(stat.size);
          const { bytesRead } = await fd.read(buf, 0, stat.size, 0);
          const slice = buf.subarray(0, bytesRead);
          if (slice.includes(0)) continue; // skip binary files
          const lines = slice.toString("utf8").replace(/\r\n/g, "\n").split("\n");
          for (let idx = 0; idx < lines.length; idx++) {
            const line = lines[idx]!;
            if (regex.test(line)) {
              matches.push(`${file.rel}:${idx + 1}: ${line.slice(0, 240)}`);
              if (matches.length >= parsed.maxMatches) {
                hitCap = true;
                break;
              }
            }
          }
        } finally {
          await fd.close();
        }
        if (hitCap) break;
      }

      if (hitCap) {
        matches.push(`[Matches capped at ${parsed.maxMatches}; narrow path or glob to see more.]`);
      }
      return { status: "completed", output: matches.join("\n") || "(no matches)", sourceTags: ["external_file"] };
    }
    case "read_file": {
      const parsed = pathArgs.extend({
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(2000).optional(),
      }).parse(call.arguments);
      const { actual } = await workspaceReadPath(request.workspacePath, parsed.path);
      const fd = await open(actual, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await fd.stat();
        if (!stat.isFile()) throw new Error("The requested path is not a regular file");
        const hasLineRange = parsed.offset !== undefined || parsed.limit !== undefined;
        if (!hasLineRange) {
          const buffer = Buffer.alloc(readLimit * 4 + 1);
          const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
          return { status: "completed", output: buffer.toString("utf8", 0, bytesRead), sourceTags: ["external_file"] };
        }
        const capBytes = Math.min(stat.size, Math.max(readLimit * 16, 256 * 1024));
        const buffer = Buffer.alloc(capBytes);
        const { bytesRead } = await fd.read(buffer, 0, capBytes, 0);
        const allLines = buffer.toString("utf8", 0, bytesRead).replace(/\r\n/g, "\n").split("\n");
        const startLine = parsed.offset ?? 1;
        const maxLines = parsed.limit ?? DEFAULT_READ_LINES;
        if (startLine > allLines.length) {
          return {
            status: "completed",
            output: `[Offset ${startLine} is past end of file (${allLines.length} lines).]`,
            sourceTags: ["external_file"],
          };
        }
        const selected = allLines.slice(startLine - 1, startLine - 1 + maxLines);
        const endLine = startLine + selected.length - 1;
        const body = selected.map((line, i) => `${startLine + i}: ${line}`).join("\n");
        const notice =
          endLine < allLines.length || bytesRead < stat.size
            ? `\n[Showing lines ${startLine}-${endLine} of ${allLines.length}${bytesRead < stat.size ? "+" : ""}. Use read_file with offset=${endLine + 1} to continue.]`
            : "";
        return { status: "completed", output: `${body}${notice}`, sourceTags: ["external_file"] };
      } finally { await fd.close(); }
    }
    case "edit_file": {
      const { path: targetPath, edits } = normalizeEditArgs(call.arguments);
      const { actual } = await workspaceReadPath(request.workspacePath, targetPath);
      const fd = await open(actual, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      let originalRaw = "";
      try {
        const stat = await fd.stat();
        if (!stat.isFile()) throw new Error("The requested path is not a regular file");
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await fd.read(buffer, 0, stat.size, 0);
        originalRaw = buffer.toString("utf8", 0, bytesRead);
      } finally {
        await fd.close();
      }
      const applied = applyTargetedEdits(originalRaw, edits);
      const outcome = resultOf(await bridge.execWriteFile({ ...intent, targetPath, content: applied.content }));
      if (outcome.status === "completed") {
        outcome.changedFile = { path: targetPath, content: applied.content };
        outcome.output = `Applied ${edits.length} edit(s) to ${targetPath} (first changed line: ${applied.firstChangedLine}).\n${applied.diffSummary}`;
      }
      return outcome;
    }
    case "write_file": {
      const { path: targetPath, content } = pathArgs.extend({ content: z.string() }).parse(call.arguments);
      const outcome = resultOf(await bridge.execWriteFile({ ...intent, targetPath, content }));
      if (outcome.status === "completed") outcome.changedFile = { path: targetPath, content };
      return outcome;
    }
    case "delete_file": {
      const { path: targetPath } = pathArgs.parse(call.arguments);
      const outcome = resultOf(await bridge.execDeleteFile({ ...intent, targetPath }));
      if (outcome.status === "completed") outcome.changedFile = { path: targetPath };
      return outcome;
    }
    case "shell": {
      const fields = z.object({ command: required, args: z.array(z.string()).default([]), cwd: required.optional() }).parse(call.arguments);
      return resultOf(await bridge.execShell({ ...intent, ...fields, env: {}, allowNetwork: false, timeoutMs: 30_000 }));
    }
    case "run_script": {
      const fields = z.object({ scriptPath: required, args: z.array(z.string()).default([]) }).parse(call.arguments);
      if (!/^scripts\/[\w.-]+\.ts$/.test(fields.scriptPath) || !Object.hasOwn(tree, fields.scriptPath)) {
        return { status: "denied", output: "", error: "Script is missing from the pinned harness" };
      }
      const script = { ...intent, ...fields, allowNetwork: false, timeoutMs: 30_000, pinnedCommitSha: request.pinnedCommitSha };
      return resultOf(await bridge.execScript(script));
    }
  }
  throw new Error(`Unknown tool: ${call.name}`);
}
