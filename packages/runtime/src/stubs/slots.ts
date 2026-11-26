import { z } from "zod";
import { ExecPolicyRuleSchema, type ExecHookIntent } from "@harnex/protocol";
import type { HarnessTree, LlmClient, RustBridge } from "@harnex/interfaces";

const frontmatter = (document: string) => {
  const block = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return { fields: {}, body: document };
  const fields = z.record(z.unknown()).parse(Bun.YAML.parse(block[1]!) ?? {});
  return { fields, body: document.slice(block[0].length) };
};

export const DISABLED_ORGANS_PATH = "meta/disabled_organs.json";

const DisabledOrgansSchema = z.object({
  disabled: z.array(z.string()),
});

function normalizeOrganPath(raw: string): string {
  return raw.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}

export function loadDisabledOrgans(tree: HarnessTree): Set<string> {
  const content = tree[DISABLED_ORGANS_PATH];
  if (typeof content !== "string" || !content.trim()) return new Set();
  try {
    const parsed = DisabledOrgansSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return new Set();
    const disabled = new Set<string>();
    for (const entry of parsed.data.disabled) {
      const normalized = normalizeOrganPath(entry);
      if (normalized) disabled.add(normalized);
    }
    return disabled;
  } catch {
    return new Set();
  }
}

export function loadMemory(tree: HarnessTree): string { return tree["memory/LongTermMEMORY.md"] ?? ""; }

export function loadSkills(tree: HarnessTree, options?: { includeDisabled?: boolean }) {
  const disabled = options?.includeDisabled === true ? undefined : loadDisabledOrgans(tree);
  return Object.entries(tree)
    .filter(([path]) => /^skills\/[^/]+\/SKILL\.md$/.test(path) && !(disabled?.has(path)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, document]) => {
      const { fields, body } = frontmatter(document);
      const metadata = z.object({ name: z.string().optional(), description: z.string().optional() }).parse(fields);
      return { path, name: metadata.name ?? path.split("/")[1]!, description: metadata.description ?? "", body };
    });
}

const McpServerSchema = z.object({
  enabled: z.boolean().default(true), disabled: z.boolean().optional(),
  url: z.string().url().optional(), command: z.string().optional(), args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
}).refine((config) => !!config.url !== !!config.command, "Set either an MCP URL or command");
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export function loadMcpServers(tree: HarnessTree): Record<string, McpServerConfig> {
  const content = tree["mcp/servers.json"];
  if (!content) return {};
  const { mcpServers, servers } = z.object({ mcpServers: z.unknown(), servers: z.unknown() }).parse(JSON.parse(content));
  const configuration = mcpServers ?? servers ?? {};
  return z.record(McpServerSchema).parse(Array.isArray(configuration) ? Object.fromEntries(configuration.map((server) => [
    z.object({ id: z.string().min(1) }).parse(server).id, server,
  ])) : configuration);
}

const HookEvents = z.enum(["PreToolUse", "PostToolUse", "SessionStart"]);
const HookConfig = z.object({ enabled: z.boolean().optional(), events: z.array(HookEvents).optional() });

export function loadHooks(tree: HarnessTree) {
  const configuration = tree["hooks/config.json"];
  const configs = configuration ? z.record(HookConfig).parse(JSON.parse(configuration)) : {};
  return Object.keys(tree).filter((path) => /^hooks\/[\w.-]+\.ts$/.test(path)).sort().flatMap((hookPath) => {
    const config = configs[hookPath];
    if (!(config?.enabled ?? !hookPath.startsWith("hooks/example_"))) return [];
    const sha256 = new Bun.CryptoHasher("sha256").update(tree[hookPath]!).digest("hex");
    const events: ExecHookIntent["event"][] = config?.events ?? ["PreToolUse", "PostToolUse"];
    return [{ hookPath, events, sha256 }];
  });
}

export async function dispatchHook(bridge: RustBridge, intent: ExecHookIntent) {
  await assertBudget(bridge);
  return bridge.execHook(intent);
}

export class BudgetExceededError extends Error {
  constructor(message = "Daily budget limit exceeded") { super(message); this.name = "BudgetExceededError"; }
}

export async function assertBudget(bridge: Pick<RustBridge, "checkBudget">, estimate?: number): Promise<void> {
  const check = await bridge.checkBudget(estimate);
  if (!check.allowed || check.status.tripped) throw new BudgetExceededError(check.reason);
}

function resolveSubagentProfilePath(profilePath: string): string {
  if (!profilePath || profilePath.includes("..") || profilePath.includes("\\")) {
    throw new Error("Unknown sub-agent profile");
  }
  if (/^sub_agents\/[\w.-]+\.md$/.test(profilePath)) {
    return profilePath;
  }
  if (/^[\w.-]+$/.test(profilePath) && profilePath !== "." && !profilePath.includes("/")) {
    return profilePath.endsWith(".md") ? `sub_agents/${profilePath}` : `sub_agents/${profilePath}.md`;
  }
  throw new Error("Unknown sub-agent profile");
}

export function loadSubagentProfile(tree: HarnessTree, profilePath: string) {
  const resolvedPath = resolveSubagentProfilePath(profilePath);
  if (!/^sub_agents\/[\w.-]+\.md$/.test(resolvedPath) || !Object.hasOwn(tree, resolvedPath)) {
    throw new Error("Unknown sub-agent profile");
  }
  const { fields, body } = frontmatter(tree[resolvedPath]!);
  const metadata = z.object({ name: z.string().optional(), description: z.string().optional() }).parse(fields);
  return { profilePath: resolvedPath, name: metadata.name ?? resolvedPath.split("/")[1]!, description: metadata.description ?? "", instructions: body };
}

export type SubagentProfile = ReturnType<typeof loadSubagentProfile>;

export function listSubagentProfiles(tree: HarnessTree, options?: { includeDisabled?: boolean }): SubagentProfile[] {
  const disabled = options?.includeDisabled === true ? undefined : loadDisabledOrgans(tree);
  return Object.keys(tree)
    .filter((path) => /^sub_agents\/[\w.-]+\.md$/.test(path) && !path.includes("..") && !(disabled?.has(path)))
    .sort()
    .map((path) => loadSubagentProfile(tree, path));
}

export function createWorkerSpawner(tree: HarnessTree, llm: LlmClient, bridge: RustBridge) {
  return async function spawn_worker(profilePath: string, task: string, signal?: AbortSignal) {
    const profile = loadSubagentProfile(tree, profilePath);
    await assertBudget(bridge);
    signal?.throwIfAborted();
    const response = await llm.complete({ slot: "solver", systemPrompt: profile.instructions,
      messages: [{ role: "user", content: task }], signal });
    if ((await bridge.recordUsage(response.modelId, response.usage)).tripped) throw new BudgetExceededError();
    return response;
  };
}

export function loadSandboxPolicies(tree: HarnessTree) {
  return Object.entries(tree).filter(([path]) => /^sandbox_policies\/[^/]+\.json$/.test(path)).sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, content]) => {
      const parsed: unknown = JSON.parse(content);
      return z.array(ExecPolicyRuleSchema).parse(Array.isArray(parsed) ? parsed : z.object({ rules: z.unknown() }).parse(parsed).rules);
    });
}
