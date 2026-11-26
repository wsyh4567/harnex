import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ExecPolicyActionSchema,
  SandboxModeSchema,
  TrustStatusSchema,
  UntrustedSourceTagSchema,
} from "./common.ts";

// --- L0 Side-Effect Execution Intents (TS -> Rust L0 Executor) ---

export const ExecWriteFileIntentSchema = z.object({
  threadId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  targetPath: z.string().min(1),
  content: z.string(),
  sandboxMode: SandboxModeSchema.default("workspace-write"),
  sourceTags: z.array(UntrustedSourceTagSchema).default(["local"]),
});
export type ExecWriteFileIntent = z.infer<typeof ExecWriteFileIntentSchema>;

export const ExecDeleteFileIntentSchema = z.object({
  threadId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  targetPath: z.string().min(1),
  sandboxMode: SandboxModeSchema.default("workspace-write"),
  sourceTags: z.array(UntrustedSourceTagSchema).default(["local"]),
});
export type ExecDeleteFileIntent = z.infer<typeof ExecDeleteFileIntentSchema>;

export const ExecShellIntentSchema = z.object({
  threadId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  sandboxMode: SandboxModeSchema.default("workspace-write"),
  allowNetwork: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(30_000),
  sourceTags: z.array(UntrustedSourceTagSchema).default(["local"]),
});
export type ExecShellIntent = z.infer<typeof ExecShellIntentSchema>;

export const ExecScriptIntentSchema = z.object({
  threadId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  scriptPath: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  sandboxMode: SandboxModeSchema.default("workspace-write"),
  allowNetwork: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(30_000),
  sourceTags: z.array(UntrustedSourceTagSchema).default(["local"]),
});
export type ExecScriptIntent = z.infer<typeof ExecScriptIntentSchema>;

export const ExecHookIntentSchema = z.object({
  threadId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  hookPath: z.string().min(1),
  event: z.enum(["PreToolUse", "PostToolUse", "SessionStart"]),
  payloadJson: z.string(),
  timeoutMs: z.number().int().positive().default(10_000),
});
export type ExecHookIntent = z.infer<typeof ExecHookIntentSchema>;

export const ExecResultSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  sandboxBackend: z.string(),
  deniedReason: z.string().optional(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

// --- ExecPolicy, Trust Store, Approval & Guardian ---

export const ExecPolicyRuleSchema = z.object({
  id: z.string().min(1),
  prefix: z.string().min(1),
  action: ExecPolicyActionSchema,
  description: z.string().default(""),
});
export type ExecPolicyRule = z.infer<typeof ExecPolicyRuleSchema>;

export const TrustKindSchema = z.enum(["hook", "mcp", "script"]);
export type TrustKind = z.infer<typeof TrustKindSchema>;

export const TrustRecordSchema = z.object({
  id: z.string().min(1),
  kind: TrustKindSchema,
  identifier: z.string().min(1),
  sha256: z.string().optional(),
  status: TrustStatusSchema,
  origin: z.enum(["user_installed", "rsi_evolved", "imported_genome"]),
  updatedAt: z.string(),
});
export type TrustRecord = z.infer<typeof TrustRecordSchema>;

export const GlobalHookItemSchema = z.object({
  path: z.string().min(1), // e.g. "hooks/example_trim_output.ts"
  name: z.string().min(1),
  event: z.enum(["PreToolUse", "PostToolUse", "SessionStart"]).default("PostToolUse"),
  content: z.string(),
  sha256: z.string().min(1),
  status: TrustStatusSchema,
  origin: z.enum(["user_installed", "rsi_evolved", "imported_genome"]).default("user_installed"),
  updatedAt: z.string(),
});
export type GlobalHookItem = z.infer<typeof GlobalHookItemSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskReasonCodeSchema = z.enum([
  "sandbox_escape",
  "forbidden_policy",
  "shell_syntax",
  "interpreter_execution",
  "file_deletion",
  "network_access",
  "protected_path",
  "untrusted_source",
  "hook_untrusted",
  "high_privilege_proposal",
  "guardian_escalated",
  "policy_prompt",
]);
export type RiskReasonCode = z.infer<typeof RiskReasonCodeSchema>;

export const ApprovalRequestKindSchema = z.enum([
  "sandbox_escape",
  "shell_command",
  "hook_trust",
  "mcp_trust",
  "high_privilege_proposal",
]);
export type ApprovalRequestKind = z.infer<typeof ApprovalRequestKindSchema>;

export const ApprovalRequestSchema = z.object({
  requestId: z.string().min(1),
  threadId: z.string().min(1),
  kind: ApprovalRequestKindSchema,
  summary: z.string().min(1),
  detail: z.string(),
  commandOrPath: z.string(),
  riskLevel: RiskLevelSchema,
  riskReasonCode: RiskReasonCodeSchema.optional(),
  sha256: z.string().optional(),
  previousSha256: z.string().optional(),
  sourceTags: z.array(UntrustedSourceTagSchema).default(["local"]),
  createdAt: z.string(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalResolveParamsSchema = z.object({
  requestId: z.string().min(1),
  decision: ApprovalDecisionSchema,
});
export type ApprovalResolveParams = z.infer<typeof ApprovalResolveParamsSchema>;

export const GuardianDecisionSchema = z.object({
  requestId: z.string().min(1),
  threadId: z.string().min(1),
  decision: z.enum(["allow", "escalate", "deny"]),
  riskLevel: RiskLevelSchema,
  riskReasonCode: RiskReasonCodeSchema.optional(),
  reason: z.string(),
  commandOrPath: z.string(),
  modelId: z.string(),
  sanitizedInputOnly: z.literal(true),
  timestamp: z.string(),
});
export type GuardianDecision = z.infer<typeof GuardianDecisionSchema>;

export const SecurityEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("security.approval_required"),
    request: ApprovalRequestSchema,
  }),
  z.object({
    type: z.literal("security.approval_resolved"),
    requestId: z.string(),
    decision: ApprovalDecisionSchema,
  }),
  z.object({
    type: z.literal("trust.hook_confirm"),
    request: ApprovalRequestSchema,
  }),
  z.object({
    type: z.literal("guardian.decision"),
    decision: GuardianDecisionSchema,
  }),
]);
export type SecurityEvent = z.infer<typeof SecurityEventSchema>;
