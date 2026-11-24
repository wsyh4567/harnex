import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MockLlmClient, MockRustBridge, type LlmRequest, type LlmResponse } from "@harnex/interfaces";
import {
  AggregatedModelEntrySchema, EvolutionProposalSchema, HarnessCompatibilityReportSchema, HarnessGardenerReportSchema, OnboardingReplayTraceSchema,
  RpcErrorCode, type AppConfig, type EvolutionProposal, type GenomeCommit,
  type GitCommitPatchParams, type ModelPricing, type ProviderConfig, type RunnerEvent, type Thread,
} from "@harnex/protocol";
import { RpcFailure, SidecarServer, StdioPeer, type SidecarServerOptions } from "../src/index.ts";

const memory = "memory/LongTermMEMORY.md";
const initialTree = { "systemprompt.md": "Complete the report.", [memory]: "Prior note.", "manifest.json": "{}" };
const metering = { inputTokens: 30, outputTokens: 20, reasoningTokens: 0, cachedInputTokens: 0, costUsd: 0.001 };
const reflected = "<edits>Introduced a completion check.</edits>\n<experience>\ncue: Several files need reconciliation\n" +
  "lesson: Add a completion check\nevidence: The rollout verified totals before delivery\nconfidence: high\n</experience>";

function mockModel(req: LlmRequest): LlmResponse {
  const prompt = req.systemPrompt ?? "";
  let content = "Incomplete report.";
  if (req.slot === "solver" && prompt.includes("Verify totals")) content = "Verified totals.";
  if (req.slot === "judge") {
    const data = /<UNTRUSTED_EVIDENCE_DATA>\n(.*)\n<\/UNTRUSTED_EVIDENCE_DATA>/.exec(req.messages.at(-1)!.content)![1]!;
    const candidates = (JSON.parse(data) as { path: string; content: string }[])
      .filter((item) => /^candidates\/[A-Z]+\/response\.md$/.test(item.path));
    const selected = candidates.find(({ content }) => content.includes("Verified totals")) ?? candidates[0]!;
    content = `<why>The response checks the totals. Confidence: high</why>\n\`\`\`choice\n${selected.path.split("/")[1]}\n\`\`\``;
  }
  if (req.slot === "improver") {
    content = prompt.startsWith("# REFLECT") ? reflected : JSON.stringify({
      operations: [{ op: "upsert", path: memory, content: "Verify totals before delivery.\n" }],
    });
  }
  return { content, modelId: req.modelId ?? `fixture-${req.slot}`, finishReason: "stop", toolCalls: [], usage: metering };
}

const getDeferred = <T>() => {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { resolve, promise };
};

function connect(options: SidecarServerOptions = {}) {
  const rust = new MockRustBridge(initialTree);
  const calls: { method: string; params: unknown }[] = [];
  const rustPeer: StdioPeer = new StdioPeer((line) => sidecarPeer.receive(line), 2000);
  const sidecarPeer: StdioPeer = new StdioPeer((line) => rustPeer.receive(line), 2000);
  const completed = getDeferred<RunnerEvent>();
  const bindings = new Map<string, string>();
  const aliases = new Map<string, (params: Record<string, unknown>) => unknown>();
  rustPeer.handle(async (method, params) => {
    calls.push({ method, params });
    const input = params as Record<string, unknown>;
    if (aliases.has(method)) return aliases.get(method)!(input);
    switch (method) {
      case "git.head_sha": return rust.gitHeadSha();
      case "git.read_tree": return rust.gitReadTree(String(input.commitSha));
      case "git.log": return rust.gitLog(Number(input.limit));
      case "git.commit_patch": return rust.gitCommitPatch(input.patch as GitCommitPatchParams);
      case "budget.check": return rust.checkBudget(Number(input.estimatedCostUsd));
      case "budget.record_usage": return rust.recordUsage(String(input.modelId), input.usage as LlmResponse["usage"]);
      case "keyring.set": rust.secrets.set(String(input.keyringRef), String(input.secret)); return null;
      case "keyring.get": return rust.keyringGet(String(input.keyringRef));
      case "keyring.delete": rust.secrets.delete(String(input.keyringRef)); return null;
      case "sandbox.bind_shadow": {
        if (bindings.has(String(input.threadId))) throw new Error("Duplicate workspace binding");
        await rust.gitReadTree(String(input.commitSha));
        bindings.set(String(input.threadId), String(input.workspaceRoot));
        return null;
      }
      case "sandbox.clear_shadow": {
        if (bindings.get(String(input.threadId)) !== input.workspaceRoot) throw new Error("Shadow path mismatch");
        bindings.delete(String(input.threadId));
        return null;
      }
      case "event.emit": {
        const event = params as RunnerEvent;
        rust.emitEvent(event);
        if (event.type === "runner.completed") completed.resolve(event);
        return null;
      }
      default: throw new RpcFailure(RpcErrorCode.MethodNotFound, "Unknown fixture L0 method");
    }
  });
  const server = new SidecarServer(sidecarPeer, { llm: new MockLlmClient(mockModel), ...options });
  return { call: rustPeer.call.bind(rustPeer), server, rust, calls, bindings, aliases, completed: completed.promise,
    async close() { await server.close(); rustPeer.close(); sidecarPeer.close(); } };
}

