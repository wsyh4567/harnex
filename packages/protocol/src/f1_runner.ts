import { z } from "zod";
import { ExecutionModeSchema, TokenUsageSchema, UntrustedSourceTagSchema } from "./common.ts";

export const GoalStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: GoalStatusSchema,
  detail: z.string().optional(),
});
export type GoalItem = z.infer<typeof GoalItemSchema>;

export const ToolCallStatusSchema = z.enum([
  "pending",
  "awaiting_approval",
  "running",
  "completed",
  "failed",
  "denied",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolCallRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.unknown()),
  status: ToolCallStatusSchema,
  output: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  truncated: z.boolean().default(false),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const ReasoningEffortSchema = z.enum(["auto", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const MessageAttachmentMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().nonnegative().max(4 * 1024 * 1024),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type MessageAttachmentMeta = z.infer<typeof MessageAttachmentMetaSchema>;

export const MessageAttachmentInputSchema = MessageAttachmentMetaSchema.extend({
  dataBase64: z.string().min(1).max(6 * 1024 * 1024),
});
export type MessageAttachmentInput = z.infer<typeof MessageAttachmentInputSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool", "steer"]),
  content: z.string(),
  reasoning: z.string().optional(),
  toolCalls: z.array(ToolCallRecordSchema).optional(),
  attachments: z.array(MessageAttachmentMetaSchema).optional(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ThreadStatusSchema = z.enum([
  "idle",
  "running",
  "paused",
  "awaiting_approval",
  "completed",
  "failed",
  "aborted",
]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1),
  title: z.string().min(1),
  mode: ExecutionModeSchema,
  status: ThreadStatusSchema,
  pinnedCommitSha: z.string().min(1),
  pinnedVersionLabel: z.string().optional(),
  domain: z.string().default("general"),
  goals: z.array(GoalItemSchema).default([]),
  contextUsedTokens: z.number().int().nonnegative().default(0),
  contextMaxTokens: z.number().int().positive().default(128_000),
  sourceTags: z.array(UntrustedSourceTagSchema).default(["local"]),
  hadHumanSteer: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof ThreadSchema>;

// --- F1 RPC Params & Results ---

export const ThreadCreateParamsSchema = z.object({
  workspacePath: z.string().min(1),
  title: z.string().min(1).optional(),
  mode: ExecutionModeSchema.default("craft"),
  domain: z.string().optional(),
});
export type ThreadCreateParams = z.infer<typeof ThreadCreateParamsSchema>;

export const ThreadRenameParamsSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
});
export type ThreadRenameParams = z.infer<typeof ThreadRenameParamsSchema>;

export const ThreadDeleteParamsSchema = z.object({ threadId: z.string().min(1) });
export type ThreadDeleteParams = z.infer<typeof ThreadDeleteParamsSchema>;

export const RunnerStartParamsSchema = z.object({
  threadId: z.string().min(1),
  prompt: z.string().min(1),
  mode: ExecutionModeSchema.optional(),
  providerIdOverride: z.string().min(1).optional(),
  modelOverride: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  attachments: z.array(MessageAttachmentInputSchema).max(4).optional(),
});
export type RunnerStartParams = z.infer<typeof RunnerStartParamsSchema>;

export const RunnerControlParamsSchema = z.object({
  threadId: z.string().min(1),
});
export type RunnerControlParams = z.infer<typeof RunnerControlParamsSchema>;

export const RunnerSteerParamsSchema = z.object({
  threadId: z.string().min(1),
  instruction: z.string().min(1),
  triggerEvolutionOnFinish: z.boolean().default(true),
});
export type RunnerSteerParams = z.infer<typeof RunnerSteerParamsSchema>;

export const SideChatAskParamsSchema = z.object({
  threadId: z.string().min(1),
  question: z.string().min(1),
});
export type SideChatAskParams = z.infer<typeof SideChatAskParamsSchema>;

export const SideChatAskResultSchema = z.object({
  answer: z.string(),
  usage: TokenUsageSchema,
  isolatedFromMainTrace: z.literal(true),
});
export type SideChatAskResult = z.infer<typeof SideChatAskResultSchema>;

// --- F1 Streaming Events ---

export const RunnerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("runner.started"),
    threadId: z.string(),
    runId: z.string(),
    pinnedCommitSha: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("runner.token"),
    threadId: z.string(),
    runId: z.string(),
    delta: z.string(),
    channel: z.enum(["content", "reasoning"]).default("content"),
  }),
  z.object({
    type: z.literal("runner.tool_call"),
    threadId: z.string(),
    runId: z.string(),
    toolCall: ToolCallRecordSchema,
  }),
  z.object({
    type: z.literal("runner.tool_result"),
    threadId: z.string(),
    runId: z.string(),
    toolCallId: z.string(),
    output: z.string(),
    error: z.string().optional(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    truncated: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("runner.goal_updated"),
    threadId: z.string(),
    goals: z.array(GoalItemSchema),
  }),
  z.object({
    type: z.literal("runner.context_usage"),
    threadId: z.string(),
    usedTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
    compressed: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("runner.paused"),
    threadId: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("runner.steered"),
    threadId: z.string(),
    instruction: z.string(),
    markedForEvolution: z.boolean(),
  }),
  z.object({
    type: z.literal("runner.completed"),
    threadId: z.string(),
    runId: z.string(),
    finalOutput: z.string(),
    usage: TokenUsageSchema,
    queuedForEvolution: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("runner.error"),
    threadId: z.string(),
    runId: z.string().optional(),
    message: z.string(),
    code: z.string().optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;
