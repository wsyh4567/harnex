import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { OnboardingReplayTraceSchema } from "@harnex/protocol";
import recordedReplayJson from "../../../../examples/first-run-challenge/recorded_replay.json";
import type { HarnexIpcEvent } from "../ipc/types.ts";

interface RecordedInvoke {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

const recordedInvokes: RecordedInvoke[] = [];
let mockEventHandler: ((ev: { payload: unknown }) => void) | null = null;
let invokeResponseFactory: (cmd: string, args?: Record<string, unknown>) => unknown = () => ({});

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    recordedInvokes.push({ cmd, args });
    return invokeResponseFactory(cmd, args);
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (_event: string, handler: (ev: { payload: unknown }) => void) => {
    mockEventHandler = handler;
    return () => {
      mockEventHandler = null;
    };
  },
}));

const { createIpcClient, isTauriRuntime, MockIpcAdapter, TauriIpcAdapter } = await import(
  "../ipc/index.ts"
);

describe("TauriIpcAdapter 1:1 Parity with tray.rs & Runtime Selection", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    recordedInvokes.length = 0;
    mockEventHandler = null;
    invokeResponseFactory = () => ({});
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("createIpcClient selects TauriIpcAdapter inside Tauri runtime and MockIpcAdapter outside", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(isTauriRuntime()).toBe(false);
    expect(createIpcClient().mode).toBe("mock");

    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(isTauriRuntime()).toBe(true);
    expect(createIpcClient().mode).toBe("tauri");
  });

  it("matches tray.rs security & trust command names and argument envelopes", async () => {
    const adapter = new TauriIpcAdapter();

    invokeResponseFactory = (cmd) => {
      if (cmd === "security_list_pending_approvals") return [];
      if (cmd === "security_list_exec_policy") return [];
      if (cmd === "security_upsert_exec_policy") return [];
      if (cmd === "security_delete_exec_policy") return [];
      if (cmd === "trust_list_records") return [];
      if (cmd === "trust_update_status") return [];
      if (cmd === "guardian_list_decisions") return [];
      return undefined;
    };

    await adapter.listPendingApprovals();
    await adapter.resolveApproval({ requestId: "apr-1", decision: "allow_once" });
    await adapter.listExecPolicyRules();
    await adapter.upsertExecPolicyRule({
      id: "r1",
      prefix: "git status",
      action: "allow",
      description: "read only",
    });
    await adapter.deleteExecPolicyRule("r1");
    await adapter.listTrustRecords();
    await adapter.updateTrustStatus("tr-1", "trusted");
    await adapter.listGuardianDecisions();

    expect(recordedInvokes).toEqual([
      { cmd: "security_list_pending_approvals", args: undefined },
      {
        cmd: "security_resolve_approval",
        args: { params: { requestId: "apr-1", decision: "allow_once" } },
      },
      { cmd: "security_list_exec_policy", args: undefined },
      {
        cmd: "security_upsert_exec_policy",
        args: {
          rule: { id: "r1", prefix: "git status", action: "allow", description: "read only" },
        },
      },
      { cmd: "security_delete_exec_policy", args: { ruleId: "r1" } },
      { cmd: "trust_list_records", args: undefined },
      { cmd: "trust_update_status", args: { id: "tr-1", status: "trusted" } },
      { cmd: "guardian_list_decisions", args: undefined },
    ]);
  });

  it("matches tray.rs git, zero-trust import, and budget commands 1:1", async () => {
    const adapter = new TauriIpcAdapter();

    invokeResponseFactory = (cmd) => {
      if (cmd === "git_log") return [];
      if (cmd === "git_read_tree") {
        return [
          {
            path: "scripts/safe_gbk_parse.ts",
            content: "console.log('ok');",
            sizeBytes: 18,
            component: "scripts",
          },
        ];
      }
      if (cmd === "git_revert") {
        return {
          sha: "abc1234",
          versionTag: "v2",
          message: "Revert",
          timestamp: "2026-11-20T00:00:00Z",
          changedComponents: [],
          isRollback: true,
        };
      }
      if (cmd === "git_scan_export") {
        return { includedFiles: [], excludedFiles: [], findings: [], safeToExport: true };
      }
      if (cmd === "git_confirm_export") {
        return { archivePath: "/tmp/bundle.json", fileCount: 3 };
      }
      if (cmd === "trust_preview_import") {
        return {
          archivePath: "/tmp/in.json",
          files: ["scripts/a.ts"],
          untrustedExecutables: ["scripts/a.ts"],
        };
      }
      if (cmd === "trust_execute_import") {
        return { importedCount: 1 };
      }
      if (cmd === "budget_get_status" || cmd === "budget_update_settings") {
        return {
          dailyLimitUsd: 8,
          spentTodayUsd: 0.1,
          tokensToday: 100,
          tripped: false,
          pricingTable: [],
        };
      }
      if (cmd === "budget_sync_pricing") {
        return {
          synced: true,
          source: "remote",
          modelCount: 312,
          updatedAt: "2026-11-20T15:50:00.000Z",
        };
      }
      return undefined;
    };

    await adapter.listCommits();
    const files = await adapter.readGenomeTree("sha-v1");
    expect(files[0]?.component).toBe("scripts");
    await adapter.revertToCommit("sha-v0", "regression");
    await adapter.scanExport();
    await adapter.confirmExport(true);
    await adapter.previewImport("/tmp/in.json");
    // Even if caller supplies trustPaths, TauriIpcAdapter sends trustPaths: [] to satisfy tray.rs L0 zero-trust
    await adapter.executeImport("/tmp/in.json", ["scripts/a.ts"]);
    await adapter.getBudgetStatus();
    await adapter.updateBudgetSettings({
      dailyLimitUsd: 8,
      pricingTable: [{ modelId: "gpt-4.1-mini", inputPer1MUsd: 0.4, outputPer1MUsd: 1.6 }],
    });
    const syncRes = await adapter.syncPricingCatalog({ force: true });
    expect(syncRes).toEqual({
      synced: true,
      source: "remote",
      modelCount: 312,
      updatedAt: "2026-11-20T15:50:00.000Z",
    });

    expect(recordedInvokes).toEqual([
      { cmd: "git_log", args: { limit: 50 } },
      { cmd: "git_read_tree", args: { commitSha: "sha-v1" } },
      { cmd: "git_revert", args: { targetSha: "sha-v0", reason: "regression" } },
      { cmd: "git_scan_export", args: undefined },
      { cmd: "git_confirm_export", args: { stripFindings: true } },
      { cmd: "trust_preview_import", args: { archivePath: "/tmp/in.json" } },
      {
        cmd: "trust_execute_import",
        args: { archivePath: "/tmp/in.json", trustPaths: [] },
      },
      { cmd: "budget_get_status", args: undefined },
      {
        cmd: "budget_update_settings",
        args: {
          params: {
            dailyLimitUsd: 8,
            pricingTable: [{ modelId: "gpt-4.1-mini", inputPer1MUsd: 0.4, outputPer1MUsd: 1.6 }],
          },
        },
      },
      {
        cmd: "budget_sync_pricing",
        args: {
          params: { force: true },
        },
      },
    ]);
  });

  it("handles provider.save apiKey trimming and sidecar_rpc envelopes cleanly", async () => {
    const adapter = new TauriIpcAdapter();
    invokeResponseFactory = () => ({
      id: "p1",
      name: "OpenAI",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4.1-mini"],
      keyringRef: "harnex/provider/p1",
      hasApiKey: true,
      source: "manual",
      enabled: true,
    });

    await adapter.saveProvider({
      provider: {
        name: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4.1-mini"],
        source: "manual",
        enabled: true,
      },
      apiKey: "  sk-test-123  ",
    });

    await adapter.saveProvider({
      provider: {
        id: "p1",
        name: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4.1-mini"],
        source: "manual",
        enabled: true,
      },
      apiKey: "   ",
    });

    expect(recordedInvokes[0]).toEqual({
      cmd: "sidecar_rpc",
      args: {
        method: "provider.save",
        params: {
          provider: {
            name: "OpenAI",
            kind: "openai",
            baseUrl: "https://api.openai.com/v1",
            models: ["gpt-4.1-mini"],
            source: "manual",
            enabled: true,
            hasApiKey: true,
          },
          apiKey: "sk-test-123",
        },
      },
    });

    expect(recordedInvokes[1]).toEqual({
      cmd: "sidecar_rpc",
      args: {
        method: "provider.save",
        params: {
          provider: {
            id: "p1",
            name: "OpenAI",
            kind: "openai",
            baseUrl: "https://api.openai.com/v1",
            models: ["gpt-4.1-mini"],
            source: "manual",
            enabled: true,
          },
        },
      },
    });
  });

  it("validates harnex://event payloads and drops malformed events", async () => {
    const adapter = new TauriIpcAdapter();
    const received: HarnexIpcEvent[] = [];
    const unsub = adapter.subscribe((ev) => received.push(ev));

    // Allow microtask if any
    await Promise.resolve();
    expect(mockEventHandler).not.toBeNull();

    mockEventHandler?.({
      payload: {
        type: "security.approval_resolved",
        requestId: "apr-1",
        decision: "allow_once",
      },
    });
    mockEventHandler?.({
      payload: {
        type: "runner.paused",
        threadId: "thr-1",
      },
    });
    // Malformed payload should be ignored without throwing
    mockEventHandler?.({
      payload: { type: "unknown.broken", bad: 123 },
    });

    expect(received.length).toBe(2);
    expect(received[0]?.type).toBe("security.approval_resolved");
    expect(received[1]?.type).toBe("runner.paused");
    unsub();
  });

  it("loads examples/first-run-challenge/recorded_replay.json identically in Mock & Tauri adapters", async () => {
    const mockAdapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    const mockReplay = await mockAdapter.getOnboardingReplay();
    const expected = OnboardingReplayTraceSchema.parse(recordedReplayJson);

    expect(mockReplay).toEqual(expected);

    const tauriAdapter = new TauriIpcAdapter();
    invokeResponseFactory = (cmd, args) => {
      if (cmd === "sidecar_rpc" && args?.method === "onboarding.get_replay") {
        return recordedReplayJson;
      }
      return undefined;
    };
    const tauriReplay = await tauriAdapter.getOnboardingReplay();
    expect(tauriReplay).toEqual(expected);
  });

  it("matches tray.rs updater_* commands and validates update.status_changed events", async () => {
    const adapter = new TauriIpcAdapter();
    invokeResponseFactory = (cmd) => ({
      phase: cmd === "updater_install" ? "installing" : cmd === "updater_download" ? "ready" : "available",
      info: { currentVersion: "0.1.0", latestVersion: "0.2.0", compatLevel: "safe" },
      downloadedBytes: 100,
      totalBytes: 100,
      verifiedSha256: cmd === "updater_download" || cmd === "updater_install",
      backupTag: cmd === "updater_install" ? "pre-update-v0.1.0-to-v0.2.0" : undefined,
    });

    const received: HarnexIpcEvent[] = [];
    const unsub = adapter.subscribe((ev) => received.push(ev));
    await Promise.resolve();

    await adapter.getUpdateStatus();
    await adapter.checkForUpdates();
    await adapter.downloadUpdate();
    await adapter.installUpdate();

    expect(recordedInvokes.map((c) => c.cmd)).toEqual([
      "updater_get_status",
      "updater_check",
      "updater_download",
      "updater_install",
    ]);

    mockEventHandler?.({
      payload: {
        type: "update.status_changed",
        status: {
          phase: "downloading",
          info: { currentVersion: "0.1.0", latestVersion: "0.2.0", compatLevel: "breaking" },
          downloadedBytes: 50,
          totalBytes: 100,
          verifiedSha256: false,
        },
      },
    });
    expect(received[0]?.type).toBe("update.status_changed");
    unsub();
  });

  it("matches tray.rs hooks_list, hooks_upsert, and hooks_delete commands 1:1", async () => {
    const adapter = new TauriIpcAdapter();
    const sampleHook = {
      path: "hooks/trim.ts",
      name: "trim",
      event: "PostToolUse",
      content: "export default function trim() { return { ok: true }; }",
      sha256: "a".repeat(64),
      status: "trusted",
      origin: "user_installed",
      updatedAt: "2026-11-20T10:00:00Z",
    };

    invokeResponseFactory = (cmd) => {
      if (cmd === "hooks_list") return [sampleHook];
      if (cmd === "hooks_upsert") return sampleHook;
      return undefined;
    };

    const listed = await adapter.listHooks();
    const upserted = await adapter.saveHook({
      path: "hooks/trim.ts",
      event: "PostToolUse",
      content: sampleHook.content,
      trustImmediately: true,
    });
    await adapter.deleteHook("hooks/trim.ts");

    expect(listed).toHaveLength(1);
    expect(upserted.path).toBe("hooks/trim.ts");
    expect(recordedInvokes).toEqual([
      { cmd: "hooks_list", args: undefined },
      {
        cmd: "hooks_upsert",
        args: {
          path: "hooks/trim.ts",
          event: "PostToolUse",
          content: sampleHook.content,
          trustImmediately: true,
        },
      },
      { cmd: "hooks_delete", args: { path: "hooks/trim.ts" } },
    ]);
  });

  it("invokes evolution.architect_chat, thread.rename, thread.delete, and forwards evolution.trigger overrides", async () => {
    const adapter = new TauriIpcAdapter();
    invokeResponseFactory = (cmd, args) => {
      if (cmd !== "sidecar_rpc") return undefined;
      if (args?.method === "evolution.architect_chat") {
        return {
          reply: "Grounded in `memory/LongTermMEMORY.md`: add strict schema check.",
          suggestedGoal: "Validate CSV columns via csv-audit skill with 0 errors.",
          modelId: "claude-sonnet-4-5",
          usage: {
            inputTokens: 210,
            outputTokens: 64,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            costUsd: 0.0018,
          },
        };
      }
      if (args?.method === "thread.rename") {
        return {
          id: "thr-1",
          workspacePath: "~/Work",
          title: "Renamed Billing Audit",
          mode: "craft",
          status: "idle",
          pinnedCommitSha: "a7f3c91",
          domain: "file_ops",
          goals: [],
          contextUsedTokens: 0,
          contextMaxTokens: 128000,
          sourceTags: ["local"],
          hadHumanSteer: false,
          createdAt: "2026-11-24T00:00:00Z",
          updatedAt: "2026-11-24T00:01:00Z",
        };
      }
      if (args?.method === "evolution.trigger") {
        return {
          id: "prop-99",
          threadId: "thr-1",
          domain: "memory",
          title: "Goal-driven memory evolution",
          mode: "parallel",
          k: 2,
          triggerSource: "manual",
          sourceTags: ["local"],
          requiresHumanTrust: false,
          baseCommitSha: "a7f3c91",
          status: "ready",
          metricsBefore: { steps: 4, errors: 1, durationMs: 5000, tokens: 1200, costUsd: 0.01 },
          metricsAfter: { steps: 2, errors: 0, durationMs: 2500, tokens: 800, costUsd: 0.006 },
          diffs: [],
          inlineComments: [],
          createdAt: "2026-11-24T00:00:00Z",
          updatedAt: "2026-11-24T00:01:00Z",
        };
      }
      return undefined;
    };

    const arch = await adapter.askEvolutionArchitect({
      pillarId: "memory",
      pillarTitle: "1. Memory System",
      domain: "memory",
      message: "Prevent duplicate memory entries",
      goalDraft: "Deduplicate facts",
      history: [{ role: "user", content: "Earlier note" }],
      modelOverride: "claude-sonnet-4-5",
      providerIdOverride: "prov-anthropic",
      locale: "en-US",
    });
    expect(arch.suggestedGoal).toContain("csv-audit");
    expect(arch.modelId).toBe("claude-sonnet-4-5");

    const renamed = await adapter.renameThread({
      threadId: "thr-1",
      title: "Renamed Billing Audit",
    });
    expect(renamed.title).toBe("Renamed Billing Audit");

    await adapter.deleteThread({ threadId: "thr-1" });

    await adapter.triggerEvolution({
      threadId: "thr-1",
      domain: "memory",
      mode: "parallel",
      k: 2,
      triggerSource: "manual",
      goal: "Deduplicate facts cleanly",
      improverModelOverride: "claude-sonnet-4-5",
      improverProviderIdOverride: "prov-anthropic",
    });

    expect(recordedInvokes.map((c) => c.args)).toEqual([
      {
        method: "evolution.architect_chat",
        params: {
          pillarId: "memory",
          pillarTitle: "1. Memory System",
          domain: "memory",
          message: "Prevent duplicate memory entries",
          goalDraft: "Deduplicate facts",
          history: [{ role: "user", content: "Earlier note" }],
          modelOverride: "claude-sonnet-4-5",
          providerIdOverride: "prov-anthropic",
          locale: "en-US",
        },
      },
      {
        method: "thread.rename",
        params: { threadId: "thr-1", title: "Renamed Billing Audit" },
      },
      {
        method: "thread.delete",
        params: { threadId: "thr-1" },
      },
      {
        method: "evolution.trigger",
        params: {
          threadId: "thr-1",
          domain: "memory",
          mode: "parallel",
          k: 2,
          triggerSource: "manual",
          goal: "Deduplicate facts cleanly",
          improverModelOverride: "claude-sonnet-4-5",
          improverProviderIdOverride: "prov-anthropic",
        },
      },
    ]);
  });
});
