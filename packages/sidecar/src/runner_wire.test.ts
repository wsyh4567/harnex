import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MockLlmClient, MockRustBridge, type LlmRequest, type LlmResponse } from "@harnex/interfaces";
import {
  RpcErrorCode,
  type ChatMessage,
  type MessageAttachmentInput,
  type RunnerEvent,
  type Thread,
} from "@harnex/protocol";
import { RpcFailure, SidecarServer, StdioPeer, type SidecarServerOptions } from "./index.ts";

const initialTree = {
  "systemprompt.md": "Base instructions.",
  "sub_agents/researcher.md": "---\nname: researcher\ndescription: Read-only researcher\n---\nCite sources.",
};

const baseUsage = {
  inputTokens: 25,
  outputTokens: 15,
  reasoningTokens: 5,
  cachedInputTokens: 0,
  costUsd: 0.001,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { resolve, promise };
}

function connectSidecar(options: SidecarServerOptions = {}) {
  const rust = new MockRustBridge(initialTree);
  const rustPeer = new StdioPeer((line) => sidecarPeer.receive(line), 2000);
  const sidecarPeer = new StdioPeer((line) => rustPeer.receive(line), 2000);
  let completedWaiter = deferred<RunnerEvent>();
  const events: RunnerEvent[] = [];

  rustPeer.handle(async (method, params) => {
    const input = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "git.head_sha":
        return rust.gitHeadSha();
      case "git.read_tree":
        return rust.gitReadTree(String(input.commitSha));
      case "git.log":
        return rust.gitLog(Number(input.limit));
      case "budget.check":
        return rust.checkBudget(Number(input.estimatedCostUsd));
      case "budget.record_usage":
        return rust.recordUsage(String(input.modelId), input.usage as LlmResponse["usage"]);
      case "exec.write_file":
        return rust.execWriteFile(input as Parameters<MockRustBridge["execWriteFile"]>[0]);
      case "event.emit": {
        const event = params as RunnerEvent;
        events.push(event);
        rust.emitEvent(event);
        if (event.type === "runner.completed") {
          completedWaiter.resolve(event);
        }
        return null;
      }
      default:
        throw new RpcFailure(RpcErrorCode.MethodNotFound, `Unhandled mock L0 method: ${method}`);
    }
  });

  const server = new SidecarServer(sidecarPeer, options);
  return {
    call: rustPeer.call.bind(rustPeer),
    server,
    rust,
    events,
    nextCompleted: () => {
      completedWaiter = deferred<RunnerEvent>();
      return completedWaiter.promise;
    },
    async close() {
      await server.close();
      rustPeer.close();
      sidecarPeer.close();
    },
  };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(import.meta.dir, ".sidecar-wire-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
  }
}

