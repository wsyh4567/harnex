import { z } from "zod";
import {
  EvolutionModeSchema,
  RunMetricsSchema,
  TokenUsageSchema,
  UntrustedSourceTagSchema,
} from "./common.ts";

export const InlineDiffCommentSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  lineNumber: z.number().int().positive(),
  comment: z.string().min(1),
  author: z.enum(["user", "guardian"]).default("user"),
  createdAt: z.string(),
});
export type InlineDiffComment = z.infer<typeof InlineDiffCommentSchema>;

export const FileDiffSchema = z.object({
  path: z.string().min(1),
  changeType: z.enum(["added", "modified", "deleted"]),
  before: z.string().default(""),
  after: z.string().default(""),
  unifiedDiff: z.string(),
  isHighPrivilege: z.boolean(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

export const BlindJudgeResultSchema = z.object({
  seed: z.string().min(1),
  optionALabel: z.string(),
  optionBLabel: z.string(),
  winnerAnonId: z.string(),
  winnerLabel: z.string(),
  winnerIsCandidate: z.boolean(),
  forwardWinnerAnonId: z.string(),
  reverseWinnerAnonId: z.string(),
  orderConsistent: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
  reasoning: z.string(),
  judgeModelId: z.string(),
});
export type BlindJudgeResult = z.infer<typeof BlindJudgeResultSchema>;

export const ExperienceEntrySchema = z.object({
  domain: z.string().min(1),
  cue: z.string().min(1),
  lesson: z.string().min(1),
  evidence: z.string().min(1),
  confidence: z.string().min(1),
  editsSummary: z.string().optional(),
});
export type ExperienceEntry = z.infer<typeof ExperienceEntrySchema>;

export const RegressionCheckSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skippedReason: z.string().optional(),
});
export type RegressionCheckSummary = z.infer<typeof RegressionCheckSummarySchema>;

export const ProposalStatusSchema = z.enum([
  "running",
  "ready",
  "needs_reprobe",
  "adopted",
  "rejected",
  "archived_no_entry",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const CompatibilityIssueSchema = z.object({
  path: z.string().min(1),
  kind: z.enum([
    "schema_version_mismatch",
    "invalid_manifest_or_mcp",
    "deprecated_hook_contract",
    "deprecated_tool_reference",
    "script_syntax_error",
    "untriggered_skill",
  ]),
  severity: z.enum(["warning", "breaking"]),
  message: z.string().min(1),
  suggestedFix: z.string().optional(),
});
export type CompatibilityIssue = z.infer<typeof CompatibilityIssueSchema>;

export const HarnessCompatibilityReportSchema = z.object({
  checkedAt: z.string(),
  appVersion: z.string(),
  expectedSchemaVersion: z.number().int().positive(),
  harnessSchemaVersion: z.number().int().nonnegative(),
  commitSha: z.string(),
  hasBreakingIssues: z.boolean(),
  needsMigration: z.boolean(),
  quarantinedPaths: z.array(z.string()).default([]),
  issues: z.array(CompatibilityIssueSchema).default([]),
  migrationGuideSummary: z.string().optional(),
});
export type HarnessCompatibilityReport = z.infer<typeof HarnessCompatibilityReportSchema>;

export const GardenerFindingSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "prompt_bloat",
    "untriggered_skill",
    "orphan_script",
    "duplicate_experience",
    "empty_organ",
    "same_model_collusion",
  ]),
  severity: z.enum(["advisory", "warning"]),
  path: z.string().min(1),
  detail: z.string().min(1),
  suggestedAction: z.enum(["prune", "trigger", "consolidate", "diversify_models"]),
});
export type GardenerFinding = z.infer<typeof GardenerFindingSchema>;

export const HarnessGardenerReportSchema = z.object({
  checkedAt: z.string(),
  commitSha: z.string(),
  healthScore: z.number().int().min(0).max(100),
  alwaysOnBytes: z.number().int().nonnegative(),
  alwaysOnEstimatedTokens: z.number().int().nonnegative(),
  totalOrgans: z.number().int().nonnegative(),
  modelDiversityOk: z.boolean(),
  findings: z.array(GardenerFindingSchema).default([]),
  suggestedPruningGoal: z.string().optional(),
});
export type HarnessGardenerReport = z.infer<typeof HarnessGardenerReportSchema>;

