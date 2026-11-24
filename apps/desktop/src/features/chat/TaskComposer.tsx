import { useEffect, useMemo, useRef, useState } from "react";
import type { ExecutionMode, SlotBinding } from "@harnex/protocol";
import {
  AtSign,
  FolderGit2,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  Send,
  Slash,
  Sparkles,
  Square,
} from "lucide-react";
import { GlobalHookTrustBar } from "../../components/GlobalHookTrustBar.tsx";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import { useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { ModelSwitcherPopover } from "./ModelSwitcherPopover.tsx";
import { PromptCompletionMenu } from "./PromptCompletionMenu.tsx";
import {
  applyCompletion,
  buildCompletionOptions,
  detectCompletionTrigger,
  type CompletionOption,
} from "./promptCompletions.ts";

interface TaskComposerProps {
  variant: "home" | "thread";
  draftPrompt?: string;
  onDraftChange?: (val: string) => void;
  className?: string;
}

export function formatElapsedDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function TaskComposer({
  variant,
  draftPrompt,
  onDraftChange,
  className,
}: TaskComposerProps) {
  const {
    threads,
    activeThreadId,
    activeWorkspace,
    setActiveWorkspace,
    setThreadMode,
    genomeFiles,
    aggregatedCatalog,
    providers,
    appConfig,
    selectedModelByThread,
    setThreadModelOverride,
    composerDrafts,
    setComposerDraft,
    clearComposerDraft,
    sendPrompt,
    startNewTaskPrompt,
    pauseActiveRun,
    steerActiveRun,
    resumeActiveRun,
    abortActiveRun,
    toggleSideChat,
    askSideChat,
    triggerEvolution,
    setActivePage,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const activeThread =
    variant === "thread" ? (threads.find((th) => th.id === activeThreadId) ?? null) : null;
  const draftKey = variant === "home" ? "home" : (activeThread?.id ?? "home");

  const prompt = draftPrompt !== undefined ? draftPrompt : (composerDrafts[draftKey] ?? "");
  const setPrompt = (val: string) => {
    if (onDraftChange) onDraftChange(val);
    else setComposerDraft(draftKey, val);
  };
  const clearDraft = () => {
    if (onDraftChange) onDraftChange("");
    else clearComposerDraft(draftKey);
  };

  const [homeMode, setHomeMode] = useState<ExecutionMode>("craft");
  const [homeBinding, setHomeBinding] = useState<SlotBinding | undefined>(undefined);
  const [steerInput, setSteerInput] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [menuDismissedAt, setMenuDismissedAt] = useState<number | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (activeThread?.status !== "running") {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [activeThread?.id, activeThread?.status]);
  const currentMode: ExecutionMode = activeThread ? activeThread.mode : homeMode;
  const currentBinding: SlotBinding | undefined = activeThread
    ? (selectedModelByThread[activeThread.id] ?? appConfig?.slots.solver)
    : (homeBinding ?? appConfig?.slots.solver);
  const isOverride = activeThread
    ? Boolean(selectedModelByThread[activeThread.id])
    : Boolean(homeBinding);

  const workspaces = useMemo(
    () =>
      Array.from(
        new Set(["~/Work", "~/Projects/acme-data", ...threads.map((th) => th.workspacePath)]),
      ),
    [threads],
  );

  const modeOptions = useMemo(
    () => [
      { value: "ask", label: t("top.mode.ask"), description: t("top.mode.askHint") },
      { value: "plan", label: t("top.mode.plan"), description: t("top.mode.planHint") },
      { value: "craft", label: t("top.mode.craft"), description: t("top.mode.craftHint") },
    ],
    [t],
  );

  const trigger = useMemo(
    () => detectCompletionTrigger(prompt, cursorPos),
    [prompt, cursorPos],
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

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const minHeight = variant === "home" ? 72 : 46;
    const nextHeight = Math.max(minHeight, Math.min(el.scrollHeight, 180));
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > 180 ? "auto" : "hidden";
  }, [prompt, variant]);

  const executeOrInsertOption = (opt: CompletionOption) => {
    if (!trigger) return;
    if (opt.action) {
      // Remove the slash command token cleanly
      const { nextText, nextCursor } = applyCompletion(prompt, trigger, "");
      setPrompt(nextText);
      setCursorPos(nextCursor);
      setMenuDismissedAt(null);

      if (opt.action === "open_btw") {
        toggleSideChat(true);
      } else if (opt.action === "evolve") {
        void triggerEvolution({ domain: activeThread?.domain ?? "general" });
        setActivePage("lab");
      } else if (opt.action === "mode_ask") {
        if (activeThread) setThreadMode(activeThread.id, "ask");
        else setHomeMode("ask");
      } else if (opt.action === "mode_plan") {
        if (activeThread) setThreadMode(activeThread.id, "plan");
        else setHomeMode("plan");
      } else if (opt.action === "mode_craft") {
        if (activeThread) setThreadMode(activeThread.id, "craft");
        else setHomeMode("craft");
      }
      return;
    }

    if (opt.insertText) {
      const { nextText, nextCursor } = applyCompletion(prompt, trigger, opt.insertText);
      setPrompt(nextText);
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
    const pos = el?.selectionStart ?? prompt.length;
    const needsSpace = pos > 0 && !/\s/.test(prompt[pos - 1] ?? "");
    const inserted = `${needsSpace ? " " : ""}${prefixChar}`;
    const next = `${prompt.slice(0, pos)}${inserted}${prompt.slice(pos)}`;
    const nextPos = pos + inserted.length;
    setPrompt(next);
    setCursorPos(nextPos);
    setMenuDismissedAt(null);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextPos, nextPos);
      }
    });
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/btw ") || trimmed === "/btw") {
      const q = trimmed.slice(4).trim();
      clearDraft();
      setCursorPos(0);
      toggleSideChat(true);
      if (q) {
        await askSideChat(q);
      }
      return;
    }

    if (trimmed === "/evolve") {
      clearDraft();
      setCursorPos(0);
      void triggerEvolution({ domain: activeThread?.domain ?? "general" });
      setActivePage("lab");
      return;
    }

    const text = trimmed;
    clearDraft();
    setCursorPos(0);
    setMenuDismissedAt(null);

    if (variant === "home") {
      await startNewTaskPrompt(text, homeMode, homeBinding);
    } else {
      await sendPrompt(text);
    }
  };

  const handleSteerAndResume = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!steerInput.trim()) return;
    const text = steerInput;
    setSteerInput("");
    await steerActiveRun(text, true);
    await resumeActiveRun();
  };

  return (
    <div className={cn("w-full", className)}>
      {variant === "thread" && <GlobalHookTrustBar />}

      {/* Pause -> Steer -> Resume Control Bar (when thread is running or paused) */}
      {activeThread && (activeThread.status === "running" || activeThread.status === "paused") && (
        <div className="mb-2.5 rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-3.5 py-2.5 shadow-xs">
          {activeThread.status === "running" ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs text-cyan-700 dark:text-cyan-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{t("chat.runningInSandbox")}</span>
                <span
                  data-testid="running-elapsed-timer"
                  className="hx-num font-mono text-[11px] rounded-md border border-cyan-500/25 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-700 dark:text-cyan-200"
                >
                  {t("chat.elapsed", { time: formatElapsedDuration(elapsedSeconds) })}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void pauseActiveRun()}
                  className="hx-pressable flex items-center gap-1.5 rounded-lg border border-violet-500/35 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25"
                >
                  <Pause className="h-3.5 w-3.5" />
                  <span>{t("chat.pauseAndSteer")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void abortActiveRun()}
                  className="hx-pressable flex items-center gap-1 rounded-lg border border-rose-500/35 bg-rose-50 px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-200"
                >
                  <Square className="h-3 w-3" />
                  <span>{t("chat.abort")}</span>
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={(e) => void handleSteerAndResume(e)} className="flex items-center gap-2">
              <input
                type="text"
                value={steerInput}
                onChange={(e) => setSteerInput(e.target.value)}
                placeholder={t("chat.steerPlaceholder")}
                className="flex-1 rounded-xl border border-violet-500/35 bg-[var(--hx-subtle)] px-3 py-1.5 text-xs text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)]"
              />
              <button
                type="submit"
                className="hx-pressable flex items-center gap-1 rounded-xl bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{t("chat.steerAndResume")}</span>
              </button>
              <button
                type="button"
                onClick={() => void resumeActiveRun()}
                className="hx-pressable rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-xs text-[var(--hx-text)] hover:bg-[var(--hx-subtle)]"
              >
                {t("chat.resume")}
              </button>
              <button
                type="button"
                onClick={() => void abortActiveRun()}
                className="hx-pressable rounded-xl border border-rose-500/35 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-200"
              >
                {t("chat.abort")}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Main Composer Card */}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="relative"
      >
        {/* Floating `/` and `@` Completion Popover */}
        {menuOpen && trigger && (
          <PromptCompletionMenu
            trigger={trigger}
            options={completionOptions}
            highlightIdx={highlightIdx}
            onHighlight={setHighlightIdx}
            onSelect={executeOrInsertOption}
          />
        )}

        <div className="hx-composer-box rounded-2xl p-3">
          <textarea
            ref={textareaRef}
            data-testid="task-composer-textarea"
            rows={variant === "home" ? 3 : 2}
            value={prompt}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={(e) => {
              setIsComposing(false);
              setCursorPos(e.currentTarget.selectionStart ?? prompt.length);
            }}
            onChange={(e) => {
              const val = e.target.value;
              setPrompt(val);
              setCursorPos(e.target.selectionStart ?? val.length);
              setMenuDismissedAt(null);
            }}
            onClick={(e) => setCursorPos(e.currentTarget.selectionStart ?? prompt.length)}
            onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? prompt.length)}
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
                    (i) => (i - 1 + completionOptions.length) % completionOptions.length,
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
                void handleSubmit();
              }
            }}
            placeholder={t("chat.composerPlaceholder")}
            className="w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-relaxed text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)] focus:outline-none"
          />

          {/* Composer Footer Controls */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[var(--hx-border)]/70">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Workspace Picker */}
              <ChoiceMenu
                ariaLabel={t("top.workspace")}
                value={activeWorkspace}
                options={workspaces.map((ws) => ({ value: ws, label: ws }))}
                onChange={(ws) => setActiveWorkspace(ws)}
                side="top"
                prefixIcon={<FolderGit2 className="h-3 w-3 text-[var(--hx-text-3)]" />}
                buttonClassName="px-2 py-1 text-[11px] font-mono rounded-lg bg-[var(--hx-subtle)] border-[var(--hx-border)]"
                menuClassName="w-56"
              />

              {/* Mode Picker */}
              <ChoiceMenu
                ariaLabel="Execution mode"
                value={currentMode}
                options={modeOptions}
                onChange={(next) => {
                  const m = next as ExecutionMode;
                  if (activeThread) setThreadMode(activeThread.id, m);
                  else setHomeMode(m);
                }}
                side="top"
                prefixIcon={<Sparkles className="h-3 w-3 text-[var(--hx-accent)]" />}
                buttonClassName="px-2 py-1 text-[11px] rounded-lg bg-[var(--hx-subtle)] border-[var(--hx-border)]"
                menuClassName="w-56"
              />

              {/* Quick triggers for / and @ and /btw */}
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
              <button
                type="button"
                title={t("rail.sideChatTitle")}
                onClick={() => toggleSideChat(true)}
                className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-1 font-mono text-[11px] text-violet-700 hover:border-violet-500/35 dark:text-violet-300"
              >
                <MessageSquarePlus className="h-3 w-3" />
                <span>/btw</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {variant === "thread" && (
                <span className="hidden xl:inline whitespace-nowrap text-[10px] text-[var(--hx-text-3)]">
                  {t("chat.composerHint")}
                </span>
              )}

              <ModelSwitcherPopover
                catalog={aggregatedCatalog}
                providers={providers}
                activeBinding={currentBinding}
                isOverride={isOverride}
                onSelect={(binding) => {
                  if (activeThread) setThreadModelOverride(activeThread.id, binding);
                  else setHomeBinding(binding);
                }}
                onResetOverride={() => {
                  if (activeThread) setThreadModelOverride(activeThread.id, undefined);
                  else setHomeBinding(undefined);
                }}
              />

              <button
                type="submit"
                data-testid="task-composer-submit"
                disabled={!prompt.trim()}
                className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-3.5 py-1.5 text-xs font-semibold text-[var(--hx-canvas)] hover:opacity-90 disabled:opacity-35"
              >
                <Send className="h-3 w-3" />
                <span>{t("chat.runBtn")}</span>
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
