import type { Content, GenerateContentParameters, GenerateContentResponse, GoogleGenAI, Part } from "@google/genai";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { ModelPricing } from "@harnex/protocol";
import { finalChunks, pricedUsage, toolArguments, zeroUsage } from "./shared.ts";

const callParts = new WeakMap<LlmToolCall, Part>();
const unsupportedThinkingModels = new Set<string>();

function isThinkingConfigRejected(error: unknown): boolean {
  const value = error as { status?: unknown; message?: unknown } | null;
  const msg = typeof value?.message === "string" ? value.message : String(error ?? "");
  const status = typeof value?.status === "number" ? value.status
    : Number(/^got status: (\d{3})\b/.exec(msg)?.[1]);
  if (Number.isFinite(status) && status !== 400) return false;
  return /thinking(?:_?config)?|include_?thoughts|unknown name.*thinking|thought.*not supported|budget.*thinking/i.test(msg);
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

  private params(request: LlmRequest, includeThoughts: boolean): GenerateContentParameters {
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
    return { model: targetModel, contents, config: {
      // Implicit caching uses the unchanged message prefix; Gemini has no ephemeral block parameter.
      systemInstruction: system.join("\n\n") || undefined, abortSignal: request.signal,
      temperature: request.temperature, maxOutputTokens: request.maxTokens,
      ...(includeThoughts ? { thinkingConfig: { includeThoughts: true } } : {}),
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
    const wantThoughts = !unsupportedThinkingModels.has(targetModel);
    let response: GenerateContentResponse;
    try {
      response = await this.sdk.models.generateContent(this.params(request, wantThoughts));
    } catch (error) {
      if (!wantThoughts || !isThinkingConfigRejected(error)) throw error;
      unsupportedThinkingModels.add(targetModel);
      response = await this.sdk.models.generateContent(this.params(request, false));
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
    const wantThoughts = !unsupportedThinkingModels.has(targetModel);
    const open = async (includeThoughts: boolean) => {
      const iterable = await this.sdk.models.generateContentStream(this.params(request, includeThoughts));
      const iterator = iterable[Symbol.asyncIterator]();
      return { iterator, first: await iterator.next() };
    };
    const { iterator, first } = await open(wantThoughts).catch(async (error) => {
      if (!wantThoughts || !isThinkingConfigRejected(error)) throw error;
      unsupportedThinkingModels.add(targetModel);
      return open(false);
    });
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
