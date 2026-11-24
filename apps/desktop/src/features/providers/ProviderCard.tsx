import { useState } from "react";
import type { KeyRotationStrategy, ProviderConfig } from "@harnex/protocol";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Zap,
} from "lucide-react";
import { useI18n } from "../../i18n/index.ts";
import type { PingProviderResult } from "../../ipc/index.ts";
import { cn } from "../../lib/utils.ts";
import { countActiveProviderKeys, isProviderAggregator } from "./modelCatalog.ts";
import { getLatencyTone } from "./providerPresets.ts";

interface ProviderCardProps {
  provider: ProviderConfig;
  isEditing: boolean;
  pinging: boolean;
  fetching: boolean;
  pingResult?: PingProviderResult;
  fetchResult?: { count: number; error?: string };
  onEdit: (provider: ProviderConfig) => void;
  onDelete: (providerId: string) => void;
  onToggleEnabled: (provider: ProviderConfig) => void;
  onPing: (providerId: string) => void;
  onFetchModels: (providerId: string) => void;
  onTogglePinModel: (providerId: string, modelId: string) => void;
  onChangeStrategy: (provider: ProviderConfig, strategy: KeyRotationStrategy) => void;
  onToggleKeyEnabled: (provider: ProviderConfig, keyId: string) => void;
  onDeleteKey: (provider: ProviderConfig, keyId: string) => void;
  onAddKey: (provider: ProviderConfig, label: string, apiKey: string) => Promise<void>;
}

