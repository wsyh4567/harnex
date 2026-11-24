import type {
  AggregatedModelEntry,
  AppConfig,
  ApprovalRequest,
  ApprovalResolveParams,
  BudgetStatus,
  ChatMessage,
  EvolutionArchitectAskParams,
  EvolutionArchitectAskResult,
  EvolutionEvent,
  EvolutionProposal,
  EvolutionProposalActionParams,
  EvolutionReviseParams,
  EvolutionTriggerParams,
  ExecPolicyRule,
  ExportScanResult,
  GenomeCommit,
  GenomeFile,
  GlobalHookItem,
  GuardianDecision,
  HarnessCompatibilityReport,
  HarnessGardenerReport,
  ImportPreview,
  ModelPricing,
  OnboardingReplayTrace,
  PricingSyncParams,
  PricingSyncResult,
  ProviderConfig,
  ProviderImportResult,
  ReplayCompareParams,
  ReplayComparison,
  RsiMode,
  RunnerControlParams,
  RunnerEvent,
  RunnerStartParams,
  RunnerSteerParams,
  SecurityEvent,
  SideChatAskParams,
  SideChatAskResult,
  SystemHealth,
  Thread,
  ThreadCreateParams,
  ThreadDeleteParams,
  ThreadRenameParams,
  TrustRecord,
  TrustStatus,
  UpdateEvent,
  UpdateStatus,
} from "@harnex/protocol";

export type HarnexIpcEvent = RunnerEvent | SecurityEvent | EvolutionEvent | UpdateEvent;

export interface LiveChallengeParams {
  dataset: "dataset_a" | "dataset_b";
  solverModelId?: string;
}

export interface ProviderKeyAddition {
  id?: string;
  label: string;
  apiKey: string;
  priority?: number;
  enabled?: boolean;
}

export interface SaveProviderParams {
  provider: Omit<ProviderConfig, "id" | "hasApiKey" | "keyringRef"> & {
    id?: string;
    keyringRef?: string;
    hasApiKey?: boolean;
  };
  apiKey?: string;
  keyAdditions?: ProviderKeyAddition[];
  keyRemovals?: string[];
}

export interface UpdateBudgetSettingsParams {
  dailyLimitUsd: number;
  pricingTable: ModelPricing[];
}

export interface MagpieImportParams {
  gatewayUrl?: string;
  importLink?: string;
}

export interface PingProviderResult {
  providerId: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

export type GlobalHookEvent = GlobalHookItem["event"];

export interface SaveHookParams {
  path: string;
  event: GlobalHookEvent;
  content: string;
  trustImmediately: boolean;
}

export interface HarnexIpcClient {
  readonly mode: "mock" | "tauri";

  // System & App Config
  getSystemHealth(): Promise<SystemHealth>;
  getAppConfig(): Promise<AppConfig>;
  updateAppConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  setRsiMode(mode: RsiMode): Promise<AppConfig>;

  // F0: Onboarding Dual-Mode
  getOnboardingReplay(): Promise<OnboardingReplayTrace>;
  startLiveChallenge(params: LiveChallengeParams): Promise<Thread>;

  // F1: Multi-Thread & Runner Controls
  listThreads(): Promise<Thread[]>;
  getThreadMessages(threadId: string): Promise<ChatMessage[]>;
  createThread(params: ThreadCreateParams): Promise<Thread>;
  renameThread(params: ThreadRenameParams): Promise<Thread>;
  deleteThread(params: ThreadDeleteParams): Promise<void>;
  startRun(params: RunnerStartParams): Promise<{ runId: string }>;
  pauseRun(params: RunnerControlParams): Promise<void>;
  steerRun(params: RunnerSteerParams): Promise<void>;
  resumeRun(params: RunnerControlParams): Promise<void>;
  abortRun(params: RunnerControlParams): Promise<void>;
  askSideChat(params: SideChatAskParams): Promise<SideChatAskResult>;

