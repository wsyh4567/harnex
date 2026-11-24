import { useState } from "react";
import {
  Archive,
  Check,
  FileDiff,
  Globe,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  localizeDomainLabel,
  localizeProposal,
  localizeSourceTags,
} from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, formatDeltaPct, formatDurationMs, formatUsd } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";

interface TriagePanelProps {
  onInspectDiff?: () => void;
}

export function TriagePanel({ onInspectDiff }: TriagePanelProps) {
  const {
    proposals,
    selectedProposalId,
    selectProposal,
    silentArchiveCount,
    setRightTab,
    adoptProposal,
    rejectProposal,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const [trustConfirmed, setTrustConfirmed] = useState<Record<string, boolean>>({});
  const visibleProposals = proposals.filter(
    (p) => p.status !== "archived_no_entry" && p.status !== "rejected",
  );

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium text-[var(--hx-text-2)]">
            {t("proposals.pendingCount", {
              count: visibleProposals.filter((p) => p.status === "ready").length,
            })}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--hx-subtle)] px-2.5 py-0.5 text-[11px] text-[var(--hx-text-3)]">
            <Archive className="h-3 w-3" />
            <span>{t("proposals.filteredPill", { count: silentArchiveCount })}</span>
          </span>
        </div>

        {visibleProposals.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--hx-border-strong)] bg-[var(--hx-surface)] p-8 text-center text-xs text-[var(--hx-text-3)]">
            {t("evo.noProposals")}
          </div>
        ) : (
          <div className="space-y-3.5">
            {visibleProposals.map((p) => {
              const selected = p.id === selectedProposalId;
              const trustChecked = trustConfirmed[p.id] ?? true;
              const loc = localizeProposal(p, locale);
              const hasExternal = p.sourceTags.some((tag) => tag !== "local");

              return (
                <article
                  key={p.id}
                  data-testid={`triage-proposal-${p.id}`}
                  onClick={() => selectProposal(p.id)}
                  className={cn(
                    "cursor-pointer space-y-3.5 rounded-2xl border bg-[var(--hx-surface)] p-4 transition-colors",
                    selected
                      ? "border-[var(--hx-accent-border)]"
                      : "border-[var(--hx-border)] hover:border-[var(--hx-border-strong)]",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 text-[11px] text-[var(--hx-text-3)]">
                        <span>{localizeDomainLabel(p.domain, locale)}</span>
                        <span>·</span>
                        <span>{loc.triggerLabel}</span>
                      </div>
                      <h3 className="text-[13px] font-semibold text-[var(--hx-text)]">
                        {loc.title}
                      </h3>
                      <p className="text-xs text-[var(--hx-text-2)]">{loc.whatChangedSummary}</p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px]">
                      {hasExternal ? (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                          <Globe className="h-3 w-3" />
                          {t("evo.externalSource", {
                            tags: localizeSourceTags(p.sourceTags, locale),
                          })}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                          <ShieldCheck className="h-3 w-3" />
                          {t("evo.localSource")}
                        </span>
                      )}

                      {p.requiresHumanTrust && (
                        <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300">
                          <ShieldAlert className="h-3 w-3" />
                          {t("evo.highPriv")}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 4 KPI Impact Tiles */}
                  <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                    {[
                      {
                        label: t("evo.steps"),
                        value: `${p.metricsBefore.steps} → ${p.metricsAfter.steps}`,
                        delta: formatDeltaPct(p.metricsBefore.steps, p.metricsAfter.steps),
                        pct: Math.max(
                          8,
                          Math.round(
                            (p.metricsAfter.steps / Math.max(1, p.metricsBefore.steps)) * 100,
                          ),
                        ),
                      },
                      {
                        label: t("evo.errors"),
                        value: `${p.metricsBefore.errors} → ${p.metricsAfter.errors}`,
                        delta:
                          p.metricsAfter.errors === 0
                            ? t("proposals.zeroOut")
                            : formatDeltaPct(p.metricsBefore.errors, p.metricsAfter.errors),
                        pct:
                          p.metricsAfter.errors === 0
                            ? 0
                            : Math.round(
                                (p.metricsAfter.errors / Math.max(1, p.metricsBefore.errors)) * 100,
                              ),
                      },
                      {
                        label: t("evo.duration"),
                        value: formatDurationMs(p.metricsAfter.durationMs, locale),
                        delta: formatDeltaPct(p.metricsBefore.durationMs, p.metricsAfter.durationMs),
                        pct: Math.max(
                          8,
                          Math.round(
                            (p.metricsAfter.durationMs / Math.max(1, p.metricsBefore.durationMs)) *
                              100,
                          ),
                        ),
                      },
                      {
                        label: t("evo.cost"),
                        value: formatUsd(p.metricsAfter.costUsd),
                        delta: formatDeltaPct(p.metricsBefore.costUsd, p.metricsAfter.costUsd),
                        pct: Math.max(
                          8,
                          Math.round(
                            (p.metricsAfter.costUsd / Math.max(0.0001, p.metricsBefore.costUsd)) *
                              100,
                          ),
                        ),
                      },
                    ].map((kpi) => (
                      <div
                        key={kpi.label}
                        className="space-y-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)]/70 p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-[var(--hx-text-3)]">{kpi.label}</span>
                          <span className="hx-num font-mono font-semibold text-emerald-700 dark:text-emerald-300">
                            {kpi.delta}
                          </span>
                        </div>
                        <div className="hx-num font-mono text-xs font-semibold text-[var(--hx-text)]">
                          {kpi.value}
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--hx-muted)]">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${kpi.pct}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--hx-text-2)]">
                    {p.blindJudge && (
                      <span className="inline-flex items-center gap-1.5 text-[var(--hx-accent)]">
                        <Sparkles className="h-3.5 w-3.5" />
                        {t("evo.blindJudgeSummary", {
                          winner: loc.winnerLabel,
                          confidence: loc.confidenceLabel,
                          consistent: p.blindJudge.orderConsistent
                            ? t("evo.orderConsistentSuffix")
                            : "",
                        })}
                      </span>
                    )}
                    {p.regressionCheck && (
                      <span className="font-mono text-emerald-700 dark:text-emerald-300">
                        {t("evo.regressionSummary", {
                          passed: p.regressionCheck.passed,
                          total: p.regressionCheck.total,
                        })}
                      </span>
                    )}
                  </div>

                  {p.status === "ready" && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hx-border)] pt-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void adoptProposal(p.id, trustChecked)}
                          className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>{t("evo.adoptTrust")}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            selectProposal(p.id);
                            setRightTab("diff");
                            onInspectDiff?.();
                          }}
                          className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-3 py-1.5 text-xs font-medium text-[var(--hx-text)] hover:bg-[var(--hx-subtle)]"
                        >
                          <FileDiff className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
                          <span>{t("evo.inspectDiff")}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void rejectProposal(p.id)}
                          className="hx-pressable inline-flex items-center gap-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3 py-1.5 text-xs text-[var(--hx-text-2)] hover:text-rose-600"
                        >
                          <X className="h-3.5 w-3.5" />
                          <span>{t("evo.reject")}</span>
                        </button>
                      </div>

                      {p.requiresHumanTrust && (
                        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--hx-text-2)]">
                          <input
                            type="checkbox"
                            checked={trustChecked}
                            onChange={(e) =>
                              setTrustConfirmed((prev) => ({ ...prev, [p.id]: e.target.checked }))
                            }
                          />
                          <span>{t("proposals.trustShort")}</span>
                        </label>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
