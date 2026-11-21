import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTraceStore, MockLlmClient, MockRustBridge, type LlmResponse, type LlmToolCall, type TaskRunRequest } from "@harnex/interfaces";
import { ChatMessageSchema, ProviderConfigSchema, RunnerEventSchema, ThreadSchema } from "@harnex/protocol";
import {
  AnthropicLlmClient, ForegroundTaskRunner, GeminiLlmClient, McpHost, OpenAiLlmClient, ProviderRegistry,
  RoutedLlmClient, SqliteTraceStore, createWorkerSpawner, dispatchHook, importCcSwitch, importMagpie,
  loadHooks, loadMcpServers, loadMemory, loadSandboxPolicies, loadSkills, loadSubagentProfile, truncateToolOutput,
} from "../src/index.ts";

const tmp: string[] = [];
async function fixture() {
  const path = await mkdtemp(join(import.meta.dir, ".runtime-test-"));
  tmp.push(path);
  return path;
}
afterEach(async () => {
  while (tmp.length) await rm(tmp.pop()!, { recursive: true, force: true });
});

const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningTokens: 1, costUsd: 0.01 };
const answer = (content = "done", toolCalls: LlmToolCall[] = []): LlmResponse => ({
  content, toolCalls, modelId: "fixture-model", usage, finishReason: toolCalls.length ? "tool_calls" : "stop",
});
const tool = (name: string, args: Record<string, unknown> = {}, id = name): LlmToolCall => ({ id, name, arguments: args });
const request = (overrides: Partial<TaskRunRequest> = {}): TaskRunRequest => ({
  threadId: "thread-1", mode: "craft", workspacePath: "/fixture-workspace", prompt: "Generate the report",
  domain: "file_ops", pinnedCommitSha: "", ...overrides,
});
const ok = (stdout: string) => ({ ok: true, stdout, stderr: "", exitCode: 0, durationMs: 1, sandboxBackend: "mock-sandbox" });
const mockFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => (
  async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)
) as typeof fetch;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

