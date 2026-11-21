import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HarnessTree, LlmToolCall, LlmToolDef, RustBridge, TaskRunRequest } from "@harnex/interfaces";
import { IMMUTABLE_L0_PATH_PATTERNS, GoalItemSchema, type ExecResult, type GoalItem, type UntrustedSourceTag } from "@harnex/protocol";

const path = { type: "string" }, text = { type: "string" }, args = { type: "array", items: text };
const def = (name: string, description: string, properties: Record<string, unknown>, required: string[]): LlmToolDef => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});

const readTools = [
  def("read_file", "Read a UTF-8 file inside the bound workspace", { path }, ["path"]),
  def("list_files", "List immediate entries inside a workspace directory", { path }, ["path"]),
  def("set_goals", "Replace the current run's goals and their progress", { goals: { type: "array", items: {
    type: "object", properties: { id: text, title: text, status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] }, detail: text },
    required: ["id", "title", "status"],
  } } }, ["goals"]),
];
const effectTools = [
  def("write_file", "Write text to a file inside the workspace via L0", { path, content: text }, ["path", "content"]),
  def("delete_file", "Delete a file inside the workspace via L0", { path }, ["path"]),
  def("shell", "Run a command with arguments inside the L0 workspace sandbox", { command: text, args, cwd: path }, ["command"]),
  def("run_script", "Run a script from the pinned harness via L0", { scriptPath: path, args }, ["scriptPath"]),
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

interface ToolOutcome {
  output: string;
  error?: string;
  status: "completed" | "failed" | "denied";
  sourceTags?: UntrustedSourceTag[];
  changedFile?: { path: string; content?: string };
  goals?: GoalItem[];
}

function resultOf(result: ExecResult): ToolOutcome {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return { output, error: result.ok ? undefined : result.deniedReason ?? `L0 exited with status ${result.exitCode}`,
    status: result.ok ? "completed" : result.deniedReason ? "denied" : "failed" };
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
    case "read_file": {
      const { path } = pathArgs.parse(call.arguments);
      const { actual } = await workspaceReadPath(request.workspacePath, path);
      const fd = await open(actual, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        if (!(await fd.stat()).isFile()) throw new Error("The requested path is not a regular file");
        const buffer = Buffer.alloc(readLimit * 4 + 1);
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        return { status: "completed", output: buffer.toString("utf8", 0, bytesRead), sourceTags: ["external_file"] };
      } finally { await fd.close(); }
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