export function ProviderCard({
  provider,
  isEditing,
  pinging,
  fetching,
  pingResult,
  fetchResult,
  onEdit,
  onDelete,
  onToggleEnabled,
  onPing,
  onFetchModels,
  onTogglePinModel,
  onChangeStrategy,
  onToggleKeyEnabled,
  onDeleteKey,
  onAddKey,
}: ProviderCardProps) {
  const { locale, t } = useI18n();
  const isZh = locale.startsWith("zh");
  const isAggregator = isProviderAggregator(provider);

  const kindLabel = (() => {
    if (!isZh) return provider.kind;
    if (provider.kind === "openai_compatible") return "OpenAI 兼容";
    if (provider.kind === "openai") return "OpenAI";
    if (provider.kind === "anthropic") return "Anthropic";
    if (provider.kind === "gemini") return "Gemini";
    if (provider.kind === "ollama") return "Ollama";
    return provider.kind;
  })();

  const sourceLabel = (() => {
    if (!isZh) return provider.source;
    if (provider.source === "manual") return "手动配置";
    if (provider.source === "cc-switch") return "CC Switch 导入";
    if (provider.source === "magpie") return "Magpie 网关";
    return provider.source;
  })();

  const localizeKeyLabel = (label: string) => {
    if (!isZh) return label;
    if (label === "Primary Key") return "主密钥";
    if (label === "Backup Key #2") return "备用密钥 #2";
    if (label === "Main Anthropic Key") return "Anthropic 主密钥";
    return label;
  };

  const localizeKeyError = (err: string) => {
    if (!isZh) return err;
    if (err === "429 rate limit recovered") return "429 限流已自动恢复";
    return err;
  };

  const resolvePingDiagnostic = (err: string) => {
    if (/\b(401|403)\b|unauthorized|invalid.*key|auth/i.test(err)) {
      return t("prov.diagAuth");
    }
    if (/\b404\b|not found/i.test(err)) {
      return t("prov.diagNotFound");
    }
    if (/\b429\b|rate.?limit|quota/i.test(err)) {
      return t("prov.diagRateLimit");
    }
    if (/\b(502|503|504)\b|bad gateway|unavailable/i.test(err)) {
      return t("prov.diagGateway");
    }
    return t("prov.diagNetwork");
  };
  const pinnedSet = new Set(provider.pinnedModels ?? []);
  const activeKeys = countActiveProviderKeys(provider);
  const keys = provider.keys ?? [];
  const strategy = provider.keyStrategy ?? "priority_failover";

  const [keyPoolOpen, setKeyPoolOpen] = useState(keys.length > 1);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeySecret, setNewKeySecret] = useState("");
  const [showNewSecret, setShowNewSecret] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [modelFilter, setModelFilter] = useState("");

  const latencyTone = pingResult
    ? getLatencyTone(pingResult.ok, pingResult.latencyMs)
    : provider.lastPingMs !== undefined
      ? getLatencyTone(true, provider.lastPingMs)
      : null;

  const filteredModels = modelFilter.trim()
    ? provider.models.filter((m) => m.toLowerCase().includes(modelFilter.trim().toLowerCase()))
    : provider.models;

  const handleAddKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeySecret.trim() || addingKey) return;
    setAddingKey(true);
    try {
      await onAddKey(
        provider,
        newKeyLabel.trim() || `Key #${keys.length + 1}`,
        newKeySecret.trim(),
      );
      setNewKeyLabel("");
      setNewKeySecret("");
    } finally {
      setAddingKey(false);
    }
  };

  const renderModelChip = (modelId: string) => {
    const pinned = pinnedSet.has(modelId);
    return (
      <span
        key={modelId}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px]",
          pinned
            ? "border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100"
            : "border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text)]",
        )}
      >
        <span>{modelId}</span>
        <button
          type="button"
          aria-label={pinned ? `Unpin ${modelId}` : `Pin ${modelId}`}
          onClick={() => onTogglePinModel(provider.id, modelId)}
          className="text-[var(--hx-text-3)] hover:text-amber-500"
        >
          <Star className={cn("h-2.5 w-2.5", pinned && "fill-amber-400 text-amber-500")} />
        </button>
      </span>
    );
  };

  return (
    <div
      data-testid={`provider-card-${provider.id}`}
      className={cn(
        "space-y-3 rounded-2xl border bg-[var(--hx-surface)] p-4 text-xs transition-colors",
        isEditing
          ? "border-[var(--hx-accent-border)]"
          : provider.enabled
            ? "border-[var(--hx-border)]"
            : "border-[var(--hx-border)] opacity-65",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-[var(--hx-text)]">{provider.name}</span>
            <span className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--hx-text-2)]">
              {kindLabel}
            </span>
            <span className="rounded-md bg-[var(--hx-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--hx-accent)]">
              {sourceLabel}
            </span>
            {isAggregator ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/30 bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-800 dark:bg-violet-500/10 dark:text-violet-200">
                <Zap className="h-2.5 w-2.5" />
                {t("prov.aggregatorBadge")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--hx-text-2)]">
                <KeyRound className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" />
                {t("prov.activeKeys", { count: activeKeys })}
              </span>
            )}
            {!provider.enabled && (
              <span className="rounded-md bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--hx-text-3)]">
                {t("common.disabled")}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--hx-text-3)]">
            {provider.baseUrl}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {latencyTone && (
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 font-mono text-[10px]",
                latencyTone === "emerald"
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : latencyTone === "amber"
                    ? "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                    : "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
              )}
            >
              {pingResult && !pingResult.ok ? "ERR" : `${pingResult?.latencyMs ?? provider.lastPingMs}ms`}
            </span>
          )}
          <button
            type="button"
            disabled={pinging}
            onClick={() => onPing(provider.id)}
            className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-1 text-[11px] text-[var(--hx-text)] hover:border-[var(--hx-border-strong)] disabled:opacity-50"
          >
            {pinging ? (
              <Loader2 className="h-3 w-3 animate-spin text-[var(--hx-accent)]" />
            ) : (
              <Activity className="h-3 w-3 text-[var(--hx-accent)]" />
            )}
            {t("prov.ping")}
          </button>
          <button
            type="button"
            disabled={fetching}
            onClick={() => onFetchModels(provider.id)}
            className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-1 text-[11px] text-[var(--hx-text)] hover:border-[var(--hx-border-strong)] disabled:opacity-50"
          >
            <RefreshCw
              className={cn("h-3 w-3 text-emerald-600 dark:text-emerald-400", fetching && "animate-spin")}
            />
            {t("prov.models")}
          </button>
          <button
            type="button"
            aria-label={`Edit provider ${provider.name}`}
            onClick={() => onEdit(provider)}
            className="hx-pressable rounded-lg p-1 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]"
          >
            <Edit3 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Toggle ${provider.name}`}
            onClick={() => onToggleEnabled(provider)}
            className={cn(
              "hx-pressable rounded-lg p-1 hover:bg-[var(--hx-subtle)]",
              provider.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--hx-text-3)]",
            )}
          >
            <Power className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Delete provider ${provider.name}`}
            onClick={() => onDelete(provider.id)}
            className="hx-pressable rounded-lg p-1 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-rose-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {pingResult && !pingResult.ok && pingResult.error && (
        <div
          data-testid={`provider-ping-error-${provider.id}`}
          className="flex flex-wrap items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-50/85 px-2.5 py-1.5 text-[11px] text-rose-800 dark:bg-rose-950/35 dark:text-rose-200"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />
          <span className="font-semibold">{resolvePingDiagnostic(pingResult.error)}:</span>
          <span className="break-all font-mono text-[10px] opacity-90">{pingResult.error}</span>
        </div>
      )}
      {fetchResult && (
        <div
          className={cn(
            "text-[11px]",
            fetchResult.error
              ? "text-rose-700 dark:text-rose-300"
              : "text-emerald-700 dark:text-emerald-300",
          )}
        >
          {fetchResult.error
            ? t("prov.fetchFailed", { error: fetchResult.error })
            : t("prov.fetchSuccess", { count: fetchResult.count })}
        </div>
      )}

      {isAggregator ? (
        <div className="space-y-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)]/60 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">
              {t("prov.modelsCount", { count: provider.models.length })}
            </span>
            {provider.models.length > 3 && (
              <div className="flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2 py-0.5">
                <Search className="h-3 w-3 text-[var(--hx-text-3)]" />
                <input
                  type="text"
                  aria-label={`Filter models for ${provider.name}`}
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder={t("prov.filterModels")}
                  className="w-28 bg-transparent text-[10px] text-[var(--hx-text)]"
                />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1">{filteredModels.map((m) => renderModelChip(m))}</div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">{provider.models.map((m) => renderModelChip(m))}</div>
      )}

      {!isAggregator && (
        <div className="space-y-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)]/60 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setKeyPoolOpen((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--hx-text)] hover:opacity-80"
            >
              {keyPoolOpen ? (
                <ChevronDown className="h-3 w-3 text-[var(--hx-text-3)]" />
              ) : (
                <ChevronRight className="h-3 w-3 text-[var(--hx-text-3)]" />
              )}
              <span>
                {t("prov.keyPool", {
                  count: keys.length > 0 ? keys.length : provider.hasApiKey ? 1 : 0,
                })}
              </span>
            </button>

            <div className="flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] p-0.5 text-[10px]">
              {(
                [
                  { id: "priority_failover", label: t("prov.priorityFailover") },
                  { id: "round_robin", label: t("prov.roundRobin") },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onChangeStrategy(provider, opt.id)}
                  className={cn(
                    "rounded-md px-2 py-0.5 transition-colors",
                    strategy === opt.id
                      ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                      : "text-[var(--hx-text-3)] hover:text-[var(--hx-text)]",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {keyPoolOpen && (
            <div className="space-y-1.5 pt-1">
              {keys.length === 0 ? (
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--hx-text-3)]">
                  {provider.hasApiKey ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                      <span>{t("prov.singleKeyHint", { ref: provider.keyringRef })}</span>
                    </>
                  ) : (
                    <span>{t("prov.noKeyHint")}</span>
                  )}
                </div>
              ) : (
                keys.map((k, idx) => (
                  <div
                    key={k.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-[11px]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-[10px] text-[var(--hx-text-3)]">
                        #{idx + 1}
                      </span>
                      <span className="truncate font-medium text-[var(--hx-text)]">
                        {localizeKeyLabel(k.label)}
                      </span>
                      {k.maskedHint && (
                        <code className="font-mono text-[10px] text-[var(--hx-text-2)]">
                          {k.maskedHint}
                        </code>
                      )}
                      {k.lastError && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                          <AlertCircle className="h-2.5 w-2.5" />
                          {localizeKeyError(k.lastError)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Toggle key ${k.label}`}
                        onClick={() => onToggleKeyEnabled(provider, k.id)}
                        className={cn(
                          "rounded p-0.5 hover:bg-[var(--hx-subtle)]",
                          k.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--hx-text-3)]",
                        )}
                      >
                        <Power className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete key ${k.label}`}
                        onClick={() => onDeleteKey(provider, k.id)}
                        className="rounded p-0.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-rose-500"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))
              )}

              <form
                onSubmit={(e) => void handleAddKeySubmit(e)}
                className="flex flex-wrap gap-1.5 pt-0.5"
              >
                <input
                  type="text"
                  aria-label={`New key label for ${provider.name}`}
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  placeholder={isZh ? "备用密钥 #2" : "Backup #2"}
                  className="w-28 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-2.5 py-1 text-[11px] text-[var(--hx-text)]"
                />
                <div className="relative flex min-w-32 flex-1 items-center">
                  <input
                    type={showNewSecret ? "text" : "password"}
                    aria-label={`New key secret for ${provider.name}`}
                    value={newKeySecret}
                    onChange={(e) => setNewKeySecret(e.target.value)}
                    placeholder="sk-…"
                    className="w-full rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] py-1 pl-2.5 pr-7 font-mono text-[11px] text-[var(--hx-text)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewSecret((v) => !v)}
                    className="absolute right-2 text-[var(--hx-text-3)] hover:text-[var(--hx-text)]"
                  >
                    {showNewSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={!newKeySecret.trim() || addingKey}
                  className="hx-pressable inline-flex items-center gap-1 rounded-xl border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--hx-accent)] disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" />
                  {t("prov.addKeyBtn")}
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