describe("foreground runner", () => {
  test("pins the harness, validates the tool allowlist, and delegates every Craft effect through the bridge", async () => {
    const bridge = new MockRustBridge({ "systemprompt.md": "Pinned instructions", "scripts/report.ts": "script", "hooks/check.ts": "hook" });
    bridge.trustedHookHashes.set("hooks/check.ts", "trusted");
    const trace = new InMemoryTraceStore();
    const pin = bridge.headSha;
    let headReads = 0;
    bridge.gitHeadSha = async () => { headReads++; return bridge.headSha; };
    const llm = new MockLlmClient(async (input, index) => {
      expect(input.systemPrompt).toContain("Pinned instructions");
      if (index > 0) return answer();
      await bridge.gitCommitPatch({ baseCommitSha: pin, operations: [{ op: "delete", path: "scripts/report.ts" }],
        message: "Updated harness", domain: "general", authorName: "Test" });
      return answer("", [tool("write_file", { path: "report.txt", content: "report data" }), tool("delete_file", { path: "old.txt" }),
        tool("shell", { command: "fixture", args: ["arg"] }), tool("run_script", { scriptPath: "scripts/report.ts" })]);
    });
    const runner = new ForegroundTaskRunner({ bridge, trace, llm });
    const result = await runner.runTask({ ...request(), sourceTags: ["web", "untrusted_mcp"] });
    expect(result.succeeded).toBe(true);
    expect(headReads).toBe(1);
    expect(result.deliverables).toEqual({ "report.txt": "report data" });
    expect(result.touchedFiles).toEqual(["report.txt", "old.txt"]);
    expect(result.sourceTags).toEqual(["local", "web", "untrusted_mcp"]);
    const calls = bridge.recordedCalls.filter(({ method }) => method.startsWith("exec"));
    expect(calls.map(({ method }) => method)).toEqual(["execWriteFile", "execDeleteFile", "execShell", "execScript"]
      .flatMap((method) => ["execHook", method, "execHook"]));
    expect(calls.find(({ method }) => method === "execScript")?.payload).toMatchObject({ pinnedCommitSha: pin, allowNetwork: false });
    expect(calls.find(({ method }) => method === "execWriteFile")?.payload).toMatchObject({ sourceTags: result.sourceTags });
    expect(bridge.spentTodayUsd).toBe(0.02);
    expect((await trace.getTraceRun(result.runId))?.pinnedCommitSha).toBe(pin);
    expect(bridge.emittedEvents.every((event) => RunnerEventSchema.safeParse(event).success)).toBe(true);
  });

  test("Ask exposes no tools; Plan reads workspace files, tracks provenance and accepts only structured goals", async () => {
    const workspacePath = await fixture();
    await writeFile(join(workspacePath, "data.txt"), "known input");
    const bridge = new MockRustBridge({ "hooks/guard.ts": "unused in read-only modes" });
    const trace = new InMemoryTraceStore();
    const llm = new MockLlmClient((input, index) => {
      if (index === 0) { expect(input.tools).toBeUndefined(); return answer("", [tool("shell", { command: "unexpected" })]); }
      if (index === 1 || index === 3) return answer();
      expect(input.tools?.map(({ name }) => name)).toEqual(["read_file", "list_files", "set_goals"]);
      return answer("", [tool("read_file", { path: "data.txt" }), tool("read_file", { path: "../data.txt" }, "escape"),
        tool("set_goals", { goals: [{ id: "validate", title: "Check input", status: "completed" }] }),
        tool("write_file", { path: "bad.txt", content: "not written" })]);
    });
    const runner = new ForegroundTaskRunner({ bridge, trace, llm });
    const ask = await runner.runTask(request({ threadId: "ask", mode: "ask", workspacePath }));
    const plan = await runner.runTask(request({ threadId: "plan", mode: "plan", workspacePath }));
    expect(ask.metrics.errors).toBe(1);
    expect(plan.metrics.errors).toBe(2);
    expect(plan.trajectoryMarkdown).toContain("known input");
    expect(plan.sourceTags).toEqual(["local", "external_file"]);
    expect((await trace.getThread("plan"))?.goals[0]?.status).toBe("completed");
    expect(bridge.recordedCalls).toEqual([]);
  });

  test("budget blocks the model before its first call and stops further actions after recordUsage trips", async () => {
    for (const tripBefore of [true, false]) {
      const bridge = new MockRustBridge({ "hooks/guard.ts": "guard" });
      bridge.budgetTripped = tripBefore;
      bridge.budgetLimitUsd = 0.005;
      const trace = new InMemoryTraceStore();
      const llm = new MockLlmClient(() => answer("", [tool("write_file", { path: "bad.txt", content: "bad" })]));
      const result = await new ForegroundTaskRunner({ bridge, trace, llm }).runTask(request());
      expect(result.succeeded).toBe(false);
      expect(llm.calls).toHaveLength(tripBefore ? 0 : 1);
      expect(bridge.recordedCalls).toEqual([]);
      expect(bridge.emittedEvents.find((event) => event.type === "runner.error")).toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(bridge.emittedEvents.at(-1)).toMatchObject({ queuedForEvolution: true });
    }
  });

  test("rechecks the budget between tools in the same model response", async () => {
    const bridge = new MockRustBridge(), trace = new InMemoryTraceStore();
    bridge.shellHandler = () => { bridge.budgetTripped = true; return ok("first tool executed"); };
    const llm = new MockLlmClient(() => answer("", [tool("shell", { command: "fixture" }),
      tool("write_file", { path: "bad.txt", content: "never written" })]));
    const result = await new ForegroundTaskRunner({ bridge, trace, llm }).runTask(request());
    expect(result.succeeded).toBe(false);
    expect(bridge.recordedCalls.map(({ method }) => method)).toEqual(["execShell"]);
    expect(bridge.emittedEvents.find((event) => event.type === "runner.error")).toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("pauses, isolates side chat, and discards model actions made before a steer", async () => {
    const bridge = new MockRustBridge();
    const trace = new InMemoryTraceStore();
    const started = deferred<void>(), pending = deferred<LlmResponse>();
    const llm = new MockLlmClient((input, index) => {
      if (index === 0) { started.resolve(); return pending.promise; }
      if (index === 1) return answer("side answer");
      expect(input.messages.some((message) => message.content === "Use CSV instead")).toBe(true);
      expect(input.messages.some((message) => message.content === "What changed?")).toBe(false);
      return answer("CSV plan");
    });
    const runner = new ForegroundTaskRunner({ bridge, trace, llm });
    const run = runner.runTask(request());
    await started.promise;
    await runner.pause("thread-1");
    await runner.steer("thread-1", "Use CSV instead");
    const mainMessages = await trace.listMessages("thread-1");
    const events = bridge.emittedEvents.length;
    const side = await runner.askSideChat("thread-1", "What changed?");
    expect(side).toMatchObject({ answer: "side answer", isolatedFromMainTrace: true });
    expect(llm.calls[1]?.messages[0]?.content).toBe("Generate the report");
    expect(await trace.listMessages("thread-1")).toEqual(mainMessages);
    expect(await trace.listTraceRunsByThread("thread-1")).toEqual([]);
    expect(bridge.emittedEvents).toHaveLength(events);
    pending.resolve(answer("stale plan", [tool("write_file", { path: "old.txt", content: "old" })]));
    await runner.resume("thread-1");
    const result = await run;
    expect(result).toMatchObject({ succeeded: true, finalOutput: "CSV plan", hadHumanSteer: true, steerInstructions: ["Use CSV instead"] });
    expect(bridge.recordedCalls).toEqual([]);
    expect(bridge.emittedEvents.map(({ type }) => type)).toContain("runner.paused");
    expect(bridge.emittedEvents.map(({ type }) => type)).toContain("runner.steered");
    expect(bridge.emittedEvents.at(-1)).toMatchObject({ queuedForEvolution: true });
  });

  test("abort releases a suspended run and prevents further actions", async () => {
    const bridge = new MockRustBridge(), trace = new InMemoryTraceStore();
    const started = deferred<void>();
    const llm = new MockLlmClient((input) => new Promise((_, reject) => {
      started.resolve();
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
    }));
    const runner = new ForegroundTaskRunner({ bridge, trace, llm });
    const run = runner.runTask(request());
    await started.promise;
    await runner.pause("thread-1");
    await runner.abort("thread-1");
    expect(await run).toMatchObject({ succeeded: false, error: "Run aborted" });
    expect((await trace.getThread("thread-1"))?.status).toBe("aborted");
    expect(bridge.recordedCalls).toEqual([]);
  });

  test("keeps the dry-run shadow off the main thread and delegates through the shadow sandbox", async () => {
    const bridge = new MockRustBridge({ "hooks/guard.ts": "guard" });
    const trace = new InMemoryTraceStore();
    const llm = new MockLlmClient((_, index) => index ? answer() : answer("", [tool("shell", { command: "fixture" })]));
    const runner = new ForegroundTaskRunner({ bridge, trace, llm });
    const result = await runner.runTask(request({ dryRunShadow: true }));
    expect(result.succeeded).toBe(true);
    expect(bridge.recordedCalls).toEqual([{ method: "execShell", payload: expect.objectContaining({ sandboxMode: "cow-shadow", allowNetwork: false }) }]);
    expect(bridge.emittedEvents).toEqual([]);
    expect(await trace.getThread("thread-1")).toBeNull();
  });

  test("marks truncated tool output and compacts the model's context without replacing stored history", async () => {
    const bridge = new MockRustBridge(), trace = new InMemoryTraceStore();
    bridge.shellHandler = () => ok("Z".repeat(8000));
    const llm = new MockLlmClient((input, index) => {
      if (index === 0) return answer("", [tool("shell", { command: "fixture" })]);
      if (index === 1) {
        expect(input.systemPrompt).toStartWith("Summarize");
        expect(input.messages[0]?.content).toContain("[tool output truncated]");
        return answer("The command returned a long diagnostic");
      }
      expect(input.messages[0]?.content).toContain("Conversation summary");
      return answer();
    });
    const runner = new ForegroundTaskRunner({ bridge, trace, llm, toolOutputLimit: 1200, compactAtTokens: 1000, contextMaxTokens: 2000 });
    // Leave the initial tool definitions below the threshold, then cross it with the tool turn.
    const result = await runner.runTask(request({ prompt: "X".repeat(180) }));
    expect(result).toMatchObject({ succeeded: true });
    expect(llm.calls).toHaveLength(3);
    const messages = await trace.listMessages("thread-1");
    expect(messages[0]?.content).toBe("X".repeat(180));
    const output = messages.find(({ role }) => role === "tool")?.content;
    expect(output).toHaveLength(1200);
    expect(output).toEndWith("[tool output truncated]");
    expect(bridge.emittedEvents.some((event) => event.type === "runner.context_usage" && event.compressed)).toBe(true);
    expect(truncateToolOutput("short", 120)).toEqual({ output: "short", truncated: false });
  });
});

describe("provider imports and routing", () => {
  test("reads a CC Switch database with a legacy provider and active per-app proxy without changing it", async () => {
    const dir = await fixture(), dbPath = join(dir, "cc switch #1.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER);
      CREATE TABLE proxy_config (app_type TEXT, enabled INTEGER, proxy_enabled INTEGER, listen_port INTEGER);`);
    db.run("INSERT INTO providers VALUES (?, ?, ?, ?, ?)", ["direct", "claude", "Anthropic", JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: "https://example.test", ANTHROPIC_MODEL: "claude-fixture", ANTHROPIC_API_KEY: "secret-fixture",
    } }), 1]);
    db.run("INSERT INTO providers VALUES (?, ?, ?, ?, ?)", ["proxy", "codex", "Codex", "{}", 1]);
    db.run("INSERT INTO proxy_config VALUES ('codex', 1, 1, 15721)");
    db.close();
    const before = await readFile(dbPath);
    const saved = new Map<string, string>();
    const result = await importCcSwitch({ dbPath, keyringPut: async (ref, secret) => { saved.set(ref, secret); } });
    expect(result).toMatchObject({ detected: true, fallbackToManual: false, warnings: [] });
    expect(result.importedProviders).toHaveLength(2);
    expect(result.importedProviders[0]).toMatchObject({ kind: "anthropic", hasApiKey: true, models: ["claude-fixture"] });
    expect(saved.get(result.importedProviders[0]!.keyringRef)).toBe("secret-fixture");
    expect(JSON.stringify(result)).not.toContain("secret-fixture");
    expect(result.importedProviders[1]).toMatchObject({ baseUrl: "http://127.0.0.1:15721/v1", kind: "openai_compatible", hasApiKey: false });
    expect(await readFile(dbPath)).toEqual(before);
    const legacy = join(dir, "legacy.db");
    const oldDb = new Database(legacy);
    oldDb.run("CREATE TABLE provider_configs (name TEXT, base_url TEXT, kind TEXT, model TEXT)");
    oldDb.run("INSERT INTO provider_configs VALUES ('Ollama', 'http://localhost:11434', 'ollama', 'local-model')");
    oldDb.close();
    expect((await importCcSwitch({ dbPath: legacy })).importedProviders[0]).toMatchObject({ kind: "ollama", models: ["local-model"] });
  });

  test("falls back on missing and unrecognized CC Switch DBs", async () => {
    const dir = await fixture(), missing = join(dir, "missing.db"), dbPath = join(dir, "unknown.db");
    expect(await importCcSwitch({ dbPath: missing })).toMatchObject({ detected: false, fallbackToManual: true });
    expect(await Bun.file(missing).exists()).toBe(false);
    const db = new Database(dbPath);
    db.run("CREATE TABLE unknown (data TEXT)");
    db.close();
    expect(await importCcSwitch({ dbPath })).toMatchObject({ detected: true, fallbackToManual: true, warnings: [expect.stringContaining("unrecognized")] });
  });

  test("reads only the checkpointed SQLite snapshot in immutable mode", async () => {
    const dbPath = join(await fixture(), "wal.db");
    const writer = new Database(dbPath);
    try {
      writer.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE providers (name TEXT, kind TEXT, base_url TEXT);
        INSERT INTO providers VALUES ('checkpointed', 'ollama', 'http://localhost:11434');
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO providers VALUES ('uncheckpointed', 'ollama', 'http://localhost:11434');`);
      expect(writer.query("SELECT * FROM providers").all()).toHaveLength(2);
      const result = await importCcSwitch({ dbPath });
      expect(result.importedProviders.map(({ name }) => name)).toEqual(["checkpointed"]);
    } finally { writer.close(); }
  });

  test("probes Magpie first, then supports config, links and graceful manual fallback", async () => {
    const dir = await fixture(), configPath = join(dir, "magpie.json");
    const online = mockFetch((url) => {
      expect(url).toBe("http://127.0.0.1:9876/v1/models");
      return Response.json({ models: [
        { id: "gateway-model", pricing: { input_per_1m_usd: "1.25", output_per_1m_usd: 10, cached_input_per_1m_usd: 0.31 } },
        { id: "gateway/camel", pricing: { inputPer1MUsd: 0, outputPer1MUsd: "0.6", cachedInputPer1MUsd: "" } },
      ] });
    });
    const offline = mockFetch(() => { throw new Error("offline"); });
    const viaGateway = await importMagpie({ baseUrl: "http://127.0.0.1:9876", configPath, fetch: online });
    expect(viaGateway.importedProviders[0]?.models).toEqual(["gateway-model", "gateway/camel"]);
    expect(viaGateway.importedProviders[0]?.isAggregator).toBe(true);
    expect(viaGateway.modelPricing).toEqual([
      { modelId: "gateway-model", inputPer1MUsd: 1.25, outputPer1MUsd: 10, cachedInputPer1MUsd: 0.31 },
      { modelId: "gateway/camel", inputPer1MUsd: 0, outputPer1MUsd: 0.6 },
    ]);
    expect(await importMagpie({ configPath, fetch: offline })).toMatchObject({ detected: false, fallbackToManual: true });
    await writeFile(configPath, JSON.stringify({ providers: { example: { kind: "ollama", baseUrl: "http://localhost:11434", model: "local" } } }));
    const local = await importMagpie({ configPath, fetch: offline });
    expect(local.importedProviders[0]).toMatchObject({ kind: "ollama", models: ["local"] });
    const viaLink = await importMagpie({ configPath, fetch: offline,
      importLink: "magpie://import?name=OpenAI&kind=openai&baseUrl=https%3A%2F%2Fapi.openai.com%2Fv1&apiKey=private-key&model=fixture",
      keyringPut: async (_, key) => { expect(key).toBe("private-key"); },
    });
    expect(viaLink.importedProviders[0]).toMatchObject({ name: "OpenAI", hasApiKey: true, models: ["fixture"] });
    expect(JSON.stringify(viaLink)).not.toContain("private-key");
  });

  test("routes all model slots, resolves credentials via the keyring and discovers models without exposing the key", async () => {
    const bridge = new MockRustBridge();
    bridge.secrets.set("provider:one", "test-key");
    const fetch = mockFetch((url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "solver-model" }, { id: "judge-model" }] });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("override-model");
      return Response.json({ model: body.model, choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    });
    const registry = new ProviderRegistry(bridge, { fetch });
    registry.upsert({ id: "one", name: "One", kind: "openai_compatible", baseUrl: "https://example.test/v1/", keyringRef: "provider:one",
      hasApiKey: true, models: [], enabled: true, source: "manual" });
    for (const slot of ["solver", "improver", "judge"] as const) registry.bind(slot, { providerId: "one", modelId: `${slot}-model` });
    expect(registry.resolve("improver").modelId).toBe("improver-model");
    expect(registry.resolve("judge").modelId).toBe("judge-model");
    expect(await registry.ping("one")).toMatchObject({ ok: true });
    expect(registry.get("one").models).toEqual(["solver-model", "judge-model"]);
    expect(await new RoutedLlmClient(registry).complete({ slot: "solver", modelId: "override-model", messages: [{ role: "user", content: "test" }] }))
      .toMatchObject({ modelId: "override-model", content: "ok" });
    expect(JSON.stringify(registry.list())).not.toContain("test-key");
  });
});

