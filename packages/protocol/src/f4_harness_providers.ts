import { z } from "zod";
import {
  HarnessComponentKindSchema,
  ProviderKindSchema,
  RsiModeSchema,
  RunMetricsSchema,
} from "./common.ts";

// --- Genome Deck (Git / Replay / Export-Import) ---

export const GenomeCommitSchema = z.object({
  sha: z.string().min(1),
  parentSha: z.string().optional(),
  versionTag: z.string().min(1),
  message: z.string(),
  timestamp: z.string(),
  domain: z.string().optional(),
  passRate: z.number().min(0).max(1).optional(),
  changedComponents: z.array(HarnessComponentKindSchema).default([]),
  isRollback: z.boolean().default(false),
});
export type GenomeCommit = z.infer<typeof GenomeCommitSchema>;

export const GenomeFileSchema = z.object({
  path: z.string().min(1),
  component: HarnessComponentKindSchema,
  content: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export type GenomeFile = z.infer<typeof GenomeFileSchema>;

export const HarnessPatchOpSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["upsert", "delete"]),
  content: z.string().optional(),
});
export type HarnessPatchOp = z.infer<typeof HarnessPatchOpSchema>;

export const GitCommitPatchParamsSchema = z.object({
  baseCommitSha: z.string().min(1),
  message: z.string().min(1),
  domain: z.string().default("general"),
  operations: z.array(HarnessPatchOpSchema).min(1),
  authorName: z.string().default("Harnex"),
});
export type GitCommitPatchParams = z.infer<typeof GitCommitPatchParamsSchema>;

export const GitCommitPatchResultSchema = z.object({
  ok: z.boolean(),
  newCommitSha: z.string().optional(),
  conflict: z.boolean().default(false),
  conflictingFiles: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type GitCommitPatchResult = z.infer<typeof GitCommitPatchResultSchema>;

export const SecretScanFindingSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  rule: z.string(),
  maskedSnippet: z.string(),
});
export type SecretScanFinding = z.infer<typeof SecretScanFindingSchema>;

export const ExportScanResultSchema = z.object({
  includedFiles: z.array(z.string()),
  excludedFiles: z.array(z.string()),
  findings: z.array(SecretScanFindingSchema),
  safeToExport: z.boolean(),
});
export type ExportScanResult = z.infer<typeof ExportScanResultSchema>;

export const ImportPreviewSchema = z.object({
  archivePath: z.string(),
  files: z.array(z.string()),
  untrustedExecutables: z.array(z.string()),
});
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

export const ReplayCompareParamsSchema = z.object({
  taskPrompt: z.string().min(1),
  workspacePath: z.string().min(1),
  v0Sha: z.string().min(1),
  vNSha: z.string().min(1),
  modelId: z.string().optional(),
});
export type ReplayCompareParams = z.infer<typeof ReplayCompareParamsSchema>;

export const ReplayComparisonSchema = z.object({
  id: z.string().min(1),
  taskPrompt: z.string(),
  v0Sha: z.string(),
  vNSha: z.string(),
  modelId: z.string(),
  v0Metrics: RunMetricsSchema,
  vNMetrics: RunMetricsSchema,
  v0Output: z.string(),
  vNOutput: z.string(),
  status: z.enum(["running", "completed", "failed"]),
});
export type ReplayComparison = z.infer<typeof ReplayComparisonSchema>;

// --- Providers, Multi-Key Pools, Model Aggregation & CC Switch / Magpie Import ---

export const KeyRotationStrategySchema = z.enum(["priority_failover", "round_robin"]);
export type KeyRotationStrategy = z.infer<typeof KeyRotationStrategySchema>;

export const ProviderKeyEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  keyringRef: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().nonnegative().default(0),
  maskedHint: z.string().optional(),
  lastError: z.string().optional(),
  cooldownUntil: z.string().optional(),
});
export type ProviderKeyEntry = z.infer<typeof ProviderKeyEntrySchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: ProviderKindSchema,
  baseUrl: z.string().min(1),
  models: z.array(z.string()).default([]),
  pinnedModels: z.array(z.string()).optional(),
  keyringRef: z.string().min(1),
  hasApiKey: z.boolean().default(false),
  keys: z.array(ProviderKeyEntrySchema).optional(),
  keyStrategy: KeyRotationStrategySchema.optional(),
  isAggregator: z.boolean().optional(),
  source: z.enum(["manual", "cc-switch", "magpie"]).default("manual"),
  enabled: z.boolean().default(true),
  lastPingMs: z.number().int().nonnegative().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const AggregatedModelEntrySchema = z.object({
  catalogId: z.string().min(1), // `${providerId}::${modelId}`
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  providerKind: ProviderKindSchema,
  providerSource: z.enum(["manual", "cc-switch", "magpie"]),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  upstreamGroup: z.string().optional(),
  isAggregator: z.boolean().default(false),
  isRoutingGroup: z.boolean().default(false),
  pinned: z.boolean().default(false),
  activeKeyCount: z.number().int().nonnegative().default(0),
});
export type AggregatedModelEntry = z.infer<typeof AggregatedModelEntrySchema>;

export const SlotBindingSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});
export type SlotBinding = z.infer<typeof SlotBindingSchema>;

