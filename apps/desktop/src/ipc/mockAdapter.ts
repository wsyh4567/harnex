import type {
  AggregatedModelEntry,
  AppConfig,
  ApprovalRequest,
  ApprovalResolveParams,
  BudgetStatus,
  ChatMessage,
  EvolutionArchitectAskParams,
  EvolutionArchitectAskResult,
  EvolutionProposal,
  EvolutionProposalActionParams,
  EvolutionReviseParams,
  EvolutionStage,
  EvolutionTriggerParams,
  ExecPolicyRule,
  ExportScanResult,
  GardenerFinding,
  GenomeCommit,
  GenomeFile,
  GlobalHookItem,
  GuardianDecision,
  HarnessCompatibilityReport,
  HarnessGardenerReport,
  MessageAttachmentMeta,
  OnboardingReplayTrace,
  PricingSyncParams,
  PricingSyncResult,
  ProviderConfig,
  ProviderImportResult,
  ReplayCompareParams,
  ReplayComparison,
  RsiMode,
  RunnerControlParams,
  RunnerStartParams,
  RunnerSteerParams,
  SideChatAskParams,
  SideChatAskResult,
  SystemHealth,
  Thread,
  ThreadCreateParams,
  ThreadDeleteParams,
  ThreadRenameParams,
  TrustRecord,
  TrustStatus,
  UpdateStatus,
} from "@harnex/protocol";
import {
  buildAggregatedModelCatalog,
  maskApiKey,
} from "../features/providers/modelCatalog.ts";
import {
  createInitialAppConfig,
  createInitialApprovals,
  createInitialBudgetStatus,
  createInitialCommits,
  createInitialExecPolicy,
  createInitialGenomeTree,
  createInitialGlobalHooks,
  createInitialGuardianDecisions,
  createInitialMessages,
  createInitialProposals,
  createInitialProviders,
  createInitialSystemHealth,
  createInitialThreads,
  createInitialTrustRecords,
  createOnboardingReplayTrace,
} from "./mockData.ts";
import type {
  HarnexIpcClient,
  HarnexIpcEvent,
  LiveChallengeParams,
  MagpieImportParams,
  OrganToggleResult,
  PingProviderResult,
  SaveHookParams,
  SaveProviderParams,
  StagedImportPreview,
  UpdateBudgetSettingsParams,
} from "./types.ts";

export interface MockAdapterOptions {
  simulationDelayMs?: number;
  pickedDirectoryFixture?: string | null;
}

export class MockIpcAdapter implements HarnexIpcClient {
  public readonly mode = "mock" as const;
  private readonly delayMs: number;
  private readonly listeners = new Set<(event: HarnexIpcEvent) => void>();

  private systemHealth: SystemHealth = createInitialSystemHealth();
  private appConfig: AppConfig = createInitialAppConfig();
  private threads: Thread[] = createInitialThreads();
  private messagesByThread: Record<string, ChatMessage[]> = createInitialMessages();
  private approvals: ApprovalRequest[] = createInitialApprovals();
  private execPolicy: ExecPolicyRule[] = createInitialExecPolicy();
  private trustRecords: TrustRecord[] = createInitialTrustRecords();
  private globalHooks: GlobalHookItem[] = createInitialGlobalHooks();
  private guardianDecisions: GuardianDecision[] = createInitialGuardianDecisions();
  private proposals: EvolutionProposal[] = createInitialProposals();
  private silentArchiveCount = 3;
  private commits: GenomeCommit[] = createInitialCommits();
  private genomeTrees: Record<string, GenomeFile[]> = createInitialGenomeTree();
  private providers: ProviderConfig[] = createInitialProviders();
  private budgetStatus: BudgetStatus = createInitialBudgetStatus();
  private readonly onboardingReplay: OnboardingReplayTrace = createOnboardingReplayTrace();
  private updateStatus: UpdateStatus = {
    phase: "idle",
    info: {
      currentVersion: "0.1.0",
      compatLevel: "safe",
    },
    downloadedBytes: 0,
    totalBytes: 0,
    verifiedSha256: false,
  };
  private compatibilityReport: HarnessCompatibilityReport = {
    checkedAt: new Date().toISOString(),
    appVersion: "0.1.0",
    expectedSchemaVersion: 1,
    harnessSchemaVersion: 1,
    commitSha: "a7f3c91e48d2b06f1c529a8d4039281726354407",
    hasBreakingIssues: false,
    needsMigration: false,
    quarantinedPaths: [],
    issues: [],
  };

  public readonly recordedRunStarts: RunnerStartParams[] = [];
  public readonly recordedEvolutionTriggers: EvolutionTriggerParams[] = [];
  private readonly pausedThreads = new Set<string>();
  private readonly abortedThreads = new Set<string>();
  private readonly steeredInstructions = new Map<string, string[]>();
  private pickedDirectoryFixture: string | null;

  constructor(options: MockAdapterOptions = {}) {
    this.delayMs = options.simulationDelayMs ?? 60;
    this.pickedDirectoryFixture = options.pickedDirectoryFixture ?? null;
  }

  setPickedDirectoryFixture(path: string | null): void {
    this.pickedDirectoryFixture = path;
  }

  private emit(event: HarnexIpcEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async sleep(ms = this.delayMs): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private nextSha(seedNum: number): string {
    return `${seedNum.toString(16).padStart(8, "0")}a7f3c91e48d2b06f1c529a8d40392817`;
  }

  subscribe(listener: (event: HarnexIpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getSystemHealth(): Promise<SystemHealth> {
    return { ...this.systemHealth };
  }

  async getAppConfig(): Promise<AppConfig> {
    return { ...this.appConfig, slots: { ...this.appConfig.slots } };
  }

  async updateAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    this.appConfig = {
      ...this.appConfig,
      ...patch,
      slots: patch.slots ? { ...this.appConfig.slots, ...patch.slots } : this.appConfig.slots,
    };
    this.systemHealth.rsiMode = this.appConfig.rsiMode;
    return this.getAppConfig();
  }

  async setRsiMode(mode: RsiMode): Promise<AppConfig> {
    return this.updateAppConfig({ rsiMode: mode });
  }

  async pickWorkspaceDirectory(_initialDir?: string): Promise<string | null> {
    return this.pickedDirectoryFixture;
  }

  async getOnboardingReplay(): Promise<OnboardingReplayTrace> {
    return this.onboardingReplay;
  }

  async startLiveChallenge(params: LiveChallengeParams): Promise<Thread> {
    const prompt =
      params.dataset === "dataset_a"
        ? "Run First-Run Crucible Dataset A: Decode GBK/GB18030 invoice CSVs in ~/Work/crucible_a and export UTF-8 summary."
        : "Run First-Run Crucible Dataset B: Triage mixed encoding server logs in ~/Work/crucible_b and extract anomaly report.";
    const thread = await this.createThread({
      workspacePath: "~/Work",
      title: `Crucible Live (${params.dataset})`,
      mode: "craft",
      domain: params.dataset === "dataset_a" ? "file_ops" : "diagnostics",
    });
    void this.startRun({
      threadId: thread.id,
      prompt,
      mode: "craft",
      modelOverride: params.solverModelId,
    });
    return thread;
  }

  async listThreads(): Promise<Thread[]> {
    return this.threads.map((t) => ({ ...t, goals: t.goals.map((g) => ({ ...g })) }));
  }

  async getThreadMessages(threadId: string): Promise<ChatMessage[]> {
    return (this.messagesByThread[threadId] ?? []).map((m) => ({ ...m }));
  }

  async createThread(params: ThreadCreateParams): Promise<Thread> {
    const headCommit = this.commits[0];
    const now = new Date().toISOString();
    const id = `thr-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const thread: Thread = {
      id,
      workspacePath: params.workspacePath,
      title: params.title ?? "New Command Thread",
      mode: params.mode ?? "craft",
      status: "idle",
      pinnedCommitSha: headCommit?.sha ?? this.systemHealth.activeCommitSha,
      pinnedVersionLabel: headCommit?.versionTag ?? "v7",
      domain: params.domain ?? "general",
      goals: [],
      contextUsedTokens: 0,
      contextMaxTokens: 128_000,
      sourceTags: ["local"],
      hadHumanSteer: false,
      createdAt: now,
      updatedAt: now,
    };
    this.threads = [thread, ...this.threads];
    this.messagesByThread[id] = [];
    return { ...thread };
  }

  async renameThread(params: ThreadRenameParams): Promise<Thread> {
    const title = params.title.trim();
    if (!title) {
      throw new Error("Thread title cannot be empty");
    }
    const existing = this.threads.find((t) => t.id === params.threadId);
    if (!existing) {
      throw new Error(`Thread not found: ${params.threadId}`);
    }
    const updated: Thread = {
      ...existing,
      title,
      updatedAt: new Date().toISOString(),
    };
    this.threads = this.threads.map((t) => (t.id === params.threadId ? updated : t));
    return { ...updated, goals: updated.goals.map((g) => ({ ...g })) };
  }

  async deleteThread(params: ThreadDeleteParams): Promise<void> {
    const existing = this.threads.find((t) => t.id === params.threadId);
    if (!existing) {
      throw new Error(`Thread not found: ${params.threadId}`);
    }
    if (existing.status === "running") {
      throw new Error(`A run is active for thread: ${params.threadId}`);
    }
    this.threads = this.threads.filter((t) => t.id !== params.threadId);
    delete this.messagesByThread[params.threadId];
    this.pausedThreads.delete(params.threadId);
    this.abortedThreads.delete(params.threadId);
    this.steeredInstructions.delete(params.threadId);
  }

  async startRun(params: RunnerStartParams): Promise<{ runId: string }> {
    this.recordedRunStarts.push(params);
    const thread = this.threads.find((t) => t.id === params.threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${params.threadId}`);
    }
    const runId = `run-${Date.now()}`;
    const now = new Date().toISOString();
    this.abortedThreads.delete(thread.id);
    this.pausedThreads.delete(thread.id);

    thread.status = "running";
    thread.mode = params.mode ?? thread.mode;
    thread.updatedAt = now;
    thread.goals = [
      { id: "g-step-1", title: "Inspect workspace inputs", status: "in_progress" },
      { id: "g-step-2", title: "Execute sandboxed transformation", status: "pending" },
      { id: "g-step-3", title: "Verify output & summarize", status: "pending" },
    ];

    const attachmentsMeta: MessageAttachmentMeta[] | undefined =
      params.attachments && params.attachments.length > 0
        ? params.attachments.map(({ id, name, mimeType, sizeBytes, width, height }) => ({
            id,
            name,
            mimeType,
            sizeBytes,
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
          }))
        : undefined;

    const userMsg: ChatMessage = {
      id: `msg-u-${Date.now()}`,
      threadId: thread.id,
      role: "user",
      content: params.prompt,
      ...(attachmentsMeta ? { attachments: attachmentsMeta } : {}),
      createdAt: now,
    };
    this.messagesByThread[thread.id] = [...(this.messagesByThread[thread.id] ?? []), userMsg];

    this.emit({
      type: "runner.started",
      threadId: thread.id,
      runId,
      pinnedCommitSha: thread.pinnedCommitSha,
      timestamp: now,
    });
    this.emit({
      type: "runner.goal_updated",
      threadId: thread.id,
      goals: thread.goals,
    });

    void this.simulateRunExecution(
      thread,
      runId,
      params.prompt,
      params.providerIdOverride,
      params.modelOverride,
    );
    return { runId };
  }

