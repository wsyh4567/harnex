import { ArrowRight, GitBranch, KeyRound, Sparkles } from "lucide-react";
import { localizeProposal } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { resolveCommitSha, resolveCommitVersionLabel, shortSha } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { TaskComposer } from "./TaskComposer.tsx";

export function NewTaskHome() {
  const {
    proposals,
    commits,
    providers,
    systemHealth,
    selectProposal,
    setActivePage,
    setRightTab,
    setComposerDraft,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const activeSha = resolveCommitSha(commits, systemHealth?.activeCommitSha);
  const activeVersion = resolveCommitVersionLabel(commits, activeSha);
  const hasEnabledProvider = providers.some((p) => p.enabled && p.models.length > 0);

  const scenarios = [
    { label: t("home.scenario1Label"), prompt: t("home.scenario1Prompt") },
    { label: t("home.scenario2Label"), prompt: t("home.scenario2Prompt") },
    { label: t("home.scenario3Label"), prompt: t("home.scenario3Prompt") },
    { label: t("home.scenario4Label"), prompt: t("home.scenario4Prompt") },
  ];

  const readyHighlights = proposals.filter(
    (p) => p.status === "ready" || p.status === "adopted",
  );

  return (
    <main className="flex flex-1 flex-col items-center justify-center overflow-y-auto bg-[var(--hx-canvas)] px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col items-center">
        {/* Clean Brand Mark + Heading */}
        <img
          src="/harnex-mark.png"
          alt="Harnex"
          className="mb-4 h-11 w-11 object-contain"
        />
        <h2 className="text-center text-2xl font-semibold tracking-tight text-[var(--hx-text)]">
          {t("home.greeting")}
        </h2>
        <p className="mt-1.5 text-center text-xs text-[var(--hx-text-3)]">
          {t("home.subtitle")}
        </p>

        {/* Active Genome Pulse Pill */}
        <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1 text-[11px] text-[var(--hx-text-2)]">
          <GitBranch className="h-3 w-3 text-[var(--hx-accent)]" />
          <span className="hx-num font-mono">
            {t("home.genomePill", { version: activeVersion, sha: shortSha(activeSha) })}
          </span>
          <span className="opacity-30">·</span>
          <button
            type="button"
            onClick={() => setActivePage("deck")}
            className="hx-pressable font-medium text-[var(--hx-accent)] hover:underline"
          >
            {t("home.openDeckLink")}
          </button>
        </div>

        {/* Contextual First-Run Provider Setup Guide */}
        {!hasEnabledProvider && (
          <div
            data-testid="home-provider-setup-banner"
            className="hx-item-enter mt-5 flex w-full flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/35 bg-amber-50/75 px-4 py-3 text-xs dark:bg-amber-950/25"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0">
                <div className="font-semibold text-amber-950 dark:text-amber-100">
                  {t("home.setupProviderTitle")}
                </div>
                <p className="mt-0.5 text-[11px] text-amber-900/80 dark:text-amber-200/80">
                  {t("home.setupProviderBody")}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActivePage("providers")}
              className="hx-pressable inline-flex shrink-0 items-center gap-1 rounded-xl bg-amber-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-amber-500"
            >
              <span>{t("home.setupProviderBtn")}</span>
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Quick Scenario Pills */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {scenarios.map((sc) => (
            <button
              key={sc.label}
              type="button"
              onClick={() => setComposerDraft("home", sc.prompt)}
              className="hx-pressable rounded-full border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 text-xs text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]"
            >
              {sc.label}
            </button>
          ))}
        </div>

        {/* Floating Task Composer */}
        <TaskComposer variant="home" className="mt-5" />

        {/* Quiet RSI Highlight Strip (Real Winning Proposals) */}
        <div className="mt-7 w-full space-y-2">
          <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-[var(--hx-text-3)]">
            <Sparkles className="h-3 w-3 text-[var(--hx-accent)]" />
            <span>{t("home.highlightsTitle")}</span>
          </div>

          {readyHighlights.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--hx-border)] px-4 py-3 text-center text-xs text-[var(--hx-text-3)]">
              {t("home.noHighlights")}
            </div>
          ) : (
            <div className="divide-y divide-[var(--hx-border)] rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]">
              {readyHighlights.slice(0, 2).map((p) => {
                const loc = localizeProposal(p, locale);
                return (
                  <div
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-[var(--hx-text)]">{loc.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-[var(--hx-text-2)]">
                        <span>
                          {p.metricsBefore.steps} → {p.metricsAfter.steps}{" "}
                          {t("evo.steps")}
                        </span>
                        <span className="opacity-30">·</span>
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {p.metricsAfter.errors} {t("evo.errors")}
                        </span>
                        {p.regressionCheck && (
                          <>
                            <span className="opacity-30">·</span>
                            <span>
                              {p.regressionCheck.passed}/{p.regressionCheck.total}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        selectProposal(p.id);
                        setRightTab("triage");
                        setActivePage("proposals");
                      }}
                      className="hx-pressable inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
                    >
                      <span>{t("home.compare")}</span>
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
