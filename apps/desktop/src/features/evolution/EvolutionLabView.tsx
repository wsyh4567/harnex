import { useEffect, useMemo, useRef, useState } from "react";
import {
  AtSign,
  Bot,
  CheckCircle2,
  Cpu,
  Play,
  Plus,
  Send,
  Slash,
  Sparkles,
} from "lucide-react";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import { getEvolutionBlueprints } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { ModelSwitcherPopover } from "../chat/ModelSwitcherPopover.tsx";
import { PromptCompletionMenu } from "../chat/PromptCompletionMenu.tsx";
import {
  applyCompletion,
  buildCompletionOptions,
  detectCompletionTrigger,
  type CompletionOption,
} from "../chat/promptCompletions.ts";
import { EvolutionTheaterPanel } from "./EvolutionTheaterPanel.tsx";

export function EvolutionLabView() {
  const {
    guidedBlueprintId,
    setGuidedBlueprint,
    guidedMessagesByBlueprint,
    guidedModelOverride,
    setGuidedModelOverride,
    sendGuidedMessage,
    triggerEvolution,
    evolutionRunning,
    genomeFiles,
    activeWorkspace,
    aggregatedCatalog,
    providers,
    appConfig,
    activeThreadId,
    setThreadMode,
    toggleSideChat,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const [labTab, setLabTab] = useState<"guided" | "live">("guided");
  const [goalByPillar, setGoalByPillar] = useState<Record<string, string>>({});
  const [assistantInput, setAssistantInput] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [menuDismissedAt, setMenuDismissedAt] = useState<number | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [isComposing, setIsComposing] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const blueprints = getEvolutionBlueprints(locale);
  const activeBp = blueprints.find((b) => b.id === guidedBlueprintId) ?? blueprints[0]!;
  const goalText = goalByPillar[activeBp.id] ?? "";
  const chatTurns = guidedMessagesByBlueprint[activeBp.id] ?? [];

  const activeBinding =
    guidedModelOverride ?? appConfig?.slots.improver ?? appConfig?.slots.solver;
  const isOverride = Boolean(guidedModelOverride);

  const trigger = useMemo(
    () => detectCompletionTrigger(assistantInput, cursorPos),
    [assistantInput, cursorPos],
  );

  const completionOptions = useMemo(() => {
    if (!trigger) return [];
    return buildCompletionOptions({
      trigger,
      genomeFiles,
      activeWorkspace,
      locale,
    });
  }, [trigger, genomeFiles, activeWorkspace, locale]);

  const menuOpen =
    Boolean(trigger) &&
    menuDismissedAt !== trigger?.startIndex &&
    completionOptions.length > 0;

  useEffect(() => {
    setHighlightIdx(0);
  }, [trigger?.kind, trigger?.query]);

  const executeOrInsertOption = (opt: CompletionOption) => {
    if (!trigger) return;
    if (opt.action) {
      const { nextText, nextCursor } = applyCompletion(assistantInput, trigger, "");
      setAssistantInput(nextText);
      setCursorPos(nextCursor);
      setMenuDismissedAt(null);

      if (opt.action === "open_btw") {
        toggleSideChat(true);
      } else if (opt.action === "evolve") {
        setLabTab("live");
        void triggerEvolution({ domain: activeBp.domain, mode: "parallel", k: 2 });
      } else if (activeThreadId && opt.action === "mode_ask") {
        setThreadMode(activeThreadId, "ask");
      } else if (activeThreadId && opt.action === "mode_plan") {
        setThreadMode(activeThreadId, "plan");
      } else if (activeThreadId && opt.action === "mode_craft") {
        setThreadMode(activeThreadId, "craft");
      }
      return;
    }

    if (opt.insertText) {
      const { nextText, nextCursor } = applyCompletion(assistantInput, trigger, opt.insertText);
      setAssistantInput(nextText);
      setCursorPos(nextCursor);
      setMenuDismissedAt(null);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(nextCursor, nextCursor);
        }
      });
    }
  };

  const insertPrefixAtCursor = (prefixChar: "/" | "@") => {
    const el = textareaRef.current;
    const pos = el?.selectionStart ?? assistantInput.length;
    const needsSpace = pos > 0 && !/\s/.test(assistantInput[pos - 1] ?? "");
    const inserted = `${needsSpace ? " " : ""}${prefixChar}`;
    const next = `${assistantInput.slice(0, pos)}${inserted}${assistantInput.slice(pos)}`;
    const nextPos = pos + inserted.length;
    setAssistantInput(next);
    setCursorPos(nextPos);
    setMenuDismissedAt(null);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextPos, nextPos);
      }
    });
  };

  const appendGoalSnippet = (snippet: string) => {
    setGoalByPillar((prev) => {
      const existing = (prev[activeBp.id] ?? "").trim();
      if (!existing) return { ...prev, [activeBp.id]: snippet };
      if (existing.includes(snippet)) return prev;
      return { ...prev, [activeBp.id]: `${existing}；${snippet}` };
    });
  };

  const handleApplyDiscussionToGoal = () => {
    const userPoints = chatTurns
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.content.trim())
      .filter(Boolean);
    if (userPoints.length === 0) return;
    const summary = userPoints.join(locale.startsWith("zh") ? "；" : "; ");
    setGoalByPillar((prev) => {
      const existing = (prev[activeBp.id] ?? "").trim();
      return {
        ...prev,
        [activeBp.id]: existing ? `${existing}\n${summary}` : summary,
      };
    });
  };

  const handleAskAssistant = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = assistantInput.trim();
    if (!trimmed) return;
    if (trimmed === "/btw" || trimmed.startsWith("/btw ")) {
      setAssistantInput("");
      setCursorPos(0);
      setMenuDismissedAt(null);
      toggleSideChat(true);
      return;
    }
    if (trimmed === "/evolve") {
      setAssistantInput("");
      setCursorPos(0);
      setMenuDismissedAt(null);
      setLabTab("live");
      void triggerEvolution({ domain: activeBp.domain, mode: "parallel", k: 2 });
      return;
    }
    sendGuidedMessage(activeBp.id, trimmed, goalText, activeBinding);
    setAssistantInput("");
    setCursorPos(0);
    setMenuDismissedAt(null);
  };

  const handleRunGuidedEvaluation = async () => {
    setLabTab("live");
    await triggerEvolution({
      domain: activeBp.domain,
      mode: "parallel",
      k: 2,
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--hx-canvas)]">
      {/* Header + Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hx-border)] px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--hx-text)]">{t("lab.title")}</h2>
          <p className="text-xs text-[var(--hx-text-3)]">{t("lab.subtitle")}</p>
        </div>

        <SegmentedTabs
          value={labTab}
          onChange={setLabTab}
          items={[
            { id: "guided", label: t("lab.tabGuided") },
            { id: "live", label: t("lab.tabLive") },
          ]}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {labTab === "live" ? (
          <EvolutionTheaterPanel />
        ) : (
          <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-12">
            {/* Left Column: 6 Broad Capability Pillars + Custom Direction */}
            <div className="space-y-2 overflow-y-auto border-b border-[var(--hx-border)] bg-[var(--hx-sidebar)]/60 p-4 lg:col-span-4 lg:border-b-0 lg:border-r">
              <div className="px-1 pb-1 text-[11px] font-semibold text-[var(--hx-text-3)]">
                {t("lab.blueprintsTitle")}
              </div>
              {blueprints.map((bp) => {
                const selected = bp.id === activeBp.id;
                return (
                  <button
                    key={bp.id}
                    type="button"
                    data-testid={`blueprint-card-${bp.id}`}
                    onClick={() => setGuidedBlueprint(bp.id)}
                    className={cn(
                      "hx-pressable w-full rounded-2xl border p-3 text-left transition-colors",
                      selected
                        ? "border-[var(--hx-accent-border)] bg-[var(--hx-surface)] shadow-xs"
                        : "border-[var(--hx-border)] bg-[var(--hx-surface)]/75 hover:border-[var(--hx-border-strong)]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[var(--hx-text)]">{bp.title}</span>
                      {selected && (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--hx-accent)]" />
                      )}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--hx-text-2)]">
                      {bp.subtitle}
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Right Column: Open Pillar Header + Inspiration Chips + Conversational Architect + Open Goal Box */}
            <div className="flex flex-col overflow-hidden lg:col-span-8">
              <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
                {/* Pillar Header & Clickable Inspiration Ideas */}
                <div className="space-y-2.5">
                  <div>
                    <h3 className="text-base font-semibold tracking-tight text-[var(--hx-text)]">
                      {activeBp.title}
                    </h3>
                    <p className="mt-0.5 text-xs text-[var(--hx-text-2)]">{activeBp.subtitle}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 pr-1 text-[11px] font-medium text-[var(--hx-text-3)]">
                      <Sparkles className="h-3 w-3 text-[var(--hx-accent)]" />
                      <span>{t("lab.inspirationsLabel")}:</span>
                    </span>
                    {activeBp.inspirations.map((idea) => (
                      <button
                        key={idea}
                        type="button"
                        onClick={() => appendGoalSnippet(idea)}
                        className="hx-pressable inline-flex items-center gap-1 rounded-full border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1 text-[11px] text-[var(--hx-text-2)] hover:border-[var(--hx-accent-border)] hover:bg-[var(--hx-accent-soft)] hover:text-[var(--hx-text)]"
                      >
                        <Plus className="h-2.5 w-2.5 text-[var(--hx-accent)]" />
                        <span>{idea}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Primary Focal Area: Conversational Evolution Architect */}
                <div className="flex min-h-[260px] flex-1 flex-col rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-2xl border-b border-[var(--hx-border)] bg-[var(--hx-subtle)]/55 px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-[var(--hx-accent)]" />
                      <div>
                        <div className="text-xs font-semibold text-[var(--hx-text)]">
                          {t("lab.assistantTitle")}
                        </div>
                        <div className="text-[11px] text-[var(--hx-text-3)]">
                          {t("lab.assistantSub")}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {activeBinding && (
                        <span
                          data-testid="lab-active-model-badge"
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px]",
                            isOverride
                              ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                              : "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text-2)]",
                          )}
                        >
                          <Cpu className="h-2.5 w-2.5 shrink-0" />
                          <span>
                            {t("lab.architectModel")}: {activeBinding.modelId}
                          </span>
                        </span>
                      )}

                      {chatTurns.some((turn) => turn.role === "user") && (
                        <button
                          type="button"
                          data-testid="guided-apply-chat-btn"
                          onClick={handleApplyDiscussionToGoal}
                          className="hx-pressable rounded-lg border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--hx-accent)]"
                        >
                          {t("lab.applyChatBtn")}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 space-y-3 overflow-y-auto p-4 text-xs">
                    <div className="mr-8 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3.5 py-2.5 leading-relaxed text-[var(--hx-text)]">
                      {activeBp.starterReply}
                    </div>

                    {chatTurns.map((turn) => (
                      <div
                        key={turn.id}
                        className={cn(
                          "whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 leading-relaxed",
                          turn.role === "user"
                            ? "ml-10 border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-text)]"
                            : "mr-8 border border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text)]",
                        )}
                      >
                        <div>{turn.content}</div>
                        {turn.role === "assistant" && turn.modelId && (
                          <div className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-[var(--hx-border)] bg-[var(--hx-surface)]/80 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hx-text-3)]">
                            <Cpu className="h-2.5 w-2.5" />
                            <span>{turn.modelId}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Composer matching TaskComposer craft, `/` & `@` completions, and Model Switcher */}
                  <div className="rounded-b-2xl border-t border-[var(--hx-border)] bg-[var(--hx-subtle)]/30 p-3">
                    <form onSubmit={(e) => handleAskAssistant(e)} className="relative">
                      {menuOpen && trigger && (
                        <PromptCompletionMenu
                          trigger={trigger}
                          options={completionOptions}
                          highlightIdx={highlightIdx}
                          onHighlight={setHighlightIdx}
                          onSelect={executeOrInsertOption}
                          testId="lab-completion-menu"
                        />
                      )}

                      <div className="hx-composer-box rounded-2xl p-2.5">
                        <textarea
                          ref={textareaRef}
                          data-testid="lab-composer-textarea"
                          rows={2}
                          value={assistantInput}
                          onCompositionStart={() => setIsComposing(true)}
                          onCompositionEnd={(e) => {
                            setIsComposing(false);
                            setCursorPos(
                              e.currentTarget.selectionStart ?? assistantInput.length,
                            );
                          }}
                          onChange={(e) => {
                            const val = e.target.value;
                            setAssistantInput(val);
                            setCursorPos(e.target.selectionStart ?? val.length);
                            setMenuDismissedAt(null);
                          }}
                          onClick={(e) =>
                            setCursorPos(e.currentTarget.selectionStart ?? assistantInput.length)
                          }
                          onKeyUp={(e) =>
                            setCursorPos(e.currentTarget.selectionStart ?? assistantInput.length)
                          }
                          onKeyDown={(e) => {
                            const nativeComposing = (e.nativeEvent as KeyboardEvent).isComposing;
                            if (isComposing || nativeComposing) return;

                            if (menuOpen) {
                              if (e.key === "ArrowDown") {
                                e.preventDefault();
                                setHighlightIdx((i) => (i + 1) % completionOptions.length);
                                return;
                              }
                              if (e.key === "ArrowUp") {
                                e.preventDefault();
                                setHighlightIdx(
                                  (i) =>
                                    (i - 1 + completionOptions.length) % completionOptions.length,
                                );
                                return;
                              }
                              if (e.key === "Enter" || e.key === "Tab") {
                                e.preventDefault();
                                const chosen = completionOptions[highlightIdx];
                                if (chosen) executeOrInsertOption(chosen);
                                return;
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setMenuDismissedAt(trigger?.startIndex ?? null);
                                return;
                              }
                            }

                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleAskAssistant();
                            }
                          }}
                          placeholder={t("lab.assistantPlaceholder")}
                          className="w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-relaxed text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)] focus:outline-none"
                        />

                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hx-border)]/70 pt-1.5">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              title="/skill · /mcp"
                              onClick={() => insertPrefixAtCursor("/")}
                              className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-1 text-[11px] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
                            >
                              <Slash className="h-3 w-3 text-[var(--hx-accent)]" />
                            </button>
                            <button
                              type="button"
                              title="@context"
                              onClick={() => insertPrefixAtCursor("@")}
                              className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-1 text-[11px] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
                            >
                              <AtSign className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                            </button>
                          </div>

                          <div className="flex items-center gap-2">
                            <ModelSwitcherPopover
                              catalog={aggregatedCatalog}
                              providers={providers}
                              activeBinding={activeBinding}
                              isOverride={isOverride}
                              resetLabel={t("lab.resetImprover")}
                              testId="lab-model-switcher-btn"
                              onSelect={(binding) => setGuidedModelOverride(binding)}
                              onResetOverride={() => setGuidedModelOverride(undefined)}
                            />

                            <button
                              type="submit"
                              data-testid="lab-composer-submit"
                              disabled={!assistantInput.trim()}
                              className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-3.5 py-1.5 text-xs font-semibold text-[var(--hx-canvas)] hover:opacity-90 disabled:opacity-35"
                            >
                              <Send className="h-3 w-3" />
                              <span>{t("lab.assistantSend")}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </form>
                  </div>
                </div>

                {/* Open Editable Evolution Goal & Expected Outcome */}
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-[var(--hx-text-2)]">
                    {t("lab.goalLabel")}
                  </label>
                  <textarea
                    rows={2}
                    data-testid="guided-goal-textarea"
                    value={goalText}
                    onChange={(e) =>
                      setGoalByPillar((prev) => ({ ...prev, [activeBp.id]: e.target.value }))
                    }
                    placeholder={t("lab.goalPlaceholder")}
                    className="w-full resize-none rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] p-3 text-xs leading-relaxed text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)] focus:border-[var(--hx-accent-border)] focus:outline-none"
                  />
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end border-t border-[var(--hx-border)] bg-[var(--hx-surface)] px-5 py-3">
                <button
                  type="button"
                  disabled={evolutionRunning}
                  data-testid="guided-run-evolution-btn"
                  onClick={() => void handleRunGuidedEvaluation()}
                  className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-4 py-2 text-xs font-semibold text-[var(--hx-canvas)] hover:opacity-90 disabled:opacity-40"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>{t("lab.runGuidedBtn")}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
