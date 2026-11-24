import {
  ApprovalResolveParamsSchema,
  EvolutionArchitectAskResultSchema,
  EvolutionEventSchema,
  EvolutionProposalSchema,
  GenomeFileSchema,
  GlobalHookItemSchema,
  HarnessCompatibilityReportSchema,
  HarnessGardenerReportSchema,
  ImportPreviewSchema,
  OnboardingReplayTraceSchema,
  PricingSyncResultSchema,
  RunnerEventSchema,
  SecurityEventSchema,
  UpdateEventSchema,
  UpdateStatusSchema,
  type AggregatedModelEntry,
  type AppConfig,
  type ApprovalRequest,
  type ApprovalResolveParams,
  type BudgetStatus,
  type ChatMessage,
  type EvolutionArchitectAskParams,
  type EvolutionArchitectAskResult,
  type EvolutionProposal,
  type EvolutionProposalActionParams,
  type EvolutionReviseParams,
  type EvolutionTriggerParams,
  type ExecPolicyRule,
  type ExportScanResult,
  type GenomeCommit,
  type GenomeFile,
  type GlobalHookItem,
  type GuardianDecision,
  type HarnessCompatibilityReport,
  type HarnessGardenerReport,
  type ImportPreview,
  type OnboardingReplayTrace,
  type PricingSyncParams,
  type PricingSyncResult,
  type ProviderConfig,
  type ProviderImportResult,
  type ReplayCompareParams,
  type ReplayComparison,
  type RsiMode,
  type RunnerControlParams,
  type RunnerStartParams,
  type RunnerSteerParams,
  type SideChatAskParams,
  type SideChatAskResult,
  type SystemHealth,
  type Thread,
  type ThreadCreateParams,
  type ThreadDeleteParams,
  type ThreadRenameParams,
  type TrustRecord,
  type TrustStatus,
  type UpdateStatus,
} from "@harnex/protocol";
import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";
import { buildAggregatedModelCatalog } from "../features/providers/modelCatalog.ts";
import type {
  HarnexIpcClient,
  HarnexIpcEvent,
  LiveChallengeParams,
  MagpieImportParams,
  PingProviderResult,
  SaveHookParams,
  SaveProviderParams,
  UpdateBudgetSettingsParams,
} from "./types.ts";

export const HarnexIpcEventSchema = z.union([
  RunnerEventSchema,
  SecurityEventSchema,
  EvolutionEventSchema,
  UpdateEventSchema,
]);

export type TauriInvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type TauriListenFn = <T>(
  event: string,
  handler: EventCallback<T>,
) => Promise<UnlistenFn>;

export interface TauriTransport {
  invoke?: TauriInvokeFn;
  listen?: TauriListenFn;
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/**
 * Production Tauri IPC client aligned 1:1 with `apps/desktop/src-tauri/src/tray.rs`
 * commands and JSON-RPC Sidecar bridge.
 */
export class TauriIpcAdapter implements HarnexIpcClient {
  public readonly mode = "tauri" as const;
  private readonly invokeCmd: TauriInvokeFn;
  private readonly listenEvt: TauriListenFn;

  constructor(transport?: TauriTransport) {
    this.invokeCmd = transport?.invoke ?? invoke;
    this.listenEvt = transport?.listen ?? listen;
  }

  private rpc<T>(method: string, params?: unknown): Promise<T> {
    return this.invokeCmd<T>("sidecar_rpc", { method, params: params ?? {} });
  }

  async getSystemHealth(): Promise<SystemHealth> {
    const raw = await this.invokeCmd<
      Omit<SystemHealth, "osSandboxLevel"> & { osSandboxLevel: string }
    >("get_system_health");
    return {
      ...raw,
      osSandboxLevel: raw.osSandboxLevel === "full" ? "full" : "beta",
    };
  }

  getAppConfig(): Promise<AppConfig> {
    return this.rpc<AppConfig>("config.get");
  }

  updateAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    return this.rpc<AppConfig>("config.update", patch);
  }

