import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { LlmRequest } from "@harnex/interfaces";
import {
  ChatMessageSchema,
  MessageAttachmentInputSchema,
  MessageAttachmentMetaSchema,
  ReasoningEffortSchema,
  RunnerStartParamsSchema,
  type MessageAttachmentInput,
} from "@harnex/protocol";
import { AnthropicLlmClient } from "./anthropic.ts";
import { GeminiLlmClient } from "./gemini.ts";
import { OpenAiLlmClient } from "./openai.ts";

const mockFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => (
  async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)
) as typeof fetch;

const sse = (objects: unknown[]) =>
  new Response(
    objects.map((object) => `data: ${JSON.stringify(object)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );

const pngAttachment: MessageAttachmentInput = {
  id: "att-img-1",
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 128,
  width: 64,
  height: 64,
  dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
};

const pdfAttachment: MessageAttachmentInput = {
  id: "att-doc-1",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 256,
  dataBase64: "JVBERi0xLjQK",
};

describe("protocol schemas for reasoningEffort and attachments", () => {
  test("validates ReasoningEffort, attachment meta/input, ChatMessage, and RunnerStartParams", () => {
    expect(ReasoningEffortSchema.options).toEqual(["auto", "low", "medium", "high"]);
    const meta = MessageAttachmentMetaSchema.parse({
      id: "a1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      width: 100,
      height: 80,
    });
    expect(meta.width).toBe(100);
    const input = MessageAttachmentInputSchema.parse(pngAttachment);
    expect(input.dataBase64).toBe(pngAttachment.dataBase64);

    const msg = ChatMessageSchema.parse({
      id: "m1",
      threadId: "t1",
      role: "user",
      content: "Check image",
      attachments: [meta],
      createdAt: "2026-11-26T00:00:00Z",
    });
    expect(msg.attachments).toHaveLength(1);

    const start = RunnerStartParamsSchema.parse({
      threadId: "t1",
      prompt: "Analyze",
      reasoningEffort: "high",
      attachments: [pngAttachment],
    });
    expect(start.reasoningEffort).toBe("high");
    expect(start.attachments).toHaveLength(1);

    expect(() =>
      RunnerStartParamsSchema.parse({
        threadId: "t1",
        prompt: "Too many",
        attachments: [pngAttachment, pngAttachment, pngAttachment, pngAttachment, pngAttachment],
      }),
    ).toThrow();
  });
});

describe("OpenAI reasoningEffort and multimodal attachments", () => {
  test("Responses API sends reasoning effort, strips on 400 and caches per (baseUrl, model, responses)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = mockFetch((url, init) => {
      expect(url).toEndWith("/responses");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const reasoning = body.reasoning as { effort?: string; summary?: string } | undefined;
      if (reasoning?.effort) {
        return new Response(
          JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort'" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({
        model: "any-custom-model",
        status: "completed",
        output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    const client = new OpenAiLlmClient(
      new OpenAI({ apiKey: "mock", baseURL: "https://oai-resp-effort.test/v1", fetch }),
      "any-custom-model",
      undefined,
      "openai",
      "responses",
    );

    const req: LlmRequest = {
      slot: "solver",
      reasoningEffort: "high",
      messages: [{ role: "user", content: "Inspect this", attachments: [pngAttachment, pdfAttachment] }],
    };

    expect((await client.complete(req)).content).toBe("ok");
    // Second turn skips effort directly via cache
    expect((await client.complete(req)).content).toBe("ok");

    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(bodies[1]?.reasoning).toEqual({ summary: "auto" });
    expect(bodies[2]?.reasoning).toEqual({ summary: "auto" });

    // Verify Responses API multimodal input encoding
    const userItem = (bodies[0]?.input as Array<{ role: string; content: unknown }>)[0];
    expect(userItem?.role).toBe("user");
    expect(userItem?.content).toEqual([
      { type: "input_text", text: "Inspect this\n[Attached file: spec.pdf (application/pdf)]" },
      {
        type: "input_image",
        image_url: `data:image/png;base64,${pngAttachment.dataBase64}`,
        detail: "auto",
      },
    ]);
  });

  test("Chat Completions API sends reasoning_effort, falls back on 400 and caches per (baseUrl, model, chat)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = mockFetch((url, init) => {
      expect(url).toEndWith("/chat/completions");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.reasoning_effort) {
        return new Response(
          JSON.stringify({ error: { message: "Unknown parameter: 'reasoning_effort'" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (body.stream) {
        return sse([
          { choices: [{ delta: { content: "streamed" } }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
        ]);
      }
      return Response.json({
        model: "compat-custom",
        choices: [{ finish_reason: "stop", message: { content: "chat-ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      });
    });

    const client = new OpenAiLlmClient(
      new OpenAI({ apiKey: "mock", baseURL: "https://oai-chat-effort.test/v1", fetch }),
      "compat-custom",
      undefined,
      "openai_compatible",
      "chat_completions",
    );

    const req: LlmRequest = {
      slot: "solver",
      reasoningEffort: "medium",
      messages: [{ role: "user", content: "Look at diagram", attachments: [pngAttachment, pdfAttachment] }],
    };

    expect((await client.complete(req)).content).toBe("chat-ok");
    const streamed: string[] = [];
    for await (const chunk of client.stream(req)) {
      if (chunk.type === "text_delta" && chunk.delta) streamed.push(chunk.delta);
    }
    expect(streamed).toEqual(["streamed"]);

    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.reasoning_effort).toBe("medium");
    expect(bodies[1]?.reasoning_effort).toBeUndefined();
    expect(bodies[2]?.reasoning_effort).toBeUndefined();

    // Verify Chat Completions multimodal content array
    const userMsg = (bodies[0]?.messages as Array<{ role: string; content: unknown }>)[0];
    expect(userMsg).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Look at diagram\n[Attached file: spec.pdf (application/pdf)]" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${pngAttachment.dataBase64}` } },
      ],
    });
  });

  test("OpenAI auto reasoningEffort preserves default behavior without effort parameter", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = mockFetch((url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/responses")) {
        return Response.json({
          model: "auto-model",
          status: "completed",
          output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 5, output_tokens: 5 },
        });
      }
      return Response.json({
        model: "auto-model",
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      });
    });

    const respClient = new OpenAiLlmClient(
      new OpenAI({ apiKey: "mock", baseURL: "https://oai-auto-resp.test/v1", fetch }),
      "auto-model",
      undefined,
      "openai",
      "responses",
    );
    await respClient.complete({ slot: "solver", reasoningEffort: "auto", messages: [{ role: "user", content: "hi" }] });
    expect(bodies[0]?.reasoning).toEqual({ summary: "auto" });

    const chatClient = new OpenAiLlmClient(
      new OpenAI({ apiKey: "mock", baseURL: "https://oai-auto-chat.test/v1", fetch }),
      "auto-model",
      undefined,
      "openai_compatible",
      "chat_completions",
    );
    await chatClient.complete({ slot: "solver", reasoningEffort: "auto", messages: [{ role: "user", content: "hi" }] });
    expect(bodies[1]?.reasoning_effort).toBeUndefined();
  });
});