  private async simulateRunExecution(
    thread: Thread,
    runId: string,
    prompt: string,
    providerIdOverride?: string,
    modelOverride?: string,
  ): Promise<void> {
    await this.sleep();
    if (this.abortedThreads.has(thread.id)) return;

    const routedLabel = modelOverride
      ? `Model override: ${providerIdOverride ? `${providerIdOverride} · ` : ""}${modelOverride}. `
      : "";
    this.emit({
      type: "runner.token",
      threadId: thread.id,
      runId,
      channel: "reasoning",
      delta: `${routedLabel}Pinned to ${thread.pinnedVersionLabel ?? "v7"} (${thread.pinnedCommitSha.slice(0, 7)}). Planning sandboxed steps for: ${prompt}`,
    });

    await this.sleep();
    while (this.pausedThreads.has(thread.id)) {
      if (this.abortedThreads.has(thread.id)) return;
      await this.sleep(40);
    }
    if (this.abortedThreads.has(thread.id)) return;

    const toolCallId = `tc-${Date.now()}`;
    const requiresSandboxEscape = /outside|\/etc|desktop/i.test(prompt);

    this.emit({
      type: "runner.tool_call",
      threadId: thread.id,
      runId,
      toolCall: {
        id: toolCallId,
        name: requiresSandboxEscape ? "fs_ops.write_file" : "shell.exec",
        args: requiresSandboxEscape
          ? { targetPath: "~/Desktop/harnex_export.csv", bytes: 1420 }
          : { command: "bun run scripts/safe_gbk_parse.ts" },
        status: requiresSandboxEscape ? "awaiting_approval" : "running",
        truncated: false,
        startedAt: new Date().toISOString(),
      },
    });

    if (requiresSandboxEscape) {
      const apr: ApprovalRequest = {
        requestId: `apr-${Date.now()}`,
        threadId: thread.id,
        kind: "sandbox_escape",
        summary: "Write outside bound workspace: ~/Desktop/harnex_export.csv",
        detail: "Rust L0 Sandbox blocked direct write outside workspace boundary. Choose Allow Once or Deny.",
        commandOrPath: "~/Desktop/harnex_export.csv",
        riskLevel: "medium",
        sourceTags: thread.sourceTags,
        createdAt: new Date().toISOString(),
      };
      this.approvals = [apr, ...this.approvals];
      thread.status = "awaiting_approval";
      this.emit({ type: "security.approval_required", request: apr });
      return;
    }

    await this.sleep();
    if (this.abortedThreads.has(thread.id)) return;

    this.emit({
      type: "runner.tool_result",
      threadId: thread.id,
      runId,
      toolCallId,
      output: "Processed 12 files cleanly inside L0 workspace-write sandbox (0 decode errors).",
      truncated: false,
    });

    thread.goals = [
      { id: "g-step-1", title: "Inspect workspace inputs", status: "completed" },
      { id: "g-step-2", title: "Execute sandboxed transformation", status: "completed" },
      { id: "g-step-3", title: "Verify output & summarize", status: "completed" },
    ];
    this.emit({
      type: "runner.goal_updated",
      threadId: thread.id,
      goals: thread.goals,
    });

    const steerNotes = this.steeredInstructions.get(thread.id) ?? [];
    const finalOutput =
      steerNotes.length > 0
        ? `Completed run with human steer applied ("${steerNotes[steerNotes.length - 1]}"). Queued trace for Harness² background evolution.`
        : `Completed task cleanly under Genome ${thread.pinnedVersionLabel ?? "v7"} inside OS sandbox.`;

    this.emit({
      type: "runner.token",
      threadId: thread.id,
      runId,
      channel: "content",
      delta: finalOutput,
    });

    thread.contextUsedTokens = Math.min(thread.contextMaxTokens, thread.contextUsedTokens + 3_240);
    this.emit({
      type: "runner.context_usage",
      threadId: thread.id,
      usedTokens: thread.contextUsedTokens,
      maxTokens: thread.contextMaxTokens,
      compressed: false,
    });

    const usage = {
      inputTokens: 2_180,
      outputTokens: 640,
      cachedInputTokens: 920,
      reasoningTokens: 310,
      costUsd: 0.014,
    };
    this.budgetStatus.spentTodayUsd = Number((this.budgetStatus.spentTodayUsd + usage.costUsd).toFixed(4));
    this.budgetStatus.tokensToday += usage.inputTokens + usage.outputTokens;

    thread.status = "completed";
    thread.updatedAt = new Date().toISOString();

    const assistantMsg: ChatMessage = {
      id: `msg-a-${Date.now()}`,
      threadId: thread.id,
      role: "assistant",
      content: finalOutput,
      reasoning: `Pinned to ${thread.pinnedCommitSha.slice(0, 7)}. Executed safely via Rust L0 executor.`,
      toolCalls: [
        {
          id: toolCallId,
          name: "shell.exec",
          args: { command: "bun run scripts/safe_gbk_parse.ts" },
          status: "completed",
          output: "Processed 12 files cleanly inside L0 workspace-write sandbox.",
          truncated: false,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    };
    this.messagesByThread[thread.id] = [...(this.messagesByThread[thread.id] ?? []), assistantMsg];

    this.emit({
      type: "runner.completed",
      threadId: thread.id,
      runId,
      finalOutput,
      usage,
      queuedForEvolution: thread.hadHumanSteer,
    });
  }

  async pauseRun(params: RunnerControlParams): Promise<void> {
    this.pausedThreads.add(params.threadId);
    const thread = this.threads.find((t) => t.id === params.threadId);
    if (thread) {
      thread.status = "paused";
      thread.updatedAt = new Date().toISOString();
    }
    this.emit({
      type: "runner.paused",
      threadId: params.threadId,
      reason: "Operator initiated Pause & Steer",
    });
  }

  async steerRun(params: RunnerSteerParams): Promise<void> {
    const list = this.steeredInstructions.get(params.threadId) ?? [];
    list.push(params.instruction);
    this.steeredInstructions.set(params.threadId, list);

    const thread = this.threads.find((t) => t.id === params.threadId);
    if (thread) {
      thread.hadHumanSteer = true;
      thread.updatedAt = new Date().toISOString();
    }

    const steerMsg: ChatMessage = {
      id: `msg-steer-${Date.now()}`,
      threadId: params.threadId,
      role: "steer",
      content: params.instruction,
      createdAt: new Date().toISOString(),
    };
    this.messagesByThread[params.threadId] = [...(this.messagesByThread[params.threadId] ?? []), steerMsg];

    this.emit({
      type: "runner.steered",
      threadId: params.threadId,
      instruction: params.instruction,
      markedForEvolution: params.triggerEvolutionOnFinish,
    });
  }

  async resumeRun(params: RunnerControlParams): Promise<void> {
    this.pausedThreads.delete(params.threadId);
    const thread = this.threads.find((t) => t.id === params.threadId);
    if (thread) {
      thread.status = "running";
      thread.updatedAt = new Date().toISOString();
      // If thread wasn't actively inside simulateRunExecution loop, finalize cleanly
      const runId = `run-resume-${Date.now()}`;
      void this.simulateRunExecution(thread, runId, "Resumed execution after human steer");
    }
  }

  async abortRun(params: RunnerControlParams): Promise<void> {
    this.pausedThreads.delete(params.threadId);
    this.abortedThreads.add(params.threadId);
    const thread = this.threads.find((t) => t.id === params.threadId);
    if (thread) {
      thread.status = "aborted";
      thread.updatedAt = new Date().toISOString();
    }
  }

  async askSideChat(params: SideChatAskParams): Promise<SideChatAskResult> {
    await this.sleep();
    const thread = this.threads.find((t) => t.id === params.threadId);
    const sha = thread?.pinnedCommitSha.slice(0, 7) ?? "a7f3c91";
    return {
      answer: `[Isolated Side Chat · Pinned ${sha}] For "${params.question}": This inquiry is zero-pollution and excluded from main trace & Harness² training context. The current thread uses ${thread?.mode ?? "craft"} mode with ${thread?.sourceTags.join(", ") ?? "local"} provenance.`,
      usage: {
        inputTokens: 140,
        outputTokens: 58,
        cachedInputTokens: 60,
        reasoningTokens: 0,
        costUsd: 0.0004,
      },
      isolatedFromMainTrace: true,
    };
  }

  async listPendingApprovals(): Promise<ApprovalRequest[]> {
    return this.approvals.map((a) => ({ ...a }));
  }

  async resolveApproval(params: ApprovalResolveParams): Promise<void> {
    const req = this.approvals.find((a) => a.requestId === params.requestId);
    this.approvals = this.approvals.filter((a) => a.requestId !== params.requestId);

    if (req) {
      if (req.kind === "hook_trust" && params.decision !== "deny") {
        const existing = this.trustRecords.find((r) => r.identifier === req.commandOrPath);
        if (existing) {
          existing.status = "trusted";
          existing.sha256 = req.sha256 ?? existing.sha256;
          existing.updatedAt = new Date().toISOString();
        } else {
          this.trustRecords.unshift({
            id: `tr-${Date.now()}`,
            kind: "hook",
            identifier: req.commandOrPath,
            sha256: req.sha256,
            status: "trusted",
            origin: "rsi_evolved",
            updatedAt: new Date().toISOString(),
          });
        }
        this.globalHooks = this.globalHooks.map((h) =>
          h.path === req.commandOrPath
            ? {
                ...h,
                status: "trusted",
                sha256: req.sha256 ?? h.sha256,
                updatedAt: new Date().toISOString(),
              }
            : h,
        );
      }

      const thread = this.threads.find((t) => t.id === req.threadId);
      if (thread) {
        const hasMoreForThread = this.approvals.some((a) => a.threadId === thread.id);
        if (!hasMoreForThread && thread.status === "awaiting_approval") {
          thread.status = params.decision === "deny" ? "failed" : "completed";
          thread.updatedAt = new Date().toISOString();
        }
      }

      this.guardianDecisions = [
        {
          requestId: req.requestId,
          threadId: req.threadId,
          decision: params.decision === "deny" ? "deny" : "allow",
          riskLevel: req.riskLevel,
          reason: `Operator resolved ${req.kind} with "${params.decision}".`,
          commandOrPath: req.commandOrPath,
          modelId: "operator-override",
          sanitizedInputOnly: true,
          timestamp: new Date().toISOString(),
        },
        ...this.guardianDecisions,
      ];
    }

    this.emit({
      type: "security.approval_resolved",
      requestId: params.requestId,
      decision: params.decision,
    });
  }

  async listExecPolicyRules(): Promise<ExecPolicyRule[]> {
    return this.execPolicy.map((r) => ({ ...r }));
  }

  async upsertExecPolicyRule(rule: ExecPolicyRule): Promise<ExecPolicyRule[]> {
    const idx = this.execPolicy.findIndex((r) => r.id === rule.id);
    if (idx >= 0) {
      this.execPolicy[idx] = { ...rule };
    } else {
      this.execPolicy = [rule, ...this.execPolicy];
    }
    return this.listExecPolicyRules();
  }

  async deleteExecPolicyRule(ruleId: string): Promise<ExecPolicyRule[]> {
    this.execPolicy = this.execPolicy.filter((r) => r.id !== ruleId);
    return this.listExecPolicyRules();
  }

  async listTrustRecords(): Promise<TrustRecord[]> {
    return this.trustRecords.map((r) => ({ ...r }));
  }

  async updateTrustStatus(id: string, status: TrustStatus): Promise<TrustRecord[]> {
    const now = new Date().toISOString();
    let updatedIdentifier: string | null = null;
    this.trustRecords = this.trustRecords.map((r) => {
      if (r.id !== id) return r;
      if (r.kind === "hook") {
        updatedIdentifier = r.identifier;
      }
      return { ...r, status, updatedAt: now };
    });
    if (updatedIdentifier) {
      this.globalHooks = this.globalHooks.map((h) =>
        h.path === updatedIdentifier ? { ...h, status, updatedAt: now } : h,
      );
    }
    return this.listTrustRecords();
  }

  private extractHookName(path: string): string {
    const normalized = path.trim();
    if (
      !normalized.startsWith("hooks/") ||
      !normalized.endsWith(".ts") ||
      normalized.includes("..") ||
      normalized.includes("\\")
    ) {
      throw new Error("Expected a TypeScript file directly under hooks/ (e.g. hooks/my_guard.ts)");
    }
    const name = normalized.slice("hooks/".length, -".ts".length);
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error("Hook filename must contain only alphanumeric, '_', '-', or '.' characters");
    }
    return name;
  }

  private computeHookSha256(content: string): string {
    // Deterministic 64-char hex digest for browser & Bun mock mode without node:crypto.
    const words = new Uint32Array(8);
    words[0] = 0x6a09e667;
    words[1] = 0xbb67ae85;
    words[2] = 0x3c6ef372;
    words[3] = 0xa54ff53a;
    words[4] = 0x510e527f;
    words[5] = 0x9b05688c;
    words[6] = 0x1f83d9ab;
    words[7] = 0x5be0cd19;
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      const lane = i % 8;
      words[lane] = Math.imul((words[lane] ?? 0) ^ (code + i * 31), 0x01000193) >>> 0;
      words[(lane + 3) % 8] =
        (((words[(lane + 3) % 8] ?? 0) << 5) | ((words[(lane + 3) % 8] ?? 0) >>> 27)) ^
        (words[lane] ?? 0);
    }
    return Array.from(words, (w) => (w >>> 0).toString(16).padStart(8, "0")).join("");
  }