  setRsiMode(mode: RsiMode): Promise<AppConfig> {
    return this.rpc<AppConfig>("config.set_rsi_mode", { rsiMode: mode });
  }

  async getOnboardingReplay(): Promise<OnboardingReplayTrace> {
    const raw = await this.rpc<unknown>("onboarding.get_replay");
    return OnboardingReplayTraceSchema.parse(raw);
  }

  startLiveChallenge(params: LiveChallengeParams): Promise<Thread> {
    return this.rpc<Thread>("onboarding.start_live_challenge", params);
  }

  listThreads(): Promise<Thread[]> {
    return this.rpc<Thread[]>("thread.list");
  }

  getThreadMessages(threadId: string): Promise<ChatMessage[]> {
    return this.rpc<ChatMessage[]>("thread.messages", { threadId });
  }

  createThread(params: ThreadCreateParams): Promise<Thread> {
    return this.rpc<Thread>("thread.create", params);
  }

  renameThread(params: ThreadRenameParams): Promise<Thread> {
    return this.rpc<Thread>("thread.rename", params);
  }

  deleteThread(params: ThreadDeleteParams): Promise<void> {
    return this.rpc<void>("thread.delete", params);
  }

  startRun(params: RunnerStartParams): Promise<{ runId: string }> {
    return this.rpc<{ runId: string }>("runner.start", params);
  }

  pauseRun(params: RunnerControlParams): Promise<void> {
    return this.rpc<void>("runner.pause", params);
  }

  steerRun(params: RunnerSteerParams): Promise<void> {
    return this.rpc<void>("runner.steer", params);
  }

  resumeRun(params: RunnerControlParams): Promise<void> {
    return this.rpc<void>("runner.resume", params);
  }

  abortRun(params: RunnerControlParams): Promise<void> {
    return this.rpc<void>("runner.abort", params);
  }

  askSideChat(params: SideChatAskParams): Promise<SideChatAskResult> {
    return this.rpc<SideChatAskResult>("sidechat.ask", params);
  }

  listPendingApprovals(): Promise<ApprovalRequest[]> {
    return this.invokeCmd<ApprovalRequest[]>("security_list_pending_approvals");
  }

  resolveApproval(params: ApprovalResolveParams): Promise<void> {
    const parsed = ApprovalResolveParamsSchema.parse(params);
    return this.invokeCmd<void>("security_resolve_approval", {
      params: {
        requestId: parsed.requestId,
        decision: parsed.decision,
      },
    });
  }

  listExecPolicyRules(): Promise<ExecPolicyRule[]> {
    return this.invokeCmd<ExecPolicyRule[]>("security_list_exec_policy");
  }

  upsertExecPolicyRule(rule: ExecPolicyRule): Promise<ExecPolicyRule[]> {
    return this.invokeCmd<ExecPolicyRule[]>("security_upsert_exec_policy", { rule });
  }

  deleteExecPolicyRule(ruleId: string): Promise<ExecPolicyRule[]> {
    return this.invokeCmd<ExecPolicyRule[]>("security_delete_exec_policy", { ruleId });
  }

  listTrustRecords(): Promise<TrustRecord[]> {
    return this.invokeCmd<TrustRecord[]>("trust_list_records");
  }

  updateTrustStatus(id: string, status: TrustStatus): Promise<TrustRecord[]> {
    return this.invokeCmd<TrustRecord[]>("trust_update_status", { id, status });
  }

  listGuardianDecisions(): Promise<GuardianDecision[]> {
    return this.invokeCmd<GuardianDecision[]>("guardian_list_decisions");
  }

  async listHooks(): Promise<GlobalHookItem[]> {
    const raw = await this.invokeCmd<unknown[]>("hooks_list");
    return raw.map((item) => GlobalHookItemSchema.parse(item));
  }

  async saveHook(params: SaveHookParams): Promise<GlobalHookItem> {
    const raw = await this.invokeCmd<unknown>("hooks_upsert", {
      path: params.path,
      event: params.event,
      content: params.content,
      trustImmediately: params.trustImmediately,
    });
    return GlobalHookItemSchema.parse(raw);
  }