describe("Anthropic reasoningEffort and multimodal attachments", () => {
  test("maps effort to budgets strictly below max_tokens, falls back cleanly on 400, and encodes image blocks", async () => {
    const seen: Array<{ thinking?: unknown; output_config?: unknown; max_tokens: number; messages: unknown }> = [];
    const fetch = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        thinking?: { type?: string; budget_tokens?: number };
        output_config?: { effort?: string };
        max_tokens: number;
        messages: unknown;
      };
      seen.push({
        thinking: body.thinking,
        output_config: body.output_config,
        max_tokens: body.max_tokens,
        messages: body.messages,
      });
      if (body.thinking?.type === "adaptive") {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "output_config is not supported" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({
        model: "claude-effort-test",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 20, output_tokens: 10 },
      });
    });

    const client = new AnthropicLlmClient(
      new Anthropic({ apiKey: "mock", baseURL: "https://anthropic-effort.test", fetch }),
      "claude-effort-test",
    );

    // High effort: adaptive -> 400 -> enabled with 12288 budget (< max_tokens 16384)
    await client.complete({
      slot: "solver",
      reasoningEffort: "high",
      messages: [{ role: "user", content: "Check diagram", attachments: [pngAttachment, pdfAttachment] }],
    });
    // Cached as enabled; test medium and low budgets, plus small maxTokens capping
    await client.complete({ slot: "solver", reasoningEffort: "medium", messages: [{ role: "user", content: "m" }] });
    await client.complete({ slot: "solver", reasoningEffort: "low", messages: [{ role: "user", content: "l" }] });
    await client.complete({ slot: "solver", reasoningEffort: "high", maxTokens: 4000, messages: [{ role: "user", content: "cap" }] });

    expect(seen[0]?.thinking).toEqual({ type: "adaptive" });
    expect(seen[0]?.output_config).toEqual({ effort: "high" });

    expect(seen[1]?.thinking).toEqual({ type: "enabled", budget_tokens: 12288 });
    expect(seen[1]!.max_tokens).toBeGreaterThan(12288);

    expect(seen[2]?.thinking).toEqual({ type: "enabled", budget_tokens: 6144 });
    expect(seen[2]!.max_tokens).toBeGreaterThan(6144);

    expect(seen[3]?.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(seen[3]!.max_tokens).toBeGreaterThan(2048);

    // Explicitly capped strictly below max_tokens
    const cappedThinking = seen[4]?.thinking as { type: string; budget_tokens: number };
    expect(cappedThinking.budget_tokens).toBeLessThan(seen[4]!.max_tokens);
    expect(seen[4]!.max_tokens).toBe(4000);

    // Multimodal blocks on user message
    const firstMsg = (seen[0]?.messages as Array<{ role: string; content: unknown[] }>)[0];
    expect(firstMsg).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Check diagram\n[Attached file: spec.pdf (application/pdf)]" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: pngAttachment.dataBase64 },
        },
      ],
    });
  });
});

