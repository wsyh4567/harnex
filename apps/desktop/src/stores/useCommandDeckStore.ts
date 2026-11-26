import { create } from "zustand";
import type {
  AggregatedModelEntry,
  AppConfig,
  ApprovalDecision,
  ApprovalRequest,
  BudgetStatus,
  ChatMessage,
  EvolutionMode,
  EvolutionProposal,
  EvolutionStage,
  ExecPolicyRule,
  ExecutionMode,
  ExportScanResult,
  GenomeCommit,
  GenomeFile,
  GlobalHookItem,
  GuardianDecision,
  HarnessCompatibilityReport,
  HarnessGardenerReport,
  MessageAttachmentInput,
  ModelSlot,
  OnboardingReplayTrace,
  PricingSyncResult,
  ProviderConfig,
  ProviderImportResult,
  ReasoningEffort,
  ReplayComparison,
  RsiMode,
  RunMetrics,
  SlotBinding,
  SystemHealth,
  Thread,
  ToolCallRecord,
  TrustRecord,
  TrustStatus,
  UpdateStatus,
} from "@harnex/protocol";
import { buildAggregatedModelCatalog } from "../features/providers/modelCatalog.ts";
import { getEvolutionBlueprints } from "../i18n/demoContent.ts";
import {
  getInitialLocale,
  setStoredLocale,
  SUPPORTED_LOCALES,
  translate,
  type Locale,
} from "../i18n/index.ts";
import { applyTheme, getInitialTheme, type ThemeMode } from "../theme/index.ts";
import {
  createIpcClient,
  type HarnexIpcClient,
  type HarnexIpcEvent,
  type LiveChallengeParams,
  type MagpieImportParams,
  type OrganToggleResult,
  type PingProviderResult,
  type SaveHookParams,
  type SaveProviderParams,
  type StagedImportPreview,
  type UpdateBudgetSettingsParams,
} from "../ipc/index.ts";

export interface SendMessageOptions {
  reasoningEffort?: ReasoningEffort;
  attachments?: MessageAttachmentInput[];
}

export type RightWorkbenchTab =
  | "triage"
  | "theater"
  | "diff"
  | "genome"
  | "security"
  | "providers";

export type ActivePage =
  | "home"
  | "thread"
  | "deck"
  | "lab"
  | "proposals"
  | "history"
  | "security"
  | "providers"
  | "settings";

export interface GuidedMessageTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId?: string;
  providerId?: string;
  createdAt: string;
}

export interface SideChatTurn {
  id: string;
  question: string;
  answer: string;
  costUsd: number;
  createdAt: string;
}

export type ActivityTimelineItem =
  | { id: string; kind: "reasoning"; text: string }
  | { id: string; kind: "tool"; toolCall: ToolCallRecord };

export interface StreamingBuffer {
  runId: string;
  startedAt: number;
  content: string;
  reasoning: string;
  toolCalls: ToolCallRecord[];
  timeline: ActivityTimelineItem[];
}

export interface InlineCommentDraft {
  id: string;
  filePath: string;
  lineNumber: number;
  comment: string;
}

export interface TheaterLogEntry {
  id: string;
  proposalId: string;
  stage: EvolutionStage;
  kind: "started" | "progress" | "completed";
  text: string;
  metricsSnapshot?: RunMetrics;
  timestamp: string;
}

export interface ToastNotice {
  id: string;
  tone: "info" | "success" | "warning" | "error";
  title: string;
  detail?: string;
  durationMs?: number;
}

export interface CommandDeckState {
  ipc: HarnexIpcClient;
  initialized: boolean;
  loading: boolean;
  initError: string | null;

  // Navigation & UI
  theme: ThemeMode;
  locale: Locale;
  activePage: ActivePage;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  activeWorkspace: string;
  customWorkspaces: string[];
  reasoningEffort: ReasoningEffort;
  rightTab: RightWorkbenchTab;
  sideChatOpen: boolean;
  sideChatLoading: boolean;
  commandPaletteOpen: boolean;
  onboardingOpen: boolean;
  onboardingMode: "replay" | "live";
  onboardingStepIndex: number;
  onboardingPlaying: boolean;
  toasts: ToastNotice[];
  guidedBlueprintId: string;
  guidedModelOverride: SlotBinding | undefined;
  guidedMessagesByBlueprint: Record<string, GuidedMessageTurn[]>;
  guidedLoading: boolean;
  guidedSuggestedGoalByBlueprint: Record<string, string>;

  // System & Config
  systemHealth: SystemHealth | null;
  appConfig: AppConfig | null;
  budgetStatus: BudgetStatus | null;
  pricingSyncing: boolean;
  lastPricingSync: PricingSyncResult | null;

  // F0
  onboardingReplay: OnboardingReplayTrace | null;

  // F1: Threads & Execution
  threads: Thread[];
  activeThreadId: string | null;
  messagesByThread: Record<string, ChatMessage[]>;
  streamingByThread: Record<string, StreamingBuffer>;
  sideChatByThread: Record<string, SideChatTurn[]>;
  composerDrafts: Record<string, string>;

  // F2: Security & Trust
  pendingApprovals: ApprovalRequest[];
  execPolicyRules: ExecPolicyRule[];
  trustRecords: TrustRecord[];
  globalHooks: GlobalHookItem[];
  dismissedHookShaByPath: Record<string, string>;
  guardianDecisions: GuardianDecision[];

  // F3: Evolution & Triage
  proposals: EvolutionProposal[];
  selectedProposalId: string | null;
  silentArchiveCount: number;
  theaterStage: EvolutionStage | null;
  theaterLogs: TheaterLogEntry[];
  theaterLiveMetrics: RunMetrics | null;
  inlineCommentDrafts: Record<string, InlineCommentDraft[]>;
  evolutionRunning: boolean;

  // F4: Genome Deck & Providers
  commits: GenomeCommit[];
  selectedCommitSha: string | null;
  genomeFiles: GenomeFile[];
  replayComparison: ReplayComparison | null;
  replayRunning: boolean;
  exportScanResult: ExportScanResult | null;
  importPreview: StagedImportPreview | null;
  providers: ProviderConfig[];
  aggregatedCatalog: AggregatedModelEntry[];
  selectedModelByThread: Record<string, SlotBinding>;
  lastImportResult: ProviderImportResult | null;
  updateStatus: UpdateStatus | null;
  compatibilityReport: HarnessCompatibilityReport | null;
  isMigrating: boolean;
  dismissedMigrationAlert: boolean;
  gardenerReport: HarnessGardenerReport | null;
  gardenerLoading: boolean;
  pendingLabGoal: string | null;

  // Actions
  initialize: (client?: HarnexIpcClient) => Promise<void>;
  disposeSubscription: () => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  setActivePage: (page: ActivePage) => void;
  toggleSidebar: (force?: boolean) => void;
  toggleInspector: (force?: boolean) => void;
  setGuidedBlueprint: (blueprintId: string) => void;
  setGuidedModelOverride: (binding?: SlotBinding) => void;
  sendGuidedMessage: (
    blueprintId: string,
    text: string,
    acceptanceText?: string,
    binding?: SlotBinding,
  ) => Promise<void>;
  startNewTaskPrompt: (
    prompt: string,
    mode?: ExecutionMode,
    binding?: SlotBinding,
    options?: SendMessageOptions,
  ) => Promise<void>;
  setActiveWorkspace: (workspace: string) => void;
  addCustomWorkspace: (workspace: string) => void;
  removeCustomWorkspace: (workspace: string) => void;
  pickWorkspaceDirectory: () => Promise<string | null>;
  setReasoningEffort: (effort: ReasoningEffort) => void;
  setActiveThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  setRightTab: (tab: RightWorkbenchTab) => void;
  toggleSideChat: (force?: boolean) => void;
  toggleCommandPalette: (force?: boolean) => void;
  openOnboarding: (open: boolean) => void;
  setOnboardingMode: (mode: "replay" | "live") => void;
  setOnboardingStepIndex: (index: number) => void;
  setOnboardingPlaying: (playing: boolean) => void;
  dismissToast: (id: string) => void;
  pushToast: (toast: Omit<ToastNotice, "id">) => void;

  // F0 Actions
  launchLiveChallenge: (params: LiveChallengeParams) => Promise<void>;