  deleteHook(path: string): Promise<void> {
    return this.invokeCmd<void>("hooks_delete", { path });
  }

  listProposals(): Promise<EvolutionProposal[]> {
    return this.rpc<EvolutionProposal[]>("evolution.triage_list");
  }

  getSilentArchiveCount(): Promise<number> {
    return this.rpc<number>("evolution.silent_archive_count");
  }

  async askEvolutionArchitect(
    params: EvolutionArchitectAskParams,
  ): Promise<EvolutionArchitectAskResult> {
    const raw = await this.rpc<unknown>("evolution.architect_chat", params);
    return EvolutionArchitectAskResultSchema.parse(raw);
  }

  triggerEvolution(params: EvolutionTriggerParams): Promise<EvolutionProposal> {
    return this.rpc<EvolutionProposal>("evolution.trigger", params);
  }

  reviseProposalWithComments(params: EvolutionReviseParams): Promise<EvolutionProposal> {
    return this.rpc<EvolutionProposal>("evolution.revise_with_comments", params);
  }

  adoptProposal(params: EvolutionProposalActionParams): Promise<{
    proposal: EvolutionProposal;
    newCommit?: GenomeCommit;
  }> {
    return this.rpc("evolution.adopt", params);
  }

  rejectProposal(params: EvolutionProposalActionParams): Promise<EvolutionProposal> {
    return this.rpc<EvolutionProposal>("evolution.reject", params);
  }

  async checkHarnessCompatibility(): Promise<HarnessCompatibilityReport> {
    const raw = await this.rpc<unknown>("evolution.check_compatibility");
    return HarnessCompatibilityReportSchema.parse(raw);
  }

  async startHarnessMigration(report?: HarnessCompatibilityReport): Promise<EvolutionProposal> {
    const raw = await this.rpc<unknown>("evolution.start_migration", { report });
    return EvolutionProposalSchema.parse(raw);
  }

  async getGardenerReport(): Promise<HarnessGardenerReport> {
    const raw = await this.rpc<unknown>("evolution.gardener_report", {});
    return HarnessGardenerReportSchema.parse(raw);
  }

  listCommits(): Promise<GenomeCommit[]> {
    return this.invokeCmd<GenomeCommit[]>("git_log", { limit: 50 });
  }

  async readGenomeTree(commitSha: string): Promise<GenomeFile[]> {
    const raw = await this.invokeCmd<unknown[]>("git_read_tree", { commitSha });
    return raw.map((entry) => GenomeFileSchema.parse(entry));
  }

  revertToCommit(targetSha: string, reason: string): Promise<GenomeCommit> {
    return this.invokeCmd<GenomeCommit>("git_revert", { targetSha, reason });
  }

  scanExport(): Promise<ExportScanResult> {
    return this.invokeCmd<ExportScanResult>("git_scan_export");
  }

  confirmExport(stripFindings: boolean): Promise<{ archivePath: string; fileCount: number }> {
    return this.invokeCmd<{ archivePath: string; fileCount: number }>("git_confirm_export", {
      stripFindings,
    });
  }

  async previewImport(archivePath: string): Promise<ImportPreview> {
    const raw = await this.invokeCmd<unknown>("trust_preview_import", { archivePath });
    return ImportPreviewSchema.parse(raw);
  }

  /**
   * Rust L0 `trust_execute_import` enforces zero-trust on import and rejects non-empty
   * `trustPaths`. Imported executables always start disabled in Trust Store and are
   * individually verified/approved afterwards via `trust_update_status`.
   */
  executeImport(archivePath: string, _trustPaths: string[]): Promise<{ importedCount: number }> {
    return this.invokeCmd<{ importedCount: number }>("trust_execute_import", {
      archivePath,
      trustPaths: [],
    });
  }

  runReplayCompare(params: ReplayCompareParams): Promise<ReplayComparison> {
    return this.rpc<ReplayComparison>("replay.compare", params);
  }

  listProviders(): Promise<ProviderConfig[]> {
    return this.rpc<ProviderConfig[]>("provider.list");
  }

