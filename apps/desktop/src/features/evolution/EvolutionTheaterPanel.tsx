import { useState } from "react";
import type { EvolutionMode, EvolutionStage } from "@harnex/protocol";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Film,
  FlaskConical,
  Loader2,
  Play,
  Scale,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import {
  localizeDomainLabel,
  localizeProposal,
  localizeStageLabel,
} from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, formatDurationMs, formatUsd } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";

const PIPELINE_STAGES: EvolutionStage[] = [
  "queued",
  "proposing_inv",
  "proposing_dom",
  "shadow_probing",
  "blind_judging",
  "regression_checking",
  "reflecting",
  "completed",
];

export function EvolutionTheaterPanel() {
  const {
    proposals,
    selectedProposalId,
    theaterStage,
    theaterLogs,
    theaterLiveMetrics,
    evolutionRunning,
    triggerEvolution,
    openOnboarding,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const [domain, setDomain] = useState("file_ops");
  const [mode, setMode] = useState<EvolutionMode>("parallel");
  const [k, setK] = useState(2);
  const [rationaleOpen, setRationaleOpen] = useState(true);

  const proposal =
    proposals.find((p) => p.id === selectedProposalId) ?? proposals[0] ?? null;
  const locProposal = proposal ? localizeProposal(proposal, locale) : null;

  const currentStageIdx = theaterStage
    ? PIPELINE_STAGES.findIndex((s) => s === theaterStage)
    : proposal
      ? PIPELINE_STAGES.length - 1
      : -1;

  const domainOptions = [
    { value: "file_ops", label: localizeDomainLabel("file_ops", locale) },
    { value: "research", label: localizeDomainLabel("research", locale) },
    { value: "diagnostics", label: localizeDomainLabel("diagnostics", locale) },
    { value: "general", label: localizeDomainLabel("general", locale) },
    { value: "memory", label: localizeDomainLabel("memory", locale) },
    { value: "hooks", label: localizeDomainLabel("hooks", locale) },
    { value: "skills", label: localizeDomainLabel("skills", locale) },
  ];

  const strategyOptions = [
    { value: "parallel", label: t("theater.strategyParallel") },
    { value: "sequential", label: t("theater.strategySequential") },
  ];

  const budgetOptions = [
    { value: "1", label: "1×" },
    { value: "2", label: "2×" },
    { value: "3", label: "3×" },
    { value: "4", label: "4×" },
  ];

  return (
    <div className="h-full overflow-y-auto p-5 space-y-4">
      {/* Launch Controls */}
      <div
        style={{ boxShadow: "var(--hx-shadow-card)" }}
        className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-[var(--hx-accent)]" />
            <h2 className="text-xs font-semibold text-[var(--hx-text)]">{t("theater.title")}</h2>
          </div>

          <div className="flex items-center gap-2">
            {evolutionRunning && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--hx-accent)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="hx-shimmer">{t("theater.evolving")}</span>
              </span>
            )}
            <button
              type="button"
              onClick={() => openOnboarding(true)}
              className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
            >
              <Film className="h-3.5 w-3.5 text-amber-500" />
              <span>{t("lab.watchReplayBtn")}</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ChoiceMenu
            ariaLabel={t("theater.domainLabel")}
            value={domain}
            options={domainOptions}
            onChange={setDomain}
            buttonClassName="min-w-32"
            menuClassName="w-48"
          />
          <ChoiceMenu
            ariaLabel={t("theater.strategyLabel")}
            value={mode}
            options={strategyOptions}
            onChange={(v) => setMode(v as EvolutionMode)}
            buttonClassName="min-w-36"
            menuClassName="w-52"
          />
          <ChoiceMenu
            ariaLabel={t("theater.budgetLabel")}
            value={String(k)}
            options={budgetOptions}
            onChange={(v) => setK(Number(v))}
            buttonClassName="min-w-20 font-mono"
            menuClassName="w-28"
          />

          <button
            type="button"
            disabled={evolutionRunning}
            onClick={() => void triggerEvolution({ domain, mode, k })}
            className="hx-pressable ml-auto inline-flex items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-3.5 py-1.5 text-xs font-semibold text-[var(--hx-canvas)] hover:opacity-90 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" />
            <span>{t("theater.runCycle")}</span>
          </button>
        </div>
      </div>

      {/* Stage Pipeline */}
      <div className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4">
        <div className="flex flex-wrap gap-1.5">
          {PIPELINE_STAGES.map((stageId, idx) => {
            const done =
              idx < currentStageIdx ||
              (!evolutionRunning && currentStageIdx === PIPELINE_STAGES.length - 1);
            const active = evolutionRunning && idx === currentStageIdx;
            return (
              <div
                key={stageId}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  active
                    ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                    : done
                      ? "border-emerald-500/30 bg-emerald-50/75 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                      : "border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text-3)]",
                )}
              >
                {active ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : done ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" />
                )}
                <span>{localizeStageLabel(stageId, locale)}</span>
              </div>
            );
          })}
        </div>

        {theaterLogs.length > 0 && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3 font-mono text-[11px]">
            {theaterLogs.map((log) => (
              <div key={log.id} className="flex items-start gap-2">
                <span
                  className={cn(
                    "shrink-0 text-[10px]",
                    log.kind === "completed"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-[var(--hx-accent)]",
                  )}
                >
                  [{localizeStageLabel(log.stage, locale)}]
                </span>
                <span className="text-[var(--hx-text)]">{log.text}</span>
              </div>
            ))}
          </div>
        )}

        {theaterLiveMetrics && (
          <div className="hx-num flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-50/70 px-3.5 py-2 font-mono text-[11px] text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
            <span>{t("theater.cowSnapshot")}</span>
            <span>
              {theaterLiveMetrics.steps} {t("evo.steps")} · {theaterLiveMetrics.errors}{" "}
              {t("evo.errors")} · {formatDurationMs(theaterLiveMetrics.durationMs, locale)} ·{" "}
              {formatUsd(theaterLiveMetrics.costUsd)}
            </span>
          </div>
        )}
      </div>

      {/* Blind Judge A/B Arena */}
      {proposal?.blindJudge && locProposal && (
        <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Scale className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              <h3 className="text-xs font-semibold text-[var(--hx-text)]">
                {t("theater.arenaTitle")}
              </h3>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-0.5 font-mono text-[10px] text-[var(--hx-text-2)]">
                {proposal.blindJudge.seed}
              </span>
              {proposal.blindJudge.orderConsistent && (
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-50/80 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <ShieldCheck className="h-3 w-3" />
                  {t("theater.orderConsistent")}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <div
              className={cn(
                "rounded-xl border p-3 text-xs",
                proposal.blindJudge.winnerAnonId === "anon-A"
                  ? "border-emerald-500/40 bg-emerald-50/70 dark:bg-emerald-950/20"
                  : "border-[var(--hx-border)] bg-[var(--hx-subtle)]",
              )}
            >
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--hx-text-2)]">{t("theater.optionA")}</span>
                {proposal.blindJudge.winnerAnonId === "anon-A" && (
                  <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                    {t("theater.winner")}
                  </span>
                )}
              </div>
              <div className="mt-1 font-medium text-[var(--hx-text)]">{locProposal.optionALabel}</div>
            </div>

            <div
              className={cn(
                "rounded-xl border p-3 text-xs",
                proposal.blindJudge.winnerAnonId === "anon-B"
                  ? "border-emerald-500/40 bg-emerald-50/70 dark:bg-emerald-950/20"
                  : "border-[var(--hx-border)] bg-[var(--hx-subtle)]",
              )}
            >
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--hx-text-2)]">{t("theater.optionB")}</span>
                {proposal.blindJudge.winnerAnonId === "anon-B" && (
                  <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                    {t("theater.winner")}
                  </span>
                )}
              </div>
              <div className="mt-1 font-medium text-[var(--hx-text)]">{locProposal.optionBLabel}</div>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--hx-text-2)]">
              <button
                type="button"
                onClick={() => setRationaleOpen((v) => !v)}
                className="inline-flex items-center gap-1 font-medium text-[var(--hx-text)]"
              >
                {rationaleOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <span>{t("theater.rationaleToggle")}</span>
              </button>
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-violet-500" />
                  {t("theater.judgeModel")}{" "}
                  <code className="font-mono text-[var(--hx-text)]">
                    {proposal.blindJudge.judgeModelId}
                  </code>
                </span>
                <span>·</span>
                <span>{t("theater.confidence", { conf: locProposal.confidenceLabel })}</span>
              </span>
            </div>
            {rationaleOpen && (
              <p className="mt-2 leading-relaxed text-[var(--hx-text)]">
                {locProposal.judgeReasoning}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Experience Distillation Card */}
      {proposal?.experienceEntry && locProposal && (
        <section className="space-y-2.5 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4 text-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <h3 className="font-semibold text-[var(--hx-text)]">{t("theater.expTitle")}</h3>
            </div>
            <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-300">
              {localizeDomainLabel(proposal.experienceEntry.domain, locale)}
            </span>
          </div>
          <div className="space-y-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
            <div>
              <span className="font-semibold text-[var(--hx-accent)]">{t("theater.cue")} </span>
              <span className="text-[var(--hx-text)]">{locProposal.cue}</span>
            </div>
            <div>
              <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                {t("theater.lesson")}{" "}
              </span>
              <span className="text-[var(--hx-text)]">{locProposal.lesson}</span>
            </div>
            <div>
              <span className="font-semibold text-violet-700 dark:text-violet-300">
                {t("theater.evidence")}{" "}
              </span>
              <span className="text-[var(--hx-text-2)]">{locProposal.evidence}</span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
