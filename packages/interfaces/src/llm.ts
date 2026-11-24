import type { ModelSlot, TokenUsage } from "@harnex/protocol";

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
  cacheControl?: "ephemeral";
}

export interface LlmRequest {
  slot: ModelSlot;
  modelId?: string;
  providerIdOverride?: string;
  systemPrompt?: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmStreamChunk {
  type: "text_delta" | "reasoning_delta" | "tool_call" | "done";
  delta?: string;
  toolCall?: LlmToolCall;
  usage?: TokenUsage;
}

export interface LlmResponse {
  content: string;
  reasoning?: string;
  toolCalls: LlmToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "aborted" | "error";
  usage: TokenUsage;
  modelId: string;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
}

export type MockLlmHandler = (request: LlmRequest, callIndex: number) => LlmResponse | Promise<LlmResponse>;

export class MockLlmClient implements LlmClient {
  public readonly calls: LlmRequest[] = [];
  private handler: MockLlmHandler;

  constructor(handler?: MockLlmHandler) {
    this.handler =
      handler ??
      ((req) => ({
        content: `mock-response:${req.slot}`,
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.001,
        },
        modelId: req.modelId ?? `mock-${req.slot}`,
      }));
  }

  setHandler(handler: MockLlmHandler): void {
    this.handler = handler;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const idx = this.calls.length;
    this.calls.push(request);
    return await this.handler(request, idx);
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const res = await this.complete(request);
    if (res.reasoning) {
      yield { type: "reasoning_delta", delta: res.reasoning };
    }
    if (res.content) {
      yield { type: "text_delta", delta: res.content };
    }
    for (const tc of res.toolCalls) {
      yield { type: "tool_call", toolCall: tc };
    }
    yield { type: "done", usage: res.usage };
  }
}