describe("pooled keys and direct model routing", () => {
  test("round-robin picks enabled keys in turn, skips cooldowns, and falls back to legacy only for an empty pool", async () => {
    const bridge = new MockRustBridge();
    for (const id of ["first", "second", "disabled", "legacy"]) bridge.secrets.set(id, `fixture-${id}`);
    let clock = 1000;
    const registry = new ProviderRegistry(bridge, { now: () => clock });
    const provider = ProviderConfigSchema.parse({ id: "pool", name: "Pool", kind: "openai_compatible", baseUrl: "https://pool.test/v1",
      keyringRef: "legacy", hasApiKey: true, keyStrategy: "round_robin", keys: [
        { id: "first", label: "First", keyringRef: "first", priority: 1 },
        { id: "second", label: "Second", keyringRef: "second", priority: 2 },
        { id: "disabled", label: "Disabled", keyringRef: "disabled", priority: 0, enabled: false },
      ] });
    registry.upsert(provider);
    expect((await registry.acquireKey("pool"))?.keyId).toBe("first");
    expect((await registry.acquireKey("pool"))?.keyId).toBe("second");
    registry.reportKeyFailure("pool", "first", "HTTP 429", 50);
    expect((await registry.acquireKey("pool"))?.keyId).toBe("second");
    registry.reportKeyFailure("pool", "second", "HTTP 401", 50);
    expect(await registry.acquireKey("pool")).toBeUndefined();
    clock += 50;
    expect((await registry.acquireKey("pool"))?.keyId).toBe("first");
    registry.upsert({ ...provider, keys: [] });
    expect(await registry.acquireKey("pool")).toEqual({ keyId: null, secret: "fixture-legacy" });
  });

  test("retries only on 401, 403 or 429, updates catalog counts, and restores the primary key after cooldown", async () => {
    const bridge = new MockRustBridge();
    const attempted: string[] = [];
    let clock = 1000, healthy = false;
    const statuses: Record<string, number> = { a: 401, b: 403, c: 429 };
    const registry = new ProviderRegistry(bridge, { now: () => clock, keyCooldownMs: 500, fetch: mockFetch((_url, init) => {
      const id = new Headers(init?.headers).get("authorization")!.replace("Bearer ", "");
      attempted.push(id);
      return !healthy && statuses[id] ? new Response("provider body", { status: statuses[id] }) : Response.json({ data: [{ id: "shared" }] });
    }) });
    registry.upsert(ProviderConfigSchema.parse({ id: "pool", name: "Pool", kind: "openai_compatible", baseUrl: "https://pool.test/v1",
      keyringRef: "legacy", models: ["shared"], keys: ["a", "b", "c", "d"].map((id, priority) => {
        bridge.secrets.set(id, id);
        return { id, label: id, keyringRef: id, priority };
      }) }));
    expect(await registry.listModels("pool")).toEqual(["shared"]);
    expect(attempted).toEqual(["a", "b", "c", "d"]);
    expect(registry.get("pool").keys?.map(({ lastError }) => lastError)).toEqual(["HTTP 401", "HTTP 403", "HTTP 429", undefined]);
    expect(registry.buildAggregatedCatalog()[0]?.activeKeyCount).toBe(1);
    healthy = true;
    clock += 500;
    await registry.listModels("pool");
    expect(attempted.at(-1)).toBe("a");
    expect(registry.buildAggregatedCatalog()[0]?.activeKeyCount).toBe(4);

    const observed: (string | null)[] = [];
    await expect(registry.withKeyFailover("pool", async ({ keyId }) => {
      observed.push(keyId);
      throw Object.assign(new Error("upstream unavailable"), { status: 500 });
    })).rejects.toThrow("upstream unavailable");
    expect(observed).toEqual(["a"]);
  });

  test("a foreground provider override uses the selected Magpie namespace even when the solver has the same model name", async () => {
    const bridge = new MockRustBridge();
    const trace = new InMemoryTraceStore();
    const attempts: string[] = [];
    const registry = new ProviderRegistry(bridge, { fetch: mockFetch((url, init) => {
      attempts.push(url);
      const { model } = JSON.parse(String(init?.body));
      return Response.json({ model, usage: { prompt_tokens: 3, completion_tokens: 2 },
        choices: [{ message: { content: `routed:${model}` }, finish_reason: "stop" }] });
    }) });
    const models = ["group/smart-split", "demo-gateway/gpt-6.2-sol"];
    registry.upsert(ProviderConfigSchema.parse({ id: "standard", name: "Standard", kind: "openai_compatible", baseUrl: "http://localhost:8001/v1",
      keyringRef: "standard", models }));
    registry.upsert(ProviderConfigSchema.parse({ id: "magpie", name: "Magpie", kind: "openai_compatible", baseUrl: "http://localhost:3425/v1",
      keyringRef: "magpie", source: "magpie", isAggregator: true, models, pinnedModels: ["group/smart-split"] }));
    registry.bind("solver", { providerId: "standard", modelId: "group/smart-split" });
    const runner = new ForegroundTaskRunner({ bridge, llm: new RoutedLlmClient(registry), trace });
    const result = await runner.runTask({ ...request({ mode: "ask" }), providerIdOverride: "magpie", modelOverride: "demo-gateway/gpt-6.2-sol" });
    expect(result.finalOutput).toBe("routed:demo-gateway/gpt-6.2-sol");
    expect(attempts).toEqual(["http://localhost:3425/v1/chat/completions"]);
    const catalog = registry.buildAggregatedCatalog();
    expect(catalog[0]).toMatchObject({ catalogId: "magpie::group/smart-split", isAggregator: true, isRoutingGroup: true,
      upstreamGroup: "group", displayName: "smart-split", pinned: true, activeKeyCount: 1 });
    expect(catalog.find(({ catalogId }) => catalogId === "magpie::demo-gateway/gpt-6.2-sol")).toMatchObject({ upstreamGroup: "demo-gateway", isRoutingGroup: false });
    expect(catalog.find(({ catalogId }) => catalogId === "standard::group/smart-split")?.upstreamGroup).toBeUndefined();
  });
});

