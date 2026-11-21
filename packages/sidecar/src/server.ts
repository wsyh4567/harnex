import { access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { InMemoryHarnessStore, type HarnessStore, type LlmClient, type TaskRunResult, type TraceStore } from "@harnex/interfaces";
import {
  AppConfigSchema, EvolutionProposalActionParamsSchema, EvolutionReviseParamsSchema, EvolutionTriggerParamsSchema, HarnessCompatibilityReportSchema,
  OnboardingReplayTraceSchema, PricingSyncParamsSchema, ReplayCompareParamsSchema, RpcErrorCode, RsiModeSchema,
  RunnerControlParamsSchema, RunnerStartParamsSchema, RunnerSteerParamsSchema, SideChatAskParamsSchema, ThreadCreateParamsSchema, ThreadSchema,
  type AppConfig, type EvolutionProposal, type ProviderImportResult, type ReplayComparison, type Thread,
} from "@harnex/protocol";
import { EvolutionScheduler, inspectHarnessCompatibility, probeTask, withShadowWorkspace } from "@harnex/evolution";
import { ForegroundTaskRunner, importCcSwitch, importMagpie, ProviderRegistry, RoutedLlmClient, SqliteTraceStore } from "@harnex/runtime";
import { z } from "zod";
import { version as appVersion } from "../../../apps/desktop/src-tauri/tauri.conf.json";
import replay from "../../../examples/first-run-challenge/recorded_replay.json";
import { SidecarSettings } from "./settings.ts";
import { saveProviderWithKeys, SaveProviderSchema } from "./provider_keys.ts";
import { ShadowBoundRunner } from "./shadow_runner.ts";
import { RpcFailure, StdioPeer, StdioRustBridge } from "./stdio_bridge.ts";

const required = z.string().min(1);
const threadCreate = ThreadCreateParamsSchema.extend({ pinnedCommitSha: required.optional() });
const configPatch = AppConfigSchema.omit({ schemaVersion: true }).partial();
const providerId = z.object({ providerId: required });
const migrationStart = z.object({ report: HarnessCompatibilityReportSchema.optional(), threadId: required.optional(), workspacePath: required.optional() });
const liveChallenge = z.object({ dataset: z.enum(["dataset_a", "dataset_b"]), solverModelId: required.optional(), pinnedCommitSha: required.optional() });
const magpieOptions = z.object({ gatewayUrl: required.optional(), importLink: required.optional() });
const slots = ["solver", "improver", "judge"] as const;
const now = () => new Date().toISOString();
const invalid = (message: string) => new RpcFailure(RpcErrorCode.InvalidParams, message);

interface ForegroundRun {
  triggerEvolution: boolean;
  queued: boolean;
  started: (runId: string) => void;
}

export interface SidecarServerOptions {
  dbPath?: string;
  trace?: TraceStore;
  llm?: LlmClient;
  examplesDir?: string;
  replayPath?: string;
  ccSwitchDbPath?: string;
  magpieConfigPath?: string;
  fetch?: typeof fetch;
  reportError?: (error: unknown) => void;
}

export class SidecarServer {
  readonly trace: TraceStore;
  readonly bridge: StdioRustBridge;
  private readonly ownedTrace?: SqliteTraceStore;
  private readonly settings: SidecarSettings;
  private readonly registry: ProviderRegistry;
  private readonly harness: HarnessStore;
  private readonly runner: ShadowBoundRunner;
  private readonly scheduler: EvolutionScheduler;
  private readonly running = new Map<string, ForegroundRun>();
  private readonly activeProposals = new Set<string>();
  private readonly activeWork = new Set<Promise<unknown>>();
  private readonly liveRequests = new Map<string, z.infer<typeof RunnerStartParamsSchema>>();
  private readonly liveWorkspaces = new Map<Promise<void>, () => void>();
  private mutations: Promise<unknown> = Promise.resolve();
  private config: AppConfig;

  constructor(peer: StdioPeer, private readonly options: SidecarServerOptions = {}) {
    const path = options.dbPath ?? ":memory:";
    this.settings = new SidecarSettings(path);
    try {
      const stored = this.settings.load();
      this.bridge = new StdioRustBridge(peer, options.reportError);
      this.registry = new ProviderRegistry(this.bridge, { fetch: options.fetch, pricing: this.bridge.pricing,
        resolvePricing: (modelId) => this.bridge.modelPricing(modelId) });
      for (const provider of stored.providers) this.registry.upsert(provider);
      this.config = stored.config;
      this.bindSlots(this.config);
      if (!options.trace) this.ownedTrace = new SqliteTraceStore(path);
      this.trace = options.trace ?? this.ownedTrace!;
      const llm = options.llm ?? new RoutedLlmClient(this.registry);
      this.harness = new InMemoryHarnessStore(this.bridge);
      const runner = new ForegroundTaskRunner({ bridge: this.bridge, llm, harness: this.harness, trace: this.trace });
      this.runner = new ShadowBoundRunner(runner, this.bridge);
      this.scheduler = new EvolutionScheduler({ bridge: this.bridge, llm, runner: this.runner, harnessStore: this.harness, traceStore: this.trace });
      this.bridge.onEvent = (event) => {
        if (event.type === "runner.started") this.running.get(event.threadId)?.started(event.runId);
        if (event.type === "runner.completed") {
          const active = this.running.get(event.threadId);
          if (active) {
            active.queued = event.queuedForEvolution && active.triggerEvolution;
            return { ...event, queuedForEvolution: active.queued };
          }
        }
        return event;
      };
      peer.handle((method, params) => this.track(this.dispatch(method, params)));
    } catch (error) { this.ownedTrace?.close(); this.settings.close(); throw error; }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.activeWork.add(work);
    const done = () => { this.activeWork.delete(work); };
    void work.then(done, done);
    return work;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.running.keys()].map((threadId) => this.runner.abort(threadId)));
    while (this.activeWork.size) await Promise.allSettled(this.activeWork);
    for (const release of this.liveWorkspaces.values()) release();
    await Promise.allSettled([...this.liveWorkspaces.keys()]);
    this.ownedTrace?.close();
    this.settings.close();
  }

  private bindSlots(config: AppConfig) {
    for (const slot of slots) {
      const binding = config.slots[slot];
      if (binding) this.registry.get(binding.providerId);
    }
    for (const slot of slots) {
      const binding = config.slots[slot];
      if (binding) this.registry.bind(slot, binding);
    }
  }

  private persist(): void { this.settings.save(this.config, this.registry.list()); }

  private mutate<T>(work: () => T | Promise<T>): Promise<T> {
    const pending = this.mutations.then(work);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  private async getThread(threadId: string): Promise<Thread> {
    const thread = await this.trace.getThread(threadId);
    if (!thread) throw invalid(`Unknown thread: ${threadId}`);
    return thread;
  }

  private async getProposal(id: string): Promise<EvolutionProposal> {
    const proposal = await this.trace.getProposal(id);
    if (!proposal) throw invalid(`Unknown proposal: ${id}`);
    return proposal;
  }

  private async checkCompatibility() {
    const commitSha = await this.harness.getHeadSha();
    return inspectHarnessCompatibility(await this.harness.readTreeAt(commitSha), { commitSha, appVersion });
  }

  private async proposalAction<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.activeProposals.has(id)) throw invalid("A proposal action is already running");
    this.activeProposals.add(id);
    try { return await action(); }
    finally { this.activeProposals.delete(id); }
  }

  private async createThread(input: z.infer<typeof threadCreate>): Promise<Thread> {
    const pinnedCommitSha = input.pinnedCommitSha ?? await this.bridge.gitHeadSha();
    const thread = ThreadSchema.parse({ ...input, id: crypto.randomUUID(), pinnedCommitSha,
      title: input.title ?? "New Command Thread", status: "idle", createdAt: now(), updatedAt: now() });
    await this.trace.upsertThread(thread);
    return thread;
  }

  private start(thread: Thread, input: z.infer<typeof RunnerStartParamsSchema>, queueEvolution = false): Promise<{ runId: string }> {
    if (this.running.has(thread.id)) throw invalid(`A run is already active for thread: ${thread.id}`);
    const id = new Promise<{ runId: string }>((resolve, reject) => {
      const active: ForegroundRun = { triggerEvolution: true, queued: queueEvolution, started: (runId) => resolve({ runId }) };
      this.running.set(thread.id, active);
      const run = this.runner.runTask({ threadId: thread.id, workspacePath: thread.workspacePath, prompt: input.prompt,
        mode: input.mode ?? thread.mode, pinnedCommitSha: thread.pinnedCommitSha, domain: thread.domain,
        modelOverride: input.modelOverride, providerIdOverride: input.providerIdOverride });
      this.track(run.then((result) => {
        this.running.delete(thread.id);
        resolve({ runId: result.runId });
        this.track(this.afterRun(thread, result, active.queued || queueEvolution && active.triggerEvolution)).catch(this.options.reportError ?? (() => {}));
      }, (error) => { this.running.delete(thread.id); reject(error); }));
    });
    return id;
  }

  private async afterRun(thread: Thread, result: TaskRunResult, queued: boolean): Promise<void> {
    if (queued && this.config.slots.improver && this.config.slots.judge) {
      this.track(this.scheduler.run({ threadId: thread.id, domain: thread.domain, triggerSource: result.hadHumanSteer ? "steer" :
        result.succeeded ? "onboarding" : "failure", mode: "parallel", k: 1 })).catch(this.options.reportError ?? (() => {}));
    }
    if (this.config.rsiMode === "auto") {
      const rollback = await this.bridge.recordHealth(thread.domain, thread.pinnedCommitSha, result.succeeded);
      if (rollback?.ok && rollback.newCommitSha) this.bridge.emitEvent({ type: "evolution.health_rollback", domain: thread.domain,
        fromSha: thread.pinnedCommitSha, toSha: rollback.newCommitSha, reason: "Domain health threshold reached", timestamp: now() });
    }
  }

  private async examplesDirectory(dataset: string): Promise<string> {
    const candidates = this.options.examplesDir ? [this.options.examplesDir] : [
      resolve(import.meta.dir, "../../../examples/first-run-challenge"),
      resolve("examples/first-run-challenge"), join(dirname(process.execPath), "examples", "first-run-challenge"),
    ];
    for (const candidate of candidates) {
      const path = resolve(candidate, dataset);
      try { await access(join(path, dataset === "dataset_a" ? "raw" : "inbox")); return path; }
      catch { /* Look in the remaining installation paths. */ }
    }
    throw invalid(`The live challenge data for ${dataset} is unavailable`);
  }

  private async startLive(input: z.infer<typeof liveChallenge>): Promise<Thread> {
    if (!this.options.llm) for (const slot of slots) this.registry.resolve(slot, slot === "solver" ? input.solverModelId : undefined);
    const first = input.dataset === "dataset_a";
    const source = await this.examplesDirectory(input.dataset);
    const prompt = first ? "Reconcile all invoice CSVs under raw/. Detect GB18030 or UTF-8 with a BOM, skip preambles and VOID rows, " +
      "parse accounting negatives, and convert USD to CNY at 7.20. Write output/billing_cleaned.csv and output/billing_summary.json." :
      "Reconcile notes and receipts under inbox/. Include approved petty cash, exclude cancellations, sort by ID, convert USD to CNY at 7.20, " +
      "and write output/reconciled_expenses.json and output/reconciled_expenses.csv.";
    const paths = (await Promise.all((first ? ["raw"] : ["inbox/notes", "inbox/receipts"]).map(async (folder) =>
      (await readdir(join(source, folder), { withFileTypes: true })).filter((file) => file.isFile())
        .map((file) => `${folder}/${file.name}`)))).flat();
    return new Promise<Thread>((ready, reject) => {
      let release!: () => void;
      const held = new Promise<void>((end) => { release = end; });
      const work = withShadowWorkspace({ workspacePath: source, touchedFiles: paths }, async (workspacePath) => {
        const thread = await this.createThread({ workspacePath, title: `Live Challenge (${input.dataset})`, mode: "craft",
          domain: "file_ops", pinnedCommitSha: input.pinnedCommitSha });
        this.liveRequests.set(thread.id, { threadId: thread.id, prompt, modelOverride: input.solverModelId });
        ready(thread);
        await held;
      });
      this.liveWorkspaces.set(work, release);
      void work.then(() => { this.liveWorkspaces.delete(work); }, (error) => { this.liveWorkspaces.delete(work); reject(error); });
    });
  }

  private async getReplay() {
    for (const file of [this.options.replayPath, this.options.examplesDir && join(this.options.examplesDir, "recorded_replay.json"),
      resolve("examples/first-run-challenge/recorded_replay.json")]) {
      if (!file) continue;
      try { return OnboardingReplayTraceSchema.parse(await Bun.file(file).json()); }
      catch { /* The compiled binary includes the recorded trace. */ }
    }
    return OnboardingReplayTraceSchema.parse(replay);
  }

  private async compare(input: z.infer<typeof ReplayCompareParamsSchema>): Promise<ReplayComparison> {
    const modelId = input.modelId ?? this.config.slots.solver?.modelId;
    if (!modelId) throw invalid("Configure the solver slot or supply a replay model");
    const touchedFiles = new Set<string>();
    for (const thread of await this.trace.listThreads()) {
      if (thread.workspacePath !== input.workspacePath) continue;
      const matching = (await this.trace.listTraceRunsByThread(thread.id)).filter((run) => run.prompt === input.taskPrompt).at(-1);
      if (!matching) continue;
      for (const file of matching.touchedFiles) touchedFiles.add(file);
      for (const message of await this.trace.listMessages(thread.id)) {
        if (message.createdAt < matching.createdAt) continue;
        for (const call of message.toolCalls ?? []) {
          if (call.name === "read_file" && call.status === "completed" && typeof call.args.path === "string") touchedFiles.add(call.args.path);
        }
      }
      break;
    }
    const id = crypto.randomUUID();
    const run = async (sha: string) => {
      const result = await probeTask(this.runner, this.bridge, { threadId: id, workspacePath: input.workspacePath,
        pinnedCommitSha: sha, prompt: input.taskPrompt, mode: "craft", domain: "replay", modelOverride: modelId }, { touchedFiles: [...touchedFiles] });
      if (!result.run) throw invalid(result.degradedReason);
      return result.run;
    };
    const v0 = await run(input.v0Sha), vN = await run(input.vNSha);
    return { id, taskPrompt: input.taskPrompt, v0Sha: input.v0Sha, vNSha: input.vNSha, modelId, v0Metrics: v0.metrics,
      vNMetrics: vN.metrics, v0Output: v0.finalOutput || v0.error || "", vNOutput: vN.finalOutput || vN.error || "",
      status: v0.succeeded && vN.succeeded ? "completed" : "failed" };
  }

  private importProviders(result: ProviderImportResult): ProviderImportResult {
    const importedProviders = result.importedProviders.map((provider) => {
      const existing = this.registry.list().find(({ id }) => provider.id === id);
      return this.registry.upsert({ ...provider, keys: existing?.keys, keyStrategy: existing?.keyStrategy,
        pinnedModels: existing?.pinnedModels ?? provider.pinnedModels,
        hasApiKey: provider.hasApiKey || existing?.hasApiKey === true, enabled: existing?.enabled ?? provider.enabled,
      });
    });
    if (importedProviders.length) this.persist();
    return { ...result, importedProviders, fallbackToManual: !importedProviders.some((provider) => provider.enabled) };
  }

  async dispatch(method: string, params: unknown = {}): Promise<unknown> {
    try {
      switch (method) {
        case "system.heartbeat": return { ok: true };
        case "config.get": return structuredClone(this.config);
        case "config.set_rsi_mode":
        case "config.update": return await this.mutate(() => {
          const patch = method === "config.set_rsi_mode" ? z.object({ rsiMode: RsiModeSchema }).parse(params) : configPatch.parse(params);
          const next = AppConfigSchema.parse({ ...this.config, ...patch, slots: { ...this.config.slots, ...("slots" in patch ? patch.slots : undefined) } });
          this.bindSlots(next);
          this.config = next;
          this.persist();
          return structuredClone(this.config);
        });
        case "onboarding.get_replay": return await this.getReplay();
        case "onboarding.start_live_challenge": return await this.startLive(liveChallenge.parse(params));
        case "onboarding.activate_live_challenge": {
          // The tray binds the prepared thread's workspace and snapshot before activation.
          const { threadId } = RunnerControlParamsSchema.parse(params);
          const input = this.liveRequests.get(threadId);
          if (!input) throw invalid("The live challenge is not awaiting activation");
          const thread = await this.getThread(threadId);
          await this.start(thread, input, true);
          this.liveRequests.delete(threadId);
          return this.getThread(threadId);
        }
        case "thread.list": return await this.trace.listThreads();
        case "thread.messages": return await this.trace.listMessages(RunnerControlParamsSchema.parse(params).threadId);
        case "thread.create": return await this.createThread(threadCreate.parse(params));
        case "runner.start": {
          const input = RunnerStartParamsSchema.parse(params);
          return await this.start(await this.getThread(input.threadId), input);
        }
        case "runner.pause": return await this.runner.pause(RunnerControlParamsSchema.parse(params).threadId);
        case "runner.resume": return await this.runner.resume(RunnerControlParamsSchema.parse(params).threadId);
        case "runner.abort": {
          const { threadId } = RunnerControlParamsSchema.parse(params);
          const running = this.running.get(threadId);
          if (running) running.triggerEvolution = false;
          return await this.runner.abort(threadId);
        }
        case "runner.steer": {
          const { threadId, instruction, triggerEvolutionOnFinish } = RunnerSteerParamsSchema.parse(params);
          await this.runner.steer(threadId, instruction);
          const active = this.running.get(threadId);
          if (active) active.triggerEvolution = triggerEvolutionOnFinish;
          return;
        }
        case "sidechat.ask": {
          const { threadId, question } = SideChatAskParamsSchema.parse(params);
          return await this.runner.askSideChat(threadId, question);
        }
        case "evolution.triage_list": return await this.trace.listProposals();
        case "evolution.silent_archive_count": return (await this.trace.listProposals(true)).filter(({ status }) => status === "archived_no_entry").length;
        case "evolution.check_compatibility": return await this.checkCompatibility();
        case "evolution.start_migration": {
          const { report, threadId, workspacePath } = migrationStart.parse(params);
          return await this.scheduler.triggerMigration({ report: report ?? await this.checkCompatibility(), threadId, workspacePath });
        }
        case "evolution.trigger": return (await this.scheduler.run(EvolutionTriggerParamsSchema.parse(params))).proposal;
        case "evolution.revise_with_comments": {
          const { proposalId, comments } = EvolutionReviseParamsSchema.parse(params);
          return await this.proposalAction(proposalId, () => this.scheduler.reviseWithInlineComments(proposalId, comments));
        }
        case "evolution.adopt": {
          const { proposalId, trustHighPrivilegeAssets } = EvolutionProposalActionParamsSchema.parse(params);
          return await this.proposalAction(proposalId, async () => {
            const proposal = await this.getProposal(proposalId);
            const result = await this.bridge.withPatchContext({ threadId: proposal.threadId, sourceTags: proposal.sourceTags },
              () => this.scheduler.acceptProposal(proposalId, trustHighPrivilegeAssets));
            if (!result.ok && !result.conflict) throw new RpcFailure(RpcErrorCode.InternalError, result.error ?? "Harness commit failed");
            const newCommit = result.newCommitSha ? (await this.bridge.gitLog(50)).find(({ sha }) => sha === result.newCommitSha) : undefined;
            return { proposal: await this.getProposal(proposalId), newCommit };
          });
        }
        case "evolution.reject": {
          const { proposalId } = EvolutionProposalActionParamsSchema.parse(params);
          return await this.proposalAction(proposalId, async () => {
            const proposal = await this.getProposal(proposalId);
            if (proposal.status !== "ready" && proposal.status !== "needs_reprobe") throw invalid(`Cannot reject a ${proposal.status} proposal`);
            const rejected: EvolutionProposal = { ...proposal, status: "rejected", updatedAt: now() };
            await this.trace.saveProposal(rejected);
            return rejected;
          });
        }
        case "replay.compare": return await this.compare(ReplayCompareParamsSchema.parse(params));
        case "budget.sync_pricing": return this.bridge.syncPricing(PricingSyncParamsSchema.parse(params ?? {}));
        case "provider.list": return this.registry.list();
        case "provider.catalog": return this.registry.buildAggregatedCatalog();
        case "provider.save": return await this.mutate(async () => {
          const saved = await saveProviderWithKeys(SaveProviderSchema.parse(params), this.registry, this.bridge);
          this.persist();
          return saved;
        });
        case "provider.delete": return await this.mutate(async () => {
          const { providerId: id } = providerId.parse(params);
          const provider = this.registry.get(id);
          for (const ref of new Set([provider.keyringRef, ...(provider.keys ?? []).map(({ keyringRef }) => keyringRef)])) {
            await this.bridge.keyringDelete(ref);
          }
          this.registry.remove(id);
          this.config = { ...this.config, slots: this.registry.getBindings() };
          this.persist();
        });
        case "provider.ping": return await this.mutate(async () => {
          const { providerId: id } = providerId.parse(params);
          const { ok, latencyMs } = await this.registry.ping(id);
          if (ok) this.persist();
          return { providerId: id, ok, latencyMs };
        });
        case "provider.fetch_models": return await this.mutate(async () => {
          const { providerId: id } = providerId.parse(params);
          const { models, pricing } = await this.registry.listModelCatalog(id);
          await this.bridge.mergePricing(pricing);
          this.registry.upsert({ ...this.registry.get(id), models });
          this.persist();
          return models;
        });
        case "provider.import_cc_switch": return await this.mutate(async () => this.importProviders(await importCcSwitch({
          dbPath: this.options.ccSwitchDbPath, keyringPut: (key, secret) => this.bridge.keyringSet(key, secret),
        })));
        case "provider.import_magpie": return await this.mutate(async () => {
          const { gatewayUrl, importLink } = magpieOptions.parse(params);
          const { modelPricing, ...result } = await importMagpie({ baseUrl: gatewayUrl, importLink, configPath: this.options.magpieConfigPath,
            fetch: this.options.fetch, keyringPut: (key, secret) => this.bridge.keyringSet(key, secret) });
          if (modelPricing) await this.bridge.mergePricing(modelPricing);
          return this.importProviders(result);
        });
        default: throw new RpcFailure(RpcErrorCode.MethodNotFound, "RPC method unavailable");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError" && "issues" in error && Array.isArray(error.issues)) {
        const issues = error.issues as z.ZodError["issues"];
        throw invalid(issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; "));
      }
      throw error;
    }
  }
}
