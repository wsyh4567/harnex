import type { Content, GenerateContentParameters, GenerateContentResponse, GoogleGenAI, Part } from "@google/genai";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { MessageAttachmentInput, ModelPricing, ReasoningEffort } from "@harnex/protocol";
import { finalChunks, pricedUsage, toolArguments, zeroUsage } from "./shared.ts";

type ExplicitReasoningEffort = Exclude<ReasoningEffort, "auto">;
type GeminiThinkingMode = "budget" | "thoughts_only" | "none";

const GEMINI_EFFORT_BUDGETS: Record<ExplicitReasoningEffort, number> = {
  low: 1024,
  medium: 4096,
  high: 12288,
};

const callParts = new WeakMap<LlmToolCall, Part>();
const thinkingCapabilityCache = new Map<string, "thoughts_only" | "none">();

function geminiBaseUrl(sdk: GoogleGenAI): string {
  const internal = sdk as unknown as {
    apiClient?: { getBaseUrl?: () => string; clientOptions?: { httpOptions?: { baseUrl?: string } } };
    baseUrl?: string;
    baseURL?: string;
  };
  return (
    internal.apiClient?.getBaseUrl?.() ??
    internal.apiClient?.clientOptions?.httpOptions?.baseUrl ??
    internal.baseUrl ??
    internal.baseURL ??
    ""
  );
}

