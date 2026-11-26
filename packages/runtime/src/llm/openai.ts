import OpenAI from "openai";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { MessageAttachmentInput, ModelPricing, OpenAiApiProtocol, ReasoningEffort } from "@harnex/protocol";
import { finalChunks, pricedUsage, toolArguments, withUpstreamCost, zeroUsage } from "./shared.ts";

type ChatParams = OpenAI.Chat.ChatCompletionCreateParams;
type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ResponsesCreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseReasoningItem = OpenAI.Responses.ResponseReasoningItem;
type ReasoningDetail = { text?: unknown; summary?: unknown };
type Reasoning = {
  reasoning_content?: string;
  reasoning?: string;
  reasoning_summary?: string;
  reasoning_details?: ReasoningDetail[];
};
type ChatUsage = OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; cost?: unknown; total_cost?: unknown; cost_usd?: unknown };
type ResponsesUsage = OpenAI.Responses.ResponseUsage & { cost?: unknown; total_cost?: unknown; cost_usd?: unknown };

type OpenAiWireMode = "responses_summary" | "responses_plain" | "chat" | "chat_no_temp";
type ExplicitReasoningEffort = Exclude<ReasoningEffort, "auto">;

const reasoningByCall = new WeakMap<LlmToolCall, { reasoning_content?: string; reasoning?: string }>();
const responseReasoningByCall = new WeakMap<LlmToolCall, ResponseReasoningItem[]>();
const protocolCache = new Map<string, OpenAiWireMode>();
const unsupportedEffortCache = new Set<string>();

