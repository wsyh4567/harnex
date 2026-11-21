import type { Content, GenerateContentParameters, GenerateContentResponse, GoogleGenAI, Part } from "@google/genai";
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk, LlmToolCall } from "@harnex/interfaces";
import type { ModelPricing } from "@harnex/protocol";
import { finalChunks, pricedUsage, toolArguments, zeroUsage } from "./shared.ts";

const callParts = new WeakMap<LlmToolCall, Part>();
const callFromPart = (part: Part): LlmToolCall[] => {
  const call = part.functionCall;
  if (!call?.name) return [];
  const result = { id: call.id ?? crypto.randomUUID(), name: call.name, arguments: toolArguments(call.args ?? {}) };
  callParts.set(result, part);
  return [result];
};

export class GeminiLlmClient implements LlmClient {
  constructor(private readonly sdk: GoogleGenAI, private readonly model: string, private readonly pricing?: ModelPricing) {}

  private params(request: LlmRequest): GenerateContentParameters {
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
    return { model: request.modelId ?? this.model, contents, config: {
      // Implicit caching uses the unchanged message prefix; Gemini has no ephemeral block parameter.
      systemInstruction: system.join("\n\n") || undefined, abortSignal: request.signal,
      temperature: request.temperature, maxOutputTokens: request.maxTokens,
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
    const response = await this.sdk.models.generateContent(this.params(request));
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const toolCalls = parts.flatMap(callFromPart);
    return {
      content: parts.map((part) => part.thought ? "" : part.text ?? "").join(""),
      reasoning: parts.map((part) => part.thought ? part.text ?? "" : "").join("") || undefined,
      toolCalls, modelId: response.modelVersion ?? request.modelId ?? this.model, usage: this.usage(response),
      finishReason: candidate?.finishReason === "MAX_TOKENS" ? "length" :
        !candidate || (candidate.finishReason && candidate.finishReason !== "STOP") ? "error" : toolCalls.length ? "tool_calls" : "stop",
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const stream = await this.sdk.models.generateContentStream(this.params(request));
    let usage = zeroUsage();
    const calls: LlmToolCall[] = [];
    for await (const response of stream) {
      if (response.usageMetadata) usage = this.usage(response);
      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) yield { type: part.thought ? "reasoning_delta" : "text_delta", delta: part.text };
        calls.push(...callFromPart(part));
      }
    }
    yield* finalChunks(calls, usage);
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
