import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code2,
  DollarSign,
  Film,
  Flame,
  KeyRound,
  Pause,
  Play,
  RotateCcw,
  Scale,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import { localizeOnboardingReplay } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, formatDeltaPct, formatDurationMs, formatUsd } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";

const ACT_STEP_INDICES = [0, 2, 4, 6] as const;

export function OnboardingCrucibleModal() {
  const {
    onboardingOpen,
    openOnboarding,
    onboardingMode,
    setOnboardingMode,
    onboardingReplay,
    onboardingStepIndex,
    setOnboardingStepIndex,
    onboardingPlaying,
    setOnboardingPlaying,
    providers,
    appConfig,
    launchLiveChallenge,
    setActivePage,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();
  const isZh = locale.startsWith("zh");

  const [dataset, setDataset] = useState<"dataset_a" | "dataset_b">("dataset_a");
  const allModels = providers.flatMap((p) => p.models.map((m) => ({ provider: p.name, modelId: m })));
  const [solverModelId, setSolverModelId] = useState<string>(
    appConfig?.slots.solver?.modelId ?? allModels[0]?.modelId ?? "gpt-4.1-mini",
  );
  const [rawStepsOpen, setRawStepsOpen] = useState(false);

  const hasReadyProvider = providers.some(
    (p) => p.enabled && (p.hasApiKey || p.kind === "ollama"),
  );
  const steps = onboardingReplay?.steps ?? [];
  const activeAct = Math.min(3, Math.floor(onboardingStepIndex / 2));

  useEffect(() => {
    if (
      !onboardingOpen ||
      onboardingMode !== "replay" ||
      !onboardingPlaying ||
      steps.length === 0
    ) {
      return;
    }
    const timer = setInterval(() => {
      const current = useCommandDeckStore.getState().onboardingStepIndex;
      const currentAct = Math.min(3, Math.floor(current / 2));
      if (currentAct >= 3) {
        setOnboardingPlaying(false);
      } else {
        setOnboardingStepIndex(ACT_STEP_INDICES[currentAct + 1]!);
      }
    }, 2200);
    return () => clearInterval(timer);
  }, [
    onboardingOpen,
    onboardingMode,
    onboardingPlaying,
    steps.length,
    setOnboardingPlaying,
    setOnboardingStepIndex,
  ]);

  if (!onboardingOpen || !onboardingReplay) return null;

  const locReplay = localizeOnboardingReplay(onboardingReplay, locale);
  const acts = [
    { idx: 0, label: t("onb.act1Label"), summary: t("onb.act1Summary") },
    { idx: 1, label: t("onb.act2Label"), summary: t("onb.act2Summary") },
    { idx: 2, label: t("onb.act3Label"), summary: t("onb.act3Summary") },
    { idx: 3, label: t("onb.act4Label"), summary: t("onb.act4Summary") },
  ];

  const selectAct = (actIdx: number) => {
    setOnboardingPlaying(false);
    setOnboardingStepIndex(ACT_STEP_INDICES[actIdx] ?? 0);
  };

  const v0 = onboardingReplay.v0Metrics;
  const v1 = onboardingReplay.v1Metrics;

  return (
    <div
      role="dialog"
      aria-label={t("onb.title")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
    >
      <div className="hx-modal flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--hx-border)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Flame className="h-5 w-5 text-amber-500" />
            <div>
              <h2 className="text-sm font-semibold text-[var(--hx-text)]">{t("onb.title")}</h2>
              <p className="text-[11px] text-[var(--hx-text-2)]">{locReplay.title}</p>
            </div>
          </div>

          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => openOnboarding(false)}
            className="hx-pressable rounded-lg p-1.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hx-border)] bg-[var(--hx-subtle)]/60 px-5 py-2.5">
          <SegmentedTabs
            value={onboardingMode}
            onChange={(m) => setOnboardingMode(m)}
            items={[
              { id: "replay", label: t("onb.replayTab") },
              { id: "live", label: t("onb.liveTab") },
            ]}
          />

          {onboardingMode === "replay" && (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              <Film className="h-3 w-3" />
              {t("onb.replayBadge")}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {onboardingMode === "replay" ? (
            <>
              {/* 4-Act Horizontal Stepper */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {acts.map((act) => {
                  const isCurrent = act.idx === activeAct;
                  const isDone = act.idx < activeAct;
                  return (
                    <button
                      key={act.idx}
                      type="button"
                      data-testid={`crucible-act-${act.idx + 1}`}
                      onClick={() => selectAct(act.idx)}
                      className={cn(
                        "hx-pressable flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors",
                        isCurrent
                          ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] font-semibold text-[var(--hx-text)]"
                          : isDone
                            ? "border-emerald-500/30 bg-[var(--hx-subtle)] text-[var(--hx-text-2)]"
                            : "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text-3)] hover:text-[var(--hx-text)]",
                      )}
                    >
                      {isDone ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : isCurrent ? (
                        <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--hx-accent)]" />
                      ) : (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-current opacity-40" />
                      )}
                      <span className="truncate">{act.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Controls Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)]/70 px-3.5 py-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setOnboardingPlaying(!onboardingPlaying)}
                    className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-3 py-1.5 text-xs font-semibold text-[var(--hx-canvas)]"
                  >
                    {onboardingPlaying ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    <span>{onboardingPlaying ? t("onb.pause") : t("onb.play")}</span>
                  </button>

                  <button
                    type="button"
                    disabled={activeAct === 0}
                    onClick={() => selectAct(Math.max(0, activeAct - 1))}
                    className="hx-pressable inline-flex items-center gap-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-xs text-[var(--hx-text)] disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>{t("onb.prevAct")}</span>
                  </button>

                  <button
                    type="button"
                    disabled={activeAct === 3}
                    onClick={() => selectAct(Math.min(3, activeAct + 1))}
                    className="hx-pressable inline-flex items-center gap-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-xs text-[var(--hx-text)] disabled:opacity-40"
                  >
                    <span>{t("onb.nextStep")}</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => selectAct(0)}
                    className="hx-pressable inline-flex items-center gap-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-xs text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>{t("onb.reset")}</span>
                  </button>
                </div>

                <span className="font-mono text-xs text-[var(--hx-text-2)]">
                  {t("onb.stepProgress", { current: activeAct + 1, total: 4 })}
                </span>
              </div>

              {/* Visual Interactive Story Stage */}
              <div
                key={activeAct}
                data-testid={`crucible-stage-act-${activeAct + 1}`}
                className="hx-modal space-y-4 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-canvas)] p-5"
              >
                <p className="text-xs leading-relaxed text-[var(--hx-text)]">
                  {acts[activeAct]?.summary}
                </p>

                {/* ACT 1: Baseline Fails · v0 */}
                {activeAct === 0 && (
                  <div className="space-y-3">
                    <div className="overflow-hidden rounded-xl border border-rose-500/30 bg-[var(--hx-surface)] text-xs">
                      <div className="flex items-center justify-between border-b border-rose-500/20 bg-rose-50/75 px-3.5 py-2 dark:bg-rose-950/25">
                        <span className="font-semibold text-rose-800 dark:text-rose-200">
                          {t("onb.v0Title")} · 2026-10-invoices.csv
                        </span>
                        <span className="font-mono text-[11px] text-rose-700 dark:text-rose-300">
                          UTF-8 (lossy)
                        </span>
                      </div>
                      <table className="w-full text-left font-mono text-[11px]">
                        <thead className="border-b border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text-3)]">
                          <tr>
                            <th className="px-3 py-1.5 font-sans">
                              {isZh ? "客户名称" : "Vendor"}
                            </th>
                            <th className="px-3 py-1.5 font-sans">
                              {isZh ? "金额" : "Amount"}
                            </th>
                            <th className="px-3 py-1.5 font-sans">
                              {isZh ? "解析状态" : "Parse Result"}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--hx-border)]">
                          <tr className="bg-rose-50/40 dark:bg-rose-950/10">
                            <td className="px-3 py-2 text-rose-700 dark:text-rose-300">
                              Ӧ
                            </td>
                            <td className="px-3 py-2 text-rose-700 dark:text-rose-300">¥NaN</td>
                            <td className="px-3 py-2 font-sans text-rose-700 dark:text-rose-300">
                              {isZh ? "UTF-8 解码失败" : "UTF-8 decode failed"}
                            </td>
                          </tr>
                          <tr className="bg-rose-50/40 dark:bg-rose-950/10">
                            <td className="px-3 py-2 text-rose-700 dark:text-rose-300">
                              ϺƼ
                            </td>
                            <td className="px-3 py-2 text-amber-700 dark:text-amber-300">
                              (180.00)
                            </td>
                            <td className="px-3 py-2 font-sans text-rose-700 dark:text-rose-300">
                              {isZh ? "负数括号未识别" : "Parens negative unparsed"}
                            </td>
                          </tr>
                          <tr>
                            <td className="px-3 py-2 text-[var(--hx-text-2)]">VOID</td>
                            <td className="px-3 py-2 text-[var(--hx-text-2)]">¥0.00</td>
                            <td className="px-3 py-2 font-sans text-amber-700 dark:text-amber-300">
                              {isZh ? "作废行未过滤" : "VOID row leaked"}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <div className="flex flex-wrap gap-2 text-xs font-mono">
                      <span className="rounded-lg border border-rose-500/30 bg-rose-50 px-2.5 py-1 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
                        {v0.steps} {t("evo.steps")}
                      </span>
                      <span className="rounded-lg border border-rose-500/30 bg-rose-50 px-2.5 py-1 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
                        {v0.errors} {t("evo.errors")}
                      </span>
                      <span className="rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1 text-[var(--hx-text-2)]">
                        {formatDurationMs(v0.durationMs, locale)}
                      </span>
                    </div>
                  </div>
                )}

                {/* ACT 2: Grows a New Tool */}
                {activeAct === 1 && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-2.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4">
                      <div className="text-xs font-semibold text-[var(--hx-text)]">
                        {t("onb.diagTitle")}
                      </div>
                      <p className="text-xs leading-relaxed text-[var(--hx-text-2)]">
                        {t("onb.diagBody")}
                      </p>
                      <div className="pt-1">
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--hx-accent)]">
                          <Sparkles className="h-3 w-3" />
                          {t("onb.toolHintBadge")}
                        </span>
                      </div>
                    </div>

                    <div className="overflow-hidden rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)]">
                      <div className="flex items-center gap-2 border-b border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3.5 py-2 text-[11px] font-semibold text-[var(--hx-text)]">
                        <Code2 className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
                        <span>{t("onb.generatedToolTitle")}</span>
                      </div>
                      <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-[var(--hx-text)]">
                        {[
                          "export function decodeCsvSafely(raw: Uint8Array) {",
                          '  const text = tryStrictUtf8(raw) ?? new TextDecoder("gb18030").decode(raw);',
                          "  return parseRows(text, {",
                          "    ignoreVoid: true,",
                          "    parseParensNegative: true,",
                          "  });",
                          "}",
                        ].join("\n")}
                      </pre>
                    </div>
                  </div>
                )}

                {/* ACT 3: Shadow Arena & Blind Judge */}
                {activeAct === 2 && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {/* Old v0 */}
                      <div className="space-y-2 rounded-xl border border-rose-500/30 bg-rose-50/50 p-3.5 dark:bg-rose-950/15">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-rose-800 dark:text-rose-200">
                            {t("onb.v0Title")}
                          </span>
                          <span className="font-mono text-[11px] text-rose-700 dark:text-rose-300">
                            {v0.steps} {t("evo.steps")} · {v0.errors} {t("evo.errors")}
                          </span>
                        </div>
                        <div className="space-y-1 rounded-lg border border-rose-500/20 bg-[var(--hx-surface)] p-2.5 font-mono text-[11px] text-rose-700 dark:text-rose-300">
                          <div>Ӧ | ¥NaN</div>
                          <div>ϺƼ | (180.00)</div>
                        </div>
                      </div>

                      {/* Evolved v1 */}
                      <div className="space-y-2 rounded-xl border border-emerald-500/35 bg-emerald-50/60 p-3.5 dark:bg-emerald-950/20">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-emerald-800 dark:text-emerald-200">
                            {t("onb.v1Title")}
                          </span>
                          <span className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                            {v1.steps} {t("evo.steps")} · {v1.errors} {t("evo.errors")}
                          </span>
                        </div>
                        <div className="space-y-1 rounded-lg border border-emerald-500/25 bg-[var(--hx-surface)] p-2.5 font-mono text-[11px] text-[var(--hx-text)]">
                          <div className="flex justify-between">
                            <span>{isZh ? "华东供应链" : "East Supply Co."}</span>
                            <span className="text-emerald-700 dark:text-emerald-300">¥12,480.50</span>
                          </div>
                          <div className="flex justify-between">
                            <span>{isZh ? "华南云算力" : "South Cloud Ltd."}</span>
                            <span className="text-emerald-700 dark:text-emerald-300">¥6,156.00</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                        <Scale className="h-3.5 w-3.5" />
                        {t("onb.arenaJudgeBadge")}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1 text-[var(--hx-text-2)]">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                        {t("onb.arenaRegBadge")}
                      </span>
                    </div>
                  </div>
                )}

                {/* ACT 4: Lesson Saved · Ready */}
                {activeAct === 3 && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {[
                        {
                          label: t("evo.steps"),
                          before: String(v0.steps),
                          after: String(v1.steps),
                          delta: formatDeltaPct(v0.steps, v1.steps),
                          pct: Math.round((v1.steps / v0.steps) * 100),
                        },
                        {
                          label: t("evo.errors"),
                          before: String(v0.errors),
                          after: String(v1.errors),
                          delta: "-100%",
                          pct: 0,
                        },
                        {
                          label: t("evo.duration"),
                          before: formatDurationMs(v0.durationMs, locale),
                          after: formatDurationMs(v1.durationMs, locale),
                          delta: formatDeltaPct(v0.durationMs, v1.durationMs),
                          pct: Math.round((v1.durationMs / v0.durationMs) * 100),
                        },
                        {
                          label: t("evo.cost"),
                          before: formatUsd(v0.costUsd),
                          after: formatUsd(v1.costUsd),
                          delta: formatDeltaPct(v0.costUsd, v1.costUsd),
                          pct: Math.round((v1.costUsd / v0.costUsd) * 100),
                        },
                      ].map((row) => (
                        <div
                          key={row.label}
                          className="space-y-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3 text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[var(--hx-text-2)]">{row.label}</span>
                            <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                              {row.before} → {row.after} ({row.delta})
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--hx-muted)]">
                            <div
                              className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                              style={{ width: `${Math.max(6, row.pct)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] p-3.5">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--hx-accent)]">
                          <BookOpen className="h-3.5 w-3.5" />
                          <span>{t("onb.expCardTitle")}</span>
                        </div>
                        <p className="text-xs leading-relaxed text-[var(--hx-text)]">
                          {t("onb.expCardBody")}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => openOnboarding(false)}
                        className="hx-pressable inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-4 py-2 text-xs font-semibold text-[var(--hx-canvas)]"
                      >
                        <span>{t("onb.enterDeck")}</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Optional Collapsed Raw 8-Step Detail Drawer */}
              <div>
                <button
                  type="button"
                  onClick={() => setRawStepsOpen((v) => !v)}
                  className="inline-flex items-center gap-1 text-[11px] text-[var(--hx-text-3)] hover:text-[var(--hx-text)]"
                >
                  {rawStepsOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <span>{t("onb.rawStepsToggle")}</span>
                </button>

                {rawStepsOpen && (
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                    {locReplay.steps.map((step, idx) => (
                      <div
                        key={step.stage}
                        className="rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[var(--hx-text)]">
                            {idx + 1}. {step.title}
                          </span>
                          <span className="font-mono text-[10px] text-[var(--hx-text-3)]">
                            +{(step.offsetMs / 1000).toFixed(1)}s
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-[var(--hx-text-2)]">
                          {step.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              {!hasReadyProvider && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/35 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>{t("onb.noKeyWarning")}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      openOnboarding(false);
                      setActivePage("providers");
                    }}
                    className="hx-pressable inline-flex shrink-0 items-center gap-1 rounded-xl border border-amber-500/40 bg-amber-100 px-2.5 py-1 font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-100"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    <span>{t("onb.setupProvider")}</span>
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex items-center gap-3 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
                  <Clock className="h-5 w-5 shrink-0 text-[var(--hx-accent)]" />
                  <div>
                    <div className="text-xs font-semibold text-[var(--hx-text)]">
                      {t("onb.estDuration")}
                    </div>
                    <div className="text-[11px] text-[var(--hx-text-2)]">
                      {t("onb.estDurationDesc")}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
                  <DollarSign className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div>
                    <div className="text-xs font-semibold text-[var(--hx-text)]">
                      {t("onb.estCost")}
                    </div>
                    <div className="text-[11px] text-[var(--hx-text-2)]">
                      {t("onb.estCostDesc")}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
                  <label className="block text-xs font-semibold text-[var(--hx-text)]">
                    {t("onb.datasetTitle")}
                  </label>
                  <div className="space-y-1.5">
                    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-2.5 text-xs">
                      <input
                        type="radio"
                        name="crucible-dataset"
                        checked={dataset === "dataset_a"}
                        onChange={() => setDataset("dataset_a")}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="font-mono text-[var(--hx-text)]">
                          {isZh ? "数据集 A · 脏编码账单 CSV" : "dataset_a (GBK Billing CSV)"}
                        </div>
                        <div className="text-[11px] text-[var(--hx-text-3)]">
                          {isZh
                            ? "12 份混合编码账单 CSV（会触发默认 UTF-8 解析报错）。"
                            : "12 mixed-encoding supplier invoices that break naive UTF-8 decoders."}
                        </div>
                      </div>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-2.5 text-xs">
                      <input
                        type="radio"
                        name="crucible-dataset"
                        checked={dataset === "dataset_b"}
                        onChange={() => setDataset("dataset_b")}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="font-mono text-[var(--hx-text)]">
                          {isZh ? "数据集 B · 服务器日志异常排查" : "dataset_b (Log Anomaly Triage)"}
                        </div>
                        <div className="text-[11px] text-[var(--hx-text-3)]">
                          {isZh
                            ? "高噪声服务器日志异常波峰提取与定位。"
                            : "Noisy access logs requiring structured error spike isolation."}
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="space-y-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
                  <label className="block text-xs font-semibold text-[var(--hx-text)]">
                    {t("onb.solverTitle")}
                  </label>
                  <ChoiceMenu
                    ariaLabel={t("onb.solverTitle")}
                    value={solverModelId}
                    options={allModels.map((m) => ({
                      value: m.modelId,
                      label: m.modelId,
                      description: m.provider,
                    }))}
                    onChange={setSolverModelId}
                    buttonClassName="w-full font-mono"
                    menuClassName="w-72"
                  />
                  <p className="text-[11px] text-[var(--hx-text-3)]">
                    {isZh ? "改进模型" : "Improver"}:{" "}
                    <code className="text-[var(--hx-text)]">
                      {appConfig?.slots.improver?.modelId ?? "unset"}
                    </code>{" "}
                    · {isZh ? "裁判模型" : "Judge"}:{" "}
                    <code className="text-[var(--hx-text)]">
                      {appConfig?.slots.judge?.modelId ?? "unset"}
                    </code>
                  </p>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => openOnboarding(false)}
                  className="hx-pressable rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-3.5 py-2 text-xs text-[var(--hx-text-2)]"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void launchLiveChallenge({ dataset, solverModelId })}
                  className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-400 dark:text-zinc-950"
                >
                  <Zap className="h-3.5 w-3.5" />
                  <span>{t("onb.launchBtn", { dataset })}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