export const SlotBindingsSchema = z.object({
  solver: SlotBindingSchema.optional(),
  improver: SlotBindingSchema.optional(),
  judge: SlotBindingSchema.optional(),
});
export type SlotBindings = z.infer<typeof SlotBindingsSchema>;

export const ProviderImportResultSchema = z.object({
  source: z.enum(["cc-switch", "magpie"]),
  detected: z.boolean(),
  importedProviders: z.array(ProviderConfigSchema),
  warnings: z.array(z.string()).default([]),
  fallbackToManual: z.boolean().default(false),
});
export type ProviderImportResult = z.infer<typeof ProviderImportResultSchema>;

// --- Budget & System Health ---

export const ModelPricingSchema = z.object({
  modelId: z.string().min(1),
  inputPer1MUsd: z.number().nonnegative(),
  outputPer1MUsd: z.number().nonnegative(),
  cachedInputPer1MUsd: z.number().nonnegative().optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const BudgetStatusSchema = z.object({
  dailyLimitUsd: z.number().positive(),
  spentTodayUsd: z.number().nonnegative(),
  tokensToday: z.number().int().nonnegative(),
  unpricedTokensToday: z.number().int().nonnegative().optional(),
  unpricedModelsToday: z.array(z.string()).optional(),
  costSource: z.enum(["estimated", "upstream_actual", "mixed", "unpriced"]).optional(),
  tripped: z.boolean(),
  pricingTable: z.array(ModelPricingSchema),
});
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

export const PricingSyncParamsSchema = z.object({
  remoteUrl: z.string().min(1).optional(),
  hashUrl: z.string().optional(),
  force: z.boolean().optional(),
});
export type PricingSyncParams = z.infer<typeof PricingSyncParamsSchema>;

export const PricingSyncResultSchema = z.object({
  synced: z.boolean(),
  source: z.enum(["remote", "cache", "embedded"]),
  modelCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type PricingSyncResult = z.infer<typeof PricingSyncResultSchema>;

export const AppConfigSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  rsiMode: RsiModeSchema.default("manual"),
  defaultWorkspace: z.string().optional(),
  slots: SlotBindingsSchema.default({}),
  dailyBudgetLimitUsd: z.number().positive().default(5.0),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const SystemHealthSchema = z.object({
  sidecarAlive: z.boolean(),
  sidecarRestartCount: z.number().int().nonnegative(),
  platform: z.enum(["macos", "linux", "windows"]),
  sandboxBackend: z.string(),
  osSandboxLevel: z.enum(["full", "beta"]),
  bunEmbeddedOk: z.boolean(),
  activeCommitSha: z.string(),
  rsiMode: RsiModeSchema,
});
export type SystemHealth = z.infer<typeof SystemHealthSchema>;

// --- F0: Onboarding Dual-Mode ---

export const OnboardingReplayStepSchema = z.object({
  offsetMs: z.number().int().nonnegative(),
  stage: z.enum([
    "task_start",
    "v0_failure",
    "steer_captured",
    "evolution_propose",
    "shadow_probe",
    "blind_judge",
    "proposal_adopt",
    "v1_replay_success",
  ]),
  title: z.string(),
  detail: z.string(),
  metrics: RunMetricsSchema.optional(),
});
export type OnboardingReplayStep = z.infer<typeof OnboardingReplayStepSchema>;

export const OnboardingReplayTraceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  isRecordedReplay: z.literal(true),
  disclaimer: z.string(),
  recordedModel: z.string(),
  recordedAt: z.string(),
  steps: z.array(OnboardingReplayStepSchema),
  v0Metrics: RunMetricsSchema,
  v1Metrics: RunMetricsSchema,
});
export type OnboardingReplayTrace = z.infer<typeof OnboardingReplayTraceSchema>;

// --- Auto-Updater (L0 Rust Managed) ---

export const UpdatePhaseSchema = z.enum([
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "installing",
  "up_to_date",
  "error",
]);
export type UpdatePhase = z.infer<typeof UpdatePhaseSchema>;

export const UpdateCompatLevelSchema = z.enum(["safe", "auto_migrate", "breaking"]);
export type UpdateCompatLevel = z.infer<typeof UpdateCompatLevelSchema>;

export const UpdateInfoSchema = z.object({
  currentVersion: z.string().min(1),
  latestVersion: z.string().optional(),
  releaseNotes: z.string().optional(),
  publishedAt: z.string().optional(),
  assetName: z.string().optional(),
  downloadUrl: z.string().optional(),
  sha256: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  harnessSchemaVersion: z.number().int().positive().optional(),
  compatLevel: UpdateCompatLevelSchema.default("safe"),
  migrationNotes: z.string().optional(),
});
export type UpdateInfo = z.infer<typeof UpdateInfoSchema>;

export const UpdateStatusSchema = z.object({
  phase: UpdatePhaseSchema,
  info: UpdateInfoSchema,
  downloadedBytes: z.number().int().nonnegative().default(0),
  totalBytes: z.number().int().nonnegative().default(0),
  downloadedPath: z.string().optional(),
  verifiedSha256: z.boolean().default(false),
  backupTag: z.string().optional(),
  checkedAt: z.string().optional(),
  error: z.string().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const UpdateEventSchema = z.object({
  type: z.literal("update.status_changed"),
  status: UpdateStatusSchema,
});
export type UpdateEvent = z.infer<typeof UpdateEventSchema>;
