import { beforeEach, describe, expect, it } from "bun:test";
import {
  applyCompletion,
  buildCompletionOptions,
  detectCompletionTrigger,
  extractMcpServersFromGenome,
  extractSkillsFromGenome,
} from "../features/chat/promptCompletions.ts";
import {
  appendUnpricedModelPricingRow,
  formatUnpricedSummary,
  resolveCostSourceBadge,
} from "../features/providers/providerPresets.ts";
import { buildDeckChartData } from "../features/harness/CommandDeckCharts.tsx";
import { buildEvolutionTreeGraph } from "../features/harness/GenomeEvolutionTree.tsx";
import {
  getEvolutionBlueprints,
  localizeApproval,
  localizeCommitMessage,
  localizeProposal,
  localizeSourceTags,
  localizeThreadStatus,
  localizeThreadTitle,
} from "../i18n/demoContent.ts";
import { enUSMessages, LOCALE_STORAGE_KEY, translate, zhCNMessages } from "../i18n/index.ts";
import { MockIpcAdapter } from "../ipc/index.ts";
import { formatRelativeTime, formatTokens } from "../lib/utils.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("Harnex Rebuilt UI: Prompt Completions, Pure i18n Separation & Guided Navigation", () => {
  beforeEach(async () => {
    if (!globalThis.localStorage) {
      const store = new Map<string, string>();
      (globalThis as { localStorage?: Storage }).localStorage = {
        get length() {
          return store.size;
        },
        clear: () => store.clear(),
        getItem: (k: string) => store.get(k) ?? null,
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        removeItem: (k: string) => {
          store.delete(k);
        },
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
      };
    }
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);
  });

  it("extracts skills and MCP servers from genomeFiles and handles / and @ completions", () => {
    const { genomeFiles, activeWorkspace } = useCommandDeckStore.getState();

    const skills = extractSkillsFromGenome(genomeFiles);
    expect(skills.map((s) => s.name)).toContain("csv-audit");

    const mcps = extractMcpServersFromGenome(genomeFiles);
    expect(mcps).toEqual([
      { name: "playwright", command: "npx @playwright/mcp@latest", enabled: false },
    ]);

    // Trigger `/` at start and filter `/mcp`
    const slashTrig = detectCompletionTrigger("Use /mcp play", 13);
    expect(slashTrig).toEqual({
      kind: "slash",
      query: "mcp play",
      startIndex: 4,
      endIndex: 13,
    });
    const mcpOpts = buildCompletionOptions({
      trigger: slashTrig!,
      genomeFiles,
      activeWorkspace,
      locale: "zh-CN",
    });
    expect(mcpOpts.length).toBe(1);
    expect(mcpOpts[0]?.label).toBe("/mcp playwright");
    expect(mcpOpts[0]?.badge).toBe("已禁用");

    const inserted = applyCompletion("Use /mcp play", slashTrig!, mcpOpts[0]!.insertText!);
    expect(inserted.nextText).toBe("Use /mcp playwright ");

    // Trigger `@` and filter genome memory with pure Chinese badges
    const atTrig = detectCompletionTrigger("Inspect @LongTerm", 17);
    expect(atTrig?.kind).toBe("at");
    const atOpts = buildCompletionOptions({
      trigger: atTrig!,
      genomeFiles,
      activeWorkspace,
      locale: "zh-CN",
    });
    const memOpt = atOpts.find((o) => o.label === "@memory/LongTermMEMORY.md");
    expect(memOpt?.badge).toBe("长期记忆");

    const skillZh = extractSkillsFromGenome(genomeFiles, "zh-CN");
    expect(skillZh[0]?.description).toContain("校验 CSV");
  });

  it("maintains 100% key parity and zero English status/mock copy leak under zh-CN", () => {
    const enKeys = Object.keys(enUSMessages).sort();
    const zhKeys = Object.keys(zhCNMessages).sort();
    expect(zhKeys).toEqual(enKeys);

    const state = useCommandDeckStore.getState();

    // Pure Chinese status, home subtitle, source tags & relative timestamp checks
    expect(localizeThreadStatus("awaiting_approval", "zh-CN")).toBe("待确认授权");
    expect(localizeThreadStatus("completed", "zh-CN")).toBe("已完成");
    expect(translate("zh-CN", "home.subtitle")).not.toContain("born small");
    expect(translate("zh-CN", "deck.theaterIdle").length).toBeGreaterThan(5);
    expect(localizeSourceTags(["web", "external_file"], "zh-CN")).toBe("网页、外部文件");
    expect(translate("zh-CN", "genome.activeBadge")).toBe("当前生效");
    expect(translate("zh-CN", "sidechat.title")).toBe("旁路问询 /btw");
    expect(translate("zh-CN", "sidechat.badge")).toBe("零污染隔离");
    expect(formatRelativeTime(new Date(Date.now() - 3600_000).toISOString(), "zh-CN")).toBe(
      "1 小时前",
    );
    expect(formatRelativeTime(new Date(Date.now() - 3600_000).toISOString(), "en-US")).toBe(
      "1h ago",
    );

    // Pure Chinese demo threads, proposals, approvals, commits
    const billingThread = state.threads.find((t) => t.id === "thr-billing-csv")!;
    expect(localizeThreadTitle(billingThread, "zh-CN")).toBe("账单 CSV 编码修复");
    expect(localizeThreadTitle(billingThread, "en-US")).toBe("Billing CSV Encoding Cleanup");

    const prop8 = state.proposals.find((p) => p.id === "prop-8")!;
    const zhProp = localizeProposal(prop8, "zh-CN");
    expect(zhProp.title).toContain("提案 #8");
    expect(zhProp.statusLabel).toBe("待审阅");
    expect(zhProp.winnerLabel).toContain("候选方案");

    const apr = state.pendingApprovals[0]!;
    const zhApr = localizeApproval(apr, "zh-CN");
    expect(zhApr.summary).toContain("尝试写入工作区之外的路径");

    const headCommit = state.commits[0]!;
    expect(localizeCommitMessage(headCommit, "zh-CN")).toContain("采纳文件批处理");
  });

  it("supports all 6 V2+ Guided Evolution blueprints and clean page/inspector navigation", async () => {
    const zhBlueprints = getEvolutionBlueprints("zh-CN");
    const enBlueprints = getEvolutionBlueprints("en-US");
    expect(zhBlueprints.length).toBe(7); // 6 open pillars + custom direction
    expect(enBlueprints.length).toBe(7);
    expect(zhBlueprints.map((b) => b.title)).toEqual([
      "1. 记忆系统",
      "2. 技能库",
      "3. 工具与连接 (MCP)",
      "4. 流程钩子 (Hooks)",
      "5. 多代理协作",
      "6. 安全边界与交互视图",
      "7. 自定义进化方向",
    ]);
    expect(enBlueprints.map((b) => b.title)).toEqual([
      "1. Memory System",
      "2. Skills Library",
      "3. Tools & MCP",
      "4. Workflow Hooks",
      "5. Multi-Agent Collaboration",
      "6. Sandbox & Views",
      "7. Custom Evolution Direction",
    ]);
    expect(zhBlueprints[0]?.inspirations.length).toBeGreaterThanOrEqual(3);

    const store = useCommandDeckStore.getState();
    store.setLocale("zh-CN");
    store.setActivePage("lab");
    expect(useCommandDeckStore.getState().activePage).toBe("lab");

    store.setGuidedBlueprint("hooks");
    await store.sendGuidedMessage("hooks", "优先增加 PII 脱敏防护", "遮蔽所有 sk- 密钥");
    const turns = useCommandDeckStore.getState().guidedMessagesByBlueprint["hooks"] ?? [];
    expect(turns.length).toBe(2);
    expect(turns[1]?.content).toContain("4. 流程钩子 (Hooks)");
    expect(useCommandDeckStore.getState().guidedSuggestedGoalByBlueprint["hooks"]).toBeTruthy();

    // Re-initialize preserves persisted locale in localStorage
    store.setLocale("en-US");
    expect(globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
    await useCommandDeckStore.getState().initialize(new MockIpcAdapter({ simulationDelayMs: 0 }));
    expect(useCommandDeckStore.getState().locale).toBe("en-US");

    // Reopening Crucible resets onboardingStepIndex back to Act 1 (0)
    useCommandDeckStore.getState().setOnboardingStepIndex(7);
    useCommandDeckStore.getState().openOnboarding(true);
    expect(useCommandDeckStore.getState().onboardingOpen).toBe(true);
    expect(useCommandDeckStore.getState().onboardingStepIndex).toBe(0);

    store.toggleInspector(true);
    expect(useCommandDeckStore.getState().inspectorOpen).toBe(true);

    store.toggleSidebar(true);
    expect(useCommandDeckStore.getState().sidebarCollapsed).toBe(true);

    await store.startNewTaskPrompt("解析新的发票目录", "plan");
    const afterStart = useCommandDeckStore.getState();
    expect(afterStart.activePage).toBe("thread");
    expect(afterStart.threads[0]?.mode).toBe("plan");
  });

  it("builds horizontal Genome Evolution Tree and Recharts cockpit data cleanly in zh-CN and en-US", () => {
    const state = useCommandDeckStore.getState();

    const zhTree = buildEvolutionTreeGraph({
      commits: state.commits,
      proposals: state.proposals,
      silentArchiveCount: state.silentArchiveCount,
      selectedCommitSha: state.selectedCommitSha,
      locale: "zh-CN",
    });
    const commitNodesZh = zhTree.nodes.filter((n) => n.data.kind === "commit");
    const proposalNodesZh = zhTree.nodes.filter((n) => n.data.kind === "proposal");
    const prunedNodesZh = zhTree.nodes.filter((n) => n.data.kind === "pruned");

    expect(commitNodesZh.length).toBe(state.commits.length);
    expect(commitNodesZh[0]?.data.kind === "commit" && commitNodesZh[0].data.versionTag).toBe("v0");
    expect(
      commitNodesZh[commitNodesZh.length - 1]?.data.kind === "commit" &&
        commitNodesZh[commitNodesZh.length - 1]?.data.activeLabel,
    ).toBe("当前生效");
    expect(proposalNodesZh.length).toBe(2);
    expect(prunedNodesZh.length).toBe(1);
    expect(prunedNodesZh[0]?.data.kind === "pruned" && prunedNodesZh[0].data.label).toContain(
      "已剪枝",
    );
    expect(zhTree.edges.some((e) => e.animated === true)).toBe(true);

    const enTree = buildEvolutionTreeGraph({
      commits: state.commits,
      proposals: state.proposals,
      silentArchiveCount: state.silentArchiveCount,
      selectedCommitSha: state.selectedCommitSha,
      locale: "en-US",
    });
    const enHead = enTree.nodes.filter((n) => n.data.kind === "commit").pop();
    expect(enHead?.data.kind === "commit" && enHead.data.activeLabel).toBe("Active");
    const enPruned = enTree.nodes.find((n) => n.data.kind === "pruned");
    expect(enPruned?.data.kind === "pruned" && enPruned.data.label).toContain("Pruned");

    const zhCharts = buildDeckChartData({
      commits: state.commits,
      proposals: state.proposals,
      genomeFiles: state.genomeFiles,
      trustRecords: state.trustRecords,
      locale: "zh-CN",
    });
    expect(zhCharts.trend.length).toBe(state.commits.length + 1);
    expect(zhCharts.radar.map((r) => r.pillar)).toEqual([
      "记忆",
      "技能",
      "工具MCP",
      "钩子",
      "多代理",
      "安全沙盒",
    ]);
    expect(zhCharts.proposalBars.length).toBe(2);

    const enCharts = buildDeckChartData({
      commits: state.commits,
      proposals: state.proposals,
      genomeFiles: state.genomeFiles,
      trustRecords: state.trustRecords,
      locale: "en-US",
    });
    expect(enCharts.radar.map((r) => r.pillar)).toEqual([
      "Memory",
      "Skills",
      "MCP",
      "Hooks",
      "Agents",
      "Sandbox",
    ]);
  });

  it("localizes budget costSource badges, token counts, and unpriced model helpers cleanly in zh-CN and en-US", () => {
    const { budgetStatus } = useCommandDeckStore.getState();
    expect(budgetStatus?.costSource).toBe("estimated");
    expect(budgetStatus?.unpricedTokensToday).toBe(0);
    expect(budgetStatus?.unpricedModelsToday).toEqual([]);

    expect(formatTokens(84_000, "en-US")).toBe("84.0k");
    expect(formatTokens(84_000, "zh-CN")).toBe("8.4万");

    expect(resolveCostSourceBadge("estimated", "zh-CN").label).toBe("本地单价估算");
    expect(resolveCostSourceBadge("upstream_actual", "zh-CN").label).toBe("上游接口实付");
    expect(resolveCostSourceBadge("mixed", "zh-CN").label).toBe("实付+估算");
    expect(resolveCostSourceBadge("unpriced", "zh-CN").label).toBe("仅统计 Token");

    expect(resolveCostSourceBadge("estimated", "en-US").label).toBe("Est. by Pricing");
    expect(resolveCostSourceBadge("upstream_actual", "en-US").label).toBe("Upstream Actual");
    expect(resolveCostSourceBadge("mixed", "en-US").label).toBe("Mixed");
    expect(resolveCostSourceBadge("unpriced", "en-US").label).toBe("Tokens Only");

    expect(formatUnpricedSummary(budgetStatus, "en-US")).toBeNull();
    const unpricedSample = {
      unpricedTokensToday: 12_400,
      unpricedModelsToday: ["custom-r1", "local-coder"],
    };
    expect(formatUnpricedSummary(unpricedSample, "zh-CN")).toBe("2 个未定价模型（1.2万 Token）");
    expect(formatUnpricedSummary(unpricedSample, "en-US")).toBe(
      "2 unpriced model(s) (12.4k tokens)",
    );

    const initialRows = budgetStatus?.pricingTable ?? [];
    const added = appendUnpricedModelPricingRow(initialRows, "custom-r1");
    expect(added.length).toBe(initialRows.length + 1);
    expect(added[added.length - 1]).toEqual({
      modelId: "custom-r1",
      inputPer1MUsd: 0,
      outputPer1MUsd: 0,
    });
    expect(appendUnpricedModelPricingRow(added, "custom-r1")).toBe(added);
  });

  it("syncs model pricing catalog through store action with pure zh-CN & en-US toast localization", async () => {
    const store = useCommandDeckStore.getState();
    store.setLocale("zh-CN");

    const zhResult = await store.syncPricingCatalog(true);
    expect(zhResult?.synced).toBe(true);
    expect(zhResult?.source).toBe("embedded");
    expect(zhResult?.modelCount).toBe(248);

    const afterZh = useCommandDeckStore.getState();
    expect(afterZh.pricingSyncing).toBe(false);
    expect(afterZh.lastPricingSync?.modelCount).toBe(248);
    expect(afterZh.toasts[afterZh.toasts.length - 1]?.title).toBe("模型定价同步完成");
    expect(afterZh.toasts[afterZh.toasts.length - 1]?.detail).toContain("内置快照");

    afterZh.setLocale("en-US");
    await afterZh.syncPricingCatalog(false);
    const afterEn = useCommandDeckStore.getState();
    expect(afterEn.toasts[afterEn.toasts.length - 1]?.title).toBe("Model Pricing Synced");
    expect(afterEn.toasts[afterEn.toasts.length - 1]?.detail).toContain("Embedded Snapshot");
  });

  it("maintains a single IPC subscription under concurrent StrictMode initialize() calls and deduplicates toolCalls", async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 5 });
    let activeSubscribers = 0;
    const origSubscribe = adapter.subscribe.bind(adapter);
    adapter.subscribe = (listener) => {
      activeSubscribers += 1;
      const unsub = origSubscribe(listener);
      return () => {
        activeSubscribers -= 1;
        unsub();
      };
    };

    const store = useCommandDeckStore.getState();
    await Promise.all([store.initialize(adapter), store.initialize(adapter)]);
    expect(activeSubscribers).toBe(1);

    await store.startNewTaskPrompt("Verify StrictMode single subscription", "craft");
    const activeThreadId = useCommandDeckStore.getState().activeThreadId!;
    expect(activeThreadId).toBeTruthy();

    // Wait for mock run stream to complete and inspect recorded assistant tool calls
    await new Promise((r) => setTimeout(r, 80));
    const finalState = useCommandDeckStore.getState();
    const msgs = finalState.messagesByThread[activeThreadId] ?? [];
    const msgIds = msgs.map((m) => m.id);
    expect(new Set(msgIds).size).toBe(msgIds.length);
    const toolIds = msgs.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id));
    expect(toolIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(toolIds).size).toBe(toolIds.length);

    // Direct upsert guard against duplicate runner.tool_call events with the same toolCall.id
    finalState.handleIpcEvent({
      type: "runner.started",
      threadId: activeThreadId,
      runId: "run-dedupe",
      pinnedCommitSha: "a7f3c91",
      timestamp: new Date().toISOString(),
    });
    const dupTool = {
      id: "tc-dup-1",
      name: "shell.exec",
      args: { command: "ls" },
      status: "running" as const,
      truncated: false,
      startedAt: new Date().toISOString(),
    };
    finalState.handleIpcEvent({
      type: "runner.tool_call",
      threadId: activeThreadId,
      runId: "run-dedupe",
      toolCall: dupTool,
    });
    finalState.handleIpcEvent({
      type: "runner.tool_call",
      threadId: activeThreadId,
      runId: "run-dedupe",
      toolCall: { ...dupTool, status: "completed" },
    });

    const streamingCalls =
      useCommandDeckStore.getState().streamingByThread[activeThreadId]?.toolCalls ?? [];
    expect(streamingCalls.length).toBe(1);
    expect(streamingCalls[0]?.id).toBe("tc-dup-1");
    expect(streamingCalls[0]?.status).toBe("completed");
  });

  it("tracks guided Evolution Architect model override and records active modelId on assistant turns", async () => {
    const store = useCommandDeckStore.getState();
    store.setLocale("zh-CN");
    expect(store.guidedModelOverride).toBeUndefined();

    const defaultImprover = store.appConfig?.slots.improver ?? store.appConfig?.slots.solver;
    await store.sendGuidedMessage("memory", "使用 /skill csv-audit 梳理记忆格式", "降低人工反复提示");
    let turns = useCommandDeckStore.getState().guidedMessagesByBlueprint["memory"] ?? [];
    expect(turns[1]?.modelId).toBe(defaultImprover?.modelId);
    expect(useCommandDeckStore.getState().guidedLoading).toBe(false);

    store.setGuidedModelOverride({ providerId: "prov-anthropic", modelId: "claude-sonnet-4-5" });
    expect(useCommandDeckStore.getState().guidedModelOverride?.modelId).toBe("claude-sonnet-4-5");

    await useCommandDeckStore
      .getState()
      .sendGuidedMessage("memory", "结合 @memory/LongTermMEMORY.md 精简上下文", "");
    turns = useCommandDeckStore.getState().guidedMessagesByBlueprint["memory"] ?? [];
    expect(turns[turns.length - 1]?.modelId).toBe("claude-sonnet-4-5");
    expect(turns[turns.length - 1]?.providerId).toBe("prov-anthropic");

    useCommandDeckStore.getState().setGuidedModelOverride(undefined);
    expect(useCommandDeckStore.getState().guidedModelOverride).toBeUndefined();
    expect(translate("zh-CN", "lab.resetImprover")).toBe("恢复默认进化模型");
    expect(translate("en-US", "lab.resetImprover")).toBe("Improver Default");
  });

  it("supports thread rename/delete in store and forwards goal & improver overrides to triggerEvolution", async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    const store = useCommandDeckStore.getState();
    await store.initialize(adapter);

    const created = await store.createThread("Initial Task Name", "craft");
    await store.renameThread(created.id, "Polished Task Name");
    expect(
      useCommandDeckStore.getState().threads.find((th) => th.id === created.id)?.title,
    ).toBe("Polished Task Name");

    await store.deleteThread(created.id);
    const afterDelete = useCommandDeckStore.getState();
    expect(afterDelete.threads.some((th) => th.id === created.id)).toBe(false);
    expect(afterDelete.activeThreadId).toBe(afterDelete.threads[0]?.id ?? null);

    await afterDelete.triggerEvolution({
      domain: "memory",
      mode: "sequential",
      k: 2,
      goal: "Deduplicate LongTermMEMORY entries cleanly",
      improverModelOverride: "claude-sonnet-4-5",
      improverProviderIdOverride: "prov-anthropic",
    });

    expect(adapter.recordedEvolutionTriggers.slice(-1)[0]).toMatchObject({
      domain: "memory",
      mode: "sequential",
      k: 2,
      goal: "Deduplicate LongTermMEMORY entries cleanly",
      improverModelOverride: "claude-sonnet-4-5",
      improverProviderIdOverride: "prov-anthropic",
    });
  });

  it("refreshes budgetStatus & silentArchiveCount and pushes localized toasts on triggerEvolution, submitInlineRevision, and proposal_ready", async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    let budgetCalls = 0;
    let archiveCalls = 0;
    const origBudget = adapter.getBudgetStatus.bind(adapter);
    const origArchive = adapter.getSilentArchiveCount.bind(adapter);
    adapter.getBudgetStatus = async () => {
      budgetCalls += 1;
      return origBudget();
    };
    adapter.getSilentArchiveCount = async () => {
      archiveCalls += 1;
      return origArchive();
    };

    const store = useCommandDeckStore.getState();
    await store.initialize(adapter);
    store.setLocale("zh-CN");

    // 1. triggerEvolution ready proposal + refreshed telemetry + zh-CN toast
    const beforeTriggerBudget = budgetCalls;
    const beforeTriggerArchive = archiveCalls;
    await store.triggerEvolution({ domain: "memory", mode: "parallel", k: 2 });
    expect(budgetCalls).toBeGreaterThanOrEqual(beforeTriggerBudget + 1);
    expect(archiveCalls).toBeGreaterThanOrEqual(beforeTriggerArchive + 1);
    let lastToast = useCommandDeckStore.getState().toasts.slice(-1)[0];
    expect(lastToast?.title).toBe("进化提案已就绪");

    // 2. submitInlineRevision updates budgetStatus and pushes localized zh-CN toast
    await new Promise((r) => setTimeout(r, 5));
    const beforeRevBudget = budgetCalls;
    store.addInlineCommentDraft("prop-8", "scripts/safe_gbk_parse.ts", 10, "保留换行处理");
    await store.submitInlineRevision("prop-8");
    expect(budgetCalls).toBeGreaterThanOrEqual(beforeRevBudget + 1);
    lastToast = useCommandDeckStore.getState().toasts.slice(-1)[0];
    expect(lastToast?.title).toBe("定向重进化已完成");

    // 3. triggerEvolution catches errors cleanly with localized error toast and clears evolutionRunning
    adapter.triggerEvolution = async () => {
      throw new Error("boom-evo");
    };
    await store.triggerEvolution({ domain: "memory" });
    const afterErr = useCommandDeckStore.getState();
    expect(afterErr.evolutionRunning).toBe(false);
    expect(afterErr.toasts.slice(-1)[0]?.tone).toBe("error");
    expect(afterErr.toasts.slice(-1)[0]?.title).toBe("进化评测启动失败");

    // 4. evolution.proposal_ready event refreshes budgetStatus & silentArchiveCount asynchronously
    const beforeEventBudget = budgetCalls;
    const beforeEventArchive = archiveCalls;
    const sampleProposal = afterErr.proposals[0]!;
    afterErr.handleIpcEvent({
      type: "evolution.proposal_ready",
      proposal: sampleProposal,
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(budgetCalls).toBe(beforeEventBudget + 1);
    expect(archiveCalls).toBe(beforeEventArchive + 1);
  });
});
