import OpenAI from "openai";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { ModelPricing } from "@harnex/protocol";
import { finalChunks, pricedUsage, toolArguments, withUpstreamCost, zeroUsage } from "./shared.ts";

type Params = OpenAI.Chat.ChatCompletionCreateParams;
type Message = OpenAI.Chat.ChatCompletionMessageParam;
type Reasoning = { reasoning_content?: string; reasoning?: string };
type Usage = OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; cost?: unknown; total_cost?: unknown; cost_usd?: unknown };
const reasoningByCall = new WeakMap<LlmToolCall, Reasoning>();

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

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const result = await this.sdk.chat.completions.create({ ...this.params(request), stream: false }, { signal: request.signal });
    const choice = result.choices[0];
    const message = choice?.message as (OpenAI.Chat.ChatCompletionMessage & Reasoning) | undefined;
    const toolCalls = message?.tool_calls?.flatMap((call): LlmToolCall[] => call.type === "function" ? [{
      id: call.id, name: call.function.name, arguments: toolArguments(call.function.arguments),
    }] : []) ?? [];
    if (toolCalls[0] && message && (message.reasoning_content || message.reasoning)) {
      reasoningByCall.set(toolCalls[0], { reasoning_content: message.reasoning_content, reasoning: message.reasoning });
    }
    return {
      content: message?.content ?? "", reasoning: message?.reasoning_content ?? message?.reasoning,
      toolCalls, modelId: result.model, usage: this.usage(result.usage),
      finishReason: !choice || choice.finish_reason === "content_filter" ? "error" :
        choice.finish_reason === "length" ? "length" : toolCalls.length ? "tool_calls" : "stop",
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const stream = await this.sdk.chat.completions.create({
      ...this.params(request), stream: true, stream_options: { include_usage: true },
    }, { signal: request.signal });
    let usage = zeroUsage();
    const rawReasoning: Reasoning = {};
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      if (chunk.usage) usage = this.usage(chunk.usage);
      const delta = chunk.choices[0]?.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & Reasoning) | undefined;
      if (!delta) continue;
      if (delta.reasoning_content) rawReasoning.reasoning_content = (rawReasoning.reasoning_content ?? "") + delta.reasoning_content;
      if (delta.reasoning) rawReasoning.reasoning = (rawReasoning.reasoning ?? "") + delta.reasoning;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
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
    yield* finalChunks(toolCalls, usage);
  }
}