async function fixture<T>(use: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(import.meta.dir, ".sidecar-test-"));
  try { return await use(root); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 2 }); }
}

test("answers heartbeat while an earlier incoming request awaits L0 and preserves JSON-RPC error codes", async () => {
  const app = connect();
  try {
    const waiting = getDeferred<void>(), head = getDeferred<string>();
    app.aliases.set("git.head_sha", () => { waiting.resolve(); return head.promise; });
    const thread = app.call<Thread>("thread.create", { workspacePath: import.meta.dir });
    await waiting.promise;
    expect(await app.call("system.heartbeat")).toEqual({ ok: true });
    expect(app.calls.filter(({ method }) => method === "git.head_sha")).toHaveLength(1);
    head.resolve(app.rust.headSha);
    expect((await thread).pinnedCommitSha).toBe(app.rust.headSha);
    await expect(app.call("missing.method")).rejects.toMatchObject({ code: RpcErrorCode.MethodNotFound });
    await expect(app.call("runner.start", { threadId: "missing" })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    app.aliases.set("keyring.get", () => { throw new RpcFailure(RpcErrorCode.ApprovalDenied, "Key access denied"); });
    await expect(app.server.bridge.keyringGet("invalid")).rejects.toMatchObject({ code: RpcErrorCode.ApprovalDenied });
  } finally { await app.close(); }
});

test("runs, probes and adopts an evolution proposal with L0 pinning, shadow cleanup and patch provenance", () => fixture(async (root) => {
  const app = connect();
  try {
    const pin = app.rust.headSha;
    const thread = await app.call<Thread>("thread.create", { workspacePath: root, pinnedCommitSha: pin, mode: "craft", domain: "office" });
    expect(thread.pinnedCommitSha).toBe(pin);
    expect(app.calls.some(({ method }) => method === "git.head_sha")).toBe(false);
    const prompt = "Reconcile the report";
    const { runId } = await app.call<{ runId: string }>("runner.start", { threadId: thread.id, prompt });
    expect(await app.completed).toMatchObject({ type: "runner.completed", runId, queuedForEvolution: false });
    expect(await app.call("thread.messages", { threadId: thread.id })).toMatchObject([
      { role: "user", content: prompt }, { role: "assistant", content: "Incomplete report." },
    ]);
    const proposal = await app.call<EvolutionProposal>("evolution.trigger", { threadId: thread.id, domain: "office", k: 1, mode: "parallel" });
    expect(proposal).toMatchObject({ status: "ready", baseCommitSha: pin, experienceEntry: { lesson: "Add a completion check" } });
    const bound = app.calls.filter(({ method }) => method === "sandbox.bind_shadow");
    const cleared = app.calls.filter(({ method }) => method === "sandbox.clear_shadow");
    expect(bound).toHaveLength(4);
    expect(cleared).toHaveLength(4);
    for (const { params } of bound) {
      const { threadId, workspaceRoot, commitSha } = params as { threadId: string; workspaceRoot: string; commitSha: string };
      expect(threadId).toStartWith(`${thread.id}:shadow:`);
      expect(workspaceRoot).not.toBe(root);
      expect(commitSha).toBe(pin);
      expect(cleared).toContainEqual({ method: "sandbox.clear_shadow", params: { threadId, workspaceRoot } });
    }
    expect(app.bindings.size).toBe(0);
    expect(await app.call("evolution.silent_archive_count")).toBe(0);
    const adopted = await app.call<{ proposal: EvolutionProposal; newCommit: GenomeCommit }>("evolution.adopt", { proposalId: proposal.id });
    expect(adopted.proposal.status).toBe("adopted");
    expect(adopted.newCommit.sha).toBe(app.rust.headSha);
    expect(app.rust.headSha).not.toBe(pin);
    expect(app.calls.find(({ method }) => method === "git.commit_patch")?.params).toMatchObject({
      threadId: thread.id, sourceTags: proposal.sourceTags, patch: { baseCommitSha: pin, operations: expect.any(Array) },
    });
    expect((await app.rust.gitReadTree(adopted.newCommit.sha))[memory]).toContain("Verify totals");
    expect(await app.call("replay.compare", { taskPrompt: prompt, workspacePath: root, modelId: "fixture-solver", v0Sha: pin, vNSha: adopted.newCommit.sha }))
      .toMatchObject({ status: "completed", v0Output: "Incomplete report.", vNOutput: "Verified totals.", modelId: "fixture-solver" });
    expect(app.bindings.size).toBe(0);
  } finally { await app.close(); }
}));

test.each(["supplied", "fresh"] as const)("puts a verified compatibility migration in Triage with a %s report", (reportSource) => fixture(async (root) => {
  const hook = "hooks/check.ts";
  const manifest = "manifest.json";
  const repair = [
    { op: "upsert", path: manifest, content: '{"schemaVersion":1,"name":"Fixture"}' },
    { op: "upsert", path: hook, content: "const payload = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(payload));" },
  ];
  const llm = new MockLlmClient((request) => ({ ...mockModel(request), content: JSON.stringify({ operations: repair }) }));
  const app = connect({ llm });
  try {
    const priorHead = app.rust.headSha;
    await app.rust.gitCommitPatch({ baseCommitSha: priorHead, message: "Legacy harness fixture", authorName: "Fixture", domain: "general",
      operations: [
        { op: "upsert", path: manifest, content: '{"schemaVersion":0,"name":"Fixture"}' },
        { op: "upsert", path: hook, content: "const payload = JSON.parse(process.argv[3]!); console.log(JSON.stringify(payload));" },
      ],
    });
    const head = app.rust.headSha;
    expect(head).not.toBe(priorHead);
    const report = HarnessCompatibilityReportSchema.parse(await app.call("evolution.check_compatibility"));
    expect(report).toMatchObject({ commitSha: head, needsMigration: true, hasBreakingIssues: true, quarantinedPaths: [hook], issues: [
      { path: manifest, kind: "schema_version_mismatch", severity: "breaking" },
      { path: hook, kind: "deprecated_hook_contract", severity: "breaking" },
    ] });
    expect(app.calls.slice(0, 2)).toEqual([{ method: "git.head_sha", params: {} }, { method: "git.read_tree", params: { commitSha: head } }]);
    const thread = await app.call<Thread>("thread.create", { workspacePath: root, pinnedCommitSha: head });
    const params = reportSource === "supplied" ? { report, threadId: thread.id } : { workspacePath: root };
    const proposal = EvolutionProposalSchema.parse(await app.call("evolution.start_migration", params));
    expect(proposal).toMatchObject({ threadId: thread.id, baseCommitSha: head, triggerSource: "upgrade_migration", status: "ready", requiresHumanTrust: true });
    expect(proposal.diffs.map(({ path }) => path)).toEqual([hook, manifest]);
    expect(await app.call("evolution.triage_list")).toEqual([proposal]);
    expect(app.rust.emittedEvents).toContainEqual({ type: "evolution.proposal_ready", proposal });
    expect(app.rust.headSha).toBe(head);
    expect(app.calls.some(({ method }) => method === "git.commit_patch")).toBe(false);

    await expect(app.call("evolution.start_migration", { report: { ...report, commitSha: priorHead }, threadId: thread.id }))
      .rejects.toThrow("older harness snapshot");
    expect(llm.calls.map(({ slot }) => slot)).toEqual(["improver"]);
  } finally { await app.close(); }
}));

test("stores provider keys only via Rust, persists safe provider metadata and cleans slot bindings on delete", () => fixture(async (root) => {
  const dbPath = join(root, "settings.sqlite");
  const password = "fixture-key-never-stored";
  let provider: ProviderConfig;
  const app = connect({ dbPath });
  try {
    provider = await app.call<ProviderConfig>("provider.save", { provider: { name: "Fixture", baseUrl: "https://provider.test/v1", kind: "openai_compatible" }, apiKey: password });
    expect(provider.hasApiKey).toBe(true);
    expect(JSON.stringify(provider)).not.toContain(password);
    expect(app.calls).toContainEqual({ method: "keyring.set", params: { keyringRef: provider.keyringRef, secret: password } });
    await app.call("config.update", { slots: { solver: { providerId: provider.id, modelId: "fixture" } } });
  } finally { await app.close(); }
  expect((await readFile(dbPath)).includes(Buffer.from(password))).toBe(false);
  const restored = connect({ dbPath });
  try {
    expect(await restored.call("provider.list")).toEqual([provider!]);
    expect((await restored.call<AppConfig>("config.get")).slots.solver?.providerId).toBe(provider!.id);
    await restored.call("provider.delete", { providerId: provider!.id });
    expect(restored.calls).toContainEqual({ method: "keyring.delete", params: { keyringRef: provider!.keyringRef } });
    expect(await restored.call("provider.list")).toEqual([]);
    expect((await restored.call<AppConfig>("config.get")).slots).toEqual({});
  } finally { await restored.close(); }
}));

test("manages named key creation, rotation and removal through Rust and persists only masked metadata", () => fixture(async (root) => {
  const dbPath = join(root, "pool.sqlite");
  const app = connect({ dbPath });
  const values = ["sk-test-primary-8fff", "sk-test-second-4cbe", "sk-rotated-first-aa77"];
  try {
    const saved = await app.call<ProviderConfig>("provider.save", { provider: {
      id: "pool", name: "Pool", kind: "openai_compatible", baseUrl: "https://pool.test/v1", keyStrategy: "round_robin", models: ["shared"],
    }, keyAdditions: [{ id: "a", label: "First", apiKey: values[0] }, { id: "b", label: "Second", apiKey: values[1] }] });
    const old = saved.keys![0]!;
    expect(saved).toMatchObject({ keyStrategy: "round_robin", hasApiKey: true, keys: [{ id: "a", maskedHint: "sk-••••8fff" }, { id: "b", maskedHint: "sk-••••4cbe" }] });
    expect(app.rust.secrets.get(old.keyringRef)).toBe(values[0]!);
    const rotated = await app.call<ProviderConfig>("provider.save", { provider: saved,
      keyAdditions: [{ id: "a", label: "Rotated", apiKey: values[2] }], keyRemovals: ["b"],
    });
    expect(rotated.keys).toMatchObject([{ id: "a", label: "Rotated", keyringRef: old.keyringRef, maskedHint: "sk-••••aa77" }]);
    expect(app.rust.secrets.get(old.keyringRef)).toBe(values[2]!);
    expect(app.rust.secrets.has(saved.keys![1]!.keyringRef)).toBe(false);
    expect(AggregatedModelEntrySchema.array().parse(await app.call("provider.catalog"))[0]?.activeKeyCount).toBe(1);
    const cleared = await app.call<ProviderConfig>("provider.save", { provider: rotated, keyRemovals: ["a"] });
    expect(cleared.hasApiKey).toBe(false);
    expect(cleared.keys).toBeUndefined();
    expect(app.rust.secrets.size).toBe(0);
  } finally { await app.close(); }
  const bytes = await readFile(dbPath);
  for (const secret of values) expect(bytes.includes(Buffer.from(secret))).toBe(false);
}));

test("routes runner.start to the selected provider and model, fails over on 429, and catalogs Magpie routing groups", () => fixture(async (root) => {
  const upstream: { url: string; key: string | null; model: string }[] = [];
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://127.0.0.1:3425/v1/models") return Response.json({ data: [{ id: "group/smart-split" }, { id: "vendor/shared" }] });
    const key = new Headers(init?.headers).get("authorization");
    const { model } = JSON.parse(String(init?.body));
    upstream.push({ url, key, model });
    if (key === "Bearer fixture-bad") return Response.json({ error: { message: "quota exhausted" } }, { status: 429 });
    return Response.json({ model, usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.012 }, choices: [{
      message: { content: `from ${model}` }, finish_reason: "stop",
    }] });
  }) as typeof globalThis.fetch;
  const app = connect({ llm: undefined, fetch });
  try {
    const imported = await app.call<{ importedProviders: ProviderConfig[] }>("provider.import_magpie");
    expect(imported.importedProviders[0]?.isAggregator).toBe(true);
    const magpie = imported.importedProviders[0]!;
    await app.call("config.update", { slots: { solver: { providerId: magpie.id, modelId: "group/smart-split" } } });
    await app.call("provider.save", { provider: { id: "alternate", name: "Alternate", kind: "openai_compatible", models: ["vendor/shared"],
      baseUrl: "https://alternate.test/v1" }, keyAdditions: [
      { id: "bad", label: "Quota", apiKey: "fixture-bad" }, { id: "good", label: "Available", apiKey: "fixture-good" },
    ] });
    const thread = await app.call<Thread>("thread.create", { workspacePath: root, mode: "ask" });
    await app.call("runner.start", { threadId: thread.id, prompt: "Check routing", providerIdOverride: "alternate", modelOverride: "vendor/shared" });
    expect(await app.completed).toMatchObject({ finalOutput: "from vendor/shared", usage: { upstreamCostUsd: 0.012, costUsd: 0.012 } });
    expect(app.calls.find(({ method }) => method === "budget.record_usage")?.params)
      .toMatchObject({ modelId: "vendor/shared", usage: { upstreamCostUsd: 0.012 } });
    expect(upstream).toEqual([
      { url: "https://alternate.test/v1/chat/completions", key: "Bearer fixture-bad", model: "vendor/shared" },
      { url: "https://alternate.test/v1/chat/completions", key: "Bearer fixture-good", model: "vendor/shared" },
    ]);
    const catalog = AggregatedModelEntrySchema.array().parse(await app.call("provider.catalog"));
    expect(catalog.find(({ modelId }) => modelId === "group/smart-split")).toMatchObject({
      isAggregator: true, isRoutingGroup: true, upstreamGroup: "group", activeKeyCount: 1,
    });
    expect(catalog.find(({ providerId, modelId }) => providerId === magpie.id && modelId === "vendor/shared"))
      .toMatchObject({ upstreamGroup: "vendor", isRoutingGroup: false, isAggregator: true });
    expect(catalog.find(({ providerId }) => providerId === "alternate")?.activeKeyCount).toBe(1);
  } finally { await app.close(); }
}));