describe("Sidecar JSON-RPC Wave 2 wiring", () => {
  test("runner.start validates and forwards reasoningEffort & image attachments to LLM while persisting metadata-only to SQLite", () =>
    withTmpDir(async (dir) => {
      const dbPath = join(dir, "sidecar-trace.sqlite");
      const seenRequests: LlmRequest[] = [];
      const llm = new MockLlmClient((req) => {
        seenRequests.push(req);
        return {
          content: `effort=${req.reasoningEffort ?? "none"} attachments=${req.messages.at(-1)?.attachments?.length ?? 0}`,
          toolCalls: [],
          modelId: "vision-model",
          finishReason: "stop",
          usage: baseUsage,
        };
      });

      const app = connectSidecar({ dbPath, llm });
      const rawBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const imageAttachment: MessageAttachmentInput = {
        id: "img-1",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 68,
        width: 1,
        height: 1,
        dataBase64: rawBase64,
      };

      try {
        const thread = await app.call<Thread>("thread.create", {
          workspacePath: dir,
          mode: "ask",
          title: "Vision Test",
        });

        // Reject invalid reasoningEffort via RunnerStartParamsSchema
        await expect(
          app.call("runner.start", {
            threadId: thread.id,
            prompt: "bad effort",
            reasoningEffort: "extreme",
          }),
        ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });

        // Reject > 4 attachments via RunnerStartParamsSchema
        await expect(
          app.call("runner.start", {
            threadId: thread.id,
            prompt: "too many images",
            attachments: [1, 2, 3, 4, 5].map((i) => ({ ...imageAttachment, id: `img-${i}` })),
          }),
        ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });

        // Valid runner.start with reasoningEffort + image attachment
        const done1 = app.nextCompleted();
        await app.call("runner.start", {
          threadId: thread.id,
          prompt: "Inspect screenshot",
          reasoningEffort: "high",
          attachments: [imageAttachment],
        });
        expect(await done1).toMatchObject({
          type: "runner.completed",
          finalOutput: "effort=high attachments=1",
        });

        // LLM received both reasoningEffort and runtime attachment with dataBase64
        expect(seenRequests[0]?.reasoningEffort).toBe("high");
        expect(seenRequests[0]?.messages[0]?.attachments).toEqual([imageAttachment]);

        // Persisted messages returned over RPC contain metadata ONLY (no dataBase64)
        const messages = await app.call<ChatMessage[]>("thread.messages", { threadId: thread.id });
        expect(messages[0]?.attachments).toEqual([
          {
            id: "img-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 68,
            width: 1,
            height: 1,
          },
        ]);
        expect(JSON.stringify(messages)).not.toContain(rawBase64);
        expect(JSON.stringify(messages)).not.toContain("dataBase64");

        // Follow-up turn without attachments does not re-send old attachments
        const done2 = app.nextCompleted();
        await app.call("runner.start", {
          threadId: thread.id,
          prompt: "Second turn",
          reasoningEffort: "low",
        });
        expect(await done2).toMatchObject({
          type: "runner.completed",
          finalOutput: "effort=low attachments=0",
        });
        expect(seenRequests[1]?.reasoningEffort).toBe("low");
        expect(seenRequests[1]?.messages.every((m) => m.attachments === undefined)).toBe(true);
      } finally {
        await app.close();
      }

      // Raw SQLite file on disk must never contain dataBase64
      const dbBytes = await readFile(dbPath);
      expect(dbBytes.includes(Buffer.from(rawBase64))).toBe(false);
      expect(dbBytes.includes(Buffer.from("dataBase64"))).toBe(false);
    }));

  test("thread.delete triggers trace.deleteThread and incremental auto-vacuum space reclamation", () =>
    withTmpDir(async (dir) => {
      const dbPath = join(dir, "vacuum-trace.sqlite");
      const bigReply = "X".repeat(64_000);
      const llm = new MockLlmClient(() => ({
        content: bigReply,
        toolCalls: [],
        modelId: "fixture-model",
        finishReason: "stop",
        usage: baseUsage,
      }));

      const app = connectSidecar({ dbPath, llm });
      try {
        const thread = await app.call<Thread>("thread.create", {
          workspacePath: dir,
          mode: "ask",
          title: "Large Thread To Delete",
        });

        // Create multiple large messages so SQLite allocates many pages
        for (let i = 0; i < 4; i++) {
          const done = app.nextCompleted();
          await app.call("runner.start", {
            threadId: thread.id,
            prompt: `Generate large response #${i}: ${"P".repeat(16_000)}`,
          });
          await done;
        }

        const beforeDelete = new Database(dbPath, { readonly: true });
        const autoVacuumMode = beforeDelete.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum;
        const pageCountBefore = beforeDelete.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
        beforeDelete.close();

        expect(autoVacuumMode).toBe(2); // INCREMENTAL
        expect(pageCountBefore).toBeGreaterThan(20);

        await app.call("thread.delete", { threadId: thread.id });

        expect(await app.call<Thread[]>("thread.list")).toEqual([]);
        expect(await app.call<ChatMessage[]>("thread.messages", { threadId: thread.id })).toEqual([]);
      } finally {
        await app.close();
      }

      const afterDelete = new Database(dbPath, { readonly: true });
      const pageCountAfter = afterDelete.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
      const freelistAfter = afterDelete.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? -1;
      afterDelete.close();

      expect(freelistAfter).toBe(0);
      expect(pageCountAfter).toBeLessThan(20);
    }));
});
