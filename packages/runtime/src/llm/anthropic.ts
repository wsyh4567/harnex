import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { MessageAttachmentInput, ModelPricing, ReasoningEffort } from "@harnex/protocol";
import { finalChunks, pricedUsage, toolArguments } from "./shared.ts";

type AnthropicThinkingTier = "adaptive" | "enabled" | "none";
type ExplicitReasoningEffort = Exclude<ReasoningEffort, "auto">;

const ANTHROPIC_EFFORT_BUDGETS: Record<ExplicitReasoningEffort, number> = {
  low: 2048,
  medium: 6144,
  high: 12288,
};

const thoughts = new WeakMap<LlmToolCall, Anthropic.ContentBlockParam[]>();
const thinkingTierCache = new Map<string, AnthropicThinkingTier>();

function isAnthropicThinkingRejected(error: unknown): boolean {
  const value = error as { status?: unknown; message?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : String(error ?? "");
  const status = typeof value?.status === "number" ? value.status : undefined;
  if (status !== undefined && status !== 400 && status !== 422) return false;
  return /thinking|adaptive|budget_tokens|output_config|\beffort\b|temperature|extra inputs are not permitted|invalid.*type/i.test(message);
}

function nextAnthropicTier(current: AnthropicThinkingTier): AnthropicThinkingTier | undefined {
  if (current === "adaptive") return "enabled";
  if (current === "enabled") return "none";
  return undefined;
}

function partitionAttachments(attachments?: MessageAttachmentInput[]): {
  images: MessageAttachmentInput[];
  fallbackNotes: string[];
} {
  const images: MessageAttachmentInput[] = [];
  const fallbackNotes: string[] = [];
  for (const att of attachments ?? []) {
    if (att.mimeType.toLowerCase().startsWith("image/") && att.dataBase64.trim().length > 0) {
      images.push(att);
    } else {
      fallbackNotes.push(`[Attached file: ${att.name} (${att.mimeType})]`);
    }
  }
  return { images, fallbackNotes };
}

function combineTextWithNotes(text: string, notes: string[]): string {
  if (!notes.length) return text;
  return text ? `${text}\n${notes.join("\n")}` : notes.join("\n");
}

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly sdk: Anthropic, private readonly model: string, private readonly pricing?: ModelPricing) {}

  private cacheKey(targetModel: string): string {
    return `${this.sdk.baseURL ?? ""}::${targetModel}`;
  }

  private params(request: LlmRequest, tier: AnthropicThinkingTier): Anthropic.MessageCreateParamsNonStreaming {
    const system: Anthropic.TextBlockParam[] = request.systemPrompt ? [{ type: "text", text: request.systemPrompt }] : [];
    const messages: Anthropic.MessageParam[] = [];
    for (const message of request.messages) {
      const cache_control = message.cacheControl ? { type: message.cacheControl } : undefined;
      if (message.role === "system") {
        if (message.content) system.push({ type: "text", text: message.content, cache_control });
        continue;
      }
      if (message.role === "tool" && !message.toolCallId) throw new Error("Tool result is missing its call ID");
      let parts: Anthropic.ContentBlockParam[];
      if (message.role === "tool") {
        parts = [{ type: "tool_result", tool_use_id: message.toolCallId!, content: message.content, cache_control }];
      } else if (message.role === "user" && message.attachments?.length) {
        const { images, fallbackNotes } = partitionAttachments(message.attachments);
        const textContent = combineTextWithNotes(message.content, fallbackNotes);
        parts = [
          ...(textContent ? [{ type: "text" as const, text: textContent, cache_control }] : []),
          ...images.map((att, index): Anthropic.ImageBlockParam => ({
            type: "image",
            source: {
              type: "base64",
              media_type: att.mimeType as Anthropic.Base64ImageSource["media_type"],
              data: att.dataBase64,
            },
            ...(!textContent && index === images.length - 1 && cache_control ? { cache_control } : {}),
          })),
        ];
      } else {
        const text: Anthropic.TextBlockParam = { type: "text", text: message.content, cache_control };
        parts = [
          ...(message.toolCalls?.[0] ? thoughts.get(message.toolCalls[0]) ?? [] : []),
          ...(message.content ? [text] : []),
          ...(message.toolCalls ?? []).map((call, index, calls): Anthropic.ToolUseBlockParam => ({
            type: "tool_use", id: call.id, name: call.name, input: call.arguments,
            cache_control: !message.content && index === calls.length - 1 ? cache_control : undefined,
          })),
        ];
      }
      if (!parts.length) continue;
      const role = message.role === "assistant" ? "assistant" : "user";
      const last = messages.at(-1);
      if (last?.role === role && Array.isArray(last.content)) last.content.push(...parts);
      else messages.push({ role, content: parts });
    }
    const explicitEffort: ExplicitReasoningEffort | undefined =
      request.reasoningEffort && request.reasoningEffort !== "auto" ? request.reasoningEffort : undefined;
    const baseMaxTokens = request.maxTokens ?? 4096;
    let thinkingMaxTokens: number;
    let budgetTokens: number;
    if (explicitEffort) {
      const targetBudget = ANTHROPIC_EFFORT_BUDGETS[explicitEffort];
      if (request.maxTokens === undefined) {
        thinkingMaxTokens = Math.max(8192, targetBudget + 4096);
        budgetTokens = targetBudget;
      } else {
        thinkingMaxTokens = Math.max(baseMaxTokens, 2048);
        budgetTokens = Math.min(targetBudget, Math.max(1024, thinkingMaxTokens - 1024));
      }
    } else {
      thinkingMaxTokens = Math.max(baseMaxTokens, 8192);
      budgetTokens = Math.min(4096, Math.max(1024, Math.floor(thinkingMaxTokens / 2)));
    }
    const thinkingExtra =
      tier === "adaptive"
        ? ({
            thinking: { type: "adaptive" },
            ...(explicitEffort ? { output_config: { effort: explicitEffort } } : {}),
          } as unknown as Partial<Anthropic.MessageCreateParamsNonStreaming>)
        : tier === "enabled"
          ? { thinking: { type: "enabled" as const, budget_tokens: budgetTokens } }
          : {};
    return {
      model: request.modelId ?? this.model,
      system,
      messages,
      max_tokens: tier === "none" ? baseMaxTokens : thinkingMaxTokens,
      ...(tier === "none" ? { temperature: request.temperature } : {}),
      ...thinkingExtra,
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
    const targetModel = request.modelId ?? this.model;
    const key = this.cacheKey(targetModel);
    let tier = thinkingTierCache.get(key) ?? "adaptive";
    for (;;) {
      try {
        const message = await this.sdk.messages.create(this.params(request, tier), { signal: request.signal });
        thinkingTierCache.set(key, tier);
        return this.result(message);
      } catch (error) {
        const next = nextAnthropicTier(tier);
        if (!next || !isAnthropicThinkingRejected(error)) throw error;
        tier = next;
        thinkingTierCache.set(key, tier);
      }
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const targetModel = request.modelId ?? this.model;
    const key = this.cacheKey(targetModel);
    let tier = thinkingTierCache.get(key) ?? "adaptive";

    const open = async (activeTier: AnthropicThinkingTier) => {
      const stream = this.sdk.messages.stream(this.params(request, activeTier), { signal: request.signal });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      return { stream, iterator, first };
    };

    let opened: Awaited<ReturnType<typeof open>>;
    for (;;) {
      try {
        opened = await open(tier);
        thinkingTierCache.set(key, tier);
        break;
      } catch (error) {
        const next = nextAnthropicTier(tier);
        if (!next || !isAnthropicThinkingRejected(error)) throw error;
        tier = next;
        thinkingTierCache.set(key, tier);
      }
    }

    try {
      for (let item = opened.first; !item.done; item = await opened.iterator.next()) {
        const event = item.value;
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text" && block.text) yield { type: "text_delta", delta: block.text };
          if (block.type === "thinking" && block.thinking) yield { type: "reasoning_delta", delta: block.thinking };
        }
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") yield { type: "text_delta", delta: event.delta.text };
        if (event.delta.type === "thinking_delta") yield { type: "reasoning_delta", delta: event.delta.thinking };
      }
      const result = this.result(await opened.stream.finalMessage());
      yield* finalChunks(result.toolCalls, result.usage, result.finishReason);
    } finally {
      await opened.iterator.return?.();
    }
  }
}
