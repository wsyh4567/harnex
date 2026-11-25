import OpenAI from "openai";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { ModelPricing } from "@harnex/protocol";
import { finalChunks, pricedUsage, toolArguments, withUpstreamCost, zeroUsage } from "./shared.ts";

type Params = OpenAI.Chat.ChatCompletionCreateParams;
type Message = OpenAI.Chat.ChatCompletionMessageParam;
type ReasoningDetail = { text?: unknown; summary?: unknown };
type Reasoning = {
  reasoning_content?: string;
  reasoning?: string;
  reasoning_summary?: string;
  reasoning_details?: ReasoningDetail[];
};
type Usage = OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; cost?: unknown; total_cost?: unknown; cost_usd?: unknown };
const reasoningByCall = new WeakMap<LlmToolCall, { reasoning_content?: string; reasoning?: string }>();

function extractReasoningText(source?: Reasoning): string | undefined {
  if (!source) return undefined;
  if (typeof source.reasoning_content === "string" && source.reasoning_content) return source.reasoning_content;
  if (typeof source.reasoning === "string" && source.reasoning) return source.reasoning;
  if (typeof source.reasoning_summary === "string" && source.reasoning_summary) return source.reasoning_summary;
  if (Array.isArray(source.reasoning_details) && source.reasoning_details.length > 0) {
    const joined = source.reasoning_details
      .map((item) => (typeof item?.text === "string" ? item.text : typeof item?.summary === "string" ? item.summary : ""))
      .filter(Boolean)
      .join("");
    if (joined) return joined;
  }
  return undefined;
}

export class OpenAiLlmClient implements LlmClient {
  constructor(
    private readonly sdk: OpenAI, private readonly model: string, private readonly pricing?: ModelPricing,
    private readonly kind: "openai" | "openai_compatible" | "ollama" = "openai",
  ) {}

  private params(request: LlmRequest): Omit<Params, "stream"> {
    const messages: Message[] = request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : [];
    for (const message of request.messages) {
      // OpenAI caches prefixes automatically; compatible gateways can accept explicit cache breakpoints.
      const content = message.cacheControl && this.kind === "openai_compatible" ?
        [{ type: "text" as const, text: message.content, cache_control: { type: message.cacheControl } }] : message.content;
      if (message.role === "tool") {
        if (!message.toolCallId) throw new Error("Tool result is missing its call ID");
        messages.push({ role: "tool", content, tool_call_id: message.toolCallId });
      } else if (message.role === "assistant") {
        const rawReasoning = this.kind === "openai_compatible" && message.toolCalls?.[0] && reasoningByCall.get(message.toolCalls[0]);
        messages.push({ ...(rawReasoning || {}), role: "assistant", content, tool_calls: message.toolCalls?.map((call) => ({
          id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) });
      } else messages.push({ role: message.role, content });
    }
    return {
      model: request.modelId ?? this.model, messages, temperature: request.temperature,
      ...(this.kind === "openai" ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }),
      tools: request.tools?.map((tool) => ({ type: "function", function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      } })),
    };
  }

  private usage(usage?: Usage | null) {
    if (!usage) return zeroUsage();
    const estimate = pricedUsage(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0,
      usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
      usage.completion_tokens_details?.reasoning_tokens ?? 0, this.pricing);
    return withUpstreamCost(estimate, usage.cost, usage.total_cost, usage.cost_usd);
  }

  private fromCompletion(result: OpenAI.Chat.ChatCompletion): LlmResponse {
    const choice = result.choices[0];
    const message = choice?.message as (OpenAI.Chat.ChatCompletionMessage & Reasoning) | undefined;
    const toolCalls = message?.tool_calls?.flatMap((call): LlmToolCall[] => call.type === "function" ? [{
      id: call.id, name: call.function.name, arguments: toolArguments(call.function.arguments),
    }] : []) ?? [];
    if (toolCalls[0] && message && (message.reasoning_content || message.reasoning)) {
      reasoningByCall.set(toolCalls[0], { reasoning_content: message.reasoning_content, reasoning: message.reasoning });
    }
    return {
      content: message?.content ?? "", reasoning: extractReasoningText(message),
      toolCalls, modelId: result.model, usage: this.usage(result.usage),
      finishReason: !choice || choice.finish_reason === "content_filter" ? "error" :
        choice.finish_reason === "length" ? "length" : toolCalls.length ? "tool_calls" : "stop",
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const result = await this.sdk.chat.completions.create({ ...this.params(request), stream: false }, { signal: request.signal });
    return this.fromCompletion(result);
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const { data: stream, response } = await this.sdk.chat.completions.create({
      ...this.params(request), stream: true, stream_options: { include_usage: true },
    }, { signal: request.signal }).withResponse();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      const fallback = this.fromCompletion(await response.json() as OpenAI.Chat.ChatCompletion);
      if (fallback.reasoning) yield { type: "reasoning_delta", delta: fallback.reasoning };
      if (fallback.content) yield { type: "text_delta", delta: fallback.content };
      yield* finalChunks(fallback.toolCalls, fallback.usage, fallback.finishReason);
      return;
    }
    let usage = zeroUsage();
    let finishReason: LlmResponse["finishReason"] | undefined;
    const rawReasoning: { reasoning_content?: string; reasoning?: string } = {};
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      if (chunk.usage) usage = this.usage(chunk.usage);
      const choice = chunk.choices[0];
      if (choice?.finish_reason === "content_filter") finishReason = "error";
      else if (choice?.finish_reason === "length") finishReason = "length";
      const delta = choice?.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & Reasoning) | undefined;
      if (!delta) continue;
      if (delta.reasoning_content) rawReasoning.reasoning_content = (rawReasoning.reasoning_content ?? "") + delta.reasoning_content;
      if (delta.reasoning) rawReasoning.reasoning = (rawReasoning.reasoning ?? "") + delta.reasoning;
      const reasoning = extractReasoningText(delta);
      if (reasoning) yield { type: "reasoning_delta", delta: reasoning };
      if (delta.content) yield { type: "text_delta", delta: delta.content };
      for (const part of delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", name: "", args: "" };
        call.id += part.id ?? "";
        call.name += part.function?.name ?? "";
        call.args += part.function?.arguments ?? "";
        calls.set(part.index, call);
      }
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id, name: call.name, arguments: toolArguments(call.args),
    }));
    if (toolCalls[0] && (rawReasoning.reasoning_content || rawReasoning.reasoning)) reasoningByCall.set(toolCalls[0], rawReasoning);
    yield* finalChunks(toolCalls, usage, finishReason);
  }
}
