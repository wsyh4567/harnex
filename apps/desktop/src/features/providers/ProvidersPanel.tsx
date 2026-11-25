import { useEffect, useRef, useState } from "react";
import type {
  KeyRotationStrategy,
  ModelPricing,
  ModelSlot,
  OpenAiApiProtocol,
  ProviderConfig,
  ProviderKind,
} from "@harnex/protocol";
import {
  AlertTriangle,
  Check,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
  Wallet,
  Wand2,
  X,
} from "lucide-react";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import { useI18n } from "../../i18n/index.ts";
import type { PingProviderResult } from "../../ipc/index.ts";
import { cn, formatRelativeTime, formatTokens, formatUsd } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { isProviderAggregator } from "./modelCatalog.ts";
import { ProviderCard } from "./ProviderCard.tsx";
import {
  appendUnpricedModelPricingRow,
  computeSlotReadiness,
  PROVIDER_PRESETS,
  resolveCostSourceBadge,
  resolveDefaultBaseUrlOnKindChange,
  syncBudgetDraftFromStatus,
  type ProviderPreset,
} from "./providerPresets.ts";

const PROVIDER_KINDS: ProviderKind[] = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "openai_compatible",
];

export function ProvidersPanel() {
  const {
    ipc,
    providers,
    appConfig,
    budgetStatus,
    pricingSyncing,
    lastPricingSync,
    lastImportResult,
    saveProvider,
    deleteProvider,
    togglePinnedModel,
    pingProvider,
    fetchProviderModels,
    importFromCcSwitch,
    importFromMagpie,
    setSlotBinding,
    setRsiMode,
    updateBudgetSettings,
    syncPricingCatalog,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();
  const costMeta = resolveCostSourceBadge(budgetStatus?.costSource, locale);
  const unpricedModels = budgetStatus?.unpricedModelsToday ?? [];

  const slots: Array<{ id: ModelSlot; label: string; desc: string }> = [
    { id: "solver", label: t("prov.slot.solver"), desc: t("prov.slot.solverDesc") },
    { id: "improver", label: t("prov.slot.improver"), desc: t("prov.slot.improverDesc") },
    { id: "judge", label: t("prov.slot.judge"), desc: t("prov.slot.judgeDesc") },
  ];

  const isMockMode = ipc.mode === "mock";
  const formRef = useRef<HTMLFormElement | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProviderKind>("openai_compatible");
  const [apiProtocol, setApiProtocol] = useState<OpenAiApiProtocol>("auto");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelsInput, setModelsInput] = useState("gpt-4.1-mini, gpt-4.1");
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [keyStrategyDraft, setKeyStrategyDraft] =
    useState<KeyRotationStrategy>("priority_failover");
  const [isAggregatorDraft, setIsAggregatorDraft] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);

  const [magpieUrl, setMagpieUrl] = useState("http://127.0.0.1:3425");
  const [showMagpieLink, setShowMagpieLink] = useState(false);
  const [magpieImportLink, setMagpieImportLink] = useState("");
  const [importingCcSwitch, setImportingCcSwitch] = useState(false);
  const [importingMagpie, setImportingMagpie] = useState(false);

  const [pingingIds, setPingingIds] = useState<Record<string, boolean>>({});
  const [fetchingIds, setFetchingIds] = useState<Record<string, boolean>>({});
  const [pingFeedback, setPingFeedback] = useState<Record<string, PingProviderResult>>({});
  const [fetchFeedback, setFetchFeedback] = useState<
    Record<string, { count: number; error?: string }>
  >({});

  const [dailyLimit, setDailyLimit] = useState(String(budgetStatus?.dailyLimitUsd ?? 5));
  const [pricingDraft, setPricingDraft] = useState<ModelPricing[]>(
    budgetStatus?.pricingTable ?? [],
  );
  const [newModelId, setNewModelId] = useState("");
  const [newInRate, setNewInRate] = useState("1.0");
  const [newOutRate, setNewOutRate] = useState("4.0");
  const [budgetSavedFlash, setBudgetSavedFlash] = useState(false);

  useEffect(() => {
    const synced = syncBudgetDraftFromStatus(budgetStatus);
    setDailyLimit(synced.dailyLimit);
    setPricingDraft(synced.pricingTable);
  }, [budgetStatus]);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setKind("openai_compatible");
    setApiProtocol("auto");
    setBaseUrl("https://api.openai.com/v1");
    setApiKey("");
    setShowApiKey(false);
    setModelsInput("gpt-4.1-mini, gpt-4.1");
    setEnabledDraft(true);
    setKeyStrategyDraft("priority_failover");
    setIsAggregatorDraft(false);
  };

  const applyPreset = (preset: ProviderPreset) => {
    setName(preset.name);
    setKind(preset.kind);
    setApiProtocol("auto");
    setBaseUrl(preset.baseUrl);
    setModelsInput(preset.models.join(", "));
    setEnabledDraft(true);
    setIsAggregatorDraft(false);
  };

  const startEditing = (prov: ProviderConfig) => {
    setEditingId(prov.id);
    setName(prov.name);
    setKind(prov.kind);
    setApiProtocol(prov.apiProtocol ?? "auto");
    setBaseUrl(prov.baseUrl);
    setApiKey("");
    setShowApiKey(false);
    setModelsInput(prov.models.join(", "));
    setEnabledDraft(prov.enabled);
    setKeyStrategyDraft(prov.keyStrategy ?? "priority_failover");
    setIsAggregatorDraft(isProviderAggregator(prov));
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const buildProviderSnapshot = (prov: ProviderConfig) => ({
    id: prov.id,
    name: prov.name,
    kind: prov.kind,
    apiProtocol: prov.apiProtocol,
    baseUrl: prov.baseUrl,
    models: prov.models,
    pinnedModels: prov.pinnedModels,
    keyringRef: prov.keyringRef,
    hasApiKey: prov.hasApiKey,
    keys: prov.keys,
    keyStrategy: prov.keyStrategy,
    isAggregator: prov.isAggregator,
    source: prov.source,
    enabled: prov.enabled,
  });

  const handleSaveProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !baseUrl.trim() || savingProvider) return;
    setSavingProvider(true);
    try {
      const existing = editingId ? providers.find((p) => p.id === editingId) : undefined;
      await saveProvider({
        provider: {
          id: editingId ?? undefined,
          name: name.trim(),
          kind,
          apiProtocol:
            kind === "openai" || kind === "openai_compatible" ? apiProtocol : undefined,
          baseUrl: baseUrl.trim(),
          models: modelsInput
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean),
          pinnedModels: existing?.pinnedModels,
          keyringRef: existing?.keyringRef,
          hasApiKey: existing?.hasApiKey,
          keys: existing?.keys,
          keyStrategy: keyStrategyDraft,
          isAggregator: isAggregatorDraft,
          source: existing?.source ?? "manual",
          enabled: enabledDraft,
        },
        apiKey: apiKey.trim() || undefined,
      });
      resetForm();
    } finally {
      setSavingProvider(false);
    }
  };

  const handleToggleEnabled = async (prov: ProviderConfig) => {
    await saveProvider({
      provider: { ...buildProviderSnapshot(prov), enabled: !prov.enabled },
    });
  };

  const handleChangeStrategy = async (prov: ProviderConfig, keyStrategy: KeyRotationStrategy) => {
    await saveProvider({
      provider: { ...buildProviderSnapshot(prov), keyStrategy },
    });
  };

  const handleToggleKeyEnabled = async (prov: ProviderConfig, keyId: string) => {
    const nextKeys = (prov.keys ?? []).map((k) =>
      k.id === keyId ? { ...k, enabled: !k.enabled } : k,
    );
    await saveProvider({
      provider: { ...buildProviderSnapshot(prov), keys: nextKeys },
    });
  };

  const handleDeleteKey = async (prov: ProviderConfig, keyId: string) => {
    await saveProvider({
      provider: buildProviderSnapshot(prov),
      keyRemovals: [keyId],
    });
  };

  const handleAddKey = async (prov: ProviderConfig, label: string, secret: string) => {
    await saveProvider({
      provider: buildProviderSnapshot(prov),
      keyAdditions: [{ label, apiKey: secret }],
    });
  };

  const handlePing = async (providerId: string) => {
    setPingingIds((prev) => ({ ...prev, [providerId]: true }));
    try {
      const res = await pingProvider(providerId);
      setPingFeedback((prev) => ({ ...prev, [providerId]: res }));
    } finally {
      setPingingIds((prev) => ({ ...prev, [providerId]: false }));
    }
  };

  const handleFetchModels = async (providerId: string) => {
    setFetchingIds((prev) => ({ ...prev, [providerId]: true }));
    try {
      const models = await fetchProviderModels(providerId);
      setFetchFeedback((prev) => ({ ...prev, [providerId]: { count: models.length } }));
    } catch (err) {
      setFetchFeedback((prev) => ({
        ...prev,
        [providerId]: { count: 0, error: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setFetchingIds((prev) => ({ ...prev, [providerId]: false }));
    }
  };

  const handleCcSwitchImport = async (simulateUnavailable: boolean) => {
    setImportingCcSwitch(true);
    try {
      await importFromCcSwitch(simulateUnavailable);
    } finally {
      setImportingCcSwitch(false);
    }
  };

  const handleMagpieImport = async (simulateUnavailable: boolean) => {
    setImportingMagpie(true);
    try {
      await importFromMagpie(
        {
          gatewayUrl: magpieUrl,
          importLink:
            showMagpieLink && magpieImportLink.trim() ? magpieImportLink.trim() : undefined,
        },
        simulateUnavailable,
      );
    } finally {
      setImportingMagpie(false);
    }
  };

  const handleAddPricingRow = () => {
    const id = newModelId.trim();
    if (!id) return;
    setPricingDraft((prev) => [
      ...prev.filter((r) => r.modelId !== id),
      {
        modelId: id,
        inputPer1MUsd: Math.max(0, Number(newInRate) || 0),
        outputPer1MUsd: Math.max(0, Number(newOutRate) || 0),
      },
    ]);
    setNewModelId("");
  };

  const handleSaveBudget = async () => {
    await updateBudgetSettings({
      dailyLimitUsd: Math.max(0.5, Number(dailyLimit) || 5),
      pricingTable: pricingDraft,
    });
    setBudgetSavedFlash(true);
    setTimeout(() => setBudgetSavedFlash(false), 2000);
  };

  const improverModel = appConfig?.slots.improver?.modelId;
  const judgeModel = appConfig?.slots.judge?.modelId;
  const sameModelBias = Boolean(improverModel && judgeModel && improverModel === judgeModel);
  const readiness = computeSlotReadiness(appConfig?.slots, providers);
  const availableSlotOptions = providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ providerId: p.id, providerName: p.name, modelId: m })));

  return (
    <div className="h-full overflow-y-auto p-5 space-y-6">
      {/* One-Click Import Wizards */}
      <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-[var(--hx-accent)]" />
            <h2 className="text-xs font-semibold text-[var(--hx-text)]">{t("prov.wizardsTitle")}</h2>
          </div>
          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            <Shield className="h-3 w-3" />
            {t("prov.keyringProtected")}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
            <div className="text-xs font-semibold text-[var(--hx-text)]">{t("prov.ccTitle")}</div>
            <p className="text-[11px] text-[var(--hx-text-2)]">{t("prov.ccDesc")}</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={importingCcSwitch}
                onClick={() => void handleCcSwitchImport(false)}
                className="hx-pressable flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] px-2.5 py-1.5 text-xs font-medium text-[var(--hx-accent)] disabled:opacity-50"
              >
                {importingCcSwitch && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>{t("prov.ccBtn")}</span>
              </button>
              {isMockMode && (
                <button
                  type="button"
                  disabled={importingCcSwitch}
                  onClick={() => void handleCcSwitchImport(true)}
                  className="hx-pressable rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-[10px] text-[var(--hx-text-2)]"
                >
                  {t("prov.testFallback")}
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[var(--hx-text)]">
                {t("prov.magpieTitle")}
              </span>
              <button
                type="button"
                onClick={() => setShowMagpieLink((v) => !v)}
                className="inline-flex items-center gap-1 text-[10px] text-violet-700 hover:underline dark:text-violet-300"
              >
                <Link2 className="h-3 w-3" />
                <span>{showMagpieLink ? t("prov.magpieHideLink") : "magpie://import"}</span>
              </button>
            </div>
            <input
              type="text"
              aria-label="Magpie gateway URL"
              value={magpieUrl}
              onChange={(e) => setMagpieUrl(e.target.value)}
              placeholder="http://127.0.0.1:3425"
              className="w-full rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-2.5 py-1 font-mono text-[11px] text-[var(--hx-text)]"
            />
            {showMagpieLink && (
              <input
                type="text"
                aria-label="Magpie import link"
                value={magpieImportLink}
                onChange={(e) => setMagpieImportLink(e.target.value)}
                placeholder="magpie://import?name=...&baseUrl=...&model=..."
                className="w-full rounded-xl border border-violet-500/35 bg-[var(--hx-surface)] px-2.5 py-1 font-mono text-[11px] text-[var(--hx-text)]"
              />
            )}
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={importingMagpie}
                onClick={() => void handleMagpieImport(false)}
                className="hx-pressable flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-violet-500/35 bg-violet-50 px-2.5 py-1.5 text-xs font-medium text-violet-800 dark:bg-violet-500/15 dark:text-violet-200"
              >
                {importingMagpie && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>{t("prov.magpieBtn")}</span>
              </button>
              {isMockMode && (
                <button
                  type="button"
                  disabled={importingMagpie}
                  onClick={() => void handleMagpieImport(true)}
                  className="hx-pressable rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-[10px] text-[var(--hx-text-2)]"
                >
                  {t("prov.testFallback")}
                </button>
              )}
            </div>
          </div>
        </div>

        {lastImportResult && (
          <div
            className={cn(
              "space-y-1.5 rounded-xl border px-3 py-2.5 text-xs",
              lastImportResult.detected
                ? "border-emerald-500/30 bg-emerald-50/75 text-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-100"
                : "border-amber-500/35 bg-amber-50/75 text-amber-900 dark:bg-amber-950/20 dark:text-amber-100",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold">
                {lastImportResult.source}:{" "}
                {lastImportResult.detected
                  ? t("prov.importSuccess", { count: lastImportResult.importedProviders.length })
                  : t("prov.importNotDetected")}
              </div>
              {lastImportResult.fallbackToManual && (
                <button
                  type="button"
                  onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth" })}
                  className="rounded-lg border border-amber-500/35 bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-100"
                >
                  {t("prov.manualSetupJump")}
                </button>
              )}
            </div>
            {lastImportResult.importedProviders.map((imp) => (
              <div
                key={imp.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/20 bg-[var(--hx-surface)] px-2.5 py-1.5 text-[11px]"
              >
                <div className="min-w-0">
                  <span className="font-semibold text-[var(--hx-text)]">{imp.name}</span>{" "}
                  <span className="font-mono text-[var(--hx-text-3)]">{imp.baseUrl}</span>{" "}
                  <span className="text-emerald-700 dark:text-emerald-300">
                    · {imp.hasApiKey ? t("prov.keyringOk") : t("prov.setApiKey")}
                  </span>
                </div>
                {imp.models[0] && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        void setSlotBinding("solver", { providerId: imp.id, modelId: imp.models[0]! })
                      }
                      className="rounded-md border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--hx-accent)]"
                    >
                      {t("prov.useAsSolver")}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void setSlotBinding("improver", {
                          providerId: imp.id,
                          modelId: imp.models[0]!,
                        })
                      }
                      className="rounded-md border border-violet-500/35 bg-violet-50 px-2 py-0.5 text-[10px] text-violet-800 dark:bg-violet-500/10 dark:text-violet-200"
                    >
                      {t("prov.useAsImprover")}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {lastImportResult.warnings.map((w, i) => (
              <div key={i} className="text-[11px] opacity-90">
                {w}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Configured Providers */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-[var(--hx-text-2)]">
            {t("prov.listTitle", { count: providers.length })}
          </h3>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="text-[11px] text-[var(--hx-accent)] hover:underline"
            >
              {t("prov.newProviderLink")}
            </button>
          )}
        </div>

        <div className="space-y-3">
          {providers.map((prov) => (
            <ProviderCard
              key={prov.id}
              provider={prov}
              isEditing={editingId === prov.id}
              pinging={Boolean(pingingIds[prov.id])}
              fetching={Boolean(fetchingIds[prov.id])}
              pingResult={pingFeedback[prov.id]}
              fetchResult={fetchFeedback[prov.id]}
              onEdit={startEditing}
              onDelete={(id) => {
                if (editingId === id) resetForm();
                void deleteProvider(id);
              }}
              onToggleEnabled={(p) => void handleToggleEnabled(p)}
              onPing={(id) => void handlePing(id)}
              onFetchModels={(id) => void handleFetchModels(id)}
              onTogglePinModel={(provId, modelId) => void togglePinnedModel(provId, modelId)}
              onChangeStrategy={(p, strat) => void handleChangeStrategy(p, strat)}
              onToggleKeyEnabled={(p, kId) => void handleToggleKeyEnabled(p, kId)}
              onDeleteKey={(p, kId) => void handleDeleteKey(p, kId)}
              onAddKey={handleAddKey}
            />
          ))}
        </div>

        {/* Add / Edit Provider Form */}
        <form
          ref={formRef}
          onSubmit={(e) => void handleSaveProvider(e)}
          className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--hx-text)]">
              <KeyRound className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
              <span>
                {editingId
                  ? t("prov.editingTitle", { name: name || editingId })
                  : t("prov.addTitle")}
              </span>
            </div>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="flex items-center gap-1 text-[11px] text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
              >
                <X className="h-3 w-3" />
                {t("prov.cancelEdit")}
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] text-[var(--hx-text-3)]">{t("prov.presetsLabel")}</span>
            {PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                className="hx-pressable rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2.5 py-1 text-[10px] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <input
              type="text"
              aria-label="Provider display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display Name (e.g. DeepSeek)"
              className="rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 text-[var(--hx-text)]"
            />
            <ChoiceMenu
              ariaLabel="Provider kind"
              value={kind}
              options={PROVIDER_KINDS.map((k) => ({ value: k, label: k }))}
              onChange={(val) => {
                const nextKind = val as ProviderKind;
                setKind(nextKind);
                setBaseUrl((prev) => resolveDefaultBaseUrlOnKindChange(prev, nextKind));
              }}
              buttonClassName="w-full"
              menuClassName="w-56"
            />
            <input
              type="text"
              aria-label="Provider base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="Base URL"
              className="rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 font-mono text-[var(--hx-text)]"
            />
            <div className="relative flex items-center">
              <input
                type={showApiKey ? "text" : "password"}
                aria-label="Provider API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
                className="w-full rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] py-1.5 pl-3 pr-8 font-mono text-[var(--hx-text)]"
              />
              <button
                type="button"
                aria-label={showApiKey ? "Hide API key" : "Show API key"}
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2.5 text-[var(--hx-text-3)] hover:text-[var(--hx-text)]"
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              aria-label="Provider models"
              value={modelsInput}
              onChange={(e) => setModelsInput(e.target.value)}
              placeholder="gpt-4.1-mini, gpt-4.1"
              className="min-w-44 flex-1 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 font-mono text-[var(--hx-text)]"
            />
            <ChoiceMenu
              ariaLabel="Key rotation strategy"
              value={keyStrategyDraft}
              options={[
                { value: "priority_failover", label: t("prov.priorityFailover") },
                { value: "round_robin", label: t("prov.roundRobin") },
              ]}
              onChange={(val) => setKeyStrategyDraft(val as KeyRotationStrategy)}
              buttonClassName="text-[11px]"
              menuClassName="w-44"
            />
            {(kind === "openai" || kind === "openai_compatible") && (
              <ChoiceMenu
                ariaLabel={t("prov.apiProtocolLabel")}
                value={apiProtocol}
                options={[
                  { value: "auto", label: t("prov.protocolAuto") },
                  { value: "responses", label: t("prov.protocolResponses") },
                  { value: "chat_completions", label: t("prov.protocolChat") },
                ]}
                onChange={(val) => setApiProtocol(val as OpenAiApiProtocol)}
                buttonClassName="text-[11px]"
                menuClassName="w-48"
              />
            )}
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--hx-text-2)]">
              <input
                type="checkbox"
                checked={isAggregatorDraft}
                onChange={(e) => setIsAggregatorDraft(e.target.checked)}
              />
              <span>{t("prov.aggregatorToggle")}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--hx-text-2)]">
              <input
                type="checkbox"
                checked={enabledDraft}
                onChange={(e) => setEnabledDraft(e.target.checked)}
              />
              <span>{t("common.enabled")}</span>
            </label>
            <button
              type="submit"
              disabled={savingProvider || !name.trim() || !baseUrl.trim()}
              className="hx-pressable inline-flex items-center gap-1 rounded-xl bg-[var(--hx-text)] px-3.5 py-1.5 font-semibold text-[var(--hx-canvas)] disabled:opacity-40"
            >
              {savingProvider ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : editingId ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              <span>{editingId ? t("prov.updateBtn") : t("prov.saveBtn")}</span>
            </button>
          </div>
        </form>
      </section>

      {/* 3-Slot Model Binder */}
      <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-violet-500" />
            <h3 className="text-xs font-semibold text-[var(--hx-text)]">{t("prov.binderTitle")}</h3>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 font-mono text-[10px]",
                readiness.allReady
                  ? "border-emerald-500/35 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                  : "border-amber-500/35 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
              )}
            >
              {readiness.allReady
                ? t("prov.slotsAllReady")
                : t("prov.slotsPartial", { count: readiness.readyCount })}
            </span>
          </div>
          {sameModelBias && (
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/35 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle className="h-3 w-3" />
              {t("prov.biasTip")}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2">
          {slots.map((slot) => {
            const current = appConfig?.slots[slot.id];
            const encodedValue = current ? `${current.providerId}::${current.modelId}` : "";

            return (
              <div
                key={slot.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3.5 py-2.5 text-xs"
              >
                <div>
                  <div className="font-semibold text-[var(--hx-text)]">{slot.label}</div>
                  <div className="text-[11px] text-[var(--hx-text-2)]">{slot.desc}</div>
                </div>
                <ChoiceMenu
                  ariaLabel={slot.label}
                  value={encodedValue}
                  placeholder={t("prov.noModelsOption")}
                  options={availableSlotOptions.map((opt) => ({
                    value: `${opt.providerId}::${opt.modelId}`,
                    label: opt.modelId,
                    description: opt.providerName,
                  }))}
                  onChange={(val) => {
                    const [providerId, modelId] = val.split("::");
                    if (providerId && modelId) {
                      void setSlotBinding(slot.id, { providerId, modelId });
                    }
                  }}
                  side="bottom-right"
                  buttonClassName="min-w-52 font-mono"
                  menuClassName="w-72"
                />
              </div>
            );
          })}
        </div>
      </section>

      {/* RSI Mode & Daily Budget */}
      <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4 text-xs">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="h-4 w-4 text-[var(--hx-accent)]" />
              <h3 className="font-semibold text-[var(--hx-text)]">{t("prov.rsiBudgetTitle")}</h3>
              {lastPricingSync && (
                <span
                  title={lastPricingSync.updatedAt}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--hx-text-2)]"
                >
                  <span>
                    {t("prov.syncMetaPill", {
                      source: t(`prov.syncSource.${lastPricingSync.source}`),
                      count: lastPricingSync.modelCount,
                    })}
                  </span>
                  {lastPricingSync.updatedAt && (
                    <>
                      <span className="opacity-40">·</span>
                      <span>{formatRelativeTime(lastPricingSync.updatedAt, locale)}</span>
                    </>
                  )}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pricingSyncing}
                onClick={() => void syncPricingCatalog(true)}
                className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--hx-text)] hover:bg-[var(--hx-surface)] disabled:opacity-60"
              >
                <RefreshCw
                  className={cn("h-3 w-3 text-[var(--hx-accent)]", pricingSyncing && "animate-spin")}
                />
                <span>{pricingSyncing ? t("prov.syncingPricesBtn") : t("prov.syncPricesBtn")}</span>
              </button>
              <div className="inline-flex items-center gap-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-0.5">
                {(["manual", "auto"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => void setRsiMode(m)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors",
                      appConfig?.rsiMode === m
                        ? "bg-[var(--hx-surface)] text-[var(--hx-text)] shadow-xs"
                        : "text-[var(--hx-text-2)] hover:text-[var(--hx-text)]",
                    )}
                  >
                    {m === "auto" ? t("top.rsiAuto") : t("top.rsiManual")}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--hx-text-2)]">
            {t("prov.budgetMethodology")}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-[var(--hx-text-2)]">
                {t("prov.spentToday")}{" "}
                <strong className="font-mono text-[var(--hx-text)]">
                  {formatUsd(budgetStatus?.spentTodayUsd ?? 0)}
                </strong>{" "}
                / {t("prov.dailyCap")}
              </span>
              <span
                title={costMeta.tooltip}
                className={cn(
                  "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                  costMeta.toneClass,
                )}
              >
                {costMeta.label}
              </span>
            </div>
            <span className="text-[var(--hx-text-3)]">·</span>
            <span className="text-[11px] text-[var(--hx-text-2)]">
              {t("budget.tokensTodayLabel")}:{" "}
              <strong className="font-mono text-[var(--hx-text)]">
                {formatTokens(budgetStatus?.tokensToday ?? 0, locale)}
              </strong>
              {(budgetStatus?.unpricedTokensToday ?? 0) > 0 && (
                <span className="ml-1 text-amber-700 dark:text-amber-300">
                  (
                  {t("prov.unpricedSub", {
                    tokens: formatTokens(budgetStatus?.unpricedTokensToday ?? 0, locale),
                  })}
                  )
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.5"
              min="0.5"
              aria-label="Daily budget limit USD"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              className="w-24 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-2.5 py-1 font-mono text-[var(--hx-text)]"
            />
            <button
              type="button"
              onClick={() => void handleSaveBudget()}
              className="hx-pressable rounded-xl bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
            >
              {t("prov.saveCapRates")}
            </button>
            {budgetSavedFlash && (
              <span className="font-medium text-emerald-600 dark:text-emerald-300">
                ✓ {t("common.saved")}
              </span>
            )}
          </div>
        </div>

        {unpricedModels.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <span className="font-medium">{t("prov.unpricedModelsBar")}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {unpricedModels.map((modelId) => {
                const alreadyDrafted = pricingDraft.some((r) => r.modelId === modelId);
                return (
                  <div
                    key={modelId}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/25 bg-[var(--hx-surface)] px-2 py-0.5"
                  >
                    <span className="font-mono text-[11px] text-[var(--hx-text)]">{modelId}</span>
                    {alreadyDrafted ? (
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                        ✓ {t("prov.addedToTable")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setPricingDraft((prev) => appendUnpricedModelPricingRow(prev, modelId))
                        }
                        className="hx-pressable inline-flex items-center gap-0.5 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-200"
                      >
                        <Plus className="h-2.5 w-2.5" />
                        {t("prov.addPriceAction")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            aria-label="New pricing model ID"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder="deepseek-chat"
            className="min-w-36 flex-1 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 font-mono text-[11px] text-[var(--hx-text)]"
          />
          <input
            type="number"
            step="0.1"
            aria-label="New model input rate"
            value={newInRate}
            onChange={(e) => setNewInRate(e.target.value)}
            className="w-20 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--hx-text)]"
          />
          <input
            type="number"
            step="0.1"
            aria-label="New model output rate"
            value={newOutRate}
            onChange={(e) => setNewOutRate(e.target.value)}
            className="w-20 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--hx-text)]"
          />
          <button
            type="button"
            onClick={handleAddPricingRow}
            className="hx-pressable inline-flex items-center gap-1 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 text-[11px] text-[var(--hx-text)]"
          >
            <Plus className="h-3 w-3 text-[var(--hx-accent)]" />
            {t("prov.addRate")}
          </button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-[var(--hx-border)]">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="bg-[var(--hx-subtle)] text-[var(--hx-text-2)]">
              <tr>
                <th className="px-3 py-2 font-sans">{t("prov.tableModel")}</th>
                <th className="px-3 py-2 font-sans">{t("prov.tableIn")}</th>
                <th className="px-3 py-2 font-sans">{t("prov.tableOut")}</th>
                <th className="px-3 py-2 text-right font-sans">{t("prov.tableRemove")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hx-border)] bg-[var(--hx-surface)]">
              {pricingDraft.map((row, idx) => (
                <tr key={row.modelId}>
                  <td className="px-3 py-2 text-[var(--hx-text)]">{row.modelId}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.1"
                      value={row.inputPer1MUsd}
                      onChange={(e) => {
                        const val = Number(e.target.value) || 0;
                        setPricingDraft((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, inputPer1MUsd: val } : r)),
                        );
                      }}
                      className="w-20 rounded-lg border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-2 py-0.5 text-[var(--hx-text)]"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.1"
                      value={row.outputPer1MUsd}
                      onChange={(e) => {
                        const val = Number(e.target.value) || 0;
                        setPricingDraft((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, outputPer1MUsd: val } : r)),
                        );
                      }}
                      className="w-20 rounded-lg border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-2 py-0.5 text-[var(--hx-text)]"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Remove pricing for ${row.modelId}`}
                      onClick={() => setPricingDraft((prev) => prev.filter((_, i) => i !== idx))}
                      className="rounded-lg p-1 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-rose-500"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
