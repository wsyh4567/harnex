import { useEffect, useRef, useState } from "react";
import type { ToolCallRecord } from "@harnex/protocol";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  FlaskConical,
  GitBranch,
  Loader2,
  PanelRight,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { filterThreadChatApprovals } from "../../hooks/globalHookSelectors.ts";
import {
  localizeDomainLabel,
  localizeGoalTitle,
  localizeMessage,
  localizeThreadStatus,
  localizeThreadTitle,
} from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, formatTokens, shortSha } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { ApprovalCard } from "../security/ApprovalCard.tsx";
import { MarkdownProse } from "../../components/ui/MarkdownProse.tsx";
import { TaskComposer } from "./TaskComposer.tsx";

function ToolCallItem({
  tc,
  localizedOutput,
}: {
  tc: ToolCallRecord;
  localizedOutput?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(
    tc.status === "awaiting_approval" || tc.status === "failed",
  );

  const statusLabelMap: Record<ToolCallRecord["status"], string> = {
    completed: t("chat.toolCompleted"),
    pending: t("chat.toolPending"),
    running: t("chat.toolRunning"),
    awaiting_approval: t("chat.toolAwaiting"),
    failed: t("chat.toolFailed"),
    denied: t("chat.toolDenied"),
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[var(--hx-subtle)] transition-colors"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Wrench className="h-3.5 w-3.5 shrink-0 text-[var(--hx-accent)]" />
          <code className="truncate font-mono text-[11px] text-[var(--hx-text)]">{tc.name}</code>
          <span
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
              tc.status === "completed"
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                : tc.status === "awaiting_approval"
                  ? "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                  : tc.status === "failed" || tc.status === "denied"
                    ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                    : "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]",
            )}
          >
            {statusLabelMap[tc.status]}
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--hx-text-3)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--hx-text-3)]" />
        )}
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-[var(--hx-border)] px-3 py-2 font-mono text-[11px]">
          <div className="break-all text-[var(--hx-text-2)]">
            <span className="text-[var(--hx-text-3)]">{t("chat.toolArgs")}: </span>
            {JSON.stringify(tc.args)}
          </div>
          {(localizedOutput || tc.output) && (
            <div className="whitespace-pre-wrap rounded-lg bg-[var(--hx-subtle)] p-2 text-[var(--hx-text)]">
              {localizedOutput ?? tc.output}
              {tc.truncated && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  {t("chat.truncated")}
                </span>
              )}
            </div>
          )}
          {tc.error && (
            <div className="whitespace-pre-wrap rounded-lg bg-rose-50 p-2 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {tc.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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

  const [openReasoningIds, setOpenReasoningIds] = useState<Record<string, boolean>>({});
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const prevThreadIdRef = useRef<string | null>(null);
  const prevMsgCountRef = useRef<number>(0);

  const activeThread = threads.find((th) => th.id === activeThreadId) ?? null;
  const messages = activeThread ? (messagesByThread[activeThread.id] ?? []) : [];
  const streaming = activeThread ? streamingByThread[activeThread.id] : undefined;
  const threadApprovals = filterThreadChatApprovals(pendingApprovals, activeThread?.id);

  useEffect(() => {
    const threadChanged = prevThreadIdRef.current !== activeThreadId;
    if (threadChanged) {
      prevThreadIdRef.current = activeThreadId;
      prevMsgCountRef.current = messages.length;
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = 0;
      }
      return;
    }

    const appendedMessage = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;

    if (appendedMessage || Boolean(streaming)) {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeThreadId, messages.length, streaming]);

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
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-5 pt-5 pb-6">
          <div className="mx-auto max-w-3xl space-y-4">
            {messages.length === 0 && !streaming && (
              <div className="rounded-2xl border border-dashed border-[var(--hx-border-strong)] bg-[var(--hx-surface)] p-6 text-center text-xs text-[var(--hx-text-2)]">
                {t("chat.emptyThread", {
                  version: activeThread.pinnedVersionLabel ?? "v7",
                  sha: shortSha(activeThread.pinnedCommitSha),
                })}
              </div>
            )}

            {messages.map((msg) => {
              const reasoningOpen = openReasoningIds[msg.id] ?? false;
              const loc = localizeMessage(msg, locale);

              if (msg.role === "user") {
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[82%] rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-4 py-2.5 text-[13px] leading-relaxed text-[var(--hx-text)]">
                      {loc.content}
                    </div>
                  </div>
                );
              }

              if (msg.role === "steer") {
                return (
                  <div
                    key={msg.id}
                    className="space-y-1 rounded-2xl border border-violet-500/30 bg-violet-50/70 px-4 py-3 text-xs dark:bg-violet-950/25"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>{t("chat.humanSteerInjected")}</span>
                    </div>
                    <p className="text-[13px] text-[var(--hx-text)]">{loc.content}</p>
                  </div>
                );
              }

              return (
                <div key={msg.id} className="space-y-2.5 py-1 text-[13px]">
                  {loc.reasoning && (
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenReasoningIds((prev) => ({ ...prev, [msg.id]: !reasoningOpen }))
                        }
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]"
                      >
                        {reasoningOpen ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        <span>{t("chat.reasoningTrace")}</span>
                      </button>
                      {reasoningOpen && (
                        <pre className="mt-1.5 whitespace-pre-wrap rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3 font-mono text-[11px] leading-relaxed text-[var(--hx-text-2)]">
                          {loc.reasoning}
                        </pre>
                      )}
                    </div>
                  )}

                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="space-y-1.5">
                      {msg.toolCalls.map((tc) => (
                        <ToolCallItem
                          key={tc.id}
                          tc={tc}
                          localizedOutput={loc.toolOutputs[tc.id]}
                        />
                      ))}
                    </div>
                  )}

                  <MarkdownProse content={loc.content} />
                </div>
              );
            })}

            {streaming && (
              <div className="space-y-2.5 rounded-2xl border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] p-4 text-xs">
                <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--hx-accent)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span className="hx-shimmer">{t("chat.streaming", { runId: streaming.runId })}</span>
                </div>
                {streaming.reasoning && (
                  <pre className="whitespace-pre-wrap rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-2.5 font-mono text-[11px] text-[var(--hx-text-2)]">
                    {streaming.reasoning}
                  </pre>
                )}
                {streaming.toolCalls.map((tc) => (
                  <ToolCallItem key={tc.id} tc={tc} />
                ))}
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
