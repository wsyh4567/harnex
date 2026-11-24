import { useEffect, useState } from "react";
import {
  Archive,
  ArrowRight,
  BookOpen,
  Check,
  FileCode2,
  FlaskConical,
  Globe,
  Scale,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import {
  localizeDomainLabel,
  localizeProposal,
  localizeSourceTags,
} from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, formatDeltaPct, formatDurationMs, formatUsd } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { DiffReviewPanel } from "./DiffReviewPanel.tsx";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function ProposalsView() {
  const {
    proposals,
    selectedProposalId,
    selectProposal,
    silentArchiveCount,
    adoptProposal,
    rejectProposal,
    setActivePage,
    setRightTab,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();
  const isZh = locale.startsWith("zh");

  const [detailTab, setDetailTab] = useState<"overview" | "diff">("overview");
  const [trustConfirmed, setTrustConfirmed] = useState<Record<string, boolean>>({});

  const visibleProposals = proposals.filter(
    (p) => p.status !== "archived_no_entry" && p.status !== "rejected",
  );
  const selected =
    visibleProposals.find((p) => p.id === selectedProposalId) ??
    visibleProposals[0] ??
    null;
  const readyCount = visibleProposals.filter(
    (p) => p.status === "ready" || p.status === "needs_reprobe",
  ).length;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;

      const lower = e.key.toLowerCase();
      if (lower === "d") {
        if (!selected) return;
        e.preventDefault();
        setDetailTab((prev) => (prev === "overview" ? "diff" : "overview"));
        return;
      }

      if (visibleProposals.length === 0) return;
      const currentIdx = selected
        ? visibleProposals.findIndex((p) => p.id === selected.id)
        : -1;

      if (e.key === "ArrowDown" || lower === "j") {
        e.preventDefault();
        const nextIdx =
          currentIdx < 0 ? 0 : Math.min(visibleProposals.length - 1, currentIdx + 1);
        const next = visibleProposals[nextIdx];
        if (next) selectProposal(next.id);
      } else if (e.key === "ArrowUp" || lower === "k") {
        e.preventDefault();
        const prevIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
        const prev = visibleProposals[prevIdx];
        if (prev) selectProposal(prev.id);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, visibleProposals, selectProposal]);

  const selectedLoc = selected ? localizeProposal(selected, locale) : null;
  const trustChecked = selected ? (trustConfirmed[selected.id] ?? true) : true;

  return (
    <div className="flex flex-1 overflow-hidden bg-[var(--hx-canvas)]">
      {/* Left Master List */}
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-[var(--hx-border)] bg-[var(--hx-sidebar)]/40">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--hx-border)] px-4 py-3 text-xs">
          <span className="font-semibold text-[var(--hx-text)]">
            {t("proposals.pendingCount", { count: readyCount })}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--hx-subtle)] px-2 py-0.5 text-[10px] text-[var(--hx-text-3)]">
            <Archive className="h-3 w-3" />
            <span>{t("proposals.filteredPill", { count: silentArchiveCount })}</span>
          </span>
        </div>

        <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
          {visibleProposals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--hx-border)] p-6 text-center text-xs text-[var(--hx-text-3)]">
              {t("evo.noProposals")}
            </div>
          ) : (
            visibleProposals.map((p) => {
              const isSelected = p.id === selected?.id;
              const loc = localizeProposal(p, locale);
              const durationDelta = formatDeltaPct(
                p.metricsBefore.durationMs,
                p.metricsAfter.durationMs,
              );
              const hasExternal = p.sourceTags.some((tag) => tag !== "local");

              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`triage-proposal-${p.id}`}
                  onClick={() => selectProposal(p.id)}
                  className={cn(
                    "hx-pressable w-full rounded-xl border p-3 text-left transition-colors",
                    isSelected
                      ? "border-[var(--hx-accent-border)] bg-[var(--hx-surface)] shadow-xs"
                      : "border-transparent bg-transparent hover:bg-[var(--hx-surface)]/75",
                  )}
                >
                  <div className="line-clamp-2 text-xs font-semibold leading-snug text-[var(--hx-text)]">
                    {loc.title}
                  </div>

                  <div className="mt-1.5 font-mono text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    {isZh
                      ? `步数 ${p.metricsBefore.steps}→${p.metricsAfter.steps} · 报错 ${p.metricsBefore.errors}→${p.metricsAfter.errors} · 耗时 ${durationDelta}`
                      : `Steps ${p.metricsBefore.steps}→${p.metricsAfter.steps} · Errors ${p.metricsBefore.errors}→${p.metricsAfter.errors} · ${durationDelta}`}
                  </div>

                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-[var(--hx-text-3)]">
                    <span className="truncate">
                      {localizeDomainLabel(p.domain, locale)} · {loc.triggerLabel}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {hasExternal && <Globe className="h-3 w-3 text-amber-500" />}
                      {p.requiresHumanTrust && <ShieldAlert className="h-3 w-3 text-rose-500" />}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="border-t border-[var(--hx-border)] px-3.5 py-2 text-[10px] font-mono text-[var(--hx-text-3)]">
          {t("proposals.kbdHint")}
        </div>
      </aside>

      {/* Right Focused Review Pane */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selected || !selectedLoc ? (
          <div className="flex flex-1 items-center justify-center p-8 text-xs text-[var(--hx-text-3)]">
            {t("evo.noProposals")}
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Decision Header */}
            <div className="border-b border-[var(--hx-border)] bg-[var(--hx-surface)] px-6 py-4">
              <div className="mx-auto flex max-w-4xl flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <h2 className="text-[15px] font-semibold tracking-tight text-[var(--hx-text)]">
                    {selectedLoc.title}
                  </h2>
                  <p className="text-xs leading-relaxed text-[var(--hx-text-2)]">
                    {selectedLoc.whatChangedSummary}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px]">
                    {selected.sourceTags.some((tag) => tag !== "local") ? (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                        <Globe className="h-3 w-3" />
                        {t("evo.externalSource", {
                          tags: localizeSourceTags(selected.sourceTags, locale),
                        })}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                        <ShieldCheck className="h-3 w-3" />
                        {t("evo.localSource")}
                      </span>
                    )}

                    {selected.requiresHumanTrust && (
                      <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300">
                        <ShieldAlert className="h-3 w-3" />
                        {t("evo.highPriv")}
                      </span>
                    )}
                  </div>
                </div>

                {selected.status === "ready" && (
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void rejectProposal(selected.id)}
                        className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-3 py-1.5 text-xs font-medium text-[var(--hx-text-2)] hover:text-rose-600"
                      >
                        <X className="h-3.5 w-3.5" />
                        <span>{t("evo.reject")}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void adoptProposal(selected.id, trustChecked)}
                        className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>{t("evo.adoptTrust")}</span>
                      </button>
                    </div>

                    {selected.requiresHumanTrust && (
                      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--hx-text-2)]">
                        <input
                          type="checkbox"
                          checked={trustChecked}
                          onChange={(e) =>
                            setTrustConfirmed((prev) => ({
                              ...prev,
                              [selected.id]: e.target.checked,
                            }))
                          }
                        />
                        <span>{t("proposals.trustShort")}</span>
                      </label>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Integrated 2-Tab Bar */}
            <div className="border-b border-[var(--hx-border)] px-6 py-2.5">
              <div className="mx-auto max-w-4xl">
                <SegmentedTabs
                  value={detailTab}
                  onChange={setDetailTab}
                  items={[
                    { id: "overview", label: t("proposals.tabOverview") },
                    {
                      id: "diff",
                      label: t("proposals.tabDiff", { count: selected.diffs.length }),
                    },
                  ]}
                />
              </div>
            </div>

            {/* Body */}
            {detailTab === "diff" ? (
              <div className="flex-1 min-h-0 overflow-hidden">
                <DiffReviewPanel embedded />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-6 py-5">
                <div className="mx-auto max-w-4xl space-y-5">
                  {/* 4 Visual KPI Impact Cards */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {[
                      {
                        label: t("evo.steps"),
                        value: `${selected.metricsBefore.steps} → ${selected.metricsAfter.steps}`,
                        delta: formatDeltaPct(
                          selected.metricsBefore.steps,
                          selected.metricsAfter.steps,
                        ),
                        pct: Math.max(
                          8,
                          Math.round(
                            (selected.metricsAfter.steps /
                              Math.max(1, selected.metricsBefore.steps)) *
                              100,
                          ),
                        ),
                      },
                      {
                        label: t("evo.errors"),
                        value: `${selected.metricsBefore.errors} → ${selected.metricsAfter.errors}`,
                        delta:
                          selected.metricsAfter.errors === 0
                            ? t("proposals.zeroOut")
                            : formatDeltaPct(
                                selected.metricsBefore.errors,
                                selected.metricsAfter.errors,
                              ),
                        pct:
                          selected.metricsAfter.errors === 0
                            ? 0
                            : Math.round(
                                (selected.metricsAfter.errors /
                                  Math.max(1, selected.metricsBefore.errors)) *
                                  100,
                              ),
                      },
                      {
                        label: t("evo.duration"),
                        value: formatDurationMs(selected.metricsAfter.durationMs, locale),
                        delta: formatDeltaPct(
                          selected.metricsBefore.durationMs,
                          selected.metricsAfter.durationMs,
                        ),
                        pct: Math.max(
                          8,
                          Math.round(
                            (selected.metricsAfter.durationMs /
                              Math.max(1, selected.metricsBefore.durationMs)) *
                              100,
                          ),
                        ),
                      },
                      {
                        label: t("evo.cost"),
                        value: formatUsd(selected.metricsAfter.costUsd),
                        delta: formatDeltaPct(
                          selected.metricsBefore.costUsd,
                          selected.metricsAfter.costUsd,
                        ),
                        pct: Math.max(
                          8,
                          Math.round(
                            (selected.metricsAfter.costUsd /
                              Math.max(0.0001, selected.metricsBefore.costUsd)) *
                              100,
                          ),
                        ),
                      },
                    ].map((kpi) => (
                      <div
                        key={kpi.label}
                        className="space-y-2 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3.5"
                      >
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="text-[var(--hx-text-3)]">{kpi.label}</span>
                          <span className="hx-num rounded-md bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                            {kpi.delta}
                          </span>
                        </div>
                        <div className="hx-num font-mono text-sm font-semibold text-[var(--hx-text)]">
                          {kpi.value}
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--hx-muted)]">
                          <div
                            className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                            style={{ width: `${kpi.pct}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Changed Files List */}
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold text-[var(--hx-text-2)]">
                      {t("proposals.changedFilesTitle")} ({selected.diffs.length})
                    </h3>
                    <div className="divide-y divide-[var(--hx-border)] rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]">
                      {selected.diffs.map((d) => (
                        <div
                          key={d.path}
                          className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className={cn(
                                "inline-flex h-5 w-5 items-center justify-center rounded-md font-mono text-[11px] font-semibold",
                                d.changeType === "added"
                                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                                  : d.changeType === "deleted"
                                    ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                                    : "bg-cyan-50 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
                              )}
                            >
                              {d.changeType === "added"
                                ? "+"
                                : d.changeType === "deleted"
                                  ? "-"
                                  : "~"}
                            </span>
                            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]" />
                            <code className="truncate font-mono text-[11px] text-[var(--hx-text)]">
                              {d.path}
                            </code>
                            {d.isHighPrivilege && (
                              <span className="rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                                {t("diff.highPriv")}
                              </span>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => setDetailTab("diff")}
                            className="hx-pressable inline-flex items-center gap-1 text-[11px] font-medium text-[var(--hx-accent)] hover:underline"
                          >
                            <span>{t("proposals.viewDiffBtn")}</span>
                            <ArrowRight className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* Verification Verdict Card */}
                  <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-semibold text-[var(--hx-text)]">
                        <Scale className="h-4 w-4 text-violet-500" />
                        <span>{t("proposals.verdictTitle")}</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        {selected.blindJudge?.orderConsistent && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                            <ShieldCheck className="h-3 w-3" />
                            {t("theater.orderConsistent")}
                          </span>
                        )}
                        {selected.regressionCheck && (
                          <span className="font-mono text-emerald-700 dark:text-emerald-300">
                            {t("evo.regressionSummary", {
                              passed: selected.regressionCheck.passed,
                              total: selected.regressionCheck.total,
                            })}
                          </span>
                        )}
                      </div>
                    </div>

                    {selectedLoc.judgeReasoning && (
                      <p className="leading-relaxed text-[var(--hx-text-2)]">
                        {selectedLoc.judgeReasoning}
                      </p>
                    )}

                    {selected.experienceEntry && (
                      <div className="space-y-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
                        <div className="flex items-center gap-1.5 font-semibold text-[var(--hx-accent)]">
                          <BookOpen className="h-3.5 w-3.5" />
                          <span>{t("theater.expTitle")}</span>
                        </div>
                        <p className="text-[var(--hx-text)]">{selectedLoc.lesson}</p>
                        <p className="text-[11px] text-[var(--hx-text-3)]">
                          {selectedLoc.evidence}
                        </p>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hx-border)] pt-2.5 text-[11px] text-[var(--hx-text-3)]">
                      <div>
                        <span className="font-medium text-[var(--hx-text-2)]">
                          {t("proposals.adoptImpactTitle")}:{" "}
                        </span>
                        {selected.requiresHumanTrust
                          ? t("evo.adoptImpactPriv")
                          : t("evo.adoptImpactSafe")}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          selectProposal(selected.id);
                          setRightTab("theater");
                          setActivePage("lab");
                        }}
                        className="hx-pressable inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--hx-accent)] hover:border-[var(--hx-accent-border)]"
                      >
                        <FlaskConical className="h-3 w-3" />
                        <span>{t("proposals.openTheater")}</span>
                      </button>
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
