import { z } from "zod";

export const PROTOCOL_VERSION = "1.0.0" as const;

export const ExecutionModeSchema = z.enum(["ask", "plan", "craft"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const RsiModeSchema = z.enum(["manual", "auto"]);
export type RsiMode = z.infer<typeof RsiModeSchema>;

export const ModelSlotSchema = z.enum(["solver", "improver", "judge"]);
export type ModelSlot = z.infer<typeof ModelSlotSchema>;

export const ProviderKindSchema = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "openai_compatible",
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const UntrustedSourceTagSchema = z.enum([
  "local",
  "web",
  "external_file",
  "untrusted_mcp",
]);
export type UntrustedSourceTag = z.infer<typeof UntrustedSourceTagSchema>;

export const TrustStatusSchema = z.enum(["trusted", "untrusted", "disabled"]);
export type TrustStatus = z.infer<typeof TrustStatusSchema>;

export const ApprovalDecisionSchema = z.enum([
  "allow_once",
  "allow_session",
  "deny",
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const SandboxModeSchema = z.enum([
  "workspace-write",
  "read-only",
  "cow-shadow",
]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const ExecPolicyActionSchema = z.enum(["allow", "prompt", "forbidden"]);
export type ExecPolicyAction = z.infer<typeof ExecPolicyActionSchema>;

export const EvolutionModeSchema = z.enum(["parallel", "sequential"]);
export type EvolutionMode = z.infer<typeof EvolutionModeSchema>;

export const HarnessComponentKindSchema = z.enum([
  "systemprompt",
  "guardrails",
  "memory",
  "tool_descriptions",
  "skills",
  "scripts",
  "hooks",
  "sub_agents",
  "mcp",
  "sandbox_policies",
  "views",
  "meta",
]);
export type HarnessComponentKind = z.infer<typeof HarnessComponentKindSchema>;

/**
 * Paths inside ~/.harnex/harness/ that require explicit human trust even in `auto` mode.
 */
export const HIGH_PRIVILEGE_HARNESS_PREFIXES = [
  "scripts/",
  "hooks/",
  "mcp/servers.json",
  "systemprompt.md",
  "guardrails.md",
] as const;

/**
 * Immutable L0 paths that no harness patch or sandboxed process may ever modify.
 */
export const IMMUTABLE_L0_PATH_PATTERNS = [
  ".git",
  ".git/",
  "src-tauri/",
  "packages/protocol/",
  "packages/interfaces/",
  ".ssh/",
  "trust.json",
] as const;

export function isHighPrivilegeHarnessPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return HIGH_PRIVILEGE_HARNESS_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? norm.startsWith(prefix) : norm === prefix,
  );
}

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  upstreamCostUsd: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const RunMetricsSchema = z.object({
  steps: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;