describe("Gemini reasoningEffort and multimodal attachments", () => {
  test("maps effort to thinkingBudget, falls back to includeThoughts on 400, caches per (baseUrl, model), and encodes inlineData", async () => {
    const seenParams: Array<{ contents: unknown; config?: Record<string, unknown> }> = [];
    const okResponse = {
      modelVersion: "gemini-effort-alias",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "gemini-ok" }] } }],
    };

    const makeSdk = (baseUrl: string, rejectBudget: boolean) =>
      ({
        apiClient: { getBaseUrl: () => baseUrl },
        models: {
          generateContent: async (params: { contents: unknown; config?: Record<string, unknown> }) => {
            seenParams.push(params);
            const tc = params.config?.thinkingConfig as { includeThoughts?: boolean; thinkingBudget?: number } | undefined;
            if (rejectBudget && tc?.thinkingBudget !== undefined) {
              throw Object.assign(new Error("got status: 400 INVALID_ARGUMENT: thinkingBudget is not supported"), { status: 400 });
            }
            return okResponse;
          },
          generateContentStream: async function* (params: { contents: unknown; config?: Record<string, unknown> }) {
            seenParams.push(params);
            const tc = params.config?.thinkingConfig as { includeThoughts?: boolean; thinkingBudget?: number } | undefined;
            if (rejectBudget && tc?.thinkingBudget !== undefined) {
              throw Object.assign(new Error("got status: 400 INVALID_ARGUMENT: thinkingBudget is not supported"), { status: 400 });
            }
            yield okResponse;
          },
        },
      }) as unknown as GoogleGenAI;

    // Endpoint A supports thinkingBudget
    const clientOk = new GeminiLlmClient(makeSdk("https://gemini-a.test", false), "gemini-effort-alias");
    await clientOk.complete({
      slot: "solver",
      reasoningEffort: "low",
      messages: [{ role: "user", content: "Describe", attachments: [pngAttachment, pdfAttachment] }],
    });
    await clientOk.complete({ slot: "solver", reasoningEffort: "medium", messages: [{ role: "user", content: "m" }] });
    await clientOk.complete({ slot: "solver", reasoningEffort: "high", messages: [{ role: "user", content: "h" }] });
    await clientOk.complete({ slot: "solver", reasoningEffort: "auto", messages: [{ role: "user", content: "a" }] });

    expect(seenParams[0]?.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
    expect(seenParams[1]?.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 4096 });
    expect(seenParams[2]?.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 12288 });
    expect(seenParams[3]?.config?.thinkingConfig).toEqual({ includeThoughts: true });

    // Verify inlineData + non-image note on user parts
    expect(seenParams[0]?.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "Describe\n[Attached file: spec.pdf (application/pdf)]" },
          { inlineData: { mimeType: "image/png", data: pngAttachment.dataBase64 } },
        ],
      },
    ]);

    // Endpoint B (same model name, different baseUrl) rejects thinkingBudget -> falls back to includeThoughts and caches
    const clientFallback = new GeminiLlmClient(makeSdk("https://gemini-b.test", true), "gemini-effort-alias");
    expect((await clientFallback.complete({ slot: "solver", reasoningEffort: "high", messages: [{ role: "user", content: "1" }] })).content).toBe("gemini-ok");
    // Second call (streaming) skips thinkingBudget directly via per-(baseUrl, model) cache
    const chunks: string[] = [];
    for await (const c of clientFallback.stream({ slot: "solver", reasoningEffort: "high", messages: [{ role: "user", content: "2" }] })) {
      if (c.type === "text_delta" && c.delta) chunks.push(c.delta);
    }
    expect(chunks).toEqual(["gemini-ok"]);
    expect(seenParams[4]?.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 12288 });
    expect(seenParams[5]?.config?.thinkingConfig).toEqual({ includeThoughts: true });
    expect(seenParams[6]?.config?.thinkingConfig).toEqual({ includeThoughts: true });
  });
});