test("syncing the pricing catalog forwards options to L0 and uses L0 prices for runtime estimates", () => fixture(async (root) => {
  const modelId = "demo-gateway/gpt-6.2-sol:xhigh";
  const fetch = (async (input: Request | string | URL) => {
    expect(String(input)).toBe("http://localhost:4000/v1/chat/completions");
    return Response.json({ model: "gpt-6.1-sol", usage: { prompt_tokens: 1000, completion_tokens: 200 },
      choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
  }) as typeof globalThis.fetch;
  const app = connect({ llm: undefined, fetch });
  const params = { remoteUrl: "https://prices.test/catalog.json", hashUrl: "https://prices.test/catalog.sha256", force: true };
  const synced = { synced: true, source: "remote", modelCount: 1, updatedAt: "2026-11-20T00:00:00Z" };
  app.aliases.set("budget.sync_pricing", (received) => { expect(received).toEqual(params); return synced; });
  app.aliases.set("budget.model_pricing", (received) => {
    expect(received).toEqual({ modelId });
    return { modelId: "gpt-6.1-sol", inputPer1MUsd: 2, outputPer1MUsd: 10, cachedInputPer1MUsd: 0.1 };
  });
  try {
    expect(await app.call("budget.sync_pricing", params)).toEqual(synced);
    await app.call("provider.save", { provider: { id: "local", name: "Local", kind: "openai_compatible",
      baseUrl: "http://localhost:4000/v1", models: [modelId] } });
    await app.call("config.update", { slots: { solver: { providerId: "local", modelId } } });
    const thread = await app.call<Thread>("thread.create", { workspacePath: root, mode: "ask" });
    await app.call("runner.start", { threadId: thread.id, prompt: "Check estimated cost" });
    expect(await app.completed).toMatchObject({ usage: { costUsd: 0.004 } });
  } finally { await app.close(); }
}));

test("fetching provider models and importing Magpie send discovered prices to the budget ledger", async () => {
  const fetch = (async (input: Request | string | URL) => {
    const url = String(input);
    if (url === "http://127.0.0.1:3425/v1/models") return Response.json({ models: [
      { id: "vendor/magpie", pricing: { inputPer1MUsd: 1, outputPer1MUsd: 2 } },
    ] });
    expect(url).toBe("http://localhost:4000/v1/models");
    return Response.json({ data: [
      { id: "vendor/direct", pricing: { prompt: "0.000003", completion: "0.000005" } },
      { id: "group/unpriced" },
    ] });
  }) as typeof globalThis.fetch;
  const app = connect({ fetch });
  const prices: ModelPricing[] = [];
  app.aliases.set("budget.merge_pricing", async ({ pricing }) => {
    prices.push(...pricing as ModelPricing[]);
    const { status } = await app.rust.checkBudget();
    return { ...status, pricingTable: prices };
  });
  try {
    const result = await app.call<{ importedProviders: ProviderConfig[] }>("provider.import_magpie");
    expect(result.importedProviders[0]?.models).toEqual(["vendor/magpie"]);
    expect(result).not.toHaveProperty("modelPricing");
    await app.call("provider.save", { provider: { id: "local", name: "Local", kind: "openai_compatible",
      baseUrl: "http://localhost:4000/v1" } });
    expect(await app.call("provider.fetch_models", { providerId: "local" })).toEqual(["vendor/direct", "group/unpriced"]);
    expect(prices).toEqual([
      { modelId: "vendor/magpie", inputPer1MUsd: 1, outputPer1MUsd: 2 },
      { modelId: "vendor/direct", inputPer1MUsd: 3, outputPer1MUsd: 5 },
    ]);
  } finally { await app.close(); }
});

test("validates and loads the onboarding replay and launches live work with the injected pinned commit", () => fixture(async (root) => {
  await mkdir(join(root, "dataset_a", "raw"), { recursive: true });
  const app = connect({ examplesDir: root, replayPath: join(root, "missing.json") });
  try {
    const replay = OnboardingReplayTraceSchema.parse(await app.call("onboarding.get_replay"));
    expect(replay.isRecordedReplay).toBe(true);
    expect(replay.steps).not.toHaveLength(0);
    const pinnedCommitSha = app.rust.headSha;
    const thread = await app.call<Thread>("onboarding.start_live_challenge", { dataset: "dataset_a", pinnedCommitSha });
    expect(thread).toMatchObject({ title: "Live Challenge (dataset_a)", pinnedCommitSha, status: "idle" });
    expect(thread.workspacePath).not.toBe(join(root, "dataset_a"));
    expect(app.rust.emittedEvents).toEqual([]);
    app.bindings.set(thread.id, thread.workspacePath);
    await app.call("onboarding.activate_live_challenge", { threadId: thread.id });
    expect(await app.completed).toMatchObject({ type: "runner.completed", threadId: thread.id });
  } finally { await app.close(); }
}));

test("supports thread.rename, thread.delete, evolution.architect_chat and actionable ping errors", () => fixture(async (root) => {
  const llm = new MockLlmClient(async (req) => {
    expect(req.slot).toBe("improver");
    expect(req.modelId).toBe("deepseek-v4.1-flash");
    expect(req.providerIdOverride).toBe("prov-demo");
    expect(req.systemPrompt).toContain("systemprompt.md");
    return {
      content: "Add a deterministic BOM check skill before writing CSV.\n<suggested_goal>Always detect UTF-8 BOM / GB18030 before parsing CSV files</suggested_goal>",
      toolCalls: [],
      modelId: "deepseek-v4.1-flash",
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.0001 },
    };
  });
  const fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
  const app = connect({ llm, fetch });
  try {
    const created = await app.call<Thread>("thread.create", { workspacePath: root, title: "Draft Thread", mode: "craft" });
    const renamed = await app.call<Thread>("thread.rename", { threadId: created.id, title: "Invoice Audit" });
    expect(renamed.title).toBe("Invoice Audit");
    const arch = await app.call<{ reply: string; suggestedGoal?: string; modelId: string }>("evolution.architect_chat", {
      pillarId: "skills", pillarTitle: "Skills", domain: "file_ops", message: "CSV encoding keeps breaking",
      modelOverride: "deepseek-v4.1-flash", providerIdOverride: "prov-demo", locale: "en-US",
    });
    expect(arch.reply).toContain("deterministic BOM check");
    expect(arch.reply).not.toContain("<suggested_goal>");
    expect(arch.suggestedGoal).toBe("Always detect UTF-8 BOM / GB18030 before parsing CSV files");
    expect(arch.modelId).toBe("deepseek-v4.1-flash");
    await app.call("thread.delete", { threadId: created.id });
    expect((await app.call<Thread[]>("thread.list")).some((t) => t.id === created.id)).toBe(false);
    await app.call("provider.save", { provider: { id: "bad-key", name: "Bad", kind: "openai_compatible", baseUrl: "http://localhost:4001/v1" }, apiKey: "sk-bad" });
    const ping = await app.call<{ ok: boolean; error?: string }>("provider.ping", { providerId: "bad-key" });
    expect(ping.ok).toBe(false);
    expect(ping.error).toContain("401");
  } finally { await app.close(); }
}));

test("returns a validated HarnessGardenerReport for evolution.gardener_report and flags same-model collusion", async () => {
  const app = connect();
  try {
    const clean = HarnessGardenerReportSchema.parse(await app.call("evolution.gardener_report"));
    expect(clean).toMatchObject({
      commitSha: app.rust.headSha,
      totalOrgans: Object.keys(initialTree).length,
      alwaysOnEstimatedTokens: Math.ceil(
        (Buffer.byteLength(initialTree["systemprompt.md"], "utf8") + Buffer.byteLength(initialTree[memory], "utf8")) / 4,
      ),
      modelDiversityOk: true,
      healthScore: 100,
      findings: [],
    });

    await app.call("provider.save", {
      provider: { id: "shared-prov", name: "Shared", kind: "openai_compatible", baseUrl: "https://shared.test/v1", models: ["m1", "m2"] },
      apiKey: "sk-shared",
    });
    await app.call("config.update", {
      slots: {
        improver: { providerId: "shared-prov", modelId: "m1" },
        judge: { providerId: "shared-prov", modelId: "m1" },
      },
    });
    const colluding = HarnessGardenerReportSchema.parse(await app.call("evolution.gardener_report"));
    expect(colluding.modelDiversityOk).toBe(false);
    expect(colluding.healthScore).toBe(95);
    expect(colluding.findings).toMatchObject([{ kind: "same_model_collusion", path: "slots/improver+judge", severity: "advisory" }]);
    expect(colluding.suggestedPruningGoal).toBeUndefined();
  } finally { await app.close(); }
});

test("compiled sidecar reads fragmented NDJSON and returns the bundled replay from another working directory", () => fixture(async (root) => {
  const exe = join(root, "sidecar.exe"), src = resolve(import.meta.dir, "../src/index.ts");
  const build = Bun.spawn([process.execPath, "build", "--compile", src, "--outfile", exe], { stdout: "pipe", stderr: "pipe" });
  const diagnostics = await new Response(build.stderr).text();
  expect(await build.exited, diagnostics).toBe(0);
  const processHandle = Bun.spawn([exe], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HARNEX_SIDECAR_DB: ":memory:" } });
  const reader = processHandle.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readFrame = async () => {
    while (!buffer.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Sidecar stdout ended: ${await new Response(processHandle.stderr).text()}`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const index = buffer.indexOf("\n"), frame = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    return frame;
  };
  try {
    processHandle.stdin.write('{"jsonrpc":"2.0","id":-1,"method":"system.heart');
    await processHandle.stdin.flush();
    processHandle.stdin.write('beat"}\n{"jsonrpc":"2.0","id":2,"method":"onboarding.get_replay"}\n');
    await processHandle.stdin.flush();
    expect(await readFrame()).toEqual({ jsonrpc: "2.0", id: -1, result: { ok: true } });
    const replayResult = await readFrame();
    expect(replayResult.id).toBe(2);
    expect(OnboardingReplayTraceSchema.parse(replayResult.result).steps.at(-1)?.stage).toBe("v1_replay_success");
    await processHandle.stdin.end();
    expect(await processHandle.exited).toBe(0);
  } finally { reader.releaseLock(); if (processHandle.exitCode === null) processHandle.kill(); }
}), 15_000);
