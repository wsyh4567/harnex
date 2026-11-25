import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  FlaskConical,
  GitBranch,
  Loader2,
  MessageSquarePlus,
  PanelRight,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { filterThreadChatApprovals } from "../../hooks/globalHookSelectors.ts";
import {
  localizeDomainLabel,
  localizeGoalTitle,
  localizeThreadStatus,
  localizeThreadTitle,
} from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, formatTokens, shortSha } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { ApprovalCard } from "../security/ApprovalCard.tsx";
import { MarkdownProse } from "../../components/ui/MarkdownProse.tsx";
import { TaskComposer } from "./TaskComposer.tsx";
import { TrajectoryMiniTimeline } from "./TrajectoryMiniTimeline.tsx";
import { buildTurnDisplaySegments, TurnActivityFeed } from "./TurnActivityFeed.tsx";

export function ThreadWorkspace() {
  const {
    threads,
    activeThreadId,
    messagesByThread,
    streamingByThread,
    pendingApprovals,
    resolveApproval,
    triggerEvolution,
    setActivePage,
    inspectorOpen,
    toggleInspector,
    toggleSideChat,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const prevThreadIdRef = useRef<string | null>(null);
  const prevMsgCountRef = useRef<number>(0);
  const msgCopyTimerRef = useRef<number | null>(null);

  const activeThread = threads.find((th) => th.id === activeThreadId) ?? null;
  const messages = activeThread ? (messagesByThread[activeThread.id] ?? []) : [];
  const streaming = activeThread ? streamingByThread[activeThread.id] : undefined;
  const threadApprovals = filterThreadChatApprovals(pendingApprovals, activeThread?.id);
  const displaySegments = useMemo(
    () => buildTurnDisplaySegments(messages, locale),
    [messages, locale],
  );

  const updateScrollBottomState = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      setShowScrollToBottom(false);
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollToBottom(distanceFromBottom > 160);
  }, []);

  const handleJumpToMessage = useCallback((messageId: string) => {
    const escapedId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(messageId)
        : messageId.replace(/"/g, '\\"');
    const target = scrollContainerRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${escapedId}"]`,
    );
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const handleCopyResponse = useCallback(async (msgId: string, content: string) => {
    try {
      await navigator.clipboard?.writeText(content);
      setCopiedMsgId(msgId);
      if (msgCopyTimerRef.current !== null) {
        window.clearTimeout(msgCopyTimerRef.current);
      }
      msgCopyTimerRef.current = window.setTimeout(() => setCopiedMsgId(null), 1800);
    } catch {
      // Ignore clipboard permission errors in restricted contexts
    }
  }, []);

  useEffect(() => {
    return () => {
      if (msgCopyTimerRef.current !== null) {
        window.clearTimeout(msgCopyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const threadChanged = prevThreadIdRef.current !== activeThreadId;
    if (threadChanged) {
      prevThreadIdRef.current = activeThreadId;
      prevMsgCountRef.current = messages.length;
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = 0;
      }
      updateScrollBottomState();
      return;
    }

    const appendedMessage = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;

    if (appendedMessage || Boolean(streaming)) {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    updateScrollBottomState();
  }, [activeThreadId, messages.length, streaming, updateScrollBottomState]);

  if (!activeThread) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center bg-[var(--hx-canvas)] p-8 text-center">
        <Sparkles className="mb-3 h-8 w-8 text-[var(--hx-accent)]" />
        <h2 className="text-sm font-semibold text-[var(--hx-text)]">{t("chat.noThreadTitle")}</h2>
        <p className="mt-1 text-xs text-[var(--hx-text-2)]">{t("chat.noThreadBody")}</p>
      </main>
    );
  }

  const ctxPct = Math.min(
    100,
    Math.round((activeThread.contextUsedTokens / activeThread.contextMaxTokens) * 100),
  );
  const allTools = messages.flatMap((m) => m.toolCalls ?? []);

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden bg-[var(--hx-canvas)]">
      {/* Main Reading Column */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Sub-header */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hx-border)] px-5 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-[var(--hx-text)]">
              {localizeThreadTitle(activeThread, locale)}
            </h2>
            <span className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--hx-text-2)]">
              {localizeDomainLabel(activeThread.domain, locale)}
            </span>
            <span className="rounded-md bg-[var(--hx-subtle)] px-2 py-0.5 text-[10px] text-[var(--hx-text-2)]">
              {localizeThreadStatus(activeThread.status, locale)}
            </span>
            {activeThread.hadHumanSteer && (
              <span className="rounded-md border border-violet-500/30 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                {t("chat.steerQueued")}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-1 font-mono text-[11px] text-[var(--hx-text-2)]">
              <GitBranch className="h-3 w-3 text-[var(--hx-accent)]" />
              {t("chat.pinned", {
                version: activeThread.pinnedVersionLabel ?? "v7",
                sha: shortSha(activeThread.pinnedCommitSha),
              })}
            </span>

            <button
              type="button"
              onClick={() => {
                void triggerEvolution({ domain: activeThread.domain });
                setActivePage("lab");
              }}
              className="hx-pressable inline-flex items-center gap-1.5 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
            >
              <FlaskConical className="h-3 w-3 text-[var(--hx-accent)]" />
              <span>{t("chat.evolveTrace")}</span>
            </button>

            <button
              type="button"
              data-testid="toggle-inspector-btn"
              onClick={() => toggleInspector()}
              className={cn(
                "hx-pressable inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium",
                inspectorOpen
                  ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                  : "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text-2)] hover:text-[var(--hx-text)]",
              )}
            >
              <PanelRight className="h-3.5 w-3.5" />
              <span className="hidden md:inline">{t("chat.inspector")}</span>
            </button>
          </div>
        </div>

        {/* Compact Goals Progress Strip */}
        {activeThread.goals.length > 0 && (
          <div className="border-b border-[var(--hx-border)] bg-[var(--hx-subtle)]/55 px-5 py-2">
            <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-[10px] font-semibold tracking-wider text-[var(--hx-text-3)]">
                {t("chat.goals")}
              </span>
              {activeThread.goals.map((g, idx) => (
                <div key={g.id} className="flex items-center gap-1.5 text-xs">
                  {g.status === "completed" ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : g.status === "in_progress" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--hx-accent)]" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-[var(--hx-text-3)]" />
                  )}
                  <span
                    className={cn(
                      g.status === "completed"
                        ? "text-[var(--hx-text-2)]"
                        : g.status === "in_progress"
                          ? "font-medium text-[var(--hx-text)]"
                          : "text-[var(--hx-text-3)]",
                    )}
                  >
                    {idx + 1}. {localizeGoalTitle(g.id, g.title, locale)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Messages Stream */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollContainerRef}
            onScroll={updateScrollBottomState}
            className="flex-1 overflow-y-auto px-5 pt-5 pb-6"
          >
            <div className="mx-auto max-w-3xl space-y-4">
              {messages.length === 0 && !streaming && (
                <div className="rounded-2xl border border-dashed border-[var(--hx-border-strong)] bg-[var(--hx-surface)] p-6 text-center text-xs text-[var(--hx-text-2)]">
                  {t("chat.emptyThread", {
                    version: activeThread.pinnedVersionLabel ?? "v7",
                    sha: shortSha(activeThread.pinnedCommitSha),
                  })}
                </div>
              )}

              {displaySegments.map((seg) => {
                if (seg.kind === "user") {
                  return (
                    <div key={seg.message.id} data-message-id={seg.message.id} className="flex justify-end">
                      <div className="max-w-[82%] rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-4 py-2.5 text-[13px] leading-relaxed text-[var(--hx-text)]">
                        {seg.content}
                      </div>
                    </div>
                  );
                }

                if (seg.kind === "steer") {
                  return (
                    <div
                      key={seg.message.id}
                      data-message-id={seg.message.id}
                      className="space-y-1 rounded-2xl border border-violet-500/30 bg-violet-50/70 px-4 py-3 text-xs dark:bg-violet-950/25"
                    >
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>{t("chat.humanSteerInjected")}</span>
                      </div>
                      <p className="text-[13px] text-[var(--hx-text)]">{seg.content}</p>
                    </div>
                  );
                }

                return (
                  <div
                    key={seg.id}
                    data-message-id={seg.id}
                    className="group/msg space-y-2.5 py-1 text-[13px]"
                  >
                    {seg.messageIds.slice(1).map((extraId) => (
                      <span key={extraId} data-message-id={extraId} className="sr-only" />
                    ))}

                    {seg.activities.length > 0 && (
                      <TurnActivityFeed
                        activities={seg.activities}
                        toolOutputs={seg.toolOutputs}
                        elapsedMs={seg.elapsedMs}
                      />
                    )}

                    {seg.finalContent && <MarkdownProse content={seg.finalContent} />}

                    {seg.finalContent && (
                      <div className="flex items-center gap-1.5 pt-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => void handleCopyResponse(seg.id, seg.finalContent)}
                          className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2 py-1 text-[11px] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
                        >
                          {copiedMsgId === seg.id ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                              <span>{t("chat.copiedResponse")}</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>{t("chat.copyResponse")}</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleSideChat(true)}
                          className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2 py-1 text-[11px] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
                        >
                          <MessageSquarePlus className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                          <span>{t("chat.askBtwAbout")}</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {streaming && (
                <div className="space-y-3 py-1 text-[13px]">
                  <TurnActivityFeed
                    activities={streaming.timeline}
                    isStreaming
                    startedAt={streaming.startedAt}
                  />
                  {streaming.content && <MarkdownProse content={streaming.content} />}
                </div>
              )}

              {threadApprovals.map((apr) => (
                <ApprovalCard
                  key={apr.requestId}
                  request={apr}
                  onResolve={(id, dec) => void resolveApproval(id, dec)}
                />
              ))}

              <div ref={streamEndRef} />
            </div>
          </div>

          {showScrollToBottom && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <button
                type="button"
                onClick={() => streamEndRef.current?.scrollIntoView({ behavior: "smooth" })}
                className="hx-pressable pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[var(--hx-border-strong)] bg-[var(--hx-surface)]/95 px-3 py-1.5 text-[11px] font-medium text-[var(--hx-text)] shadow-sm backdrop-blur hover:bg-[var(--hx-subtle)]"
              >
                <ArrowDown className="h-3 w-3 text-[var(--hx-accent)]" />
                <span>{t("chat.scrollToBottom")}</span>
              </button>
            </div>
          )}
        </div>

        {/* Bottom Composer */}
        <div className="px-5 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <TaskComposer variant="thread" />
          </div>
        </div>
      </main>

      {/* Optional Right-Side Task Inspector Drawer */}
      {inspectorOpen && (
        <aside
          data-testid="thread-inspector-drawer"
          className="hx-drawer flex w-80 shrink-0 flex-col border-l border-[var(--hx-border)] bg-[var(--hx-sidebar)] p-4 text-xs"
        >
          <div className="flex items-center justify-between pb-3 border-b border-[var(--hx-border)]">
            <span className="font-semibold text-[var(--hx-text)]">
              {t("chat.inspectorTitle")}
            </span>
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={() => toggleInspector(false)}
              className="hx-pressable rounded-lg p-1 text-[var(--hx-text-3)] hover:bg-[var(--hx-surface)] hover:text-[var(--hx-text)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-4 flex-1 space-y-4 overflow-y-auto">
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--hx-text-3)]">
                {t("chat.inspectorPinned")}
              </div>
              <div className="rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-2.5 font-mono text-[11px] text-[var(--hx-text)]">
                {activeThread.pinnedVersionLabel ?? "v7"} · {shortSha(activeThread.pinnedCommitSha, 12)}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--hx-text-3)]">
                <span>{t("chat.inspectorContext")}</span>
                <span className="hx-num font-mono text-[var(--hx-text-2)]">{ctxPct}%</span>
              </div>
              <div className="rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-2.5 space-y-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--hx-muted)]">
                  <div
                    className="h-full rounded-full bg-cyan-500"
                    style={{ width: `${ctxPct}%` }}
                  />
                </div>
                <div className="hx-num font-mono text-[10px] text-[var(--hx-text-3)]">
                  {formatTokens(activeThread.contextUsedTokens)} /{" "}
                  {formatTokens(activeThread.contextMaxTokens)}
                </div>
              </div>
            </div>

            <TrajectoryMiniTimeline
              messages={messages}
              onJumpToMessage={handleJumpToMessage}
            />

            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--hx-text-3)]">
                {t("chat.inspectorTools")} ({allTools.length})
              </div>
              <div className="space-y-1.5">
                {allTools.map((tc) => (
                  <div
                    key={tc.id}
                    className="flex items-center justify-between rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 font-mono text-[11px]"
                  >
                    <span className="truncate text-[var(--hx-text)]">{tc.name}</span>
                    <span className="text-[10px] text-[var(--hx-text-3)]">{tc.status}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5 border-t border-[var(--hx-border)] pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--hx-text-3)]">
                {t("chat.inspectorActions")}
              </div>
              <button
                type="button"
                onClick={() => toggleSideChat(true)}
                className="hx-pressable flex w-full items-center justify-between rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-2 text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
              >
                <span>{t("sidechat.title")}</span>
                <span className="font-mono text-[10px] text-[var(--hx-text-3)]">Ctrl+;</span>
              </button>
              <button
                type="button"
                onClick={() => setActivePage("lab")}
                className="hx-pressable flex w-full items-center justify-between rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-2 text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
              >
                <span>{t("nav.lab")}</span>
                <FlaskConical className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