  // F2: L0 Security, Approvals, ExecPolicy, Trust Store & Guardian
  listPendingApprovals(): Promise<ApprovalRequest[]>;
  resolveApproval(params: ApprovalResolveParams): Promise<void>;
  listExecPolicyRules(): Promise<ExecPolicyRule[]>;
  upsertExecPolicyRule(rule: ExecPolicyRule): Promise<ExecPolicyRule[]>;
  deleteExecPolicyRule(ruleId: string): Promise<ExecPolicyRule[]>;
  listTrustRecords(): Promise<TrustRecord[]>;
  updateTrustStatus(id: string, status: TrustStatus): Promise<TrustRecord[]>;
  listGuardianDecisions(): Promise<GuardianDecision[]>;

  // Global Hooks Manager
  listHooks(): Promise<GlobalHookItem[]>;
  saveHook(params: SaveHookParams): Promise<GlobalHookItem>;
  deleteHook(path: string): Promise<void>;

  // F3: Evolution Triage, Theater & Inline Diff Revision
  listProposals(): Promise<EvolutionProposal[]>;
  getSilentArchiveCount(): Promise<number>;
  askEvolutionArchitect(params: EvolutionArchitectAskParams): Promise<EvolutionArchitectAskResult>;
  triggerEvolution(params: EvolutionTriggerParams): Promise<EvolutionProposal>;
  reviseProposalWithComments(params: EvolutionReviseParams): Promise<EvolutionProposal>;
  adoptProposal(params: EvolutionProposalActionParams): Promise<{
    proposal: EvolutionProposal;
    newCommit?: GenomeCommit;
  }>;
  rejectProposal(params: EvolutionProposalActionParams): Promise<EvolutionProposal>;
  checkHarnessCompatibility(): Promise<HarnessCompatibilityReport>;
  startHarnessMigration(report?: HarnessCompatibilityReport): Promise<EvolutionProposal>;
  getGardenerReport(): Promise<HarnessGardenerReport>;

  // F4: Genome Deck (Git, Component Browser, Replay Compare, Export/Import)
  listCommits(): Promise<GenomeCommit[]>;
  readGenomeTree(commitSha: string): Promise<GenomeFile[]>;
  revertToCommit(targetSha: string, reason: string): Promise<GenomeCommit>;
  scanExport(): Promise<ExportScanResult>;
  confirmExport(stripFindings: boolean): Promise<{ archivePath: string; fileCount: number }>;
  previewImport(archivePath: string): Promise<ImportPreview>;
  executeImport(archivePath: string, trustPaths: string[]): Promise<{ importedCount: number }>;
  runReplayCompare(params: ReplayCompareParams): Promise<ReplayComparison>;

  // F4: Providers, Keyring, Import Wizards & Budget
  listProviders(): Promise<ProviderConfig[]>;
  getAggregatedCatalog(): Promise<AggregatedModelEntry[]>;
  saveProvider(params: SaveProviderParams): Promise<ProviderConfig>;
  deleteProvider(providerId: string): Promise<void>;
  pingProvider(providerId: string): Promise<PingProviderResult>;
  fetchProviderModels(providerId: string): Promise<string[]>;
  importFromCcSwitch(simulateUnavailable?: boolean): Promise<ProviderImportResult>;
  importFromMagpie(
    params?: string | MagpieImportParams,
    simulateUnavailable?: boolean,
  ): Promise<ProviderImportResult>;
  getBudgetStatus(): Promise<BudgetStatus>;
  updateBudgetSettings(params: UpdateBudgetSettingsParams): Promise<BudgetStatus>;
  syncPricingCatalog(params?: PricingSyncParams): Promise<PricingSyncResult>;

  // Auto-Updater (L0 Rust Managed)
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;

  // Event Subscription
  subscribe(listener: (event: HarnexIpcEvent) => void): () => void;
}
