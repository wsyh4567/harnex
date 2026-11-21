import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { ModelPricing } from "@harnex/protocol";
import { finalChunks, pricedUsage, toolArguments } from "./shared.ts";

const thoughts = new WeakMap<LlmToolCall, Anthropic.ContentBlockParam[]>();

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly sdk: Anthropic, private readonly model: string, private readonly pricing?: ModelPricing) {}

  private params(request: LlmRequest): Anthropic.MessageCreateParamsNonStreaming {
    const system: Anthropic.TextBlockParam[] = request.systemPrompt ? [{ type: "text", text: request.systemPrompt }] : [];
    const messages: Anthropic.MessageParam[] = [];
    for (const message of request.messages) {
      const cache_control = message.cacheControl ? { type: message.cacheControl } : undefined;
      const text: Anthropic.TextBlockParam = { type: "text", text: message.content, cache_control };
      if (message.role === "system") {
        if (message.content) system.push(text);
        continue;
      }
      if (message.role === "tool" && !message.toolCallId) throw new Error("Tool result is missing its call ID");
      const parts: Anthropic.ContentBlockParam[] = message.role === "tool" ? [{
        type: "tool_result", tool_use_id: message.toolCallId!, content: message.content, cache_control,
      }] : [
        ...(message.toolCalls?.[0] ? thoughts.get(message.toolCalls[0]) ?? [] : []),
        ...(message.content ? [text] : []),
        ...(message.toolCalls ?? []).map((call, index, calls): Anthropic.ToolUseBlockParam => ({
          type: "tool_use", id: call.id, name: call.name, input: call.arguments,
          cache_control: !message.content && index === calls.length - 1 ? cache_control : undefined,
        })),
      ];
      if (!parts.length) continue;
      const role = message.role === "assistant" ? "assistant" : "user";
      const last = messages.at(-1);
      if (last?.role === role && Array.isArray(last.content)) last.content.push(...parts);
      else messages.push({ role, content: parts });
    }
    return {
      model: request.modelId ?? this.model, system, messages,
      max_tokens: request.maxTokens ?? 4096, temperature: request.temperature,
      tools: request.tools?.map((tool) => ({
        name: tool.name, description: tool.description, input_schema: { ...tool.inputSchema, type: "object" },
      })),
    };
  }

  private result(message: Anthropic.Message): LlmResponse {
    let content = "", reasoning = "";
    const toolCalls: LlmToolCall[] = [];
    const thinking: Anthropic.ContentBlockParam[] = [];
    for (const block of message.content) {
      if (block.type === "text") content += block.text;
      if (block.type === "thinking") reasoning += block.thinking;
      if (block.type === "thinking" || block.type === "redacted_thinking") thinking.push(block);
      if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: toolArguments(block.input) });
    }
    if (toolCalls[0] && thinking.length) thoughts.set(toolCalls[0], thinking);
    const usage = message.usage as Anthropic.Usage & { reasoning_tokens?: number };
    const cached = usage.cache_read_input_tokens ?? 0;
    const created = usage.cache_creation_input_tokens ?? 0;
    return {
      content, reasoning: reasoning || undefined, toolCalls, modelId: message.model,
      usage: pricedUsage(usage.input_tokens + cached + created, usage.output_tokens, cached, usage.reasoning_tokens ?? 0, this.pricing, created),
      finishReason: message.stop_reason === "max_tokens" ? "length" : toolCalls.length ? "tool_calls" : "stop",
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return this.result(await this.sdk.messages.create(this.params(request), { signal: request.signal }));
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const stream = this.sdk.messages.stream(this.params(request), { signal: request.signal });
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "text" && block.text) yield { type: "text_delta", delta: block.text };
        if (block.type === "thinking" && block.thinking) yield { type: "reasoning_delta", delta: block.thinking };
      }
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") yield { type: "text_delta", delta: event.delta.text };
      if (event.delta.type === "thinking_delta") yield { type: "reasoning_delta", delta: event.delta.thinking };
    }
    const result = this.result(await stream.finalMessage());
    yield* finalChunks(result.toolCalls, result.usage);
  }
}