test("OpenRouter catalogs convert per-token prices and retain models with incomplete or invalid pricing", async () => {
  const fetch = mockFetch((url) => {
    expect(url).toBe("https://openrouter.test/api/v1/models");
    return Response.json({ data: [
      { id: "vendor/model", pricing: { prompt: "0.00000125", completion: 0.000010, input_cache_read: "3.1e-7" } },
      { id: "vendor/free", pricing: { prompt: "0", completion: 0 } },
      { id: "vendor/invalid", pricing: { prompt: "  ", completion: -1 } },
      { id: "vendor/overflow", pricing: { prompt: "1e308", completion: "0.001" } },
      { id: "vendor/incomplete", pricing: { prompt: 0.000001 } },
      null,
    ] });
  });
  const bridge = new MockRustBridge();
  bridge.secrets.set("openrouter", "test-key");
  const registry = new ProviderRegistry(bridge, { fetch });
  registry.upsert(ProviderConfigSchema.parse({ id: "openrouter", name: "OpenRouter", kind: "openai_compatible",
    baseUrl: "https://openrouter.test/api/v1", keyringRef: "openrouter", hasApiKey: true, enabled: true }));
  expect(await registry.listModelCatalog("openrouter")).toEqual({
    models: ["vendor/model", "vendor/free", "vendor/invalid", "vendor/overflow", "vendor/incomplete"],
    pricing: [
      { modelId: "vendor/model", inputPer1MUsd: 1.25, outputPer1MUsd: 10, cachedInputPer1MUsd: 0.31 },
      { modelId: "vendor/free", inputPer1MUsd: 0, outputPer1MUsd: 0 },
    ],
  });
});

