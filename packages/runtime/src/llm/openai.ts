import OpenAI from "openai";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { ModelPricing, OpenAiApiProtocol } from "@harnex/protocol";
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

const reasoningByCall = new WeakMap<LlmToolCall, { reasoning_content?: string; reasoning?: string }>();
const responseReasoningByCall = new WeakMap<LlmToolCall, ResponseReasoningItem[]>();
const protocolCache = new Map<string, OpenAiWireMode>();

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

  private initialMode(targetModel: string): OpenAiWireMode {
    const cached = protocolCache.get(this.cacheKey(targetModel));
    if (cached) return cached;
    if (this.apiProtocol === "responses") return "responses_summary";
    if (this.apiProtocol === "chat_completions") return "chat";
    return this.kind === "openai" ? "responses_summary" : "chat";
  }

  private nextFallbackMode(current: OpenAiWireMode, error: unknown): OpenAiWireMode | undefined {
    const allowSwitch = this.apiProtocol === "auto";
    if (current === "responses_summary") {
      if (allowSwitch && isResponsesEndpointUnavailable(error)) return "chat";
      if (isResponsesReasoningRejected(error)) return "responses_plain";
      return undefined;
    }
    if (current === "responses_plain") {
      if (allowSwitch && isResponsesEndpointUnavailable(error)) return "chat";
      return undefined;
    }
    if (current === "chat") {
      if (allowSwitch && isChatRequiresResponses(error)) return "responses_summary";
      if (isTemperatureRejected(error)) return "chat_no_temp";
      return undefined;
    }
    return undefined;
  }

  private chatParams(request: LlmRequest, omitTemperature: boolean): Omit<ChatParams, "stream"> {
    const messages: ChatMessage[] = request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : [];
    for (const message of request.messages) {
      // OpenAI caches prefixes automatically; compatible gateways can accept explicit cache breakpoints.
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
      ...(this.kind === "openai" ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }),
      tools: request.tools?.map((tool) => ({ type: "function", function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      } })),
    };
  }

  private responsesParams(request: LlmRequest, includeReasoningSummary: boolean): Omit<ResponsesCreateParams, "stream"> {
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
      input.push({ role: "user", content: message.content });
    }
    return {
      model: request.modelId ?? this.model,
      instructions: instructions.join("\n\n") || undefined,
      input,
      ...(includeReasoningSummary
        ? { reasoning: { summary: "auto" } }
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

  private async completeWithMode(request: LlmRequest, mode: OpenAiWireMode, targetModel: string): Promise<LlmResponse> {
    if (mode === "responses_summary" || mode === "responses_plain") {
      const result = await this.sdk.responses.create(
        { ...this.responsesParams(request, mode === "responses_summary"), stream: false },
        { signal: request.signal },
      );
      return this.fromResponse(result, targetModel);
    }
    const result = await this.sdk.chat.completions.create(
      { ...this.chatParams(request, mode === "chat_no_temp"), stream: false },
      { signal: request.signal },
    );
    return this.fromCompletion(result);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const targetModel = request.modelId ?? this.model;
    const key = this.cacheKey(targetModel);
    let mode = this.initialMode(targetModel);
    const tried = new Set<OpenAiWireMode>();
    for (;;) {
      tried.add(mode);
      try {
        const res = await this.completeWithMode(request, mode, targetModel);
        protocolCache.set(key, mode);
        return res;
      } catch (error) {
        const next = this.nextFallbackMode(mode, error);
        if (!next || tried.has(next)) throw error;
        mode = next;
        protocolCache.set(key, mode);
      }
    }
  }

  private async *streamChat(request: LlmRequest, omitTemperature: boolean): AsyncIterable<LlmStreamChunk> {
    const { data: stream, response } = await this.sdk.chat.completions.create({
      ...this.chatParams(request, omitTemperature), stream: true, stream_options: { include_usage: true },
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
  ): AsyncIterable<LlmStreamChunk> {
    const { data: stream, response } = await this.sdk.responses.create(
      { ...this.responsesParams(request, includeReasoningSummary), stream: true },
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
    const tried = new Set<OpenAiWireMode>();

    const open = async (wireMode: OpenAiWireMode) => {
      const iterable =
        wireMode === "responses_summary" || wireMode === "responses_plain"
          ? this.streamResponses(request, wireMode === "responses_summary", targetModel)
          : this.streamChat(request, wireMode === "chat_no_temp");
      const iterator = iterable[Symbol.asyncIterator]();
      const first = await iterator.next();
      return { iterator, first };
    };

    let opened: { iterator: AsyncIterator<LlmStreamChunk>; first: IteratorResult<LlmStreamChunk> };
    for (;;) {
      tried.add(mode);
      try {
        opened = await open(mode);
        protocolCache.set(key, mode);
        break;
      } catch (error) {
        const next = this.nextFallbackMode(mode, error);
        if (!next || tried.has(next)) throw error;
        mode = next;
        protocolCache.set(key, mode);
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
