import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Flame,
  GitBranch,
  Leaf,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Webhook,
  Wrench,
} from "lucide-react";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import { localizeThreadStatus, localizeThreadTitle } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, shortSha } from "../../lib/utils.ts";
import { useCommandDeckStore, type RightWorkbenchTab } from "../../stores/useCommandDeckStore.ts";
import { extractMcpServersFromGenome } from "../chat/promptCompletions.ts";
import { DiffReviewPanel } from "../evolution/DiffReviewPanel.tsx";
import { EvolutionTheaterPanel } from "../evolution/EvolutionTheaterPanel.tsx";
import { TriagePanel } from "../evolution/TriagePanel.tsx";
import { ProvidersPanel } from "../providers/ProvidersPanel.tsx";
import { SecurityCenterPanel } from "../security/SecurityCenterPanel.tsx";
import { CommandDeckCharts } from "./CommandDeckCharts.tsx";
import { GenomeDeckPanel } from "./GenomeDeckPanel.tsx";

export function CommandDeckView() {
  const {
    rightTab,
    setRightTab,
    proposals,
    pendingApprovals,
    commits,
    genomeFiles,
    trustRecords,
    openOnboarding,
    threads,
    activeThreadId,
    setActiveThread,
    theaterLogs,
    gardenerReport,
    gardenerLoading,
    refreshGardenerReport,
    launchPruningEvolution,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();
  const [chartsOpen, setChartsOpen] = useState(true);
  const [gardenerOpen, setGardenerOpen] = useState(false);

  const triageCount = proposals.filter(
    (p) => p.status === "ready" || p.status === "needs_reprobe",
  ).length;
  const headCommit = commits[0];
  const passPct = headCommit?.passRate !== undefined ? Math.round(headCommit.passRate * 100) : 94;
  const activeThread = threads.find((th) => th.id === activeThreadId) ?? threads[0] ?? null;

  const skillCount = genomeFiles.filter(
    (f) => f.component === "skills" || f.path.startsWith("skills/"),
  ).length;
  const hookCount = genomeFiles.filter(
    (f) => f.component === "hooks" || f.path.startsWith("hooks/"),
  ).length;
  const memoryCount = genomeFiles.filter(
    (f) => f.component === "memory" || f.path.startsWith("memory/"),
  ).length;
  const mcpCount = extractMcpServersFromGenome(genomeFiles).length;

  const tabs: Array<{ id: RightWorkbenchTab; label: string; badge?: number }> = [
    { id: "triage", label: t("tabs.triage"), badge: triageCount },
    { id: "theater", label: t("tabs.theater") },
    { id: "diff", label: t("tabs.diff") },
    { id: "genome", label: t("tabs.genome") },
    { id: "security", label: t("tabs.security"), badge: pendingApprovals.length },
    { id: "providers", label: t("tabs.providers") },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--hx-canvas)]">
      {/* Living Genome Pulse Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hx-border)] bg-[var(--hx-sidebar)]/50 px-5 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5">
            <GitBranch className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
            <span className="hx-num font-mono font-semibold text-[var(--hx-text)]">
              {headCommit?.versionTag ?? "v7"} · {shortSha(headCommit?.sha ?? "a7f3c91")}
            </span>
            <span className="hx-num text-emerald-600 dark:text-emerald-400">
              · {t("genome.passRateBadge", { pct: passPct })}
            </span>
          </div>

          {/* Active Organ Counts */}
          <div className="hidden md:inline-flex items-center gap-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 text-[11px] text-[var(--hx-text-2)]">
            <span className="hx-num inline-flex items-center gap-1">
              <Wrench className="h-3 w-3 text-cyan-600 dark:text-cyan-400" />
              {t("deck.organSkills", { count: skillCount })}
            </span>
            <span className="opacity-30">·</span>
            <span className="hx-num inline-flex items-center gap-1">
              <Webhook className="h-3 w-3 text-violet-600 dark:text-violet-400" />
              {t("deck.organHooks", { count: hookCount })}
            </span>
            <span className="opacity-30">·</span>
            <span className="hx-num inline-flex items-center gap-1">
              <Brain className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              {t("deck.organMemory", { count: memoryCount })}
            </span>
            <span className="opacity-30">·</span>
            <span className="hx-num inline-flex items-center gap-1">
              <Plug className="h-3 w-3 text-amber-600 dark:text-amber-400" />
              {t("deck.organMcp", { count: mcpCount })}
            </span>
          </div>

          {triageCount > 0 && (
            <button
              type="button"
              onClick={() => setRightTab("triage")}
              className="hx-pressable hx-num inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--hx-accent)] hover:opacity-90"
            >
              <Sparkles className="h-3 w-3" />
              <span>{t("deck.readyProposalsBadge", { count: triageCount })}</span>
            </button>
          )}

          {gardenerReport && (
            <button
              type="button"
              data-testid="gardener-pill-btn"
              onClick={() => setGardenerOpen((v) => !v)}
              className={cn(
                "hx-pressable hx-num inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                gardenerOpen
                  ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                  : "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]",
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  gardenerReport.findings.length === 0 && gardenerReport.modelDiversityOk
                    ? "bg-emerald-500"
                    : "bg-amber-500",
                )}
              />
              <span>{t("gardener.badge", { score: gardenerReport.healthScore })}</span>
              {gardenerOpen ? (
                <ChevronDown className="h-3 w-3 opacity-70" />
              ) : (
                <ChevronRight className="h-3 w-3 opacity-70" />
              )}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setChartsOpen((v) => !v)}
            className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
          >
            <BarChart3 className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
            <span>{chartsOpen ? t("deck.chartsHide") : t("deck.chartsShow")}</span>
            {chartsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>

          <button
            type="button"
            onClick={() => openOnboarding(true)}
            className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-amber-500/35 bg-amber-50/80 px-3 py-1.5 font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <Flame className="h-3.5 w-3.5" />
            <span>{t("top.crucible")}</span>
          </button>
        </div>
      </div>

      {/* Collapsible Harness Gardener · Entropy Audit Card */}
      {gardenerOpen && gardenerReport && (
        <div
          data-testid="gardener-card"
          className="border-b border-[var(--hx-border)] bg-[var(--hx-subtle)]/45 px-5 py-3.5 text-xs"
        >
          <div className="rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4 shadow-xs">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <Leaf className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <div className="text-xs font-semibold text-[var(--hx-text)]">
                    {t("gardener.title")}
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--hx-text-3)]">
                    {t("gardener.subtitle")}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="hx-num rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-1 font-mono text-[11px] text-[var(--hx-text-2)]">
                  {t("gardener.alwaysOnTokens", { tokens: gardenerReport.alwaysOnEstimatedTokens })}
                </span>

                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium",
                    gardenerReport.modelDiversityOk
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                  )}
                >
                  {gardenerReport.modelDiversityOk ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <AlertTriangle className="h-3 w-3" />
                  )}
                  <span>
                    {gardenerReport.modelDiversityOk
                      ? t("gardener.diversityOk")
                      : t("gardener.diversityWarn")}
                  </span>
                </span>

                <button
                  type="button"
                  aria-label={t("gardener.refresh")}
                  title={t("gardener.refresh")}
                  disabled={gardenerLoading}
                  onClick={() => void refreshGardenerReport()}
                  className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-1 text-[11px] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)] disabled:opacity-50"
                >
                  <RefreshCw className={cn("h-3 w-3", gardenerLoading && "animate-spin")} />
                  <span>{t("gardener.refresh")}</span>
                </button>
              </div>
            </div>

            <div className="mt-3">
              {gardenerReport.findings.length === 0 ? (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3 py-2.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("gardener.cleanState")}</span>
                </div>
              ) : (
                <div className="divide-y divide-[var(--hx-border)] rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)]/40">
                  {gardenerReport.findings.map((f) => (
                    <div
                      key={f.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px]"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                              f.severity === "warning"
                                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                : "bg-slate-500/12 text-[var(--hx-text-2)]",
                            )}
                          >
                            {t(`gardener.kind.${f.kind}`)}
                          </span>
                          <span className="font-mono text-[11px] font-medium text-[var(--hx-text)]">
                            {f.path}
                          </span>
                        </div>
                        <div className="text-[11px] text-[var(--hx-text-2)]">{f.detail}</div>
                      </div>
                      <span className="shrink-0 rounded-md border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--hx-text-2)]">
                        {t(`gardener.action.${f.suggestedAction}`)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {gardenerReport.suggestedPruningGoal && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  data-testid="gardener-start-pruning-btn"
                  onClick={() => launchPruningEvolution(gardenerReport.suggestedPruningGoal!)}
                  className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-3 py-1.5 text-[11px] font-semibold text-[var(--hx-canvas)] hover:opacity-90"
                >
                  <span>{t("gardener.startPruning")}</span>
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Collapsible 3-Chart Telemetry Cockpit */}
      {chartsOpen && (
        <div className="border-b border-[var(--hx-border)] bg-[var(--hx-subtle)]/35 px-5 py-3.5">
          <CommandDeckCharts
            commits={commits}
            proposals={proposals}
            genomeFiles={genomeFiles}
            trustRecords={trustRecords}
          />
        </div>
      )}

      {/* Sub-navigation Tabs */}
      <div className="border-b border-[var(--hx-border)] px-5 py-2.5">
        <SegmentedTabs value={rightTab} onChange={setRightTab} items={tabs} />
      </div>

      {/* Main Deck Split: Workbench + Telemetry/Context Rail */}
      <div className="grid flex-1 min-h-0 grid-cols-1 overflow-hidden xl:grid-cols-12">
        <div className="min-h-0 overflow-hidden xl:col-span-9">
          {rightTab === "triage" && <TriagePanel onInspectDiff={() => setRightTab("diff")} />}
          {rightTab === "theater" && <EvolutionTheaterPanel />}
          {rightTab === "diff" && <DiffReviewPanel />}
          {rightTab === "genome" && <GenomeDeckPanel />}
          {rightTab === "security" && <SecurityCenterPanel />}
          {rightTab === "providers" && <ProvidersPanel />}
        </div>

        <aside className="hidden xl:flex xl:col-span-3 flex-col border-l border-[var(--hx-border)] bg-[var(--hx-sidebar)]/50 p-4 space-y-4 overflow-y-auto text-xs">
          {activeThread && (
            <div className="space-y-2 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--hx-text-3)]">
                {t("nav.sectionWorkspace")}
              </div>
              <button
                type="button"
                onClick={() => void setActiveThread(activeThread.id)}
                className="text-left font-semibold text-[var(--hx-text)] hover:text-[var(--hx-accent)]"
              >
                {localizeThreadTitle(activeThread, locale)}
              </button>
              <div className="flex items-center justify-between text-[11px] text-[var(--hx-text-2)]">
                <span>{localizeThreadStatus(activeThread.status, locale)}</span>
                <span className="hx-num font-mono">
                  {activeThread.pinnedVersionLabel ?? "v7"} ·{" "}
                  {shortSha(activeThread.pinnedCommitSha)}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-2 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--hx-text-3)]">
              {t("tabs.theater")}
            </div>
            {theaterLogs.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-[var(--hx-text-3)]">
                {t("deck.theaterIdle")}
              </p>
            ) : (
              <div className="space-y-1.5 font-mono text-[10px]">
                {theaterLogs.slice(-6).map((log) => (
                  <div key={log.id} className="truncate text-[var(--hx-text-2)]">
                    <span className="text-[var(--hx-accent)]">[{log.stage}]</span> {log.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
