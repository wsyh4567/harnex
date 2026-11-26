import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ExecutionMode,
  MessageAttachmentInput,
  ReasoningEffort,
  SlotBinding,
} from "@harnex/protocol";
import {
  AtSign,
  Brain,
  FolderGit2,
  FolderOpen,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  Send,
  Slash,
  Sparkles,
  Square,
  X,
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

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export interface PendingImageAttachment extends MessageAttachmentInput {
  previewUrl: string;
}

export interface ImageAttachmentCandidate {
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export type ImageAttachmentValidationIssue =
  | { kind: "non_image"; name: string }
  | { kind: "too_large"; name: string; sizeBytes: number }
  | { kind: "too_many"; max: number; skippedCount: number };

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateImageAttachmentBatch<T extends ImageAttachmentCandidate>(
  existingCount: number,
  candidates: readonly T[],
): { accepted: T[]; issues: ImageAttachmentValidationIssue[] } {
  const accepted: T[] = [];
  const issues: ImageAttachmentValidationIssue[] = [];
  let remainingSlots = Math.max(0, MAX_IMAGE_ATTACHMENTS - existingCount);
  let overflowCount = 0;

  for (const candidate of candidates) {
    if (!candidate.mimeType || !candidate.mimeType.toLowerCase().startsWith("image/")) {
      issues.push({ kind: "non_image", name: candidate.name || "file" });
      continue;
    }
    if (candidate.sizeBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
      issues.push({
        kind: "too_large",
        name: candidate.name || "image",
        sizeBytes: candidate.sizeBytes,
      });
      continue;
    }
    if (remainingSlots <= 0) {
      overflowCount += 1;
      continue;
    }
    accepted.push(candidate);
    remainingSlots -= 1;
  }

  if (overflowCount > 0) {
    issues.push({
      kind: "too_many",
      max: MAX_IMAGE_ATTACHMENTS,
      skippedCount: overflowCount,
    });
  }
  return { accepted, issues };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Failed to read image data"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function probeImageDimensions(dataUrl: string): Promise<{ width?: number; height?: number }> {
  if (typeof Image === "undefined") return Promise.resolve({});
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({
        width: img.naturalWidth > 0 ? img.naturalWidth : undefined,
        height: img.naturalHeight > 0 ? img.naturalHeight : undefined,
      });
    };
    img.onerror = () => resolve({});
    img.src = dataUrl;
  });
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
    customWorkspaces,
    setActiveWorkspace,
    pickWorkspaceDirectory,
    reasoningEffort,
    setReasoningEffort,
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
    pushToast,
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
  const [attachments, setAttachments] = useState<PendingImageAttachment[]>([]);
  const [isDraggingImage, setIsDraggingImage] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        new Set(
          [
            activeWorkspace,
            ...customWorkspaces,
            appConfig?.defaultWorkspace,
            ...threads.map((th) => th.workspacePath),
            "~/Work",
          ].filter((w): w is string => Boolean(w && w.trim())),
        ),
      ),
    [activeWorkspace, customWorkspaces, appConfig?.defaultWorkspace, threads],
  );

  const modeOptions = useMemo(
    () => [
      { value: "ask", label: t("top.mode.ask"), description: t("top.mode.askHint") },
      { value: "plan", label: t("top.mode.plan"), description: t("top.mode.planHint") },
      { value: "craft", label: t("top.mode.craft"), description: t("top.mode.craftHint") },
    ],
    [t],
  );

  const effortOptions = useMemo(
    () => [
      { value: "auto", label: t("chat.effort.auto"), description: t("chat.effort.autoHint") },
      { value: "low", label: t("chat.effort.low"), description: t("chat.effort.lowHint") },
      { value: "medium", label: t("chat.effort.medium"), description: t("chat.effort.mediumHint") },
      { value: "high", label: t("chat.effort.high"), description: t("chat.effort.highHint") },
    ],
    [t],
  );

  const ingestImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const candidates = files.map((file) => ({
      file,
      name: file.name || `pasted-image.${(file.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "")}`,
      mimeType: file.type,
      sizeBytes: file.size,
    }));
    const { accepted, issues } = validateImageAttachmentBatch(attachments.length, candidates);

    for (const issue of issues) {
      if (issue.kind === "non_image") {
        pushToast({
          tone: "warning",
          title: t("chat.attachUnsupportedTitle"),
          detail: t("chat.attachUnsupportedDetail", { name: issue.name }),
        });
      } else if (issue.kind === "too_large") {
        pushToast({
          tone: "warning",
          title: t("chat.attachTooLargeTitle"),
          detail: t("chat.attachTooLargeDetail", { name: issue.name, maxMb: 4 }),
        });
      } else if (issue.kind === "too_many") {
        pushToast({
          tone: "warning",
          title: t("chat.attachLimitTitle"),
          detail: t("chat.attachLimitDetail", { max: issue.max }),
        });
      }
    }

    if (accepted.length === 0) return;

    const prepared: PendingImageAttachment[] = [];
    for (let i = 0; i < accepted.length; i += 1) {
      const item = accepted[i]!;
      try {
        const dataUrl = await readFileAsDataUrl(item.file);
        const commaIdx = dataUrl.indexOf(",");
        const dataBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        if (!dataBase64) continue;
        const dims = await probeImageDimensions(dataUrl);
        prepared.push({
          id: `att-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          name: item.name.slice(0, 255),
          mimeType: item.mimeType || "image/png",
          sizeBytes: item.sizeBytes,
          ...(dims.width ? { width: dims.width } : {}),
          ...(dims.height ? { height: dims.height } : {}),
          dataBase64,
          previewUrl: dataUrl,
        });
      } catch {
        pushToast({
          tone: "error",
          title: t("chat.attachReadFailedTitle"),
          detail: item.name,
        });
      }
    }

    if (prepared.length > 0) {
      setAttachments((prev) => [...prev, ...prepared].slice(0, MAX_IMAGE_ATTACHMENTS));
    }
  };

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
    const outgoingAttachments: MessageAttachmentInput[] = attachments.map(
      ({ previewUrl: _previewUrl, ...rest }) => rest,
    );
    clearDraft();
    setAttachments([]);
    setCursorPos(0);
    setMenuDismissedAt(null);

    const sendOptions = {
      reasoningEffort,
      ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
    };

    if (variant === "home") {
      await startNewTaskPrompt(text, homeMode, homeBinding, sendOptions);
    } else {
      await sendPrompt(text, sendOptions);
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

        <div
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
              e.preventDefault();
              setIsDraggingImage(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setIsDraggingImage(false);
            }
          }}
          onDrop={(e) => {
            setIsDraggingImage(false);
            const droppedFiles = Array.from(e.dataTransfer?.files ?? []);
            if (droppedFiles.length > 0) {
              e.preventDefault();
              void ingestImageFiles(droppedFiles);
            }
          }}
          className={cn(
            "hx-composer-box rounded-2xl p-3 transition-colors",
            isDraggingImage && "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)]/25",
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            data-testid="composer-image-file-input"
            onChange={(e) => {
              const selected = Array.from(e.target.files ?? []);
              e.target.value = "";
              void ingestImageFiles(selected);
            }}
          />

          {attachments.length > 0 && (
            <div
              data-testid="composer-attachment-chips"
              className="mb-2 flex flex-wrap items-center gap-1.5"
            >
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="hx-item-enter inline-flex max-w-[220px] items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] py-1 pl-1 pr-2 text-[11px]"
                >
                  <img
                    src={att.previewUrl}
                    alt={att.name}
                    className="h-6 w-6 shrink-0 rounded-lg border border-[var(--hx-border)] object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-[var(--hx-text)]">{att.name}</div>
                    <div className="hx-num font-mono text-[9.5px] text-[var(--hx-text-3)]">
                      {formatAttachmentSize(att.sizeBytes)}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={t("chat.attachRemove", { name: att.name })}
                    title={t("chat.attachRemove", { name: att.name })}
                    onClick={() =>
                      setAttachments((prev) => prev.filter((item) => item.id !== att.id))
                    }
                    className="hx-pressable rounded-md p-0.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-surface)] hover:text-[var(--hx-text)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            data-testid="task-composer-textarea"
            rows={variant === "home" ? 3 : 2}
            value={prompt}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData?.items ?? []);
              const imageFiles: File[] = [];
              for (const item of items) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                  const file = item.getAsFile();
                  if (file) imageFiles.push(file);
                }
              }
              if (imageFiles.length === 0) {
                for (const file of Array.from(e.clipboardData?.files ?? [])) {
                  if (file.type.startsWith("image/")) imageFiles.push(file);
                }
              }
              if (imageFiles.length > 0) {
                e.preventDefault();
                void ingestImageFiles(imageFiles);
              }
            }}
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
              {/* Workspace Picker + Native Folder Browse */}
              <div className="inline-flex items-center gap-1">
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
                <button
                  type="button"
                  data-testid="composer-browse-workspace-btn"
                  title={t("nav.browseWorkspace")}
                  aria-label={t("nav.browseWorkspace")}
                  onClick={() => void pickWorkspaceDirectory()}
                  className="hx-pressable inline-flex items-center justify-center rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-1.5 text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
                >
                  <FolderOpen className="h-3 w-3" />
                </button>
              </div>

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

              {/* Quick triggers for image attach, /, @, and /btw */}
              <button
                type="button"
                data-testid="composer-attach-image-btn"
                title={t("chat.attachImageTitle")}
                aria-label={t("chat.attachImageTitle")}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "hx-pressable inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors",
                  attachments.length > 0
                    ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                    : "border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]",
                )}
              >
                <ImagePlus className="h-3 w-3" />
                {attachments.length > 0 && (
                  <span className="hx-num font-mono text-[10px] font-semibold">
                    {attachments.length}
                  </span>
                )}
              </button>
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

            <div className="flex items-center gap-1.5">
              {variant === "thread" && (
                <span className="hidden xl:inline whitespace-nowrap text-[10px] text-[var(--hx-text-3)]">
                  {t("chat.composerHint")}
                </span>
              )}

              <ChoiceMenu
                testId="reasoning-effort-selector"
                ariaLabel={t("chat.effortLabel")}
                value={reasoningEffort}
                options={effortOptions}
                onChange={(val) => setReasoningEffort(val as ReasoningEffort)}
                side="top-right"
                prefixIcon={<Brain className="h-3 w-3 text-[var(--hx-accent)]" />}
                buttonClassName="px-2 py-1 text-[11px] rounded-lg bg-[var(--hx-subtle)] border-[var(--hx-border)]"
                menuClassName="w-52"
              />

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