function isThinkingConfigRejected(error: unknown): boolean {
  const value = error as { status?: unknown; message?: unknown } | null;
  const msg = typeof value?.message === "string" ? value.message : String(error ?? "");
  const status = typeof value?.status === "number" ? value.status
    : Number(/^got status: (\d{3})\b/.exec(msg)?.[1]);
  if (Number.isFinite(status) && status !== 400) return false;
  return /thinking(?:_?config|_?budget)?|include_?thoughts|unknown name.*thinking|thought.*not supported|budget.*thinking/i.test(msg);
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

const callFromPart = (part: Part): LlmToolCall[] => {
  const call = part.functionCall;
  if (!call?.name) return [];
  const result = { id: call.id ?? crypto.randomUUID(), name: call.name, arguments: toolArguments(call.args ?? {}) };
  callParts.set(result, part);
  return [result];
};

export class GeminiLlmClient implements LlmClient {
  constructor(private readonly sdk: GoogleGenAI, private readonly model: string, private readonly pricing?: ModelPricing) {}

  private cacheKey(targetModel: string): string {
    return `${geminiBaseUrl(this.sdk)}::${targetModel}`;
  }

  private initialThinkingMode(request: LlmRequest, targetModel: string): GeminiThinkingMode {
    const cached = thinkingCapabilityCache.get(this.cacheKey(targetModel));
    if (cached === "none") return "none";
    const explicitEffort = request.reasoningEffort && request.reasoningEffort !== "auto" ? request.reasoningEffort : undefined;
    if (explicitEffort && cached !== "thoughts_only") return "budget";
    return "thoughts_only";
  }

  private nextThinkingMode(current: GeminiThinkingMode, key: string): GeminiThinkingMode | undefined {
    if (current === "budget") {
      thinkingCapabilityCache.set(key, "thoughts_only");
      return "thoughts_only";
    }
    if (current === "thoughts_only") {
      thinkingCapabilityCache.set(key, "none");
      return "none";
    }
    return undefined;
  }

  private params(request: LlmRequest, mode: GeminiThinkingMode): GenerateContentParameters {
    const contents: Content[] = [];
    const calls = new Map<string, LlmToolCall>();
    const system = request.systemPrompt ? [request.systemPrompt] : [];
    for (const message of request.messages) {
      if (message.role === "system") { system.push(message.content); continue; }
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
      const role = message.role === "assistant" ? "model" : "user";
      let parts: Part[];
      if (message.role === "tool") {
        const call = message.toolCallId && calls.get(message.toolCallId);
        if (!call) throw new Error("Tool result has no matching call");
        parts = [{ functionResponse: {
          name: call.name, response: { output: message.content }, id: callParts.get(call)?.functionCall?.id,
        } }];
      } else if (message.role === "user" && message.attachments?.length) {
        const { images, fallbackNotes } = partitionAttachments(message.attachments);
        const textContent = combineTextWithNotes(message.content, fallbackNotes);
        parts = textContent ? [{ text: textContent }] : [];
        for (const att of images) {
          parts.push({ inlineData: { mimeType: att.mimeType, data: att.dataBase64 } });
        }
      } else {
        parts = message.content ? [{ text: message.content }] : [];
        for (const call of message.toolCalls ?? []) parts.push(callParts.get(call) ?? {
          functionCall: { name: call.name, args: call.arguments },
        });
      }
      if (!parts.length) continue;
      const last = contents.at(-1);
      if (last?.role === role) last.parts?.push(...parts);
      else contents.push({ role, parts });
    }
    const targetModel = request.modelId ?? this.model;
    const explicitEffort: ExplicitReasoningEffort | undefined =
      request.reasoningEffort && request.reasoningEffort !== "auto" ? request.reasoningEffort : undefined;
    const thinkingConfig =
      mode === "budget" && explicitEffort
        ? { includeThoughts: true, thinkingBudget: GEMINI_EFFORT_BUDGETS[explicitEffort] }
        : mode === "thoughts_only"
          ? { includeThoughts: true }
          : undefined;
    return { model: targetModel, contents, config: {
      // Implicit caching uses the unchanged message prefix; Gemini has no ephemeral block parameter.
      systemInstruction: system.join("\n\n") || undefined, abortSignal: request.signal,
      temperature: request.temperature, maxOutputTokens: request.maxTokens,
      ...(thinkingConfig ? { thinkingConfig } : {}),
      tools: request.tools?.length ? [{ functionDeclarations: request.tools.map((tool) => ({
        name: tool.name, description: tool.description,
        parameters: geminiSchema(tool.inputSchema),
      })) }] : undefined,
    } };
  }

  private usage(response: GenerateContentResponse) {
    const usage = response.usageMetadata;
    if (!usage) return zeroUsage();
    const input = (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0);
    const thoughts = usage.thoughtsTokenCount ?? 0;
    return pricedUsage(input, (usage.candidatesTokenCount ?? 0) + thoughts,
      usage.cachedContentTokenCount ?? 0, thoughts, this.pricing);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const targetModel = request.modelId ?? this.model;
    const key = this.cacheKey(targetModel);
    let mode = this.initialThinkingMode(request, targetModel);
    let response: GenerateContentResponse;
    for (;;) {
      try {
        response = await this.sdk.models.generateContent(this.params(request, mode));
        break;
      } catch (error) {
        if (!isThinkingConfigRejected(error)) throw error;
        const next = this.nextThinkingMode(mode, key);
        if (!next) throw error;
        mode = next;
      }
    }
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const toolCalls = parts.flatMap(callFromPart);
    return {
      content: parts.map((part) => part.thought ? "" : part.text ?? "").join(""),
      reasoning: parts.map((part) => part.thought ? part.text ?? "" : "").join("") || undefined,
      toolCalls, modelId: response.modelVersion ?? targetModel, usage: this.usage(response),
      finishReason: candidate?.finishReason === "MAX_TOKENS" ? "length" :
        !candidate || (candidate.finishReason && candidate.finishReason !== "STOP") ? "error" : toolCalls.length ? "tool_calls" : "stop",
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const targetModel = request.modelId ?? this.model;
    const key = this.cacheKey(targetModel);
    let mode = this.initialThinkingMode(request, targetModel);
    const open = async (activeMode: GeminiThinkingMode) => {
      const iterable = await this.sdk.models.generateContentStream(this.params(request, activeMode));
      const iterator = iterable[Symbol.asyncIterator]();
      return { iterator, first: await iterator.next() };
    };
    let opened: Awaited<ReturnType<typeof open>>;
    for (;;) {
      try {
        opened = await open(mode);
        break;
      } catch (error) {
        if (!isThinkingConfigRejected(error)) throw error;
        const next = this.nextThinkingMode(mode, key);
        if (!next) throw error;
        mode = next;
      }
    }
    const { iterator, first } = opened;
    let usage = zeroUsage();
    let finishReason: LlmResponse["finishReason"] | undefined;
    const calls: LlmToolCall[] = [];
    try {
      for (let item = first; !item.done; item = await iterator.next()) {
        const response = item.value;
        if (response.usageMetadata) usage = this.usage(response);
        const candidate = response.candidates?.[0];
        if (candidate?.finishReason === "MAX_TOKENS") finishReason = "length";
        else if (candidate?.finishReason && candidate.finishReason !== "STOP") finishReason = "error";
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text) yield { type: part.thought ? "reasoning_delta" : "text_delta", delta: part.text };
          calls.push(...callFromPart(part));
        }
      }
    } finally {
      await iterator.return?.(undefined);
    }
    yield* finalChunks(calls, usage, finishReason);
  }
}

type GeminiSchema = NonNullable<import("@google/genai").FunctionDeclaration["parameters"]>;

function geminiSchema(schema: Record<string, unknown>): GeminiSchema {
  const { additionalProperties: _unsupported, ...result } = schema;
  if (typeof result.type === "string") result.type = result.type.toUpperCase();
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties)
    .map(([key, value]) => [key, geminiSchema(value as Record<string, unknown>)]));
  if (result.items && typeof result.items === "object") result.items = geminiSchema(result.items as Record<string, unknown>);
  return result as GeminiSchema;
}