  // F1 Actions
  createThread: (title?: string, mode?: ExecutionMode) => Promise<Thread>;
  setThreadMode: (threadId: string, mode: ExecutionMode) => void;
  setThreadModelOverride: (threadId: string, binding: SlotBinding | undefined) => void;
  setComposerDraft: (scopeKey: string, text: string) => void;
  clearComposerDraft: (scopeKey: string) => void;
  sendPrompt: (prompt: string, options?: SendMessageOptions) => Promise<void>;
  pauseActiveRun: () => Promise<void>;
  steerActiveRun: (instruction: string, triggerEvolution?: boolean) => Promise<void>;
  resumeActiveRun: () => Promise<void>;
  abortActiveRun: () => Promise<void>;
  askSideChat: (question: string) => Promise<void>;

  // F2 Actions
  resolveApproval: (requestId: string, decision: ApprovalDecision) => Promise<void>;
  upsertExecPolicyRule: (rule: ExecPolicyRule) => Promise<void>;
  deleteExecPolicyRule: (ruleId: string) => Promise<void>;
  updateTrustStatus: (id: string, status: TrustStatus) => Promise<void>;
  loadHooks: () => Promise<void>;
  saveHook: (params: SaveHookParams) => Promise<GlobalHookItem>;
  deleteHook: (path: string) => Promise<void>;
  trustGlobalHook: (path: string) => Promise<void>;
  toggleGlobalHookStatus: (hook: GlobalHookItem) => Promise<void>;
  dismissGlobalHookNotice: (path: string, sha256: string) => void;

  // F3 Actions
  selectProposal: (proposalId: string) => void;
  triggerEvolution: (params?: {
    domain?: string;
    mode?: EvolutionMode;
    k?: number;
    goal?: string;
    improverModelOverride?: string;
    improverProviderIdOverride?: string;
  }) => Promise<void>;
  addInlineCommentDraft: (proposalId: string, filePath: string, lineNumber: number, comment: string) => void;
  removeInlineCommentDraft: (proposalId: string, draftId: string) => void;
  submitInlineRevision: (proposalId: string) => Promise<void>;
  adoptProposal: (proposalId: string, trustHighPrivilegeAssets: boolean) => Promise<void>;
  rejectProposal: (proposalId: string) => Promise<void>;

  // F4 Genome Actions
  selectCommit: (sha: string) => Promise<void>;
  revertToCommit: (targetSha: string, reason: string) => Promise<void>;
  toggleOrgan: (path: string, enabled: boolean) => Promise<OrganToggleResult | null>;
  runReplayCompare: (params: { taskPrompt: string; v0Sha: string; vNSha: string; modelId?: string }) => Promise<void>;
  scanExport: () => Promise<ExportScanResult>;
  confirmExport: (stripFindings: boolean) => Promise<void>;
  clearExportScan: () => void;
  previewImport: (archivePath: string) => Promise<StagedImportPreview>;
  executeImport: (archivePath: string, trustPaths: string[]) => Promise<void>;
  clearImportPreview: () => void;

  // F4 Provider & Config Actions
  setRsiMode: (mode: RsiMode) => Promise<void>;
  setSlotBinding: (slot: ModelSlot, binding: SlotBinding | undefined) => Promise<void>;
  saveProvider: (params: SaveProviderParams) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  togglePinnedModel: (providerId: string, modelId: string) => Promise<void>;
  pingProvider: (providerId: string) => Promise<PingProviderResult>;
  fetchProviderModels: (providerId: string) => Promise<string[]>;
  importFromCcSwitch: (simulateUnavailable?: boolean) => Promise<ProviderImportResult>;
  importFromMagpie: (
    params?: string | MagpieImportParams,
    simulateUnavailable?: boolean,
  ) => Promise<ProviderImportResult>;
  updateBudgetSettings: (params: UpdateBudgetSettingsParams) => Promise<void>;
  syncPricingCatalog: (force?: boolean) => Promise<PricingSyncResult | null>;

  // Auto-Updater & Self-Healing Migration Actions
  checkForUpdates: () => Promise<UpdateStatus | null>;
  downloadUpdate: () => Promise<UpdateStatus | null>;
  installUpdate: () => Promise<UpdateStatus | null>;
  checkHarnessCompatibility: () => Promise<HarnessCompatibilityReport | null>;
  startHarnessMigration: () => Promise<EvolutionProposal | null>;
  dismissMigrationAlert: () => void;
  refreshGardenerReport: () => Promise<HarnessGardenerReport | null>;
  launchPruningEvolution: (goal: string) => void;
  consumePendingLabGoal: () => void;

  // Internal event handler
  handleIpcEvent: (event: HarnexIpcEvent) => void;
}

let activeUnsubscribe: (() => void) | null = null;
let initGeneration = 0;

function clearActiveSubscription(): void {
  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = null;
  }
}

function upsertToolCall(toolCalls: ToolCallRecord[], incoming: ToolCallRecord): ToolCallRecord[] {
  const exists = toolCalls.some((tc) => tc.id === incoming.id);
  return exists
    ? toolCalls.map((tc) => (tc.id === incoming.id ? { ...tc, ...incoming } : tc))
    : [...toolCalls, incoming];
}

export const COMPOSER_DRAFTS_KEY = "harnex:composer-drafts:v1";
const MAX_COMPOSER_DRAFTS = 20;
export const CUSTOM_WORKSPACES_KEY = "harnex:workspaces:v1";
const MAX_CUSTOM_WORKSPACES = 24;
export const REASONING_EFFORT_KEY = "harnex:reasoning-effort:v1";

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "auto" || value === "low" || value === "medium" || value === "high";
}

export function loadReasoningEffort(): ReasoningEffort {
  try {
    const raw = globalThis.localStorage?.getItem(REASONING_EFFORT_KEY);
    return isReasoningEffort(raw) ? raw : "auto";
  } catch {
    return "auto";
  }
}

export function saveReasoningEffort(effort: ReasoningEffort): void {
  try {
    globalThis.localStorage?.setItem(REASONING_EFFORT_KEY, effort);
  } catch {
    // Ignore storage quota or SSR/test unavailability
  }
}

function normalizeWorkspaceList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.slice(0, MAX_CUSTOM_WORKSPACES);
}

export function loadCustomWorkspaces(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(CUSTOM_WORKSPACES_KEY);
    if (!raw) return [];
    return normalizeWorkspaceList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveCustomWorkspaces(workspaces: string[]): void {
  try {
    globalThis.localStorage?.setItem(
      CUSTOM_WORKSPACES_KEY,
      JSON.stringify(normalizeWorkspaceList(workspaces)),
    );
  } catch {
    // Ignore storage quota or SSR/test unavailability
  }
}

function normalizeComposerDrafts(raw: Record<string, string>): Record<string, string> {
  const entries = Object.entries(raw).filter(
    ([key, val]) => key.trim().length > 0 && typeof val === "string" && val.trim().length > 0,
  );
  return Object.fromEntries(entries.slice(-MAX_COMPOSER_DRAFTS));
}

export function loadComposerDrafts(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(COMPOSER_DRAFTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return normalizeComposerDrafts(parsed as Record<string, string>);
  } catch {
    return {};
  }
}

export function saveComposerDrafts(drafts: Record<string, string>): void {
  try {
    const normalized = normalizeComposerDrafts(drafts);
    globalThis.localStorage?.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage quota or SSR/test unavailability
  }
}

function dedupeMessagesById(msgs: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const msg of msgs) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    out.push(msg);
  }
  return out;
}