export const EvolutionProposalSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  mode: EvolutionModeSchema,
  k: z.number().int().positive().default(1),
  triggerSource: z.enum([
    "steer",
    "failure",
    "manual",
    "onboarding",
    "inline_revision",
    "upgrade_migration",
  ]),
  sourceTags: z.array(UntrustedSourceTagSchema).default(["local"]),
  requiresHumanTrust: z.boolean(),
  baseCommitSha: z.string().min(1),
  status: ProposalStatusSchema,
  degradedReason: z.string().optional(),
  metricsBefore: RunMetricsSchema,
  metricsAfter: RunMetricsSchema,
  blindJudge: BlindJudgeResultSchema.optional(),
  diffs: z.array(FileDiffSchema),
  experienceEntry: ExperienceEntrySchema.optional(),
  inlineComments: z.array(InlineDiffCommentSchema).default([]),
  regressionCheck: RegressionCheckSummarySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EvolutionProposal = z.infer<typeof EvolutionProposalSchema>;

// --- F3 RPC Params ---

export const EvolutionTriggerParamsSchema = z.object({
  threadId: z.string().min(1),
  domain: z.string().default("general"),
  mode: EvolutionModeSchema.default("parallel"),
  k: z.number().int().min(1).max(4).default(1),
  triggerSource: z
    .enum(["steer", "failure", "manual", "onboarding", "upgrade_migration"])
    .default("manual"),
  goal: z.string().trim().max(4000).optional(),
  improverModelOverride: z.string().min(1).optional(),
  improverProviderIdOverride: z.string().min(1).optional(),
});
export type EvolutionTriggerParams = z.infer<typeof EvolutionTriggerParamsSchema>;

export const EvolutionArchitectAskParamsSchema = z.object({
  pillarId: z.string().min(1),
  pillarTitle: z.string().min(1),
  domain: z.string().min(1),
  message: z.string().trim().min(1).max(4000),
  goalDraft: z.string().max(4000).optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(12).default([]),
  modelOverride: z.string().min(1).optional(),
  providerIdOverride: z.string().min(1).optional(),
  locale: z.string().optional(),
});
export type EvolutionArchitectAskParams = z.infer<typeof EvolutionArchitectAskParamsSchema>;

export const EvolutionArchitectAskResultSchema = z.object({
  reply: z.string(),
  suggestedGoal: z.string().optional(),
  modelId: z.string(),
  usage: TokenUsageSchema,
});
export type EvolutionArchitectAskResult = z.infer<typeof EvolutionArchitectAskResultSchema>;

export const EvolutionReviseParamsSchema = z.object({
  proposalId: z.string().min(1),
  comments: z.array(
    z.object({
      filePath: z.string().min(1),
      lineNumber: z.number().int().positive(),
      comment: z.string().min(1),
    }),
  ).min(1),
});
export type EvolutionReviseParams = z.infer<typeof EvolutionReviseParamsSchema>;

export const EvolutionProposalActionParamsSchema = z.object({
  proposalId: z.string().min(1),
  trustHighPrivilegeAssets: z.boolean().default(false),
});
export type EvolutionProposalActionParams = z.infer<typeof EvolutionProposalActionParamsSchema>;

// --- F3 Theater Streaming Events ---

export const EvolutionStageSchema = z.enum([
  "queued",
  "proposing_inv",
  "proposing_dom",
  "shadow_probing",
  "composing",
  "blind_judging",
  "regression_checking",
  "reflecting",
  "completed",
  "failed",
]);
export type EvolutionStage = z.infer<typeof EvolutionStageSchema>;

export const EvolutionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("evolution.step.started"),
    proposalId: z.string(),
    stage: EvolutionStageSchema,
    label: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("evolution.step.progress"),
    proposalId: z.string(),
    stage: EvolutionStageSchema,
    message: z.string(),
    metricsSnapshot: RunMetricsSchema.optional(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("evolution.step.completed"),
    proposalId: z.string(),
    stage: EvolutionStageSchema,
    summary: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("evolution.proposal_ready"),
    proposal: EvolutionProposalSchema,
  }),
  z.object({
    type: z.literal("evolution.health_rollback"),
    domain: z.string(),
    fromSha: z.string(),
    toSha: z.string(),
    reason: z.string(),
    timestamp: z.string(),
  }),
]);
export type EvolutionEvent = z.infer<typeof EvolutionEventSchema>;