test("registry estimates namespaced models using exact prices before the last suffix", async () => {
  const fetch = mockFetch(() => Response.json({ model: "gpt-4.1-mini", usage: { prompt_tokens: 1000, completion_tokens: 200 },
    choices: [{ message: { content: "done" }, finish_reason: "stop" }] }));
  const registry = new ProviderRegistry(new MockRustBridge(), { fetch, pricing: [
    { modelId: "gpt-4.1-mini", inputPer1MUsd: 0.4, outputPer1MUsd: 1.6 },
    { modelId: "gateway/exact/gpt-4.1-mini", inputPer1MUsd: 2, outputPer1MUsd: 5 },
  ] });
  registry.upsert(ProviderConfigSchema.parse({ id: "gateway", name: "Gateway", kind: "openai_compatible",
    baseUrl: "http://localhost:3425/v1", keyringRef: "gateway", enabled: true }));
  const input = { slot: "solver" as const, messages: [] };
  const suffixId = "gateway/fallback/gpt-4.1-mini";
  const suffix = await (await registry.client("solver", suffixId, "gateway")).complete(input);
  expect(suffix.modelId).toBe(suffixId);
  expect(suffix.usage.costUsd).toBeCloseTo(0.00072, 12);
  const exact = await (await registry.client("solver", "gateway/exact/gpt-4.1-mini", "gateway")).complete(input);
  expect(exact.usage.costUsd).toBeCloseTo(0.003, 12);
});