  async getAggregatedCatalog(): Promise<AggregatedModelEntry[]> {
    try {
      const catalog = await this.rpc<AggregatedModelEntry[]>("provider.catalog");
      if (Array.isArray(catalog)) {
        return catalog;
      }
    } catch {
      // Fallback gracefully to client-side aggregation when Sidecar omits provider.catalog
    }
    return buildAggregatedModelCatalog(await this.listProviders());
  }

  saveProvider(params: SaveProviderParams): Promise<ProviderConfig> {
    const trimmedKey = params.apiKey?.trim();
    const payload: Record<string, unknown> = {
      provider: trimmedKey
        ? { ...params.provider, hasApiKey: true }
        : params.provider,
    };
    if (trimmedKey) {
      payload.apiKey = trimmedKey;
    }
    if (params.keyAdditions && params.keyAdditions.length > 0) {
      payload.keyAdditions = params.keyAdditions;
    }
    if (params.keyRemovals && params.keyRemovals.length > 0) {
      payload.keyRemovals = params.keyRemovals;
    }
    return this.rpc<ProviderConfig>("provider.save", payload);
  }

  deleteProvider(providerId: string): Promise<void> {
    return this.rpc<void>("provider.delete", { providerId });
  }

  pingProvider(providerId: string): Promise<PingProviderResult> {
    return this.rpc<PingProviderResult>("provider.ping", { providerId });
  }

  fetchProviderModels(providerId: string): Promise<string[]> {
    return this.rpc<string[]>("provider.fetch_models", { providerId });
  }

  importFromCcSwitch(_simulateUnavailable?: boolean): Promise<ProviderImportResult> {
    return this.rpc<ProviderImportResult>("provider.import_cc_switch");
  }

  importFromMagpie(
    params?: string | MagpieImportParams,
    _simulateUnavailable?: boolean,
  ): Promise<ProviderImportResult> {
    const resolved =
      typeof params === "string" ? { gatewayUrl: params } : (params ?? {});
    const payload: Record<string, unknown> = {};
    if (resolved.gatewayUrl?.trim()) payload.gatewayUrl = resolved.gatewayUrl.trim();
    if (resolved.importLink?.trim()) payload.importLink = resolved.importLink.trim();
    return this.rpc<ProviderImportResult>("provider.import_magpie", payload);
  }

  getBudgetStatus(): Promise<BudgetStatus> {
    return this.invokeCmd<BudgetStatus>("budget_get_status");
  }

  updateBudgetSettings(params: UpdateBudgetSettingsParams): Promise<BudgetStatus> {
    return this.invokeCmd<BudgetStatus>("budget_update_settings", {
      params: {
        dailyLimitUsd: params.dailyLimitUsd,
        pricingTable: params.pricingTable,
      },
    });
  }

  async syncPricingCatalog(params?: PricingSyncParams): Promise<PricingSyncResult> {
    return PricingSyncResultSchema.parse(
      await this.invokeCmd<unknown>("budget_sync_pricing", {
        params: params ?? {},
      }),
    );
  }

  async getUpdateStatus(): Promise<UpdateStatus> {
    return UpdateStatusSchema.parse(await this.invokeCmd<unknown>("updater_get_status"));
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    return UpdateStatusSchema.parse(await this.invokeCmd<unknown>("updater_check"));
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    return UpdateStatusSchema.parse(await this.invokeCmd<unknown>("updater_download"));
  }

  async installUpdate(): Promise<UpdateStatus> {
    return UpdateStatusSchema.parse(await this.invokeCmd<unknown>("updater_install"));
  }

  subscribe(listener: (event: HarnexIpcEvent) => void): () => void {
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    void this.listenEvt<unknown>("harnex://event", (ev) => {
      if (!active) return;
      const parsed = HarnexIpcEventSchema.safeParse(ev.payload);
      if (parsed.success) {
        listener(parsed.data);
      } else {
        console.warn("[harnex] Ignored malformed harnex://event payload:", parsed.error.issues);
      }
    }).then((unlisten) => {
      if (active) unlisteners.push(unlisten);
      else unlisten();
    });
    return () => {
      active = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }
}