  async listHooks(): Promise<GlobalHookItem[]> {
    return this.globalHooks.map((h) => ({ ...h }));
  }

  async saveHook(params: SaveHookParams): Promise<GlobalHookItem> {
    const path = params.path.trim();
    const name = this.extractHookName(path);
    const existing = this.globalHooks.find((h) => h.path === path);
    const sha256 =
      existing && existing.content === params.content
        ? existing.sha256
        : this.computeHookSha256(params.content);
    const status: TrustStatus = params.trustImmediately ? "trusted" : "untrusted";
    const now = new Date().toISOString();

    const saved: GlobalHookItem = {
      path,
      name,
      event: params.event,
      content: params.content,
      sha256,
      status,
      origin: existing?.origin ?? "user_installed",
      updatedAt: now,
    };

    if (existing) {
      this.globalHooks = this.globalHooks.map((h) => (h.path === path ? saved : h));
    } else {
      this.globalHooks = [saved, ...this.globalHooks];
    }

    const existingTrust = this.trustRecords.find(
      (r) => r.kind === "hook" && r.identifier === path,
    );
    if (existingTrust) {
      existingTrust.status = status;
      existingTrust.sha256 = sha256;
      existingTrust.updatedAt = now;
    } else {
      this.trustRecords = [
        {
          id: `tr-hook-${Date.now()}`,
          kind: "hook",
          identifier: path,
          sha256,
          status,
          origin: saved.origin,
          updatedAt: now,
        },
        ...this.trustRecords,
      ];
    }

    if (params.trustImmediately) {
      const matchingApprovals = this.approvals.filter(
        (a) => a.kind === "hook_trust" && a.commandOrPath === path,
      );
      for (const req of matchingApprovals) {
        await this.resolveApproval({ requestId: req.requestId, decision: "allow_session" });
      }
    }

    return { ...saved };
  }

  async deleteHook(path: string): Promise<void> {
    this.extractHookName(path.trim());
    const target = path.trim();
    this.globalHooks = this.globalHooks.filter((h) => h.path !== target);
    this.trustRecords = this.trustRecords.filter(
      (r) => !(r.kind === "hook" && r.identifier === target),
    );
    this.approvals = this.approvals.filter(
      (a) => !(a.kind === "hook_trust" && a.commandOrPath === target),
    );
  }

  async listGuardianDecisions(): Promise<GuardianDecision[]> {
    return this.guardianDecisions.map((d) => ({ ...d }));
  }

  async listProposals(): Promise<EvolutionProposal[]> {
    return this.proposals.map((p) => ({
      ...p,
      diffs: p.diffs.map((d) => ({ ...d })),
      inlineComments: p.inlineComments.map((c) => ({ ...c })),
    }));
  }

  async getSilentArchiveCount(): Promise<number> {
    return this.silentArchiveCount;
  }