describe("provider completion gateway retries", () => {
  const request = { slot: "solver" as const, messages: [] };
  async function gateway(fetch: typeof globalThis.fetch, gatewayRetryDelayMs: number) {
    const registry = new ProviderRegistry(new MockRustBridge(), { fetch, gatewayRetryDelayMs });
    registry.upsert(ProviderConfigSchema.parse({ id: "gateway", name: "Gateway", kind: "openai_compatible",
      baseUrl: "http://localhost:3425/v1", keyringRef: "gateway", models: ["fixture-model"] }));
    return registry.client("solver", undefined, "gateway");
  }

  test("recovers from 502 and 503 using the same credential", async () => {
    let attempts = 0;
    const client = await gateway(mockFetch(() => {
      const status = [502, 503][attempts++];
      if (status) return new Response("Temporary gateway error", { status });
      return Response.json({ model: "fixture-model", choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
    }), 0);
    expect(await client.complete(request)).toMatchObject({ content: "done", modelId: "fixture-model", finishReason: "stop" });
    expect(attempts).toBe(3);
  });

  test.each([[504, 3], [500, 1]])("HTTP %i ends after %i attempts", async (status, expectedAttempts) => {
    let attempts = 0;
    const client = await gateway(mockFetch(() => {
      attempts++;
      return new Response("Gateway error", { status });
    }), 0);
    await expect(client.complete(request)).rejects.toMatchObject({ status });
    expect(attempts).toBe(expectedAttempts);
  });

  test("aborting during backoff prevents further HTTP requests", async () => {
    const requested = deferred<void>();
    const controller = new AbortController();
    let attempts = 0;
    const client = await gateway(mockFetch(() => {
      attempts++;
      requested.resolve();
      return new Response("Temporary gateway error", { status: 502 });
    }), 10_000);
    const completion = client.complete({ ...request, signal: controller.signal });
    await requested.promise;
    await Bun.sleep(20);
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  }, 1_000);
});

describe("native SDK adapters", () => {
  const pricing = { modelId: "fixture-model", inputPer1MUsd: 3, outputPer1MUsd: 15, cachedInputPer1MUsd: 0.3 };
  const input = { slot: "solver" as const, messages: [{ role: "user" as const, content: "prompt", cacheControl: "ephemeral" as const }] };
  const sse = (objects: unknown[]) => new Response(objects.map((object) => `data: ${JSON.stringify(object)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });

  test("OpenAI compatible usage reports numeric gateway charges in regular and streaming requests", async () => {
    const cases = [
      { fields: { cost: 0, total_cost: 1 }, expected: 0 },
      { fields: { cost: -1, total_cost: 0.22 }, expected: 0.22 },
      { fields: { cost: "0.11", total_cost: null, cost_usd: 0.13 }, expected: 0.13 },
      { fields: { cost: -1, total_cost: "0.22", cost_usd: null }, expected: undefined },
    ];
    for (const { fields, expected } of cases) {
      const fetch = mockFetch((_, init) => {
        const usage = { prompt_tokens: 1000, completion_tokens: 200, ...fields };
        return JSON.parse(String(init?.body)).stream ? sse([{ choices: [], usage }]) :
          Response.json({ model: "fixture-model", usage, choices: [{ finish_reason: "stop", message: { content: "done" } }] });
      });
      const llm = new OpenAiLlmClient(new OpenAI({ apiKey: "mock", baseURL: "https://sdk.test/v1", fetch }),
        "fixture-model", pricing, "openai_compatible");
      const full = (await llm.complete(input)).usage;
      expect(full.upstreamCostUsd).toBe(expected);
      expect(full.costUsd).toBeCloseTo(expected ?? 0.006, 12);
      const chunks = [];
      for await (const chunk of llm.stream(input)) chunks.push(chunk);
      expect(chunks).toEqual([{ type: "done", usage: full }]);
    }
  });

  test("OpenAI compatible streaming preserves raw reasoning and tool deltas and prices cached tokens once", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url).toEndWith("/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
      const usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 80 } };
      if (!body.stream) return Response.json({ model: "fixture-model", usage, choices: [{ finish_reason: "stop",
        message: { reasoning_content: "reason", content: "result" } }] });
      return sse([{ choices: [{ delta: { reasoning_content: "thought" } }] },
        { choices: [{ delta: { content: "text", tool_calls: [{ index: 0, id: "call", function: { name: "tool", arguments: '{"n":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }, { choices: [], usage }]);
    });
    const llm = new OpenAiLlmClient(new OpenAI({ apiKey: "mock", baseURL: "https://sdk.test/v1", fetch }), "fixture-model", pricing, "openai_compatible");
    const full = await llm.complete(input);
    expect(full).toMatchObject({ content: "result", reasoning: "reason", usage: { inputTokens: 1000, cachedInputTokens: 800, reasoningTokens: 80 } });
    expect(full.usage.costUsd).toBeCloseTo(0.00384, 12);
    const chunks = [];
    for await (const chunk of llm.stream(input)) chunks.push(chunk);
    expect(chunks).toEqual([{ type: "reasoning_delta", delta: "thought" }, { type: "text_delta", delta: "text" },
      { type: "tool_call", toolCall: tool("tool", { n: 1 }, "call") }, { type: "done", usage: full.usage }]);
  });

  test("Anthropic keeps cache breakpoints and prices cache creation separately from cache reads", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url).toEndWith("/v1/messages");
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
      return Response.json({ model: "fixture-model", stop_reason: "tool_use", content: [
        { type: "thinking", thinking: "reason", signature: "signature" }, { type: "text", text: "result" },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "test.txt" } },
      ], usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 700 } });
    });
    const llm = new AnthropicLlmClient(new Anthropic({ apiKey: "mock", baseURL: "https://sdk.test", fetch }), "fixture-model", pricing);
    const result = await llm.complete(input);
    expect(result).toMatchObject({ content: "result", reasoning: "reason", finishReason: "tool_calls",
      toolCalls: [tool("read_file", { path: "test.txt" }, "toolu_1")], usage: { inputTokens: 1000, cachedInputTokens: 700, outputTokens: 100 } });
    expect(result.usage.costUsd).toBeCloseTo(0.002685, 12);
  });

  test("Gemini retains raw thought parts and includes reasoning in billed output", async () => {
    const response = { modelVersion: "fixture-model", candidates: [{ finishReason: "STOP", content: { parts: [
      { thought: true, text: "consider" }, { text: "answer" }, { functionCall: { id: "f1", name: "sample", args: { x: 1 } } },
    ] } }], usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 4 } };
    const sdk = { models: { generateContent: async () => response, generateContentStream: async function* () { yield response; } } } as unknown as GoogleGenAI;
    const llm = new GeminiLlmClient(sdk, "fixture-model", pricing);
    const full = await llm.complete(input);
    expect(full).toMatchObject({ content: "answer", reasoning: "consider", toolCalls: [tool("sample", { x: 1 }, "f1")],
      usage: { inputTokens: 20, cachedInputTokens: 12, outputTokens: 9, reasoningTokens: 4 } });
    const chunks = [];
    for await (const chunk of llm.stream(input)) chunks.push(chunk);
    expect(chunks).toEqual([{ type: "reasoning_delta", delta: "consider" }, { type: "text_delta", delta: "answer" },
      { type: "tool_call", toolCall: full.toolCalls[0] }, { type: "done", usage: full.usage }]);
  });
});

describe("SQLite trace store", () => {
  test("migrates a v1 DB in place, persists its contents, exports JSONL and computes recent domain health", async () => {
    const dbPath = join(await fixture(), "trace.db");
    const at = new Date(0).toISOString();
    let store = new SqliteTraceStore(dbPath);
    expect(store.schemaVersion).toBe(2);
    await store.upsertThread(ThreadSchema.parse({ id: "t", workspacePath: "/workspace", title: "one", mode: "ask", status: "completed",
      pinnedCommitSha: "abc", createdAt: at, updatedAt: at }));
    await store.appendMessage(ChatMessageSchema.parse({ id: "m", threadId: "t", role: "user", content: "hello", createdAt: at }));
    for (const [runId, succeeded, steps, domain] of [["r1", true, 2, "files"], ["r2", false, 3, "files"],
      ["r3", true, 10, "other"], ["r4", false, 4, "files"]] as const) {
      await store.saveTraceRun({ runId, succeeded, threadId: "t", domain, pinnedCommitSha: "abc", prompt: "hello", finalOutput: "result",
        trajectoryMarkdown: "[ACTION] reviewed", touchedFiles: [], hadHumanSteer: false, steerInstructions: [], sourceTags: ["local"], createdAt: at,
        metrics: { steps, errors: 0, costUsd: 0, durationMs: 1, tokens: 0 } });
    }
    store.close();
    const oldDb = new Database(dbPath);
    oldDb.exec(`DROP INDEX messages_thread; DROP INDEX runs_thread; DROP INDEX runs_domain; DROP INDEX regression_cases_domain;
      DELETE FROM schemaVersion WHERE version = 2;`);
    oldDb.close();
    store = new SqliteTraceStore(dbPath);
    try {
      expect(store.schemaVersion).toBe(2);
      expect(await store.getThread("t")).toMatchObject({ title: "one" });
      expect(await store.listMessages("t")).toMatchObject([{ id: "m", content: "hello" }]);
      expect(await store.getTraceRun("r4")).toMatchObject({ succeeded: false });
      expect((await store.exportJsonl("t")).trim().split("\n").map((line) => JSON.parse(line).runId)).toEqual(["r1", "r2", "r3", "r4"]);
      expect(await store.getDomainHealth("files")).toEqual({ domain: "files", recentRuns: 3, failureRate: 2 / 3, consecutiveFailures: 2, avgSteps: 3 });
      expect(await store.getDomainHealth("files", 2)).toMatchObject({ recentRuns: 2, failureRate: 1, avgSteps: 3.5 });
      expect(await store.getDomainHealth("missing")).toMatchObject({ recentRuns: 0, failureRate: 0 });
      await store.deleteThread("t");
      expect(await store.getThread("t")).toBeNull();
      expect(await store.listMessages("t")).toEqual([]);
    } finally { store.close(); }
    const migrated = new Database(dbPath, { readonly: true });
    expect(migrated.query("SELECT version FROM schemaVersion ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }]);
    migrated.close();
  });
});

describe("harness slots", () => {
  const tree = {
    "memory/LongTermMEMORY.md": "Keep notes here",
    "skills/reports/SKILL.md": "---\nname: reports\ndescription: >\n  Tabular exports\n  with totals\n---\nInstructions",
    "mcp/servers.json": '{"servers":[{"id":"example","command":"mcp-fixture","args":["--local"]},{"id":"disabled","enabled":false,"url":"https://mcp.test/"}]}',
    "hooks/guard.ts": "guard body", "hooks/example_trim_output.ts": "example code",
    "sub_agents/reader.md": "---\nname: reader\n---\nIsolated reader instructions",
    "sandbox_policies/readonly.json": '{"rules":[{"id":"readonly","prefix":"blocked fixture","action":"forbidden"}]}',
  };

  test("loads memory, skill metadata, hooks, sub-agent profiles and sandbox policies from the pinned tree", async () => {
    expect(loadMemory(tree)).toBe("Keep notes here");
    expect(loadSkills(tree)).toMatchObject([{ name: "reports", description: "Tabular exports with totals\n", body: "Instructions" }]);
    const hooks = loadHooks(tree);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ hookPath: "hooks/guard.ts", events: ["PreToolUse", "PostToolUse"], sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(loadSubagentProfile(tree, "sub_agents/reader.md")).toMatchObject({ name: "reader", instructions: "Isolated reader instructions" });
    expect(loadSandboxPolicies(tree)).toEqual([{ id: "readonly", prefix: "blocked fixture", action: "forbidden", description: "" }]);
    const bridge = new MockRustBridge();
    const intent = { hookPath: "hooks/guard.ts", threadId: "t", workspaceRoot: "/workspace", event: "PreToolUse" as const, payloadJson: "{}", timeoutMs: 1000 };
    expect(await dispatchHook(bridge, intent)).toMatchObject({ deniedReason: "hook_untrusted" });
    const llm = new MockLlmClient();
    const spawn_worker = createWorkerSpawner(tree, llm, bridge);
    expect(await spawn_worker("sub_agents/reader.md", "Inspect a sample")).toMatchObject({ finishReason: "stop" });
    expect(llm.calls[0]).toMatchObject({ systemPrompt: "Isolated reader instructions", messages: [{ role: "user", content: "Inspect a sample" }] });
    expect(llm.calls[0]?.tools).toBeUndefined();
    bridge.budgetTripped = true;
    await expect(dispatchHook(bridge, intent)).rejects.toThrow("Daily budget limit exceeded");
    await expect(spawn_worker("sub_agents/reader.md", "another request")).rejects.toThrow("Daily budget limit exceeded");
    expect(bridge.recordedCalls).toEqual([{ method: "execHook", payload: intent }]);
  });

  test("loads MCP configs and calls the SDK over a supplied L0-managed transport", async () => {
    const servers = loadMcpServers(tree);
    expect(servers.example).toMatchObject({ command: "mcp-fixture", enabled: true });
    const [transport, remote] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "inspect", inputSchema: { type: "object" } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "fixture output" }] }));
    await server.connect(remote);
    const host = new McpHost(servers, async (name) => { expect(name).toBe("example"); return transport; });
    try {
      expect(await host.listTools("example")).toMatchObject({ tools: [{ name: "inspect" }] });
      expect(await host.callTool("example", "inspect", {})).toMatchObject({
        result: { content: [{ type: "text", text: "fixture output" }] }, sourceTags: ["untrusted_mcp"],
      });
      await expect(host.listTools("disabled")).rejects.toThrow("MCP server unavailable");
      await expect(new McpHost(servers).listTools("example")).rejects.toThrow("requires an L0-managed transport");
    } finally { await host.close(); await server.close(); }
  });
});
