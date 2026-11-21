import { useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Flame,
  GitBranch,
  MessageSquarePlus,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import { localizeThreadStatus, localizeThreadTitle } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { formatTokens, formatUsd, shortSha } from "../../lib/utils.ts";
import { resolveCostSourceBadge } from "../providers/providerPresets.ts";
import { useCommandDeckStore, type RightWorkbenchTab } from "../../stores/useCommandDeckStore.ts";
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
    systemHealth,
    appConfig,
    setRsiMode,
    budgetStatus,
    openOnboarding,
    toggleSideChat,
    threads,
    activeThreadId,
    setActiveThread,
    theaterLogs,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();
  const [chartsOpen, setChartsOpen] = useState(true);

  const triageCount = proposals.filter(
    (p) => p.status === "ready" || p.status === "needs_reprobe",
  ).length;
  const headCommit = commits[0];
  const passPct = headCommit?.passRate !== undefined ? Math.round(headCommit.passRate * 100) : 94;
  const rsiMode = appConfig?.rsiMode ?? systemHealth?.rsiMode ?? "manual";
  const activeThread = threads.find((th) => th.id === activeThreadId) ?? threads[0] ?? null;
  const costMeta = resolveCostSourceBadge(budgetStatus?.costSource, locale);
  const tokensText = t("budget.tokensShort", {
    count: formatTokens(budgetStatus?.tokensToday ?? 0, locale),
  });

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
      {/* Live Operations Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hx-border)] bg-[var(--hx-sidebar)]/50 px-5 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5">
            <GitBranch className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
            <span className="font-mono font-semibold text-[var(--hx-text)]">
              {headCommit?.versionTag ?? "v7"} · {shortSha(headCommit?.sha ?? "a7f3c91")}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              · {t("genome.passRateBadge", { pct: passPct })}
            </span>
          </div>

          <button
            type="button"
            onClick={() => void setRsiMode(rsiMode === "manual" ? "auto" : "manual")}
            className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
          >
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
            <span>
              {t("top.rsi")}: {rsiMode === "auto" ? t("top.rsiAuto") : t("top.rsiManual")}
            </span>
          </button>

          <div className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 text-[var(--hx-text-2)]">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            <span>
              {systemHealth?.osSandboxLevel === "beta"
                ? t("top.sandboxBeta")
                : t("top.sandboxFull")}
            </span>
          </div>

          <div
            title={costMeta.tooltip}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 font-mono text-[var(--hx-text)]"
          >
            <Wallet className="h-3.5 w-3.5 text-emerald-500" />
            <span>
              {formatUsd(budgetStatus?.spentTodayUsd ?? 0)} /{" "}
              {formatUsd(budgetStatus?.dailyLimitUsd ?? 5)}
            </span>
            <span className="text-[var(--hx-text-3)]">·</span>
            <span className="font-sans text-[11px] text-[var(--hx-text-2)]">{tokensText}</span>
          </div>
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

          <button
            type="button"
            onClick={() => toggleSideChat(true)}
            className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 font-mono text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
          >
            <MessageSquarePlus className="h-3.5 w-3.5 text-violet-500" />
            <span>/btw</span>
          </button>
        </div>
      </div>

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
                <span className="font-mono">
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
