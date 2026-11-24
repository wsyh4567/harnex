import { useMemo } from "react";
import type { ChatMessage } from "@harnex/protocol";
import { useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";

export interface TrajectorySpan {
  id: string;
  messageId: string;
  lane: 0 | 1 | 2;
  kind: "reasoning" | "message" | "tool";
  label: string;
  isError: boolean;
  status?: string;
}

export interface TrajectoryProjection {
  spans: TrajectorySpan[];
  turnCount: number;
  toolCount: number;
  errorCount: number;
}

/**
 * Project thread chat messages into a 3-lane trajectory timeline:
 * Lane 0 = Reasoning, Lane 1 = Messages (User / Steer / Assistant), Lane 2 = Tool Calls.
 */
export function buildTrajectorySpans(messages: ChatMessage[]): TrajectoryProjection {
  const spans: TrajectorySpan[] = [];
  let toolCount = 0;
  let errorCount = 0;

  for (const msg of messages) {
    const isPromptTurn = msg.role === "user" || msg.role === "steer";

    if (isPromptTurn && msg.content.trim().length > 0) {
      spans.push({
        id: `${msg.id}:message`,
        messageId: msg.id,
        lane: 1,
        kind: "message",
        label: msg.content.trim().slice(0, 60),
        isError: false,
        status: msg.role,
      });
    }

    if (msg.reasoning && msg.reasoning.trim().length > 0) {
      spans.push({
        id: `${msg.id}:reasoning`,
        messageId: msg.id,
        lane: 0,
        kind: "reasoning",
        label: msg.reasoning.trim().slice(0, 60),
        isError: false,
      });
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        const isError = tc.status === "failed" || tc.status === "denied";
        toolCount += 1;
        if (isError) errorCount += 1;
        spans.push({
          id: `${msg.id}:tool:${tc.id}`,
          messageId: msg.id,
          lane: 2,
          kind: "tool",
          label: tc.name,
          isError,
          status: tc.status,
        });
      }
    }

    if (msg.role === "assistant" && msg.content.trim().length > 0) {
      spans.push({
        id: `${msg.id}:message`,
        messageId: msg.id,
        lane: 1,
        kind: "message",
        label: msg.content.trim().slice(0, 60),
        isError: false,
        status: msg.role,
      });
    }
  }

  const promptTurns = messages.filter((m) => m.role === "user" || m.role === "steer").length;
  const assistantTurns = messages.filter((m) => m.role === "assistant").length;
  const turnCount = Math.max(promptTurns, assistantTurns);

  return {
    spans,
    turnCount,
    toolCount,
    errorCount,
  };
}

function getSpanToneClass(span: TrajectorySpan): string {
  if (span.kind === "reasoning") {
    return "bg-violet-500/80 hover:bg-violet-500 dark:bg-violet-400/80 dark:hover:bg-violet-400";
  }
  if (span.kind === "message") {
    if (span.status === "user") {
      return "bg-slate-400/70 hover:bg-slate-400 dark:bg-zinc-500/80 dark:hover:bg-zinc-400";
    }
    if (span.status === "steer") {
      return "bg-indigo-500/80 hover:bg-indigo-500 dark:bg-indigo-400/80 dark:hover:bg-indigo-400";
    }
    return "bg-cyan-500/85 hover:bg-cyan-500 dark:bg-cyan-400/85 dark:hover:bg-cyan-400";
  }
  if (span.isError) {
    return "bg-rose-500/90 hover:bg-rose-500 dark:bg-rose-400/90 dark:hover:bg-rose-400";
  }
  if (span.status === "awaiting_approval") {
    return "bg-amber-500/90 hover:bg-amber-500 dark:bg-amber-400/90 dark:hover:bg-amber-400";
  }
  if (span.status === "running" || span.status === "pending") {
    return "bg-cyan-500/75 animate-pulse dark:bg-cyan-400/75";
  }
  return "bg-emerald-500/85 hover:bg-emerald-500 dark:bg-emerald-400/85 dark:hover:bg-emerald-400";
}

interface TrajectoryMiniTimelineProps {
  messages: ChatMessage[];
  onJumpToMessage: (messageId: string) => void;
}

export function TrajectoryMiniTimeline({
  messages,
  onJumpToMessage,
}: TrajectoryMiniTimelineProps) {
  const { t } = useI18n();
  const projection = useMemo(() => buildTrajectorySpans(messages), [messages]);
  const { spans, turnCount, toolCount, errorCount } = projection;

  const lanes: Array<{ lane: 0 | 1 | 2; label: string }> = [
    { lane: 0, label: t("chat.trajectoryLaneReasoning") },
    { lane: 1, label: t("chat.trajectoryLaneMessage") },
    { lane: 2, label: t("chat.trajectoryLaneTool") },
  ];

  return (
    <div className="space-y-1.5" data-testid="trajectory-mini-timeline">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--hx-text-3)]">
          {t("chat.trajectoryTitle")}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="hx-num font-mono text-[10px] text-[var(--hx-text-2)]">
            {t("chat.trajectoryTurns", { turns: turnCount, tools: toolCount })}
          </span>
          {errorCount > 0 && (
            <span className="hx-num rounded-md bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
              {t("chat.trajectoryErrors", { count: errorCount })}
            </span>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-2.5">
        {spans.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-[var(--hx-text-3)]">
            {t("chat.trajectoryEmpty")}
          </p>
        ) : (
          <div className="space-y-1.5 overflow-x-auto pb-0.5">
            {lanes.map(({ lane, label }) => (
              <div key={lane} className="flex items-center gap-2">
                <span className="w-9 shrink-0 truncate text-[10px] font-medium text-[var(--hx-text-3)]">
                  {label}
                </span>
                <div
                  className="grid min-w-0 flex-1 items-center gap-1 rounded-md bg-[var(--hx-subtle)]/70 px-1 py-1"
                  style={{
                    gridTemplateColumns: `repeat(${spans.length}, minmax(10px, 1fr))`,
                  }}
                >
                  {spans.map((span, idx) =>
                    span.lane === lane ? (
                      <button
                        key={span.id}
                        type="button"
                        title={span.label}
                        aria-label={span.label}
                        onClick={() => onJumpToMessage(span.messageId)}
                        style={{ gridColumn: `${idx + 1} / span 1` }}
                        className={cn(
                          "hx-pressable h-3 w-full min-w-[10px] rounded-[4px] transition-transform hover:scale-y-110 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--hx-accent)]",
                          getSpanToneClass(span),
                        )}
                      />
                    ) : null,
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