  async askEvolutionArchitect(
    params: EvolutionArchitectAskParams,
  ): Promise<EvolutionArchitectAskResult> {
    await this.sleep();
    const headSha = this.commits[0]?.sha ?? this.systemHealth.activeCommitSha;
    const files = this.genomeTrees[headSha] ?? [];
    const relevant = files
      .filter((f) => f.path.includes(params.domain) || f.component === params.domain)
      .concat(files.slice(0, 3))
      .slice(0, 3)
      .map((f) => `\`${f.path}\``);
    const fileList = relevant.length > 0 ? relevant.join(", ") : "`systemprompt.md`";
    const isZh = (params.locale ?? "").startsWith("zh");
    const modelId =
      params.modelOverride ?? this.appConfig.slots.improver?.modelId ?? "claude-sonnet-4-5";

    const usage = {
      inputTokens: 320,
      outputTokens: 118,
      cachedInputTokens: 120,
      reasoningTokens: 0,
      costUsd: 0.0021,
    };
    this.budgetStatus.spentTodayUsd = Number(
      (this.budgetStatus.spentTodayUsd + usage.costUsd).toFixed(4),
    );
    this.budgetStatus.tokensToday += usage.inputTokens + usage.outputTokens;

    const cleanMsg = params.message.trim();
    const suggestedGoal = isZh
      ? `围绕「${params.pillarTitle}」优化 ${fileList.replace(/`/g, "")}，针对「${cleanMsg.slice(0, 80)}」在影子沙盒中将回归错误清零并验证双盲胜出。`
      : `Refine ${fileList.replace(/`/g, "")} for ${params.pillarTitle}: address "${cleanMsg.slice(0, 80)}" with zero regression errors in CoW shadow sandbox and Blind Judge win.`;

    const reply = isZh
      ? `基于当前基因库资产（${fileList}），针对「${params.pillarTitle}」方向的建议：\n\n1. **聚焦改动范围**：优先在现有器官文件上做最小可逆增量，避免破坏已有回归基线。\n2. **可验证验收标准**：${params.goalDraft?.trim() ? `结合你当前草稿「${params.goalDraft.trim()}」，` : ""}建议将成功条件量化为「影子沙盒 0 报错、步骤数下降且 6/6 回归通过」。`
      : `Grounded in current Genome assets (${fileList}) for **${params.pillarTitle}**:\n\n1. **Focused Delta**: Keep changes minimal and reversible within the relevant organ files.\n2. **Verifiable Criterion**: ${params.goalDraft?.trim() ? `Building on your draft ("${params.goalDraft.trim()}"), ` : ""}gate success on zero shadow-probe errors, fewer steps, and 6/6 regression passes.`;

    return {
      reply,
      suggestedGoal,
      modelId,
      usage,
    };
  }

  private async emitTheaterSequence(proposalId: string, labelPrefix: string): Promise<void> {
    const stages: Array<{ stage: EvolutionStage; label: string; summary: string }> = [
      { stage: "queued", label: `${labelPrefix}: Queued in Harness² Scheduler`, summary: "Snapshot pinned" },
      { stage: "proposing_inv", label: `${labelPrefix}: Invariant Track (INV)`, summary: "Distilled encoding & schema invariants" },
      { stage: "proposing_dom", label: `${labelPrefix}: Domain Track (DOM)`, summary: "Generated candidate tool & script diff" },
      { stage: "shadow_probing", label: `${labelPrefix}: CoW Shadow Sandbox Probe`, summary: "0 errors in isolated copy-on-write workspace" },
      { stage: "blind_judging", label: `${labelPrefix}: Blind Judge A/B Arena`, summary: "Forward & reverse pass order-consistent win" },
      { stage: "regression_checking", label: `${labelPrefix}: Regression Suite Check`, summary: "6/6 meta regression cases passed" },
      { stage: "reflecting", label: `${labelPrefix}: EXPERIENCE.md Distillation`, summary: "Cue / Lesson / Evidence verified" },
      { stage: "completed", label: `${labelPrefix}: Proposal Ready for Triage`, summary: "Ready for human review" },
    ];

    for (const s of stages) {
      this.emit({
        type: "evolution.step.started",
        proposalId,
        stage: s.stage,
        label: s.label,
        timestamp: new Date().toISOString(),
      });
      await this.sleep();
      this.emit({
        type: "evolution.step.progress",
        proposalId,
        stage: s.stage,
        message: s.summary,
        metricsSnapshot:
          s.stage === "shadow_probing"
            ? { steps: 2, errors: 0, durationMs: 3900, tokens: 3850, costUsd: 0.034 }
            : undefined,
        timestamp: new Date().toISOString(),
      });
      this.emit({
        type: "evolution.step.completed",
        proposalId,
        stage: s.stage,
        summary: s.summary,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async triggerEvolution(params: EvolutionTriggerParams): Promise<EvolutionProposal> {
    this.recordedEvolutionTriggers.push(params);
    const id = `prop-${Date.now()}`;
    await this.emitTheaterSequence(id, `Evolution (${params.domain})`);
    const head = this.commits[0];
    const now = new Date().toISOString();
    const goalSnippet = params.goal?.trim() ? ` — ${params.goal.trim().slice(0, 64)}` : "";
    const proposal: EvolutionProposal = {
      id,
      threadId: params.threadId,
      domain: params.domain,
      title: `Proposal #${this.proposals.length + 8}: Evolved ${params.domain} guardrail & helper${goalSnippet}`,
      mode: params.mode,
      k: params.k,
      triggerSource: params.triggerSource,
      sourceTags: ["local"],
      requiresHumanTrust: true,
      baseCommitSha: head?.sha ?? this.systemHealth.activeCommitSha,
      status: "ready",
      metricsBefore: { steps: 6, errors: 2, durationMs: 14_000, tokens: 7_200, costUsd: 0.068 },
      metricsAfter: { steps: 2, errors: 0, durationMs: 3_900, tokens: 3_850, costUsd: 0.034 },
      blindJudge: {
        seed: `sha1:${Math.random().toString(16).slice(2, 9)}`,
        optionALabel: "Baseline Harness",
        optionBLabel: "Evolved Candidate",
        winnerAnonId: "anon-B",
        winnerLabel: "Option B (Candidate)",
        winnerIsCandidate: true,
        forwardWinnerAnonId: "anon-B",
        reverseWinnerAnonId: "anon-B",
        orderConsistent: true,
        confidence: "high",
        reasoning: params.goal?.trim()
          ? `Candidate satisfies goal ("${params.goal.trim()}") deterministically inside CoW shadow sandbox with 67% fewer steps.`
          : "Candidate resolves errors deterministically inside CoW shadow sandbox with 67% fewer steps.",
        judgeModelId: this.appConfig.slots.judge?.modelId ?? "gpt-4.1",
      },
      diffs: [
        {
          path: `scripts/evolved_${params.domain}_helper.ts`,
          changeType: "added",
          isHighPrivilege: true,
          before: "",
          after: `// Evolved helper for ${params.domain}\nexport function verifyInputs(items: string[]): boolean {\n  return items.length > 0;\n}`,
          unifiedDiff: `@@ -0,0 +1,4 @@\n+// Evolved helper for ${params.domain}\n+export function verifyInputs(items: string[]): boolean {\n+  return items.length > 0;\n+}`,
        },
      ],
      experienceEntry: {
        domain: params.domain,
        cue: params.goal?.trim()
          ? params.goal.trim()
          : `Recurring ${params.domain} ambiguity during ${params.triggerSource} run`,
        lesson: `Validate inputs deterministically via scripts/evolved_${params.domain}_helper.ts before side effects.`,
        evidence: "CoW shadow probe passed 0 errors across test fixtures.",
        confidence: "high (0.91)",
      },
      inlineComments: [],
      regressionCheck: { total: 6, passed: 6, failed: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.proposals = [proposal, ...this.proposals];
    this.emit({ type: "evolution.proposal_ready", proposal });
    return proposal;
  }

  async getGardenerReport(): Promise<HarnessGardenerReport> {
    const headSha = this.commits[0]?.sha ?? this.systemHealth.activeCommitSha;
    const files = this.genomeTrees[headSha] ?? [];

    const alwaysOnFiles = files.filter(
      (f) =>
        f.path === "systemprompt.md" ||
        f.path === "guardrails.md" ||
        f.path.startsWith("memory/") ||
        f.path.startsWith("tool_descriptions/"),
    );
    const alwaysOnBytes = alwaysOnFiles.reduce((sum, f) => sum + f.content.length, 0);
    const alwaysOnEstimatedTokens = Math.ceil(alwaysOnBytes / 4);

    const referenceCorpus = files
      .filter(
        (f) =>
          f.path === "systemprompt.md" ||
          f.path === "guardrails.md" ||
          f.path.startsWith("memory/") ||
          f.path.startsWith("tool_descriptions/"),
      )
      .map((f) => f.content.toLowerCase())
      .join("\n");

    const fullReferenceCorpus = files
      .filter((f) => !f.path.startsWith("scripts/"))
      .map((f) => f.content.toLowerCase())
      .join("\n");

    const findings: GardenerFinding[] = [];

    // 1. Prompt bloat check on always-on context
    if (alwaysOnEstimatedTokens > 2500) {
      findings.push({
        id: "gardener-prompt-bloat",
        kind: "prompt_bloat",
        severity: "warning",
        path: "systemprompt.md",
        detail: `Always-on prompt footprint reached ~${alwaysOnEstimatedTokens} tokens (${alwaysOnBytes} B); consider moving domain rules into lazy skills.`,
        suggestedAction: "prune",
      });
    }

    // 2. Empty organ check
    for (const file of files) {
      if (file.content.trim().length === 0) {
        findings.push({
          id: `gardener-empty-${file.path}`,
          kind: "empty_organ",
          severity: "advisory",
          path: file.path,
          detail: "Organ file is empty and adds noise to the Genome tree.",
          suggestedAction: "prune",
        });
      }
    }

    // 3. Untriggered skill check (skills/*/SKILL.md not referenced in always-on prompts/tool guides)
    for (const file of files) {
      if (file.path.startsWith("skills/") && file.path.endsWith("/SKILL.md")) {
        const skillFolder = file.path.slice("skills/".length, -"/SKILL.md".length).toLowerCase();
        const skillSlug = skillFolder.replace(/_/g, "-");
        const isReferenced =
          referenceCorpus.includes(file.path.toLowerCase()) ||
          referenceCorpus.includes(skillFolder) ||
          referenceCorpus.includes(skillSlug);
        if (!isReferenced) {
          findings.push({
            id: `gardener-untriggered-${skillFolder}`,
            kind: "untriggered_skill",
            severity: "advisory",
            path: file.path,
            detail: `Skill "${skillFolder}" is not mentioned in systemprompt.md or tool descriptions and may stay dormant.`,
            suggestedAction: "trigger",
          });
        }
      }
    }

    // 4. Orphan script check (scripts/* not referenced by any skill, hook, tool guide, or experience)
    for (const file of files) {
      if (file.path.startsWith("scripts/")) {
        const scriptName = file.path.slice("scripts/".length).toLowerCase();
        if (
          !fullReferenceCorpus.includes(file.path.toLowerCase()) &&
          !fullReferenceCorpus.includes(scriptName)
        ) {
          findings.push({
            id: `gardener-orphan-${file.path}`,
            kind: "orphan_script",
            severity: "advisory",
            path: file.path,
            detail: "Script is unreferenced across prompts, skills, tool guides, and distilled experience.",
            suggestedAction: "prune",
          });
        }
      }
    }

    // 5. Duplicate experience cue check across EXPERIENCE.md files
    const seenCues = new Map<string, string>();
    for (const file of files) {
      if (!file.path.endsWith("EXPERIENCE.md")) continue;
      for (const line of file.content.split(/\r?\n/)) {
        const cueMatch = line.match(/^\s*-\s*\*\*Cue\*\*:\s*(.+)$/i);
        if (!cueMatch?.[1]) continue;
        const normalizedCue = cueMatch[1].trim().toLowerCase().replace(/\s+/g, " ");
        const priorPath = seenCues.get(normalizedCue);
        if (priorPath) {
          findings.push({
            id: `gardener-dup-exp-${file.path}-${seenCues.size}`,
            kind: "duplicate_experience",
            severity: "advisory",
            path: file.path,
            detail: `Experience cue duplicates entry already recorded in ${priorPath}.`,
            suggestedAction: "consolidate",
          });
        } else {
          seenCues.set(normalizedCue, file.path);
        }
      }
    }

    // 6. Same-model Improver / Judge collusion check
    const improverSlot = this.appConfig.slots.improver;
    const judgeSlot = this.appConfig.slots.judge;
    const sameModelCollusion = Boolean(
      improverSlot && judgeSlot && improverSlot.modelId === judgeSlot.modelId,
    );
    const modelDiversityOk = !sameModelCollusion;
    if (sameModelCollusion && improverSlot) {
      findings.push({
        id: "gardener-same-model-collusion",
        kind: "same_model_collusion",
        severity: "warning",
        path: "appConfig.slots",
        detail: `Improver and Judge both bind "${improverSlot.modelId}", increasing self-preference bias.`,
        suggestedAction: "diversify_models",
      });
    }

    const penalty = findings.reduce(
      (sum, f) => sum + (f.severity === "warning" ? 18 : 12),
      0,
    );
    const healthScore = Math.max(0, Math.min(100, 100 - penalty));

    const actionablePaths = findings
      .filter((f) => f.kind !== "same_model_collusion")
      .map((f) => f.path);
    const suggestedPruningGoal =
      actionablePaths.length > 0
        ? `Audit and resolve harness hygiene findings (${actionablePaths.join(", ")}): wire untriggered skills into systemprompt.md or prune redundant assets while passing 6/6 regressions.`
        : findings.length > 0
          ? "Diversify Improver and Judge models or tighten always-on prompt footprint to eliminate bias and bloat."
          : undefined;

    return {
      checkedAt: new Date().toISOString(),
      commitSha: headSha,
      healthScore,
      alwaysOnBytes,
      alwaysOnEstimatedTokens,
      totalOrgans: files.length,
      modelDiversityOk,
      findings,
      suggestedPruningGoal,
    };
  }

  async reviseProposalWithComments(params: EvolutionReviseParams): Promise<EvolutionProposal> {
    const existing = this.proposals.find((p) => p.id === params.proposalId);
    if (!existing) {
      throw new Error(`Proposal not found: ${params.proposalId}`);
    }
    await this.emitTheaterSequence(existing.id, "Targeted Re-Evolution");

    const now = new Date().toISOString();
    const commentNotes = params.comments.map((c) => `// Review note (L${c.lineNumber}): ${c.comment}`);
    const updatedDiffs = existing.diffs.map((d) => {
      const matching = params.comments.filter((c) => c.filePath === d.path);
      if (matching.length === 0) return d;
      const appendedLines = matching.map((c) => `// Applied review comment @ line ${c.lineNumber}: ${c.comment}`);
      const nextAfter = `${d.after}\n${appendedLines.join("\n")}`;
      const nextUnified = `${d.unifiedDiff}\n${appendedLines.map((l) => `+${l}`).join("\n")}`;
      return {
        ...d,
        after: nextAfter,
        unifiedDiff: nextUnified,
      };
    });

    const newComments = params.comments.map((c, idx) => ({
      id: `idc-${Date.now()}-${idx}`,
      filePath: c.filePath,
      lineNumber: c.lineNumber,
      comment: c.comment,
      author: "user" as const,
      createdAt: now,
    }));

    const revised: EvolutionProposal = {
      ...existing,
      triggerSource: "inline_revision",
      diffs: updatedDiffs,
      inlineComments: [...existing.inlineComments, ...newComments],
      metricsAfter: {
        ...existing.metricsAfter,
        durationMs: Math.max(2500, existing.metricsAfter.durationMs - 400),
      },
      blindJudge: existing.blindJudge
        ? {
            ...existing.blindJudge,
            reasoning: `${existing.blindJudge.reasoning} Revised cleanly for inline comments (${commentNotes.join("; ")}).`,
          }
        : undefined,
      updatedAt: now,
    };

    this.proposals = this.proposals.map((p) => (p.id === revised.id ? revised : p));
    this.emit({ type: "evolution.proposal_ready", proposal: revised });
    return revised;
  }

  async adoptProposal(params: EvolutionProposalActionParams): Promise<{
    proposal: EvolutionProposal;
    newCommit?: GenomeCommit;
  }> {
    const proposal = this.proposals.find((p) => p.id === params.proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${params.proposalId}`);
    }
    const updated: EvolutionProposal = {
      ...proposal,
      status: "adopted",
      updatedAt: new Date().toISOString(),
    };
    this.proposals = this.proposals.map((p) => (p.id === updated.id ? updated : p));

    const nextNum = this.commits.length + 4;
    const sha = this.nextSha(nextNum);
    const parentSha = this.commits[0]?.sha;
    const newCommit: GenomeCommit = {
      sha,
      parentSha,
      versionTag: `v${nextNum}`,
      message: `Adopt ${proposal.title}`,
      timestamp: new Date().toISOString(),
      domain: proposal.domain,
      passRate: 0.96,
      changedComponents: ["scripts", "tool_descriptions", "meta"],
      isRollback: false,
    };
    this.commits = [newCommit, ...this.commits];
    this.systemHealth.activeCommitSha = sha;

    const prevFiles = parentSha ? (this.genomeTrees[parentSha] ?? []) : [];
    const nextFiles = [...prevFiles];
    for (const diff of proposal.diffs) {
      const idx = nextFiles.findIndex((f) => f.path === diff.path);
      const fileObj: GenomeFile = {
        path: diff.path,
        component: diff.path.startsWith("scripts/")
          ? "scripts"
          : diff.path.startsWith("skills/")
            ? "skills"
            : diff.path.startsWith("systemprompt")
              ? "systemprompt"
              : "tool_descriptions",
        content: diff.after,
        sizeBytes: diff.after.length,
      };
      if (idx >= 0) nextFiles[idx] = fileObj;
      else nextFiles.push(fileObj);
    }
    this.genomeTrees[sha] = nextFiles;

    if (params.trustHighPrivilegeAssets) {
      for (const diff of proposal.diffs.filter((d) => d.isHighPrivilege)) {
        const existing = this.trustRecords.find((r) => r.identifier === diff.path);
        if (existing) {
          existing.status = "trusted";
          existing.updatedAt = new Date().toISOString();
        } else {
          this.trustRecords.unshift({
            id: `tr-${Date.now()}-${diff.path}`,
            kind: diff.path.startsWith("hooks/") ? "hook" : diff.path.startsWith("mcp/") ? "mcp" : "script",
            identifier: diff.path,
            sha256: sha,
            status: "trusted",
            origin: "rsi_evolved",
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    return { proposal: updated, newCommit };
  }

  async rejectProposal(params: EvolutionProposalActionParams): Promise<EvolutionProposal> {
    const proposal = this.proposals.find((p) => p.id === params.proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${params.proposalId}`);
    }
    const updated: EvolutionProposal = {
      ...proposal,
      status: "rejected",
      updatedAt: new Date().toISOString(),
    };
    this.proposals = this.proposals.map((p) => (p.id === updated.id ? updated : p));
    this.silentArchiveCount += 1;
    return updated;
  }

  simulateBreakingUpgrade(enable = true): HarnessCompatibilityReport {
    const headSha = this.commits[0]?.sha ?? this.systemHealth.activeCommitSha;
    this.compatibilityReport = enable
      ? {
          checkedAt: new Date().toISOString(),
          appVersion: "0.2.0",
          expectedSchemaVersion: 2,
          harnessSchemaVersion: 1,
          commitSha: headSha,
          hasBreakingIssues: true,
          needsMigration: true,
          quarantinedPaths: ["hooks/custom_hook.ts"],
          issues: [
            {
              path: "hooks/custom_hook.ts",
              kind: "deprecated_hook_contract",
              severity: "breaking",
              message: "Hook signature `onToolCall` is replaced by `PreToolUse(ctx)` in v0.2.0.",
              suggestedFix: "Migrate export to `PreToolUse` handler and re-verify SHA-256 trust.",
            },
            {
              path: "manifest.json",
              kind: "schema_version_mismatch",
              severity: "breaking",
              message: "Harness manifest schemaVersion=1 lags behind app expectedSchemaVersion=2.",
              suggestedFix: "Bump schemaVersion to 2 and preserve existing domain metadata.",
            },
          ],
          migrationGuideSummary:
            "Automatically quarantined hooks/custom_hook.ts; Harness² can synthesize a non-destructive migration diff.",
        }
      : {
          checkedAt: new Date().toISOString(),
          appVersion: "0.1.0",
          expectedSchemaVersion: 1,
          harnessSchemaVersion: 1,
          commitSha: headSha,
          hasBreakingIssues: false,
          needsMigration: false,
          quarantinedPaths: [],
          issues: [],
        };
    return {
      ...this.compatibilityReport,
      quarantinedPaths: [...this.compatibilityReport.quarantinedPaths],
      issues: this.compatibilityReport.issues.map((i) => ({ ...i })),
    };
  }

  async checkHarnessCompatibility(): Promise<HarnessCompatibilityReport> {
    return {
      ...this.compatibilityReport,
      quarantinedPaths: [...this.compatibilityReport.quarantinedPaths],
      issues: this.compatibilityReport.issues.map((i) => ({ ...i })),
    };
  }

  async startHarnessMigration(report?: HarnessCompatibilityReport): Promise<EvolutionProposal> {
    const targetReport = report ?? this.compatibilityReport;
    const id = `prop-mig-${Date.now()}`;
    await this.emitTheaterSequence(id, "Self-Healing Migration");
    const head = this.commits[0];
    const now = new Date().toISOString();
    const proposal: EvolutionProposal = {
      id,
      threadId: this.threads[0]?.id ?? "thr-billing-csv",
      domain: "migration",
      title: `Migration Proposal: Repair ${targetReport.issues.map((i) => i.path).join(" & ") || "hooks/custom_hook.ts & manifest.json"}`,
      mode: "sequential",
      k: 1,
      triggerSource: "upgrade_migration",
      sourceTags: ["local"],
      requiresHumanTrust: true,
      baseCommitSha: head?.sha ?? this.systemHealth.activeCommitSha,
      status: "ready",
      metricsBefore: { steps: 4, errors: Math.max(1, targetReport.issues.length), durationMs: 5_200, tokens: 2_800, costUsd: 0.021 },
      metricsAfter: { steps: 1, errors: 0, durationMs: 1_900, tokens: 1_520, costUsd: 0.011 },
      blindJudge: {
        seed: `sha1:mig-${Date.now().toString(16).slice(-5)}`,
        optionALabel: "Legacy v1 Harness (Broken Contract)",
        optionBLabel: "Harness² Migrated v2 Candidate",
        winnerAnonId: "anon-B",
        winnerLabel: "Option B (Migrated)",
        winnerIsCandidate: true,
        forwardWinnerAnonId: "anon-B",
        reverseWinnerAnonId: "anon-B",
        orderConsistent: true,
        confidence: "high",
        reasoning:
          "Candidate preserves original hook behavior under the v2 `PreToolUse` contract and bumps `manifest.json` schemaVersion cleanly with 0 regression errors.",
        judgeModelId: this.appConfig.slots.judge?.modelId ?? "gpt-4.1",
      },
      diffs: [
        {
          path: "hooks/custom_hook.ts",
          changeType: "modified",
          isHighPrivilege: true,
          before: "export function onToolCall(tool: string) {\n  return { allow: true };\n}",
          after:
            "// Migrated to v0.2.0 PreToolUse contract by Harness²\nexport function PreToolUse(ctx: { toolName: string }) {\n  return { decision: \"allow\", tool: ctx.toolName };\n}",
          unifiedDiff: [
            "@@ -1,3 +1,4 @@",
            "-export function onToolCall(tool: string) {",
            "-  return { allow: true };",
            "+// Migrated to v0.2.0 PreToolUse contract by Harness²",
            "+export function PreToolUse(ctx: { toolName: string }) {",
            "+  return { decision: \"allow\", tool: ctx.toolName };",
            " }",
          ].join("\n"),
        },
        {
          path: "manifest.json",
          changeType: "modified",
          isHighPrivilege: false,
          before: '{\n  "schemaVersion": 1,\n  "genomeVersion": "v7"\n}',
          after: '{\n  "schemaVersion": 2,\n  "genomeVersion": "v8-migrated"\n}',
          unifiedDiff: [
            "@@ -1,4 +1,4 @@",
            " {",
            '-  "schemaVersion": 1,',
            '-  "genomeVersion": "v7"',
            '+  "schemaVersion": 2,',
            '+  "genomeVersion": "v8-migrated"',
            " }",
          ].join("\n"),
        },
      ],
      experienceEntry: {
        domain: "migration",
        cue: "App upgrade flags deprecated_hook_contract or schema_version_mismatch",
        lesson: "Quarantine incompatible hooks non-destructively and synthesize contract-preserving diffs via Harness².",
        evidence: "CoW shadow probe verified 0 errors after migrating hooks/custom_hook.ts & manifest.json.",
        confidence: "high (0.96)",
      },
      inlineComments: [],
      regressionCheck: { total: 6, passed: 6, failed: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.proposals = [proposal, ...this.proposals];
    this.emit({ type: "evolution.proposal_ready", proposal });
    return proposal;
  }

  async listCommits(): Promise<GenomeCommit[]> {
    return this.commits.map((c) => ({ ...c }));
  }

  async readGenomeTree(commitSha: string): Promise<GenomeFile[]> {
    return (this.genomeTrees[commitSha] ?? this.genomeTrees[this.commits[0]?.sha ?? ""] ?? []).map((f) => ({ ...f }));
  }

  async revertToCommit(targetSha: string, reason: string): Promise<GenomeCommit> {
    const target = this.commits.find((c) => c.sha === targetSha);
    if (!target) {
      throw new Error(`Target commit not found: ${targetSha}`);
    }
    const nextNum = this.commits.length + 4;
    const sha = this.nextSha(nextNum);
    const parentSha = this.commits[0]?.sha;
    const rollbackCommit: GenomeCommit = {
      sha,
      parentSha,
      versionTag: `v${nextNum}`,
      message: `Revert to ${target.versionTag}: ${reason}`,
      timestamp: new Date().toISOString(),
      domain: target.domain,
      passRate: target.passRate,
      changedComponents: target.changedComponents,
      isRollback: true,
    };
    this.commits = [rollbackCommit, ...this.commits];
    this.genomeTrees[sha] = [...(this.genomeTrees[targetSha] ?? [])];
    this.systemHealth.activeCommitSha = sha;
    return rollbackCommit;
  }

  async gitToggleOrgan(organPath: string, enabled: boolean): Promise<OrganToggleResult> {
    const normalized = organPath.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
    if (!normalized) {
      throw new Error("Organ path cannot be empty");
    }
    const headCommit = this.commits[0];
    const headSha = headCommit?.sha ?? this.systemHealth.activeCommitSha;
    const currentFiles = [...(this.genomeTrees[headSha] ?? [])];
    const disabledPath = "meta/disabled_organs.json";
    const existingEntry = currentFiles.find((f) => f.path === disabledPath);
    const disabledSet = new Set<string>();
    if (existingEntry) {
      try {
        const parsed = JSON.parse(existingEntry.content) as { disabled?: unknown };
        if (Array.isArray(parsed.disabled)) {
          for (const item of parsed.disabled) {
            if (typeof item === "string" && item.trim()) disabledSet.add(item.trim());
          }
        }
      } catch {
        // Ignore malformed mock registry
      }
    }
    const hadItem = disabledSet.has(normalized);
    const changed = enabled ? hadItem : !hadItem;
    if (enabled) disabledSet.delete(normalized);
    else disabledSet.add(normalized);
    const disabledPaths = Array.from(disabledSet).sort();

    if (!changed) {
      return { ok: true, disabledPaths };
    }

    const content = `${JSON.stringify({ disabled: disabledPaths }, null, 2)}\n`;
    const updatedEntry: GenomeFile = {
      path: disabledPath,
      component: "meta",
      content,
      sizeBytes: content.length,
    };
    const nextFiles = currentFiles.some((f) => f.path === disabledPath)
      ? currentFiles.map((f) => (f.path === disabledPath ? updatedEntry : f))
      : [...currentFiles, updatedEntry];

    const nextNum = this.commits.length + 4;
    const sha = this.nextSha(nextNum);
    const toggleCommit: GenomeCommit = {
      sha,
      parentSha: headSha,
      versionTag: `v${nextNum}`,
      message: `${enabled ? "Enable" : "Disable"} organ ${normalized}`,
      timestamp: new Date().toISOString(),
      domain: "organ_toggle",
      passRate: headCommit?.passRate,
      changedComponents: ["meta"],
      isRollback: false,
    };
    this.commits = [toggleCommit, ...this.commits];
    this.genomeTrees[sha] = nextFiles;
    this.systemHealth.activeCommitSha = sha;

    return { ok: true, newCommitSha: sha, disabledPaths };
  }

  async scanExport(): Promise<ExportScanResult> {
    return {
      includedFiles: [
        "manifest.json",
        "systemprompt.md",
        "guardrails.md",
        "tool_descriptions/shell.md",
        "skills/csv_audit/SKILL.md",
        "scripts/safe_gbk_parse.ts",
        "meta/domains/file_ops/EXPERIENCE.md",
      ],
      excludedFiles: ["memory/LongTermMEMORY.md", ".harnex/trust.json", "keyring/*"],
      findings: [
        {
          file: "mcp/servers.json",
          line: 6,
          rule: "generic-api-token",
          maskedSnippet: 'Authorization: "Bearer sk-live-••••••••9f2a"',
        },
      ],
      safeToExport: false,
    };
  }

  async confirmExport(stripFindings: boolean): Promise<{ archivePath: string; fileCount: number }> {
    await this.sleep();
    return {
      archivePath: stripFindings
        ? "~/Downloads/harnex-genome-v7-sanitized.harnex.zip"
        : "~/Downloads/harnex-genome-v7.harnex.zip",
      fileCount: 7,
    };
  }

  async previewImport(archivePath: string): Promise<StagedImportPreview> {
    const headSha = this.commits[0]?.sha ?? this.systemHealth.activeCommitSha;
    const currentFiles = new Map((this.genomeTrees[headSha] ?? []).map((f) => [f.path, f.content]));
    const existingExperience = currentFiles.get("meta/domains/file_ops/EXPERIENCE.md");
    const stagedBundle: Record<string, string> = {
      "manifest.json": '{"schemaVersion":1,"genomeVersion":"community-pack"}',
      "tool_descriptions/shell.md": "# Shell Tool\nUpdated community shell hints.",
      "meta/domains/file_ops/EXPERIENCE.md":
        existingExperience ?? "## Entry #1\n- **Cue**: Multi-file directory aggregation",
      "scripts/community_pdf_extract.ts": "export function extractPdf() { return []; }",
      "hooks/post_shell_lint.ts": "export default function lint() { return { ok: true }; }",
      "mcp/servers.json": '{"servers":{"playwright":{"command":"npx","enabled":false}}}',
    };
    const files = Object.keys(stagedBundle);
    const untrustedExecutables = [
      "scripts/community_pdf_extract.ts",
      "hooks/post_shell_lint.ts",
      "mcp/servers.json",
    ];
    const addedFiles: string[] = [];
    const overwrittenFiles: string[] = [];
    const unchangedFiles: string[] = [];
    for (const [filePath, content] of Object.entries(stagedBundle)) {
      const existing = currentFiles.get(filePath);
      if (existing === undefined) addedFiles.push(filePath);
      else if (existing === content) unchangedFiles.push(filePath);
      else overwrittenFiles.push(filePath);
    }
    return {
      archivePath,
      files,
      untrustedExecutables,
      addedFiles,
      overwrittenFiles,
      unchangedFiles,
    };
  }

  async executeImport(archivePath: string, trustPaths: string[]): Promise<{ importedCount: number }> {
    const preview = await this.previewImport(archivePath);
    for (const exePath of preview.untrustedExecutables) {
      const trusted = trustPaths.includes(exePath);
      this.trustRecords.unshift({
        id: `tr-imp-${Date.now()}-${exePath}`,
        kind: exePath.startsWith("hooks/") ? "hook" : exePath.startsWith("mcp/") ? "mcp" : "script",
        identifier: exePath,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        status: trusted ? "trusted" : "disabled",
        origin: "imported_genome",
        updatedAt: new Date().toISOString(),
      });
    }
    return { importedCount: preview.files.length };
  }

  async runReplayCompare(params: ReplayCompareParams): Promise<ReplayComparison> {
    await this.sleep();
    const modelId = params.modelId ?? this.appConfig.slots.solver?.modelId ?? "gpt-4.1-mini";
    return {
      id: `rep-${Date.now()}`,
      taskPrompt: params.taskPrompt,
      v0Sha: params.v0Sha,
      vNSha: params.vNSha,
      modelId,
      v0Metrics: {
        steps: 7,
        errors: 3,
        durationMs: 18_400,
        tokens: 9_840,
        costUsd: 0.09,
      },
      vNMetrics: {
        steps: 2,
        errors: 0,
        durationMs: 4_120,
        tokens: 4_110,
        costUsd: 0.038,
      },
      v0Output: "Failed on row 4: UTF-8 replacement characters () broke CSV numeric parser. Output incomplete.",
      vNOutput: "Decoded 12 GB18030 CSV files cleanly via scripts/safe_gbk_parse.ts. Exported UTF-8 summary with 0 errors.",
      status: "completed",
    };
  }

  async listProviders(): Promise<ProviderConfig[]> {
    return this.providers.map((p) => ({
      ...p,
      models: [...p.models],
      pinnedModels: p.pinnedModels ? [...p.pinnedModels] : undefined,
      keys: p.keys ? p.keys.map((k) => ({ ...k })) : undefined,
    }));
  }

  async getAggregatedCatalog(): Promise<AggregatedModelEntry[]> {
    return buildAggregatedModelCatalog(this.providers);
  }

  async saveProvider(params: SaveProviderParams): Promise<ProviderConfig> {
    const id = params.provider.id ?? `prov-${Date.now()}`;
    const existing = this.providers.find((p) => p.id === id);
    const trimmedKey = params.apiKey?.trim();

    let nextKeys = (params.provider.keys ?? existing?.keys ?? []).map((k) => ({ ...k }));
    if (params.keyRemovals && params.keyRemovals.length > 0) {
      const removals = new Set(params.keyRemovals);
      nextKeys = nextKeys.filter((k) => !removals.has(k.id));
    }
    if (params.keyAdditions && params.keyAdditions.length > 0) {
      for (const add of params.keyAdditions) {
        const secret = add.apiKey.trim();
        if (!secret) continue;
        const keyId = add.id ?? `key-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        nextKeys.push({
          id: keyId,
          label: add.label.trim() || `Key #${nextKeys.length + 1}`,
          keyringRef: `harnex/provider/${id}/${keyId}`,
          enabled: add.enabled ?? true,
          priority: add.priority ?? nextKeys.length,
          maskedHint: maskApiKey(secret),
        });
      }
    }
    if (trimmedKey && !params.provider.isAggregator && nextKeys.length === 0) {
      const keyId = `key-${Date.now()}`;
      nextKeys.push({
        id: keyId,
        label: "Primary Key",
        keyringRef: params.provider.keyringRef ?? `harnex/provider/${id}`,
        enabled: true,
        priority: 0,
        maskedHint: maskApiKey(trimmedKey),
      });
    }

    const hasPoolKey = nextKeys.some((k) => k.enabled);
    const saved: ProviderConfig = {
      id,
      name: params.provider.name,
      kind: params.provider.kind,
      apiProtocol: params.provider.apiProtocol ?? existing?.apiProtocol,
      baseUrl: params.provider.baseUrl,
      models: [...params.provider.models],
      pinnedModels: params.provider.pinnedModels ?? existing?.pinnedModels,
      keyringRef: params.provider.keyringRef ?? `harnex/provider/${id}`,
      hasApiKey:
        Boolean(trimmedKey && trimmedKey.length > 0) ||
        hasPoolKey ||
        Boolean(params.provider.hasApiKey ?? existing?.hasApiKey),
      keys: nextKeys.length > 0 ? nextKeys : undefined,
      keyStrategy: params.provider.keyStrategy ?? existing?.keyStrategy ?? "priority_failover",
      isAggregator: params.provider.isAggregator ?? existing?.isAggregator,
      source: params.provider.source ?? existing?.source ?? "manual",
      enabled: params.provider.enabled ?? true,
      lastPingMs: existing?.lastPingMs,
    };
    if (existing) {
      this.providers = this.providers.map((p) => (p.id === id ? saved : p));
    } else {
      this.providers = [...this.providers, saved];
    }
    return saved;
  }

  async deleteProvider(providerId: string): Promise<void> {
    this.providers = this.providers.filter((p) => p.id !== providerId);
  }

  async pingProvider(providerId: string): Promise<PingProviderResult> {
    await this.sleep();
    const prov = this.providers.find((p) => p.id === providerId);
    if (!prov) {
      return { providerId, latencyMs: 0, ok: false, error: `Unknown provider: ${providerId}` };
    }
    if (!prov.enabled) {
      return { providerId, latencyMs: 0, ok: false, error: "Provider is disabled" };
    }
    const latencyMs = prov.kind === "ollama" ? 9 : 118;
    this.providers = this.providers.map((p) => (p.id === providerId ? { ...p, lastPingMs: latencyMs } : p));
    return { providerId, latencyMs, ok: true };
  }

  async fetchProviderModels(providerId: string): Promise<string[]> {
    await this.sleep();
    const prov = this.providers.find((p) => p.id === providerId);
    if (!prov) return [];
    const fetched =
      prov.kind === "anthropic"
        ? ["claude-sonnet-4-5", "claude-3-7-sonnet", "claude-3-5-haiku"]
        : prov.kind === "gemini"
          ? ["gemini-2.5-pro", "gemini-2.5-flash"]
          : prov.kind === "ollama"
            ? ["qwen2.5-coder:14b", "llama3.3:70b", "deepseek-r1:14b"]
            : ["gpt-4.1-mini", "gpt-4.1", "o4-mini", "gpt-4o"];
    prov.models = fetched;
    return [...fetched];
  }

  async importFromCcSwitch(simulateUnavailable = false): Promise<ProviderImportResult> {
    await this.sleep();
    if (simulateUnavailable) {
      return {
        source: "cc-switch",
        detected: false,
        importedProviders: [],
        warnings: [
          "Could not locate ~/.cc-switch/cc-switch.db or local proxy 127.0.0.1:15721. Please add your provider manually below.",
        ],
        fallbackToManual: true,
      };
    }

    const imported: ProviderConfig = {
      id: "prov-cc-switch",
      name: "CC Switch Proxy (127.0.0.1:15721)",
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:15721/v1",
      models: ["claude-sonnet-4-5", "gpt-4.1", "deepseek-chat"],
      keyringRef: "harnex/provider/prov-cc-switch",
      hasApiKey: true,
      source: "cc-switch",
      enabled: true,
      lastPingMs: 15,
    };
    if (!this.providers.some((p) => p.id === imported.id)) {
      this.providers = [...this.providers, imported];
    }
    return {
      source: "cc-switch",
      detected: true,
      importedProviders: [imported],
      warnings: ["Opened ~/.cc-switch/cc-switch.db in read-only immutable SQLite mode; credentials stored in OS Keyring."],
      fallbackToManual: false,
    };
  }

  async importFromMagpie(
    params?: string | MagpieImportParams,
    simulateUnavailable = false,
  ): Promise<ProviderImportResult> {
    await this.sleep();
    const resolved =
      typeof params === "string" ? { gatewayUrl: params } : (params ?? {});
    const gatewayUrl = resolved.gatewayUrl?.trim() || "http://127.0.0.1:3425";
    const importLink = resolved.importLink?.trim();

    if (importLink) {
      try {
        const parsed = new URL(importLink);
        if (parsed.protocol !== "magpie:" || parsed.hostname !== "import") {
          throw new Error("Invalid magpie://import link");
        }
        const name = parsed.searchParams.get("name")?.trim() || "Magpie Link Provider";
        const baseUrl =
          parsed.searchParams.get("baseUrl")?.trim() ||
          parsed.searchParams.get("endpoint")?.trim() ||
          `${gatewayUrl.replace(/\/$/, "")}/v1`;
        const modelParam = parsed.searchParams.get("model") || parsed.searchParams.get("models") || "gpt-4.1-mini";
        const models = modelParam
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
        const hasKey = Boolean(parsed.searchParams.get("apiKey") || parsed.searchParams.get("token"));
        const imported: ProviderConfig = {
          id: `prov-magpie-link-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name,
          kind: "openai_compatible",
          baseUrl,
          models: models.length > 0 ? models : ["gpt-4.1-mini"],
          keyringRef: `harnex/provider/magpie-${Date.now()}`,
          hasApiKey: hasKey || baseUrl.includes("127.0.0.1"),
          source: "magpie",
          enabled: true,
          lastPingMs: 14,
        };
        if (!this.providers.some((p) => p.id === imported.id)) {
          this.providers = [...this.providers, imported];
        }
        return {
          source: "magpie",
          detected: true,
          importedProviders: [imported],
          warnings: hasKey
            ? ["Imported API key from magpie://import link directly into OS Keyring."]
            : ["Imported Magpie link configuration; verify API key if using a remote endpoint."],
          fallbackToManual: false,
        };
      } catch {
        return {
          source: "magpie",
          detected: false,
          importedProviders: [],
          warnings: [
            "The provided magpie://import link is malformed. Expected magpie://import?name=...&baseUrl=...",
          ],
          fallbackToManual: true,
        };
      }
    }

    if (simulateUnavailable) {
      return {
        source: "magpie",
        detected: false,
        importedProviders: [],
        warnings: [
          `Magpie local gateway (${gatewayUrl}) did not respond and no magpie://import payload was detected. Fallback to manual provider setup.`,
        ],
        fallbackToManual: true,
      };
    }

    const imported: ProviderConfig = {
      id: "prov-magpie",
      name: "Magpie Local Gateway (127.0.0.1:3425)",
      kind: "openai_compatible",
      baseUrl: `${gatewayUrl.replace(/\/$/, "")}/v1`,
      models: [
        "group/smart-split",
        "demo-gateway/gpt-6.2-sol",
        "demo-gateway/deepseek-v4.1-flash",
        "ai-studio/gemini-4-hydrogen",
        "ai-studio/gemini-2.5-pro",
      ],
      pinnedModels: ["group/smart-split", "ai-studio/gemini-4-hydrogen"],
      keyringRef: "harnex/provider/prov-magpie",
      hasApiKey: true,
      isAggregator: true,
      source: "magpie",
      enabled: true,
      lastPingMs: 11,
    };
    const exists = this.providers.some((p) => p.id === imported.id);
    this.providers = exists
      ? this.providers.map((p) => (p.id === imported.id ? { ...imported, pinnedModels: p.pinnedModels ?? imported.pinnedModels } : p))
      : [...this.providers, imported];
    return {
      source: "magpie",
      detected: true,
      importedProviders: [imported],
      warnings: [],
      fallbackToManual: false,
    };
  }

  async getBudgetStatus(): Promise<BudgetStatus> {
    return {
      ...this.budgetStatus,
      unpricedModelsToday: [...(this.budgetStatus.unpricedModelsToday ?? [])],
      pricingTable: this.budgetStatus.pricingTable.map((p) => ({ ...p })),
    };
  }

  async updateBudgetSettings(params: UpdateBudgetSettingsParams): Promise<BudgetStatus> {
    const pricedIds = new Set(params.pricingTable.map((p) => p.modelId));
    const remainingUnpriced = (this.budgetStatus.unpricedModelsToday ?? []).filter(
      (id) => !pricedIds.has(id),
    );
    this.budgetStatus = {
      ...this.budgetStatus,
      dailyLimitUsd: params.dailyLimitUsd,
      tripped: this.budgetStatus.spentTodayUsd > params.dailyLimitUsd,
      unpricedModelsToday: remainingUnpriced,
      pricingTable: params.pricingTable.map((p) => ({ ...p })),
    };
    this.appConfig.dailyBudgetLimitUsd = params.dailyLimitUsd;
    return this.getBudgetStatus();
  }

  async syncPricingCatalog(_params?: PricingSyncParams): Promise<PricingSyncResult> {
    return {
      synced: true,
      source: "embedded",
      modelCount: 248,
      updatedAt: new Date().toISOString(),
    };
  }

  private cloneUpdateStatus(status: UpdateStatus): UpdateStatus {
    return { ...status, info: { ...status.info } };
  }

  private setAndEmitUpdate(status: UpdateStatus): UpdateStatus {
    this.updateStatus = this.cloneUpdateStatus(status);
    this.emit({ type: "update.status_changed", status: this.cloneUpdateStatus(status) });
    return this.cloneUpdateStatus(status);
  }

  async getUpdateStatus(): Promise<UpdateStatus> {
    return this.cloneUpdateStatus(this.updateStatus);
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    this.setAndEmitUpdate({
      ...this.updateStatus,
      phase: "checking",
      error: undefined,
    });
    await this.sleep();
    const totalBytes = 20_237_516;
    return this.setAndEmitUpdate({
      phase: "available",
      info: {
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        releaseNotes:
          "• Multi-key provider pools with Priority Failover & Round-Robin\n• Magpie Aggregated Gateway integration & fast Chat Model Switcher\n• L0 sandbox & libgit2 snapshot stability improvements",
        publishedAt: "2026-11-20T09:30:00Z",
        assetName: "harnex-v0.2.0-desktop.tar.gz",
        downloadUrl: "https://releases.harnex.dev/v0.2.0/harnex-v0.2.0-desktop.tar.gz",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        sizeBytes: totalBytes,
        harnessSchemaVersion: 1,
        compatLevel: "safe",
      },
      downloadedBytes: 0,
      totalBytes,
      verifiedSha256: false,
      checkedAt: new Date().toISOString(),
    });
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (this.updateStatus.phase === "idle" || !this.updateStatus.info.latestVersion) {
      await this.checkForUpdates();
    }
    const totalBytes = this.updateStatus.totalBytes || this.updateStatus.info.sizeBytes || 20_237_516;
    const steps = [0, 0.33, 0.64, 1.0];
    for (const ratio of steps) {
      this.setAndEmitUpdate({
        ...this.updateStatus,
        phase: "downloading",
        downloadedBytes: Math.round(totalBytes * ratio),
        totalBytes,
        verifiedSha256: false,
        error: undefined,
      });
      await this.sleep();
    }
    return this.setAndEmitUpdate({
      ...this.updateStatus,
      phase: "ready",
      downloadedBytes: totalBytes,
      totalBytes,
      downloadedPath: "~/.harnex/updates/harnex-v0.2.0-desktop.tar.gz",
      verifiedSha256: true,
    });
  }

  async installUpdate(): Promise<UpdateStatus> {
    const current = this.updateStatus.info.currentVersion;
    const latest = this.updateStatus.info.latestVersion ?? "0.2.0";
    const backupTag = `pre-update-v${current}-to-v${latest}`;
    await this.sleep();
    return this.setAndEmitUpdate({
      ...this.updateStatus,
      phase: "installing",
      backupTag,
    });
  }
}