export const useCommandDeckStore = create<CommandDeckState>((set, get) => ({
  ipc: createIpcClient(),
  initialized: false,
  loading: false,
  initError: null,

  theme: getInitialTheme(),
  locale: getInitialLocale(),
  activePage: "home",
  sidebarCollapsed: false,
  inspectorOpen: false,
  activeWorkspace: "~/Work",
  customWorkspaces: loadCustomWorkspaces(),
  reasoningEffort: loadReasoningEffort(),
  rightTab: "triage",
  sideChatOpen: false,
  sideChatLoading: false,
  commandPaletteOpen: false,
  onboardingOpen: false,
  onboardingMode: "replay",
  onboardingStepIndex: 0,
  onboardingPlaying: false,
  toasts: [],
  guidedBlueprintId: "memory",
  guidedModelOverride: undefined,
  guidedMessagesByBlueprint: {},
  guidedLoading: false,
  guidedSuggestedGoalByBlueprint: {},

  systemHealth: null,
  appConfig: null,
  budgetStatus: null,
  pricingSyncing: false,
  lastPricingSync: null,
  onboardingReplay: null,

  threads: [],
  activeThreadId: null,
  messagesByThread: {},
  streamingByThread: {},
  sideChatByThread: {},
  composerDrafts: loadComposerDrafts(),

  pendingApprovals: [],
  execPolicyRules: [],
  trustRecords: [],
  globalHooks: [],
  dismissedHookShaByPath: {},
  guardianDecisions: [],

  proposals: [],
  selectedProposalId: null,
  silentArchiveCount: 0,
  theaterStage: null,
  theaterLogs: [],
  theaterLiveMetrics: null,
  inlineCommentDrafts: {},
  evolutionRunning: false,

  commits: [],
  selectedCommitSha: null,
  genomeFiles: [],
  replayComparison: null,
  replayRunning: false,
  exportScanResult: null,
  importPreview: null,
  providers: [],
  aggregatedCatalog: [],
  selectedModelByThread: {},
  lastImportResult: null,
  updateStatus: null,
  compatibilityReport: null,
  isMigrating: false,
  dismissedMigrationAlert: false,
  gardenerReport: null,
  gardenerLoading: false,
  pendingLabGoal: null,

  disposeSubscription: () => {
    initGeneration += 1;
    clearActiveSubscription();
  },

  initialize: async (client) => {
    clearActiveSubscription();
    const myGen = ++initGeneration;
    const initialTheme = getInitialTheme();
    const initialLocale = getInitialLocale();
    applyTheme(initialTheme);
    setStoredLocale(initialLocale);
    const ipc = client ?? get().ipc;

    set({ ipc, loading: true, initError: null, theme: initialTheme, locale: initialLocale });

    try {
      const [
        systemHealth,
        appConfig,
        budgetStatus,
        onboardingReplay,
        threads,
        pendingApprovals,
        execPolicyRules,
        trustRecords,
        globalHooks,
        guardianDecisions,
        proposals,
        silentArchiveCount,
        commits,
        providers,
        aggregatedCatalog,
      ] = await Promise.all([
        ipc.getSystemHealth(),
        ipc.getAppConfig(),
        ipc.getBudgetStatus().catch(() => null),
        ipc.getOnboardingReplay().catch(() => null),
        ipc.listThreads(),
        ipc.listPendingApprovals().catch(() => []),
        ipc.listExecPolicyRules().catch(() => []),
        ipc.listTrustRecords().catch(() => []),
        ipc.listHooks().catch(() => []),
        ipc.listGuardianDecisions().catch(() => []),
        ipc.listProposals().catch(() => []),
        ipc.getSilentArchiveCount().catch(() => 0),
        ipc.listCommits().catch(() => []),
        ipc.listProviders().catch(() => []),
        ipc.getAggregatedCatalog().catch(() => []),
      ]);
      if (myGen !== initGeneration) return;

      const activeThread = threads[0] ?? null;
      const activeThreadId = activeThread?.id ?? null;
      const savedWorkspaces = loadCustomWorkspaces();
      const activeWorkspace =
        activeThread?.workspacePath ??
        appConfig.defaultWorkspace ??
        savedWorkspaces[0] ??
        "~/Work";

      const initialMessages: Record<string, ChatMessage[]> = {};
      await Promise.all(
        threads.map(async (t) => {
          initialMessages[t.id] = dedupeMessagesById(
            await ipc.getThreadMessages(t.id).catch(() => []),
          );
        }),
      );
      if (myGen !== initGeneration) return;

      const headSha = commits[0]?.sha ?? systemHealth.activeCommitSha;
      const [genomeFiles, refreshedHealth] = await Promise.all([
        headSha ? ipc.readGenomeTree(headSha).catch(() => []) : Promise.resolve([]),
        systemHealth.sidecarAlive
          ? Promise.resolve(systemHealth)
          : ipc.getSystemHealth().catch(() => systemHealth),
      ]);
      if (myGen !== initGeneration) return;
      const latestSystemHealth = refreshedHealth;
      const firstReadyProposal = proposals.find((p) => p.status === "ready") ?? proposals[0] ?? null;

      clearActiveSubscription();
      activeUnsubscribe = ipc.subscribe((ev) => {
        get().handleIpcEvent(ev);
      });

      set({
        initialized: true,
        loading: false,
        initError: null,
        systemHealth: latestSystemHealth,
        appConfig,
        budgetStatus,
        onboardingReplay,
        threads,
        activeThreadId,
        activeWorkspace,
        customWorkspaces: savedWorkspaces,
        reasoningEffort: loadReasoningEffort(),
        messagesByThread: initialMessages,
        pendingApprovals,
        execPolicyRules,
        trustRecords,
        globalHooks,
        guardianDecisions,
        proposals,
        selectedProposalId: firstReadyProposal?.id ?? null,
        silentArchiveCount,
        commits,
        selectedCommitSha: headSha,
        genomeFiles,
        providers,
        aggregatedCatalog,
        composerDrafts: loadComposerDrafts(),
      });

      if (!latestSystemHealth.sidecarAlive) {
        for (const delayMs of [1500, 4000]) {
          setTimeout(() => {
            if (myGen !== initGeneration || get().systemHealth?.sidecarAlive) return;
            void ipc
              .getSystemHealth()
              .then((nextHealth) => {
                if (myGen === initGeneration) {
                  set({ systemHealth: nextHealth });
                }
              })
              .catch(() => {});
          }, delayMs);
        }
      }

      // Quietly check for updates, compatibility & gardener hygiene on startup without blocking initial deck render
      void get().checkForUpdates();
      void get().checkHarnessCompatibility();
      void get().refreshGardenerReport();
    } catch (error) {
      if (myGen !== initGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      set({
        loading: false,
        initError: message || "Failed to connect to Harnex L0 Runtime",
      });
    }
  },

  pushToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const defaultDuration =
      toast.tone === "error" ? 7500 : toast.tone === "warning" ? 5500 : 4000;
    set((s) => ({
      toasts: [...s.toasts.slice(-3), { ...toast, durationMs: toast.durationMs ?? defaultDuration, id }],
    }));
  },

  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },

  toggleTheme: () => {
    const next: ThemeMode = get().theme === "light" ? "dark" : "light";
    applyTheme(next);
    set({ theme: next });
  },

  setLocale: (locale) => {
    setStoredLocale(locale);
    set({ locale });
  },

  toggleLocale: () => {
    const idx = SUPPORTED_LOCALES.findIndex((l) => l.code === get().locale);
    const next = SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length]?.code ?? "en-US";
    setStoredLocale(next);
    set({ locale: next });
  },

  setActivePage: (activePage) => set({ activePage }),

  toggleSidebar: (force) =>
    set((s) => ({ sidebarCollapsed: force !== undefined ? force : !s.sidebarCollapsed })),

  toggleInspector: (force) =>
    set((s) => ({ inspectorOpen: force !== undefined ? force : !s.inspectorOpen })),

  setGuidedBlueprint: (guidedBlueprintId) => set({ guidedBlueprintId }),

  setGuidedModelOverride: (guidedModelOverride) => set({ guidedModelOverride }),

  sendGuidedMessage: async (blueprintId, text, acceptanceText, binding) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const state = get();
    const locale = state.locale;
    const resolvedBinding =
      binding ??
      state.guidedModelOverride ??
      state.appConfig?.slots.improver ??
      state.appConfig?.slots.solver;
    const blueprints = getEvolutionBlueprints(locale);
    const bp = blueprints.find((b) => b.id === blueprintId) ?? blueprints[0]!;
    const priorTurns = state.guidedMessagesByBlueprint[blueprintId] ?? [];
    const history = priorTurns.slice(-6).map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
    const userTurn: GuidedMessageTurn = {
      id: `gm-u-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({
      guidedLoading: true,
      guidedMessagesByBlueprint: {
        ...s.guidedMessagesByBlueprint,
        [blueprintId]: [...(s.guidedMessagesByBlueprint[blueprintId] ?? []), userTurn],
      },
    }));

    try {
      const res = await get().ipc.askEvolutionArchitect({
        pillarId: bp.id,
        pillarTitle: bp.title,
        domain: bp.domain,
        message: trimmed,
        goalDraft: acceptanceText?.trim() || undefined,
        history,
        modelOverride: resolvedBinding?.modelId,
        providerIdOverride: resolvedBinding?.providerId,
        locale,
      });
      const replyTurn: GuidedMessageTurn = {
        id: `gm-a-${Date.now() + 1}`,
        role: "assistant",
        content: res.reply,
        modelId: res.modelId || resolvedBinding?.modelId,
        providerId: resolvedBinding?.providerId,
        createdAt: new Date().toISOString(),
      };
      const budgetStatus = await get()
        .ipc.getBudgetStatus()
        .catch(() => get().budgetStatus);
      set((s) => ({
        budgetStatus,
        guidedMessagesByBlueprint: {
          ...s.guidedMessagesByBlueprint,
          [blueprintId]: [...(s.guidedMessagesByBlueprint[blueprintId] ?? []), replyTurn],
        },
        guidedSuggestedGoalByBlueprint: res.suggestedGoal
          ? { ...s.guidedSuggestedGoalByBlueprint, [blueprintId]: res.suggestedGoal }
          : s.guidedSuggestedGoalByBlueprint,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({
        tone: "error",
        title: translate(locale, "lab.architectErrorTitle"),
        detail: message,
      });
    } finally {
      set({ guidedLoading: false });
    }
  },

  setActiveWorkspace: (workspace) => {
    const trimmed = workspace.trim();
    if (!trimmed) return;
    const firstInWorkspace = get().threads.find((t) => t.workspacePath === trimmed);
    set({
      activeWorkspace: trimmed,
      activeThreadId: firstInWorkspace?.id ?? get().activeThreadId,
    });
  },

  addCustomWorkspace: (workspace) => {
    const trimmed = workspace.trim();
    if (!trimmed) return;
    const next = normalizeWorkspaceList([trimmed, ...get().customWorkspaces]);
    saveCustomWorkspaces(next);
    const firstInWorkspace = get().threads.find((t) => t.workspacePath === trimmed);
    set({
      customWorkspaces: next,
      activeWorkspace: trimmed,
      activeThreadId: firstInWorkspace?.id ?? get().activeThreadId,
    });
    void get()
      .ipc.updateAppConfig({ defaultWorkspace: trimmed })
      .then((appConfig) => set({ appConfig }))
      .catch(() => {});
  },

  removeCustomWorkspace: (workspace) => {
    const next = get().customWorkspaces.filter((w) => w !== workspace);
    saveCustomWorkspaces(next);
    const current = get().activeWorkspace;
    const fallback =
      current === workspace
        ? (next[0] ?? get().threads[0]?.workspacePath ?? "~/Work")
        : current;
    set({
      customWorkspaces: next,
      activeWorkspace: fallback,
    });
  },

  pickWorkspaceDirectory: async () => {
    try {
      const picked = await get().ipc.pickWorkspaceDirectory(get().activeWorkspace);
      if (picked && picked.trim()) {
        get().addCustomWorkspace(picked.trim());
        return picked.trim();
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({
        tone: "error",
        title: translate(get().locale, "nav.browseWorkspaceError"),
        detail: message,
      });
      return null;
    }
  },

  setReasoningEffort: (reasoningEffort) => {
    saveReasoningEffort(reasoningEffort);
    set({ reasoningEffort });
  },

  setActiveThread: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    const existing = get().messagesByThread[threadId];
    if (!existing) {
      const msgs = await get().ipc.getThreadMessages(threadId);
      set((s) => ({
        activeThreadId: threadId,
        activePage: "thread",
        activeWorkspace: thread?.workspacePath ?? s.activeWorkspace,
        messagesByThread: { ...s.messagesByThread, [threadId]: msgs },
      }));
      return;
    }
    set((s) => ({
      activeThreadId: threadId,
      activePage: "thread",
      activeWorkspace: thread?.workspacePath ?? s.activeWorkspace,
    }));
  },

  renameThread: async (threadId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const updated = await get().ipc.renameThread({ threadId, title: trimmed });
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? updated : t)),
    }));
  },

  deleteThread: async (threadId) => {
    await get().ipc.deleteThread({ threadId });
    set((s) => {
      const remaining = s.threads.filter((t) => t.id !== threadId);
      const nextMessages = { ...s.messagesByThread };
      delete nextMessages[threadId];
      const nextSideChat = { ...s.sideChatByThread };
      delete nextSideChat[threadId];
      const nextModels = { ...s.selectedModelByThread };
      delete nextModels[threadId];
      const nextDrafts = { ...s.composerDrafts };
      delete nextDrafts[threadId];
      saveComposerDrafts(nextDrafts);

      const deletingActive = s.activeThreadId === threadId;
      const nextThread = deletingActive ? (remaining[0] ?? null) : null;
      return {
        threads: remaining,
        messagesByThread: nextMessages,
        sideChatByThread: nextSideChat,
        selectedModelByThread: nextModels,
        composerDrafts: nextDrafts,
        activeThreadId: deletingActive ? (nextThread?.id ?? null) : s.activeThreadId,
        activePage: deletingActive && !nextThread ? "home" : s.activePage,
      };
    });
  },

  setRightTab: (rightTab) => set({ rightTab }),

  toggleSideChat: (force) =>
    set((s) => ({ sideChatOpen: force !== undefined ? force : !s.sideChatOpen })),

  toggleCommandPalette: (force) =>
    set((s) => ({ commandPaletteOpen: force !== undefined ? force : !s.commandPaletteOpen })),

  openOnboarding: (onboardingOpen) =>
    set((s) => ({
      onboardingOpen,
      onboardingPlaying: false,
      onboardingStepIndex: onboardingOpen && !s.onboardingOpen ? 0 : s.onboardingStepIndex,
    })),
  setOnboardingMode: (onboardingMode) => set({ onboardingMode }),
  setOnboardingStepIndex: (onboardingStepIndex) => set({ onboardingStepIndex }),
  setOnboardingPlaying: (onboardingPlaying) => set({ onboardingPlaying }),

  launchLiveChallenge: async (params) => {
    const thread = await get().ipc.startLiveChallenge(params);
    const msgs = await get().ipc.getThreadMessages(thread.id);
    const isZh = get().locale.startsWith("zh");
    set((s) => ({
      threads: [thread, ...s.threads.filter((t) => t.id !== thread.id)],
      activeThreadId: thread.id,
      activePage: "thread",
      activeWorkspace: thread.workspacePath,
      messagesByThread: { ...s.messagesByThread, [thread.id]: msgs },
      onboardingOpen: false,
      rightTab: "theater",
    }));
    get().pushToast({
      tone: "info",
      title: isZh ? `已启动实时试炼 (${params.dataset})` : `Launched Live Crucible (${params.dataset})`,
      detail: isZh
        ? "正在隔离沙盒中执行，可随时暂停并纠偏。"
        : "Executing inside isolated sandbox; pause & steer anytime.",
    });
  },

  createThread: async (title, mode = "craft") => {
    const workspacePath = get().activeWorkspace;
    const thread = await get().ipc.createThread({ workspacePath, title, mode });
    const nextCustom =
      thread.workspacePath && thread.workspacePath !== workspacePath
        ? normalizeWorkspaceList([thread.workspacePath, ...get().customWorkspaces])
        : get().customWorkspaces;
    if (thread.workspacePath && thread.workspacePath !== workspacePath) {
      saveCustomWorkspaces(nextCustom);
    }
    set((s) => ({
      threads: [thread, ...s.threads],
      activeThreadId: thread.id,
      activeWorkspace: thread.workspacePath || s.activeWorkspace,
      customWorkspaces: nextCustom,
      activePage: "thread",
      messagesByThread: { ...s.messagesByThread, [thread.id]: [] },
    }));
    return thread;
  },

  startNewTaskPrompt: async (prompt, mode = "craft", binding, options) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const cleanTitle = trimmed.replace(/\s+/g, " ").slice(0, 36);
    try {
      const thread = await get().createThread(cleanTitle, mode);
      if (binding) {
        get().setThreadModelOverride(thread.id, binding);
      }
      await get().sendPrompt(trimmed, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().setComposerDraft("home", trimmed);
      get().pushToast({
        tone: "error",
        title: translate(get().locale, "toast.startTaskFailed"),
        detail: message,
      });
    }
  },

  setThreadMode: (threadId, mode) => {
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, mode } : t)),
    }));
  },

  setThreadModelOverride: (threadId, binding) => {
    set((s) => {
      const next = { ...s.selectedModelByThread };
      if (binding) next[threadId] = binding;
      else delete next[threadId];
      return { selectedModelByThread: next };
    });
  },

  setComposerDraft: (scopeKey, text) => {
    const cleanKey = scopeKey.trim();
    if (!cleanKey) return;
    set((s) => {
      const next = { ...s.composerDrafts };
      delete next[cleanKey];
      if (text.trim().length > 0) {
        next[cleanKey] = text;
      }
      const normalized = normalizeComposerDrafts(next);
      saveComposerDrafts(normalized);
      return { composerDrafts: normalized };
    });
  },

  clearComposerDraft: (scopeKey) => {
    const cleanKey = scopeKey.trim();
    if (!cleanKey) return;
    set((s) => {
      if (!(cleanKey in s.composerDrafts)) return s;
      const next = { ...s.composerDrafts };
      delete next[cleanKey];
      saveComposerDrafts(next);
      return { composerDrafts: next };
    });
  },

  sendPrompt: async (prompt, options) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    try {
      let threadId = get().activeThreadId;
      if (!threadId) {
        const created = await get().createThread("New Command Thread");
        threadId = created.id;
      }
      const thread = get().threads.find((t) => t.id === threadId);
      const override = get().selectedModelByThread[threadId];
      const solverSlot = get().appConfig?.slots.solver;
      const activeBinding = override ?? solverSlot;
      const reasoningEffort = options?.reasoningEffort ?? get().reasoningEffort;
      const attachments =
        options?.attachments && options.attachments.length > 0 ? options.attachments : undefined;

      await get().ipc.startRun({
        threadId,
        prompt: trimmed,
        mode: thread?.mode ?? "craft",
        providerIdOverride: activeBinding?.providerId,
        modelOverride: activeBinding?.modelId,
        reasoningEffort,
        ...(attachments ? { attachments } : {}),
      });
      const msgs = dedupeMessagesById(await get().ipc.getThreadMessages(threadId));
      set((s) => ({
        activePage: "thread",
        messagesByThread: { ...s.messagesByThread, [threadId]: msgs },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const draftKey = get().activeThreadId ?? "home";
      get().setComposerDraft(draftKey, trimmed);
      get().pushToast({
        tone: "error",
        title: translate(get().locale, "toast.startTaskFailed"),
        detail: message,
      });
    }
  },

  pauseActiveRun: async () => {
    const threadId = get().activeThreadId;
    if (!threadId) return;
    await get().ipc.pauseRun({ threadId });
  },

  steerActiveRun: async (instruction, triggerEvolutionOnFinish = true) => {
    const threadId = get().activeThreadId;
    const trimmed = instruction.trim();
    if (!threadId || !trimmed) return;
    await get().ipc.steerRun({ threadId, instruction: trimmed, triggerEvolutionOnFinish });
    const msgs = dedupeMessagesById(await get().ipc.getThreadMessages(threadId));
    set((s) => ({
      messagesByThread: { ...s.messagesByThread, [threadId]: msgs },
    }));
  },

  resumeActiveRun: async () => {
    const threadId = get().activeThreadId;
    if (!threadId) return;
    await get().ipc.resumeRun({ threadId });
  },

  abortActiveRun: async () => {
    const threadId = get().activeThreadId;
    if (!threadId) return;
    await get().ipc.abortRun({ threadId });
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, status: "aborted" } : t)),
    }));
  },

  askSideChat: async (question) => {
    const threadId = get().activeThreadId;
    const trimmed = question.trim();
    if (!threadId || !trimmed) return;
    set({ sideChatLoading: true });
    try {
      const res = await get().ipc.askSideChat({ threadId, question: trimmed });
      const turn: SideChatTurn = {
        id: `sc-${Date.now()}`,
        question: trimmed,
        answer: res.answer,
        costUsd: res.usage.costUsd,
        createdAt: new Date().toISOString(),
      };
      set((s) => ({
        sideChatByThread: {
          ...s.sideChatByThread,
          [threadId]: [...(s.sideChatByThread[threadId] ?? []), turn],
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({
        tone: "error",
        title: translate(get().locale, "toast.sideChatFailed"),
        detail: message,
      });
    } finally {
      set({ sideChatLoading: false });
    }
  },

  resolveApproval: async (requestId, decision) => {
    await get().ipc.resolveApproval({ requestId, decision });
    const [pendingApprovals, trustRecords, globalHooks, guardianDecisions, threads] = await Promise.all([
      get().ipc.listPendingApprovals(),
      get().ipc.listTrustRecords(),
      get().ipc.listHooks(),
      get().ipc.listGuardianDecisions(),
      get().ipc.listThreads(),
    ]);
    set({ pendingApprovals, trustRecords, globalHooks, guardianDecisions, threads });
  },

  upsertExecPolicyRule: async (rule) => {
    const execPolicyRules = await get().ipc.upsertExecPolicyRule(rule);
    set({ execPolicyRules });
  },

  deleteExecPolicyRule: async (ruleId) => {
    const execPolicyRules = await get().ipc.deleteExecPolicyRule(ruleId);
    set({ execPolicyRules });
  },

  updateTrustStatus: async (id, status) => {
    const trustRecords = await get().ipc.updateTrustStatus(id, status);
    const globalHooks = await get().ipc.listHooks();
    set({ trustRecords, globalHooks });
  },

  loadHooks: async () => {
    const globalHooks = await get().ipc.listHooks();
    set({ globalHooks });
  },

  saveHook: async (params) => {
    const saved = await get().ipc.saveHook(params);
    const [globalHooks, trustRecords, pendingApprovals, guardianDecisions, threads] =
      await Promise.all([
        get().ipc.listHooks(),
        get().ipc.listTrustRecords(),
        get().ipc.listPendingApprovals(),
        get().ipc.listGuardianDecisions(),
        get().ipc.listThreads(),
      ]);
    set((s) => {
      const nextDismissed = { ...s.dismissedHookShaByPath };
      delete nextDismissed[params.path];
      return {
        globalHooks,
        trustRecords,
        pendingApprovals,
        guardianDecisions,
        threads,
        dismissedHookShaByPath: nextDismissed,
      };
    });
    return saved;
  },

  deleteHook: async (path) => {
    await get().ipc.deleteHook(path);
    const [globalHooks, trustRecords, pendingApprovals] = await Promise.all([
      get().ipc.listHooks(),
      get().ipc.listTrustRecords(),
      get().ipc.listPendingApprovals(),
    ]);
    set((s) => {
      const nextDismissed = { ...s.dismissedHookShaByPath };
      delete nextDismissed[path];
      return {
        globalHooks,
        trustRecords,
        pendingApprovals,
        dismissedHookShaByPath: nextDismissed,
      };
    });
  },

  trustGlobalHook: async (path) => {
    const ipc = get().ipc;
    const hook = get().globalHooks.find((h) => h.path === path);
    if (hook) {
      await ipc.saveHook({
        path: hook.path,
        event: hook.event,
        content: hook.content,
        trustImmediately: true,
      });
    }
    const matchingPending = (await ipc.listPendingApprovals()).filter(
      (a) => a.kind === "hook_trust" && a.commandOrPath === path,
    );
    for (const req of matchingPending) {
      await ipc.resolveApproval({ requestId: req.requestId, decision: "allow_session" });
    }
    const [globalHooks, pendingApprovals, trustRecords, guardianDecisions, threads] =
      await Promise.all([
        ipc.listHooks(),
        ipc.listPendingApprovals(),
        ipc.listTrustRecords(),
        ipc.listGuardianDecisions(),
        ipc.listThreads(),
      ]);
    set((s) => {
      const nextDismissed = { ...s.dismissedHookShaByPath };
      delete nextDismissed[path];
      return {
        globalHooks,
        pendingApprovals,
        trustRecords,
        guardianDecisions,
        threads,
        dismissedHookShaByPath: nextDismissed,
      };
    });
  },

  toggleGlobalHookStatus: async (hook) => {
    if (hook.status === "trusted") {
      const rec = get().trustRecords.find(
        (r) => r.kind === "hook" && r.identifier === hook.path,
      );
      if (rec) {
        await get().updateTrustStatus(rec.id, "disabled");
      }
      return;
    }
    await get().trustGlobalHook(hook.path);
  },

  dismissGlobalHookNotice: (path, sha256) => {
    set((s) => ({
      dismissedHookShaByPath: { ...s.dismissedHookShaByPath, [path]: sha256 },
    }));
  },

  selectProposal: (selectedProposalId) => set({ selectedProposalId }),

  triggerEvolution: async (params) => {
    const threadId = get().activeThreadId ?? get().threads[0]?.id ?? "thr-default";
    const activeThread = get().threads.find((t) => t.id === threadId);
    const locale = get().locale;
    set({ evolutionRunning: true, theaterLogs: [], rightTab: "theater" });
    try {
      const proposal = await get().ipc.triggerEvolution({
        threadId,
        domain: params?.domain ?? activeThread?.domain ?? "general",
        mode: params?.mode ?? "parallel",
        k: params?.k ?? 2,
        triggerSource: "manual",
        goal: params?.goal?.trim() || undefined,
        improverModelOverride: params?.improverModelOverride,
        improverProviderIdOverride: params?.improverProviderIdOverride,
      });
      const [proposals, silentArchiveCount, budgetStatus] = await Promise.all([
        get().ipc.listProposals(),
        get().ipc.getSilentArchiveCount(),
        get().ipc.getBudgetStatus(),
      ]);
      set({
        proposals,
        silentArchiveCount,
        budgetStatus,
        selectedProposalId: proposal.id,
      });

      if (proposal.status === "archived_no_entry") {
        get().pushToast({
          tone: "info",
          title: translate(locale, "evo.toastNoGainTitle"),
          detail: translate(locale, "evo.toastNoGainDetail"),
        });
      } else if (proposal.status === "rejected") {
        get().pushToast({
          tone: "warning",
          title: translate(locale, "evo.toastRejectedTitle"),
          detail: translate(locale, "evo.toastRejectedDetail"),
        });
      } else {
        get().pushToast({
          tone: "success",
          title: translate(locale, "evo.toastReadyTitle"),
          detail: translate(locale, "evo.toastReadyDetail", { title: proposal.title }),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({
        tone: "error",
        title: translate(locale, "evo.toastTriggerFailedTitle"),
        detail: message,
      });
    } finally {
      set({ evolutionRunning: false });
    }
  },

  addInlineCommentDraft: (proposalId, filePath, lineNumber, comment) => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    const draft: InlineCommentDraft = {
      id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filePath,
      lineNumber,
      comment: trimmed,
    };
    set((s) => ({
      inlineCommentDrafts: {
        ...s.inlineCommentDrafts,
        [proposalId]: [...(s.inlineCommentDrafts[proposalId] ?? []), draft],
      },
    }));
  },

  removeInlineCommentDraft: (proposalId, draftId) => {
    set((s) => ({
      inlineCommentDrafts: {
        ...s.inlineCommentDrafts,
        [proposalId]: (s.inlineCommentDrafts[proposalId] ?? []).filter((d) => d.id !== draftId),
      },
    }));
  },

  submitInlineRevision: async (proposalId) => {
    const drafts = get().inlineCommentDrafts[proposalId] ?? [];
    if (drafts.length === 0) return;
    const locale = get().locale;
    set({ evolutionRunning: true, theaterLogs: [], rightTab: "theater" });
    try {
      const revised = await get().ipc.reviseProposalWithComments({
        proposalId,
        comments: drafts.map((d) => ({
          filePath: d.filePath,
          lineNumber: d.lineNumber,
          comment: d.comment,
        })),
      });
      const [proposals, budgetStatus] = await Promise.all([
        get().ipc.listProposals(),
        get().ipc.getBudgetStatus(),
      ]);
      set((s) => ({
        proposals,
        budgetStatus,
        selectedProposalId: revised.id,
        rightTab: "diff",
        inlineCommentDrafts: { ...s.inlineCommentDrafts, [proposalId]: [] },
      }));
      get().pushToast({
        tone: "success",
        title: translate(locale, "evo.toastRevisionTitle"),
        detail: translate(locale, "evo.toastRevisionDetail", { count: drafts.length }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({
        tone: "error",
        title: translate(locale, "evo.toastRevisionFailedTitle"),
        detail: message,
      });
    } finally {
      set({ evolutionRunning: false });
    }
  },

  adoptProposal: async (proposalId, trustHighPrivilegeAssets) => {
    const res = await get().ipc.adoptProposal({ proposalId, trustHighPrivilegeAssets });
    const [proposals, commits, trustRecords, systemHealth] = await Promise.all([
      get().ipc.listProposals(),
      get().ipc.listCommits(),
      get().ipc.listTrustRecords(),
      get().ipc.getSystemHealth(),
    ]);
    const headSha = res.newCommit?.sha ?? commits[0]?.sha ?? null;
    const genomeFiles = headSha ? await get().ipc.readGenomeTree(headSha) : get().genomeFiles;
    const currentCompat = get().compatibilityReport;
    const resolvedCompat =
      res.proposal.triggerSource === "upgrade_migration" && currentCompat
        ? { ...currentCompat, hasBreakingIssues: false, needsMigration: false }
        : currentCompat;
    set({
      proposals,
      commits,
      trustRecords,
      systemHealth,
      selectedCommitSha: headSha,
      genomeFiles,
      compatibilityReport: resolvedCompat,
    });
    void get().refreshGardenerReport();
    get().pushToast({
      tone: "success",
      title: `Adopted ${res.proposal.title}`,
      detail: res.newCommit ? `Committed Genome ${res.newCommit.versionTag} via libgit2.` : undefined,
    });
  },

  rejectProposal: async (proposalId) => {
    await get().ipc.rejectProposal({ proposalId, trustHighPrivilegeAssets: false });
    const [proposals, silentArchiveCount] = await Promise.all([
      get().ipc.listProposals(),
      get().ipc.getSilentArchiveCount(),
    ]);
    set({ proposals, silentArchiveCount });
  },

  selectCommit: async (sha) => {
    const genomeFiles = await get().ipc.readGenomeTree(sha);
    set({ selectedCommitSha: sha, genomeFiles });
  },

  revertToCommit: async (targetSha, reason) => {
    const commit = await get().ipc.revertToCommit(targetSha, reason);
    const [commits, systemHealth, genomeFiles] = await Promise.all([
      get().ipc.listCommits(),
      get().ipc.getSystemHealth(),
      get().ipc.readGenomeTree(commit.sha),
    ]);
    set({ commits, systemHealth, selectedCommitSha: commit.sha, genomeFiles });
    void get().refreshGardenerReport();
    get().pushToast({
      tone: "warning",
      title: `Reverted Harness to ${commit.versionTag}`,
      detail: "Active running threads keep their pinned SHA; new runs use reverted genome.",
    });
  },

  toggleOrgan: async (path, enabled) => {
    try {
      const res = await get().ipc.gitToggleOrgan(path, enabled);
      const [commits, systemHealth] = await Promise.all([
        get().ipc.listCommits(),
        get().ipc.getSystemHealth(),
      ]);
      const headSha = res.newCommitSha ?? commits[0]?.sha ?? get().selectedCommitSha;
      const genomeFiles = headSha ? await get().ipc.readGenomeTree(headSha) : get().genomeFiles;
      set({
        commits,
        systemHealth,
        selectedCommitSha: headSha,
        genomeFiles,
      });
      void get().refreshGardenerReport();
      get().pushToast({
        tone: "success",
        title: enabled
          ? translate(get().locale, "genome.organEnabledToast")
          : translate(get().locale, "genome.organDisabledToast"),
        detail: path,
      });
      return res;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({
        tone: "error",
        title: translate(get().locale, "genome.organToggleFailedToast"),
        detail: message,
      });
      return null;
    }
  },

  runReplayCompare: async (params) => {
    set({ replayRunning: true });
    try {
      const workspacePath = get().activeWorkspace;
      const replayComparison = await get().ipc.runReplayCompare({
        ...params,
        workspacePath,
      });
      set({ replayComparison });
    } finally {
      set({ replayRunning: false });
    }
  },

  scanExport: async () => {
    const exportScanResult = await get().ipc.scanExport();
    set({ exportScanResult });
    return exportScanResult;
  },

  confirmExport: async (stripFindings) => {
    const res = await get().ipc.confirmExport(stripFindings);
    set({ exportScanResult: null });
    get().pushToast({
      tone: "success",
      title: "Sanitized Genome Bundle Exported",
      detail: `${res.archivePath} (${res.fileCount} files)`,
    });
  },

  clearExportScan: () => set({ exportScanResult: null }),

  previewImport: async (archivePath) => {
    const importPreview = await get().ipc.previewImport(archivePath);
    set({ importPreview });
    return importPreview;
  },

  executeImport: async (archivePath, trustPaths) => {
    const res = await get().ipc.executeImport(archivePath, trustPaths);
    const trustRecords = await get().ipc.listTrustRecords();
    set({ importPreview: null, trustRecords });
    get().pushToast({
      tone: "info",
      title: `Imported ${res.importedCount} Genome Files (Zero-Trust)`,
      detail: `${trustPaths.length} executable(s) explicitly trusted; others kept disabled.`,
    });
  },

  clearImportPreview: () => set({ importPreview: null }),

  setRsiMode: async (mode) => {
    const appConfig = await get().ipc.setRsiMode(mode);
    const systemHealth = await get().ipc.getSystemHealth();
    set({ appConfig, systemHealth });
  },

  setSlotBinding: async (slot, binding) => {
    const current = get().appConfig;
    if (!current) return;
    const nextSlots = { ...current.slots, [slot]: binding };
    const appConfig = await get().ipc.updateAppConfig({ slots: nextSlots });
    set({ appConfig });
  },

  saveProvider: async (params) => {
    await get().ipc.saveProvider(params);
    const providers = await get().ipc.listProviders();
    set({ providers, aggregatedCatalog: buildAggregatedModelCatalog(providers) });
  },

  deleteProvider: async (providerId) => {
    await get().ipc.deleteProvider(providerId);
    const providers = await get().ipc.listProviders();
    set({ providers, aggregatedCatalog: buildAggregatedModelCatalog(providers) });
  },

  togglePinnedModel: async (providerId, modelId) => {
    const prov = get().providers.find((p) => p.id === providerId);
    if (!prov) return;
    const currentPins = prov.pinnedModels ?? [];
    const nextPins = currentPins.includes(modelId)
      ? currentPins.filter((m) => m !== modelId)
      : [...currentPins, modelId];
    await get().saveProvider({
      provider: {
        id: prov.id,
        name: prov.name,
        kind: prov.kind,
        apiProtocol: prov.apiProtocol,
        baseUrl: prov.baseUrl,
        models: prov.models,
        pinnedModels: nextPins,
        keyringRef: prov.keyringRef,
        hasApiKey: prov.hasApiKey,
        keys: prov.keys,
        keyStrategy: prov.keyStrategy,
        isAggregator: prov.isAggregator,
        source: prov.source,
        enabled: prov.enabled,
      },
    });
  },

  pingProvider: async (providerId) => {
    try {
      const res = await get().ipc.pingProvider(providerId);
      const providers = await get().ipc.listProviders();
      set({ providers, aggregatedCatalog: buildAggregatedModelCatalog(providers) });
      get().pushToast({
        tone: res.ok ? "success" : "error",
        title: res.ok ? `Ping OK (${res.latencyMs}ms)` : "Ping Failed",
        detail: res.error,
      });
      return res;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: PingProviderResult = { providerId, latencyMs: 0, ok: false, error: message };
      get().pushToast({ tone: "error", title: "Ping Failed", detail: message });
      return failed;
    }
  },

  fetchProviderModels: async (providerId) => {
    try {
      const models = await get().ipc.fetchProviderModels(providerId);
      const providers = await get().ipc.listProviders();
      set({ providers, aggregatedCatalog: buildAggregatedModelCatalog(providers) });
      get().pushToast({
        tone: "info",
        title: `Fetched ${models.length} model(s)`,
      });
      return models;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({ tone: "error", title: "Failed to Fetch Models", detail: message });
      throw error;
    }
  },

  importFromCcSwitch: async (simulateUnavailable = false) => {
    const result = await get().ipc.importFromCcSwitch(simulateUnavailable);
    const providers = await get().ipc.listProviders();
    set({
      providers,
      aggregatedCatalog: buildAggregatedModelCatalog(providers),
      lastImportResult: result,
    });
    get().pushToast({
      tone: result.detected ? "success" : "warning",
      title: result.detected ? "Imported from CC Switch" : "CC Switch Not Detected — Manual Setup Ready",
      detail: result.warnings[0],
    });
    return result;
  },

  importFromMagpie: async (params, simulateUnavailable = false) => {
    const result = await get().ipc.importFromMagpie(params, simulateUnavailable);
    const providers = await get().ipc.listProviders();
    set({
      providers,
      aggregatedCatalog: buildAggregatedModelCatalog(providers),
      lastImportResult: result,
    });
    get().pushToast({
      tone: result.detected ? "success" : "warning",
      title: result.detected ? "Connected Magpie Gateway" : "Magpie Gateway Unavailable — Manual Fallback",
      detail: result.warnings[0],
    });
    return result;
  },

  updateBudgetSettings: async (params) => {
    const budgetStatus = await get().ipc.updateBudgetSettings(params);
    const appConfig = await get().ipc.getAppConfig();
    set({ budgetStatus, appConfig });
    get().pushToast({
      tone: "success",
      title: "Budget & Pricing Updated",
      detail: `Daily hard cap set to $${budgetStatus.dailyLimitUsd.toFixed(2)}.`,
    });
  },

  syncPricingCatalog: async (force) => {
    set({ pricingSyncing: true });
    const locale = get().locale;
    try {
      const result = await get().ipc.syncPricingCatalog({ force });
      const budgetStatus = await get().ipc.getBudgetStatus();
      set({ lastPricingSync: result, budgetStatus });
      const sourceLabel = translate(locale, `prov.syncSource.${result.source}`);
      if (result.synced) {
        get().pushToast({
          tone: "success",
          title: translate(locale, "prov.syncToastSuccessTitle"),
          detail: translate(locale, "prov.syncToastSuccessDetail", {
            source: sourceLabel,
            count: result.modelCount,
          }),
        });
      } else {
        get().pushToast({
          tone: "warning",
          title: translate(locale, "prov.syncToastFallbackTitle"),
          detail:
            result.error ??
            translate(locale, "prov.syncToastFallbackDetail", {
              source: sourceLabel,
              count: result.modelCount,
            }),
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({
        tone: "error",
        title: translate(locale, "prov.syncToastFailedTitle"),
        detail: message,
      });
      return null;
    } finally {
      set({ pricingSyncing: false });
    }
  },

  checkForUpdates: async () => {
    try {
      const updateStatus = await get().ipc.checkForUpdates();
      set({ updateStatus });
      return updateStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = get().updateStatus;
      const fallback: UpdateStatus = {
        phase: "error",
        info: current?.info ?? { currentVersion: "0.1.0", compatLevel: "safe" },
        downloadedBytes: current?.downloadedBytes ?? 0,
        totalBytes: current?.totalBytes ?? 0,
        verifiedSha256: false,
        error: message,
      };
      set({ updateStatus: fallback });
      return fallback;
    }
  },

  downloadUpdate: async () => {
    try {
      const updateStatus = await get().ipc.downloadUpdate();
      set({ updateStatus });
      return updateStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = get().updateStatus;
      const fallback: UpdateStatus = {
        phase: "error",
        info: current?.info ?? { currentVersion: "0.1.0", compatLevel: "safe" },
        downloadedBytes: current?.downloadedBytes ?? 0,
        totalBytes: current?.totalBytes ?? 0,
        verifiedSha256: false,
        error: message,
      };
      set({ updateStatus: fallback });
      return fallback;
    }
  },

  installUpdate: async () => {
    try {
      const updateStatus = await get().ipc.installUpdate();
      set({ updateStatus });
      return updateStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = get().updateStatus;
      const fallback: UpdateStatus = {
        phase: "error",
        info: current?.info ?? { currentVersion: "0.1.0", compatLevel: "safe" },
        downloadedBytes: current?.downloadedBytes ?? 0,
        totalBytes: current?.totalBytes ?? 0,
        verifiedSha256: current?.verifiedSha256 ?? false,
        error: message,
      };
      set({ updateStatus: fallback });
      return fallback;
    }
  },

  checkHarnessCompatibility: async () => {
    try {
      const compatibilityReport = await get().ipc.checkHarnessCompatibility();
      set({ compatibilityReport, dismissedMigrationAlert: false });
      return compatibilityReport;
    } catch {
      return null;
    }
  },

  startHarnessMigration: async () => {
    set({ isMigrating: true, theaterLogs: [] });
    try {
      const report = get().compatibilityReport ?? undefined;
      const proposal = await get().ipc.startHarnessMigration(report);
      const proposals = await get().ipc.listProposals();
      set({
        proposals,
        selectedProposalId: proposal.id,
        rightTab: "triage",
      });
      get().pushToast({
        tone: "success",
        title: translate(get().locale, "toast.migrationReadyTitle"),
        detail: translate(get().locale, "toast.migrationReadyDetail"),
      });
      return proposal;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().pushToast({
        tone: "error",
        title: translate(get().locale, "toast.migrationFailedTitle"),
        detail: message,
      });
      return null;
    } finally {
      set({ isMigrating: false });
    }
  },

  dismissMigrationAlert: () => set({ dismissedMigrationAlert: true }),

  refreshGardenerReport: async () => {
    set({ gardenerLoading: true });
    try {
      const gardenerReport = await get().ipc.getGardenerReport();
      set({ gardenerReport, gardenerLoading: false });
      return gardenerReport;
    } catch {
      set({ gardenerLoading: false });
      return null;
    }
  },

  launchPruningEvolution: (goal) => {
    set({ pendingLabGoal: goal, activePage: "lab" });
  },

  consumePendingLabGoal: () => {
    set({ pendingLabGoal: null });
  },

  handleIpcEvent: (event) => {
    switch (event.type) {
      case "runner.started": {
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === event.threadId ? { ...t, status: "running", pinnedCommitSha: event.pinnedCommitSha } : t,
          ),
          streamingByThread: {
            ...s.streamingByThread,
            [event.threadId]: {
              runId: event.runId,
              startedAt: Date.now(),
              content: "",
              reasoning: "",
              toolCalls: [],
              timeline: [],
            },
          },
        }));
        break;
      }
      case "runner.token": {
        set((s) => {
          const prev = s.streamingByThread[event.threadId] ?? {
            runId: event.runId,
            startedAt: Date.now(),
            content: "",
            reasoning: "",
            toolCalls: [],
            timeline: [],
          };
          if (event.channel === "reasoning") {
            const timeline = [...prev.timeline];
            const last = timeline[timeline.length - 1];
            if (last && last.kind === "reasoning") {
              timeline[timeline.length - 1] = { ...last, text: last.text + event.delta };
            } else {
              timeline.push({
                id: `reason-${timeline.length + 1}`,
                kind: "reasoning",
                text: event.delta,
              });
            }
            return {
              streamingByThread: {
                ...s.streamingByThread,
                [event.threadId]: {
                  ...prev,
                  reasoning: prev.reasoning + event.delta,
                  timeline,
                },
              },
            };
          }
          return {
            streamingByThread: {
              ...s.streamingByThread,
              [event.threadId]: { ...prev, content: prev.content + event.delta },
            },
          };
        });
        break;
      }
      case "runner.tool_call": {
        set((s) => {
          const prev = s.streamingByThread[event.threadId] ?? {
            runId: event.runId,
            startedAt: Date.now(),
            content: "",
            reasoning: "",
            toolCalls: [],
            timeline: [],
          };
          const timeline = [...prev.timeline];
          const existingIdx = timeline.findIndex(
            (item) => item.kind === "tool" && item.toolCall.id === event.toolCall.id,
          );
          if (existingIdx >= 0) {
            timeline[existingIdx] = {
              id: event.toolCall.id,
              kind: "tool",
              toolCall: event.toolCall,
            };
          } else {
            timeline.push({
              id: event.toolCall.id,
              kind: "tool",
              toolCall: event.toolCall,
            });
          }
          return {
            streamingByThread: {
              ...s.streamingByThread,
              [event.threadId]: {
                ...prev,
                toolCalls: upsertToolCall(prev.toolCalls, event.toolCall),
                timeline,
              },
            },
          };
        });
        break;
      }
      case "runner.tool_result": {
        set((s) => {
          const prev = s.streamingByThread[event.threadId];
          if (!prev) return s;
          const patchTool = (tc: ToolCallRecord): ToolCallRecord =>
            tc.id === event.toolCallId
              ? {
                  ...tc,
                  status: event.error ? "failed" : "completed",
                  output: event.output,
                  error: event.error,
                  exitCode: event.exitCode ?? tc.exitCode,
                  durationMs: event.durationMs ?? tc.durationMs,
                  truncated: event.truncated,
                  finishedAt: new Date().toISOString(),
                }
              : tc;
          return {
            streamingByThread: {
              ...s.streamingByThread,
              [event.threadId]: {
                ...prev,
                toolCalls: prev.toolCalls.map(patchTool),
                timeline: prev.timeline.map((item) =>
                  item.kind === "tool" && item.toolCall.id === event.toolCallId
                    ? { ...item, toolCall: patchTool(item.toolCall) }
                    : item,
                ),
              },
            },
          };
        });
        break;
      }
      case "runner.goal_updated": {
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === event.threadId ? { ...t, goals: event.goals } : t,
          ),
        }));
        break;
      }
      case "runner.context_usage": {
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === event.threadId
              ? { ...t, contextUsedTokens: event.usedTokens, contextMaxTokens: event.maxTokens }
              : t,
          ),
        }));
        break;
      }
      case "runner.paused": {
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === event.threadId ? { ...t, status: "paused" } : t,
          ),
        }));
        break;
      }
      case "runner.steered": {
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === event.threadId ? { ...t, hadHumanSteer: true } : t,
          ),
        }));
        break;
      }
      case "runner.completed": {
        void get()
          .ipc.getThreadMessages(event.threadId)
          .then((msgs) => {
            void get()
              .ipc.getBudgetStatus()
              .then((budgetStatus) => {
                set((s) => {
                  const nextStreaming = { ...s.streamingByThread };
                  delete nextStreaming[event.threadId];
                  return {
                    threads: s.threads.map((t) =>
                      t.id === event.threadId ? { ...t, status: "completed" } : t,
                    ),
                    messagesByThread: {
                      ...s.messagesByThread,
                      [event.threadId]: dedupeMessagesById(msgs),
                    },
                    streamingByThread: nextStreaming,
                    budgetStatus,
                  };
                });
              });
          });
        if (event.queuedForEvolution) {
          get().pushToast({
            tone: "info",
            title: "Steered Run Queued for Harness² Evolution",
            detail: "Background evolution will distill your steer signal into a candidate proposal.",
          });
        }
        break;
      }
      case "runner.error": {
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === event.threadId ? { ...t, status: "failed" } : t,
          ),
        }));
        get().pushToast({ tone: "error", title: "Runner Error", detail: event.message });
        break;
      }
      case "security.approval_required":
      case "trust.hook_confirm": {
        set((s) => ({
          pendingApprovals: [
            event.request,
            ...s.pendingApprovals.filter((a) => a.requestId !== event.request.requestId),
          ],
          threads: s.threads.map((t) =>
            t.id === event.request.threadId ? { ...t, status: "awaiting_approval" } : t,
          ),
        }));
        break;
      }
      case "security.approval_resolved": {
        set((s) => ({
          pendingApprovals: s.pendingApprovals.filter((a) => a.requestId !== event.requestId),
        }));
        break;
      }
      case "guardian.decision": {
        set((s) => ({
          guardianDecisions: [event.decision, ...s.guardianDecisions],
        }));
        break;
      }
      case "evolution.step.started": {
        set((s) => ({
          theaterStage: event.stage,
          theaterLogs: [
            ...s.theaterLogs,
            {
              id: `tl-${Date.now()}-${Math.random()}`,
              proposalId: event.proposalId,
              stage: event.stage,
              kind: "started",
              text: event.label,
              timestamp: event.timestamp,
            },
          ],
        }));
        break;
      }
      case "evolution.step.progress": {
        set((s) => ({
          theaterStage: event.stage,
          theaterLiveMetrics: event.metricsSnapshot ?? s.theaterLiveMetrics,
          theaterLogs: [
            ...s.theaterLogs,
            {
              id: `tl-${Date.now()}-${Math.random()}`,
              proposalId: event.proposalId,
              stage: event.stage,
              kind: "progress",
              text: event.message,
              metricsSnapshot: event.metricsSnapshot,
              timestamp: event.timestamp,
            },
          ],
        }));
        break;
      }
      case "evolution.step.completed": {
        set((s) => ({
          theaterLogs: [
            ...s.theaterLogs,
            {
              id: `tl-${Date.now()}-${Math.random()}`,
              proposalId: event.proposalId,
              stage: event.stage,
              kind: "completed",
              text: event.summary,
              timestamp: event.timestamp,
            },
          ],
        }));
        break;
      }
      case "evolution.proposal_ready": {
        set((s) => ({
          proposals: [
            event.proposal,
            ...s.proposals.filter((p) => p.id !== event.proposal.id),
          ],
          selectedProposalId: event.proposal.id,
        }));
        void Promise.all([
          get().ipc.getBudgetStatus(),
          get().ipc.getSilentArchiveCount(),
        ])
          .then(([budgetStatus, silentArchiveCount]) => {
            set({ budgetStatus, silentArchiveCount });
          })
          .catch(() => {
            // Non-blocking background telemetry refresh
          });
        break;
      }
      case "evolution.health_rollback": {
        get().pushToast({
          tone: "warning",
          title: `Auto Health Rollback (${event.domain})`,
          detail: `${event.fromSha.slice(0, 7)} → ${event.toSha.slice(0, 7)}: ${event.reason}`,
        });
        break;
      }
      case "update.status_changed": {
        set({ updateStatus: event.status });
        break;
      }
    }
  },
}));
