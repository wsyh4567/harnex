import type { LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { ModelPricing, TokenUsage } from "@harnex/protocol";

export const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0 });

export function withUpstreamCost(usage: TokenUsage, ...values: unknown[]): TokenUsage {
  const cost = values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return cost === undefined ? usage : { ...usage, upstreamCostUsd: cost, costUsd: cost };
}

export function pricedUsage(
  inputTokens: number, outputTokens: number, cachedInputTokens: number, reasoningTokens: number,
  pricing?: ModelPricing, cacheCreationTokens = 0, cacheCreationPer1MUsd?: number,
): TokenUsage {
  const costUsd = pricing ? (
    (inputTokens - cachedInputTokens - cacheCreationTokens) * pricing.inputPer1MUsd +
    cachedInputTokens * (pricing.cachedInputPer1MUsd ?? pricing.inputPer1MUsd) +
    cacheCreationTokens * (cacheCreationPer1MUsd ?? pricing.inputPer1MUsd * 1.25) +
    outputTokens * pricing.outputPer1MUsd
  ) / 1_000_000 : 0;
  return { inputTokens, outputTokens, cachedInputTokens, reasoningTokens, costUsd };
}

export function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    if (!value.trim()) return {};
    value = JSON.parse(value);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function* finalChunks(
  calls: Iterable<LlmToolCall>,
  usage: TokenUsage,
  finishReason?: LlmStreamChunk["finishReason"],
): AsyncIterable<LlmStreamChunk> {
  for (const toolCall of calls) yield { type: "tool_call", toolCall };
  if (finishReason && finishReason !== "stop" && finishReason !== "tool_calls") {
    yield { type: "done", usage, finishReason };
  } else {
    yield { type: "done", usage };
  }
}