function explicitEffortOf(effort?: ReasoningEffort): ExplicitReasoningEffort | undefined {
  return effort && effort !== "auto" ? effort : undefined;
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

function errorStatusAndMessage(error: unknown): { status?: number; message: string } {
  const value = error as { status?: unknown; message?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : String(error ?? "");
  const status = typeof value?.status === "number" ? value.status : undefined;
  return { status, message };
}

function isResponsesEndpointUnavailable(error: unknown): boolean {
  const { status, message } = errorStatusAndMessage(error);
  if (status === 404 || status === 405 || status === 501) return true;
  return /unknown url|invalid url|not found.*\/responses|unsupported.*\/responses|does not support.*responses/i.test(message);
}

function isResponsesReasoningRejected(error: unknown): boolean {
  const { status, message } = errorStatusAndMessage(error);
  if (status !== undefined && status !== 400 && status !== 422) return false;
  return /reasoning|summary|temperature|unsupported parameter|unknown parameter/i.test(message);
}

function isChatRequiresResponses(error: unknown): boolean {
  const { status, message } = errorStatusAndMessage(error);
  if (status === 404 || status === 405 || status === 501) return true;
  if (status !== undefined && status !== 400 && status !== 422) return false;
  return /v1\/responses|responses api|not a chat model|use the responses/i.test(message);
}

function isTemperatureRejected(error: unknown): boolean {
  const { status, message } = errorStatusAndMessage(error);
  if (status !== undefined && status !== 400 && status !== 422) return false;
  return /temperature/i.test(message);
}

function isEffortOnlyRejected(error: unknown): boolean {
  const { status, message } = errorStatusAndMessage(error);
  if (status !== undefined && status !== 400 && status !== 422) return false;
  return /reasoning[._]effort|\beffort\b/i.test(message);
}

function isChatReasoningEffortRejected(error: unknown): boolean {
  const { status, message } = errorStatusAndMessage(error);
  if (status !== undefined && status !== 400 && status !== 422) return false;
  if (isChatRequiresResponses(error)) return false;
  if (isTemperatureRejected(error) && !/reasoning|\beffort\b/i.test(message)) return false;
  return /reasoning(?:_?effort)?|\beffort\b|unsupported parameter|unknown parameter|unrecognized request argument|extra_forbidden|additional properties/i.test(message);
}

function extractResponsesItemReasoning(item: ResponseReasoningItem): string {
  const parts: string[] = [];
  for (const s of item.summary ?? []) {
    if (typeof s?.text === "string" && s.text) parts.push(s.text);
  }
  const extraContent = (item as unknown as { content?: Array<{ text?: unknown }> }).content;
  if (parts.length === 0 && Array.isArray(extraContent)) {
    for (const c of extraContent) {
      if (typeof c?.text === "string" && c.text) parts.push(c.text);
    }
  }
  return parts.join("\n");
}

export class OpenAiLlmClient implements LlmClient {
  constructor(
    private readonly sdk: OpenAI, private readonly model: string, private readonly pricing?: ModelPricing,
    private readonly kind: "openai" | "openai_compatible" | "ollama" = "openai",
    private readonly apiProtocol: OpenAiApiProtocol = "auto",
  ) {}

  private cacheKey(targetModel: string): string {
    return `${this.sdk.baseURL ?? ""}::${this.kind}::${this.apiProtocol}::${targetModel}`;
  }

  private effortCacheKey(targetModel: string, protocol: "responses" | "chat"): string {
    return `${this.sdk.baseURL ?? ""}::${targetModel}::${protocol}`;
  }

  private activeEffort(request: LlmRequest, mode: OpenAiWireMode, targetModel: string): ExplicitReasoningEffort | undefined {
    const effort = explicitEffortOf(request.reasoningEffort);
    if (!effort || mode === "responses_plain") return undefined;
    const protocol = mode === "responses_summary" ? "responses" : "chat";
    return unsupportedEffortCache.has(this.effortCacheKey(targetModel, protocol)) ? undefined : effort;
  }

  private initialMode(targetModel: string): OpenAiWireMode {
    const cached = protocolCache.get(this.cacheKey(targetModel));
    if (cached) return cached;
    if (this.apiProtocol === "responses") return "responses_summary";
    if (this.apiProtocol === "chat_completions") return "chat";
    return this.kind === "openai" ? "responses_summary" : "chat";
  }

  private nextAttempt(
    current: OpenAiWireMode,
    usedEffort: ExplicitReasoningEffort | undefined,
    error: unknown,
    targetModel: string,
  ): { mode: OpenAiWireMode; modeChanged: boolean } | undefined {
    const allowSwitch = this.apiProtocol === "auto";
    if (current === "responses_summary") {
      if (allowSwitch && isResponsesEndpointUnavailable(error)) return { mode: "chat", modeChanged: true };
      if (usedEffort && isEffortOnlyRejected(error)) {
        unsupportedEffortCache.add(this.effortCacheKey(targetModel, "responses"));
        return { mode: "responses_summary", modeChanged: false };
      }
      if (isResponsesReasoningRejected(error)) {
        if (usedEffort) unsupportedEffortCache.add(this.effortCacheKey(targetModel, "responses"));
        return { mode: "responses_plain", modeChanged: true };
      }
      return undefined;
    }
    if (current === "responses_plain") {
      if (allowSwitch && isResponsesEndpointUnavailable(error)) return { mode: "chat", modeChanged: true };
      return undefined;
    }
    if (current === "chat" || current === "chat_no_temp") {
      if (allowSwitch && isChatRequiresResponses(error)) return { mode: "responses_summary", modeChanged: true };
      if (usedEffort && isChatReasoningEffortRejected(error)) {
        unsupportedEffortCache.add(this.effortCacheKey(targetModel, "chat"));
        return { mode: current, modeChanged: false };
      }
      if (current === "chat" && isTemperatureRejected(error)) return { mode: "chat_no_temp", modeChanged: true };
      return undefined;
    }
    return undefined;
  }

  private chatParams(
    request: LlmRequest,
    omitTemperature: boolean,
    effort?: ExplicitReasoningEffort,
  ): Omit<ChatParams, "stream"> {
    const messages: ChatMessage[] = request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : [];
    for (const message of request.messages) {
      // OpenAI caches prefixes automatically; compatible gateways can accept explicit cache breakpoints.
      if (message.role === "user" && message.attachments?.length) {
        const { images, fallbackNotes } = partitionAttachments(message.attachments);
        const text = combineTextWithNotes(message.content, fallbackNotes);
        if (images.length > 0) {
          const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
          if (text) {
            parts.push(
              message.cacheControl && this.kind === "openai_compatible"
                ? ({ type: "text", text, cache_control: { type: message.cacheControl } } as unknown as OpenAI.Chat.ChatCompletionContentPart)
                : { type: "text", text },
            );
          }
          for (const att of images) {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${att.mimeType};base64,${att.dataBase64}` },
            });
          }
          messages.push({ role: "user", content: parts });
        } else {
          const content = message.cacheControl && this.kind === "openai_compatible"
            ? [{ type: "text" as const, text, cache_control: { type: message.cacheControl } }]
            : text;
          messages.push({ role: "user", content });
        }
        continue;
      }
      const content = message.cacheControl && this.kind === "openai_compatible" ?
        [{ type: "text" as const, text: message.content, cache_control: { type: message.cacheControl } }] : message.content;
      if (message.role === "tool") {
        if (!message.toolCallId) throw new Error("Tool result is missing its call ID");
        messages.push({ role: "tool", content, tool_call_id: message.toolCallId });
      } else if (message.role === "assistant") {
        const rawReasoning = message.toolCalls?.[0] && reasoningByCall.get(message.toolCalls[0]);
        messages.push({ ...(rawReasoning || {}), role: "assistant", content, tool_calls: message.toolCalls?.map((call) => ({
          id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) });
      } else messages.push({ role: message.role, content });
    }
    return {
      model: request.modelId ?? this.model,
      messages,
      ...(omitTemperature ? {} : { temperature: request.temperature }),
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(this.kind === "openai" ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }),
      tools: request.tools?.map((tool) => ({ type: "function", function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      } })),
    };
  }

  private responsesParams(
    request: LlmRequest,
    includeReasoningSummary: boolean,
    effort?: ExplicitReasoningEffort,
  ): Omit<ResponsesCreateParams, "stream"> {
    const instructions: string[] = request.systemPrompt ? [request.systemPrompt] : [];
    const input: ResponseInputItem[] = [];
    for (const message of request.messages) {
      if (message.role === "system") {
        if (message.content) instructions.push(message.content);
        continue;
      }
      if (message.role === "tool") {
        if (!message.toolCallId) throw new Error("Tool result is missing its call ID");
        input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
        continue;
      }
      if (message.role === "assistant") {
        const priorReasoning = message.toolCalls?.[0] ? responseReasoningByCall.get(message.toolCalls[0]) : undefined;
        if (priorReasoning?.length) {
          for (const item of priorReasoning) input.push(item);
        }
        if (message.content) {
          input.push({ role: "assistant", content: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          });
        }
        continue;
      }
      if (message.attachments?.length) {
        const { images, fallbackNotes } = partitionAttachments(message.attachments);
        const text = combineTextWithNotes(message.content, fallbackNotes);
        if (images.length > 0) {
          const content: OpenAI.Responses.ResponseInputMessageContentList = [];
          if (text) content.push({ type: "input_text", text });
          for (const att of images) {
            content.push({
              type: "input_image",
              image_url: `data:${att.mimeType};base64,${att.dataBase64}`,
              detail: "auto",
            });
          }
          input.push({ role: "user", content });
        } else {
          input.push({ role: "user", content: text });
        }
      } else {
        input.push({ role: "user", content: message.content });
      }
    }
    return {
      model: request.modelId ?? this.model,
      instructions: instructions.join("\n\n") || undefined,
      input,
      ...(includeReasoningSummary
        ? { reasoning: effort ? { effort, summary: "auto" as const } : { summary: "auto" as const } }
        : request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
      tools: request.tools?.length
        ? request.tools.map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          }))
        : undefined,
    };
  }

  private chatUsage(usage?: ChatUsage | null) {
    if (!usage) return zeroUsage();
    const estimate = pricedUsage(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0,
      usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
      usage.completion_tokens_details?.reasoning_tokens ?? 0, this.pricing);
    return withUpstreamCost(estimate, usage.cost, usage.total_cost, usage.cost_usd);
  }

  private responsesUsage(usage?: ResponsesUsage | null) {
    if (!usage) return zeroUsage();
    const estimate = pricedUsage(
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.input_tokens_details?.cached_tokens ?? 0,
      usage.output_tokens_details?.reasoning_tokens ?? 0,
      this.pricing,
    );
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
      toolCalls, modelId: result.model, usage: this.chatUsage(result.usage),
      finishReason: !choice || choice.finish_reason === "content_filter" ? "error" :
        choice.finish_reason === "length" ? "length" : toolCalls.length ? "tool_calls" : "stop",
    };
  }

  private fromResponse(result: OpenAI.Responses.Response, fallbackModel: string): LlmResponse {
    let content = "";
    const reasoningParts: string[] = [];
    const reasoningItems: ResponseReasoningItem[] = [];
    const toolCalls: LlmToolCall[] = [];
    for (const item of result.output ?? []) {
      if (item.type === "reasoning") {
        reasoningItems.push(item);
        const summary = extractResponsesItemReasoning(item);
        if (summary) reasoningParts.push(summary);
      } else if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text) content += part.text;
        }
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id || item.id || crypto.randomUUID(),
          name: item.name,
          arguments: toolArguments(item.arguments),
        });
      }
    }
    if (!content && typeof result.output_text === "string" && result.output_text) {
      content = result.output_text;
    }
    if (toolCalls[0] && reasoningItems.length) {
      responseReasoningByCall.set(toolCalls[0], reasoningItems);
    }
    const finishReason: LlmResponse["finishReason"] =
      result.status === "failed" || result.status === "cancelled"
        ? "error"
        : result.status === "incomplete"
          ? "length"
          : toolCalls.length
            ? "tool_calls"
            : "stop";
    return {
      content,
      reasoning: reasoningParts.join("\n") || undefined,
      toolCalls,
      modelId: result.model ?? fallbackModel,
      usage: this.responsesUsage(result.usage as ResponsesUsage | undefined),
      finishReason,
    };
  }

  private async completeWithMode(
    request: LlmRequest,
    mode: OpenAiWireMode,
    targetModel: string,
    effort?: ExplicitReasoningEffort,
  ): Promise<LlmResponse> {
    if (mode === "responses_summary" || mode === "responses_plain") {
      const result = await this.sdk.responses.create(
        { ...this.responsesParams(request, mode === "responses_summary", effort), stream: false },
        { signal: request.signal },
      );
      return this.fromResponse(result, targetModel);
    }
    const result = await this.sdk.chat.completions.create(
      { ...this.chatParams(request, mode === "chat_no_temp", effort), stream: false },
      { signal: request.signal },
    );
    return this.fromCompletion(result);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const targetModel = request.modelId ?? this.model;
    const key = this.cacheKey(targetModel);
    let mode = this.initialMode(targetModel);
    const tried = new Set<string>();
    for (;;) {
      const effort = this.activeEffort(request, mode, targetModel);
      const attemptKey = `${mode}::${effort ?? ""}`;
      tried.add(attemptKey);
      try {
        const res = await this.completeWithMode(request, mode, targetModel, effort);
        protocolCache.set(key, mode);
        return res;
      } catch (error) {
        const next = this.nextAttempt(mode, effort, error, targetModel);
        if (!next) throw error;
        const nextEffort = this.activeEffort(request, next.mode, targetModel);
        if (tried.has(`${next.mode}::${nextEffort ?? ""}`)) throw error;
        mode = next.mode;
        if (next.modeChanged) protocolCache.set(key, mode);
      }
    }
  }

  private async *streamChat(
    request: LlmRequest,
    omitTemperature: boolean,
    effort?: ExplicitReasoningEffort,
  ): AsyncIterable<LlmStreamChunk> {
    const { data: stream, response } = await this.sdk.chat.completions.create({
      ...this.chatParams(request, omitTemperature, effort), stream: true, stream_options: { include_usage: true },
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
      if (chunk.usage) usage = this.chatUsage(chunk.usage);
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

  private async *streamResponses(
    request: LlmRequest,
    includeReasoningSummary: boolean,
    targetModel: string,
    effort?: ExplicitReasoningEffort,
  ): AsyncIterable<LlmStreamChunk> {
    const { data: stream, response } = await this.sdk.responses.create(
      { ...this.responsesParams(request, includeReasoningSummary, effort), stream: true },
      { signal: request.signal },
    ).withResponse();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      const fallback = this.fromResponse(await response.json() as OpenAI.Responses.Response, targetModel);
      if (fallback.reasoning) yield { type: "reasoning_delta", delta: fallback.reasoning };
      if (fallback.content) yield { type: "text_delta", delta: fallback.content };
      yield* finalChunks(fallback.toolCalls, fallback.usage, fallback.finishReason);
      return;
    }

    let usage = zeroUsage();
    let finishReason: LlmResponse["finishReason"] | undefined;
    let sawReasoningDelta = false;
    const reasoningItems: ResponseReasoningItem[] = [];
    const callsByIndex = new Map<number, { id: string; name: string; args: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_summary.delta":
        case "response.reasoning.delta": {
          const delta = typeof (event as { delta?: unknown }).delta === "string"
            ? (event as { delta: string }).delta
            : "";
          if (delta) {
            sawReasoningDelta = true;
            yield { type: "reasoning_delta", delta };
          }
          break;
        }
        case "response.output_text.delta": {
          if (event.delta) yield { type: "text_delta", delta: event.delta };
          break;
        }
        case "response.output_item.added": {
          if (event.item.type === "function_call") {
            callsByIndex.set(event.output_index, {
              id: event.item.call_id || event.item.id || crypto.randomUUID(),
              name: event.item.name,
              args: event.item.arguments ?? "",
            });
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const call = callsByIndex.get(event.output_index) ?? { id: event.item_id, name: "", args: "" };
          call.args += event.delta;
          callsByIndex.set(event.output_index, call);
          break;
        }
        case "response.function_call_arguments.done": {
          const call = callsByIndex.get(event.output_index);
          if (call && event.arguments) call.args = event.arguments;
          break;
        }
        case "response.output_item.done": {
          if (event.item.type === "function_call") {
            callsByIndex.set(event.output_index, {
              id: event.item.call_id || event.item.id || crypto.randomUUID(),
              name: event.item.name,
              args: event.item.arguments,
            });
          } else if (event.item.type === "reasoning") {
            reasoningItems.push(event.item);
            if (!sawReasoningDelta) {
              const summary = extractResponsesItemReasoning(event.item);
              if (summary) yield { type: "reasoning_delta", delta: summary };
            }
          }
          break;
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed": {
          const resp = event.response;
          if (resp?.usage) usage = this.responsesUsage(resp.usage as ResponsesUsage);
          if (event.type === "response.incomplete") finishReason = "length";
          else if (event.type === "response.failed") finishReason = "error";
          break;
        }
      }
    }

    const toolCalls = [...callsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: toolArguments(call.args),
      }));
    if (toolCalls[0] && reasoningItems.length) {
      responseReasoningByCall.set(toolCalls[0], reasoningItems);
    }
    yield* finalChunks(toolCalls, usage, finishReason);
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const targetModel = request.modelId ?? this.model;
    const key = this.cacheKey(targetModel);
    let mode = this.initialMode(targetModel);
    const tried = new Set<string>();

    const open = async (wireMode: OpenAiWireMode, effort?: ExplicitReasoningEffort) => {
      const iterable =
        wireMode === "responses_summary" || wireMode === "responses_plain"
          ? this.streamResponses(request, wireMode === "responses_summary", targetModel, effort)
          : this.streamChat(request, wireMode === "chat_no_temp", effort);
      const iterator = iterable[Symbol.asyncIterator]();
      const first = await iterator.next();
      return { iterator, first };
    };

    let opened: { iterator: AsyncIterator<LlmStreamChunk>; first: IteratorResult<LlmStreamChunk> };
    for (;;) {
      const effort = this.activeEffort(request, mode, targetModel);
      tried.add(`${mode}::${effort ?? ""}`);
      try {
        opened = await open(mode, effort);
        protocolCache.set(key, mode);
        break;
      } catch (error) {
        const next = this.nextAttempt(mode, effort, error, targetModel);
        if (!next) throw error;
        const nextEffort = this.activeEffort(request, next.mode, targetModel);
        if (tried.has(`${next.mode}::${nextEffort ?? ""}`)) throw error;
        mode = next.mode;
        if (next.modeChanged) protocolCache.set(key, mode);
      }
    }

    try {
      for (let item = opened.first; !item.done; item = await opened.iterator.next()) {
        yield item.value;
      }
    } finally {
      await opened.iterator.return?.();
    }
  }
}
