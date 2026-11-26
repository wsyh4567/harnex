import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ToolCallRecord } from "@harnex/protocol";
import {
  Brain,
  Check,
  ChevronRight,
  Copy,
  FilePenLine,
  FileText,
  FolderOpen,
  ListChecks,
  Loader2,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { MarkdownProse } from "../../components/ui/MarkdownProse.tsx";
import { localizeMessage } from "../../i18n/demoContent.ts";
import { useI18n, type Locale } from "../../i18n/index.ts";
import { cn, formatToolDuration } from "../../lib/utils.ts";
import type { ActivityTimelineItem } from "../../stores/useCommandDeckStore.ts";

export type TurnDisplaySegment =
  | { kind: "user"; message: ChatMessage; content: string }
  | { kind: "steer"; message: ChatMessage; content: string }
  | {
      kind: "assistant_turn";
      id: string;
      messageIds: string[];
      activities: ActivityTimelineItem[];
      toolOutputs: Record<string, string>;
      finalContent: string;
      elapsedMs?: number;
    };

export function isCommandTool(name: string): boolean {
  return name === "shell" || name === "run_script" || name === "bash" || name === "exec";
}

export function formatDurationCompact(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function summarizeToolTarget(tc: ToolCallRecord): string {
  const args = tc.args ?? {};
  const str = (key: string): string => (typeof args[key] === "string" ? args[key] : "");
  switch (tc.name) {
    case "shell": {
      const cmd = str("command");
      const extra = Array.isArray(args.args)
        ? args.args.filter((v): v is string => typeof v === "string").join(" ")
        : "";
      return `${cmd}${extra ? ` ${extra}` : ""}`.trim();
    }
    case "run_script": {
      const script = str("scriptPath");
      const extra = Array.isArray(args.args)
        ? args.args.filter((v): v is string => typeof v === "string").join(" ")
        : "";
      return `${script}${extra ? ` ${extra}` : ""}`.trim();
    }
    case "read_file": {
      const path = str("path");
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const range = limit !== undefined ? `L${start}-${start + limit - 1}` : `L${start}+`;
        return `${path} (${range})`;
      }
      return path;
    }
    case "edit_file": {
      const path = str("path");
      const count = Array.isArray(args.edits) ? args.edits.length : 1;
      return `${path} (${count})`;
    }
    case "write_file":
    case "delete_file":
    case "list_files":
      return str("path");
    case "find_files": {
      const pat = str("pattern");
      const path = str("path");
      return [pat, path && path !== "." ? path : ""].filter(Boolean).join(" · ") || ".";
    }
    case "grep_files": {
      const query = str("query");
      const path = str("path");
      return query ? `"${query}"${path && path !== "." ? ` in ${path}` : ""}` : path;
    }
    case "set_goals": {
      const count = Array.isArray(args.goals) ? args.goals.length : 0;
      return `${count} goals`;
    }
    default: {
      try {
        const compact = JSON.stringify(args);
        return compact === "{}" ? "" : compact;
      } catch {
        return "";
      }
    }
  }
}

export function buildTurnDisplaySegments(
  messages: readonly ChatMessage[],
  locale: Locale,
): TurnDisplaySegment[] {
  const segments: TurnDisplaySegment[] = [];
  let pendingAssistant: {
    id: string;
    messageIds: string[];
    activities: ActivityTimelineItem[];
    toolOutputs: Record<string, string>;
    contentParts: string[];
    firstTs: number | null;
    lastTs: number | null;
  } | null = null;

  const parseTs = (iso?: string): number | null => {
    if (!iso) return null;
    const n = Date.parse(iso);
    return Number.isFinite(n) ? n : null;
  };

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    const elapsedMs =
      pendingAssistant.firstTs !== null &&
      pendingAssistant.lastTs !== null &&
      pendingAssistant.lastTs >= pendingAssistant.firstTs
        ? pendingAssistant.lastTs - pendingAssistant.firstTs
        : undefined;
    segments.push({
      kind: "assistant_turn",
      id: pendingAssistant.id,
      messageIds: pendingAssistant.messageIds,
      activities: pendingAssistant.activities,
      toolOutputs: pendingAssistant.toolOutputs,
      finalContent: pendingAssistant.contentParts.join("\n\n").trim(),
      elapsedMs,
    });
    pendingAssistant = null;
  };

  for (const msg of messages) {
    // Persisted raw tool observation rows are already represented inside their ToolCallRecord.
    if (msg.role === "tool" || msg.role === "system") continue;
    const loc = localizeMessage(msg, locale);

    if (msg.role === "user") {
      flushAssistant();
      segments.push({ kind: "user", message: msg, content: loc.content });
      continue;
    }

    if (msg.role === "steer") {
      flushAssistant();
      segments.push({ kind: "steer", message: msg, content: loc.content });
      continue;
    }

    // Group consecutive assistant steps into one unified turn activity feed + final response.
    const msgTs = parseTs(msg.createdAt);
    if (!pendingAssistant) {
      pendingAssistant = {
        id: msg.id,
        messageIds: [],
        activities: [],
        toolOutputs: {},
        contentParts: [],
        firstTs: msgTs,
        lastTs: msgTs,
      };
    }
    pendingAssistant.messageIds.push(msg.id);
    if (msgTs !== null) {
      pendingAssistant.firstTs =
        pendingAssistant.firstTs === null ? msgTs : Math.min(pendingAssistant.firstTs, msgTs);
      pendingAssistant.lastTs =
        pendingAssistant.lastTs === null ? msgTs : Math.max(pendingAssistant.lastTs, msgTs);
    }

    if (loc.reasoning && loc.reasoning.trim()) {
      pendingAssistant.activities.push({
        id: `${msg.id}-reason`,
        kind: "reasoning",
        text: loc.reasoning,
      });
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        pendingAssistant.activities.push({
          id: tc.id,
          kind: "tool",
          toolCall: tc,
        });
        const startTs = parseTs(tc.startedAt);
        const endTs = parseTs(tc.finishedAt);
        if (startTs !== null) {
          pendingAssistant.firstTs =
            pendingAssistant.firstTs === null ? startTs : Math.min(pendingAssistant.firstTs, startTs);
        }
        if (endTs !== null) {
          pendingAssistant.lastTs =
            pendingAssistant.lastTs === null ? endTs : Math.max(pendingAssistant.lastTs, endTs);
        }
      }
      Object.assign(pendingAssistant.toolOutputs, loc.toolOutputs);
    }

    if (loc.content && loc.content.trim()) {
      pendingAssistant.contentParts.push(loc.content.trim());
    }
  }

  flushAssistant();
  return segments;
}

function ToolKindIcon({ name }: { name: string }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]";
  switch (name) {
    case "shell":
    case "run_script":
    case "bash":
      return <Terminal className={cls} />;
    case "read_file":
      return <FileText className={cls} />;
    case "edit_file":
    case "write_file":
    case "delete_file":
      return <FilePenLine className={cls} />;
    case "grep_files":
    case "find_files":
      return <Search className={cls} />;
    case "list_files":
      return <FolderOpen className={cls} />;
    case "set_goals":
      return <ListChecks className={cls} />;
    default:
      return <Wrench className={cls} />;
  }
}

function formatPrettyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return String(args);
  }
}

function CompactToolRow({
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
  const [copiedField, setCopiedField] = useState<"args" | "output" | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const summary = useMemo(() => summarizeToolTarget(tc), [tc]);
  const prettyArgs = useMemo(() => formatPrettyArgs(tc.args), [tc.args]);
  const isCmd = isCommandTool(tc.name);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async (field: "args" | "output", value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopiedField(field);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedField(null), 1600);
    } catch {
      // Ignore clipboard failures in restricted environments
    }
  };

  const outputText = localizedOutput ?? tc.output;
  const durationLabel = tc.durationMs !== undefined ? formatToolDuration(tc.durationMs) : "";

  return (
    <div data-testid={`tool-row-${tc.name}`} className="hx-item-enter text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="group/row flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-[var(--hx-subtle)]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ToolKindIcon name={tc.name} />
          {!isCmd && (
            <span className="shrink-0 font-mono text-[11.5px] font-medium text-[var(--hx-text-2)] group-hover/row:text-[var(--hx-text)]">
              {tc.name}
            </span>
          )}
          <span
            className={cn(
              "truncate font-mono text-[11.5px]",
              isCmd ? "text-[var(--hx-text)]" : "text-[var(--hx-text-3)]",
            )}
          >
            {summary || tc.name}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[11px]">
          {(tc.status === "running" || tc.status === "pending") && (
            <Loader2 className="h-3 w-3 animate-spin text-[var(--hx-accent)]" />
          )}
          {tc.status === "awaiting_approval" && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300">
              {t("chat.toolAwaiting")}
            </span>
          )}
          {durationLabel && (
            <span className="hx-num font-mono text-[10px] text-[var(--hx-text-3)] opacity-80">
              {durationLabel}
            </span>
          )}
          {tc.exitCode !== undefined && (
            <span
              className={cn(
                "font-mono text-[11px]",
                tc.exitCode === 0
                  ? "text-[var(--hx-text-3)]"
                  : "font-medium text-rose-600 dark:text-rose-400",
              )}
            >
              {t("chat.exitCode", { code: tc.exitCode })}
            </span>
          )}
          {tc.exitCode === undefined && (tc.status === "failed" || tc.status === "denied") && (
            <span className="text-[11px] font-medium text-rose-600 dark:text-rose-400">
              {tc.status === "denied" ? t("chat.toolDenied") : t("chat.toolFailed")}
            </span>
          )}
          <ChevronRight
            data-open={expanded ? "true" : "false"}
            className="hx-chevron-right h-3.5 w-3.5 text-[var(--hx-text-3)]"
          />
        </div>
      </button>

      <div className="hx-collapse" data-open={expanded ? "true" : "false"}>
        <div className="hx-collapse-inner">
          <div className="mt-1 ml-5 space-y-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-2.5 font-mono text-[11px]">
            <div className="rounded-lg bg-[var(--hx-subtle)] p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium text-[var(--hx-text-3)]">
                  {t("chat.toolArgs")}
                </span>
                <button
                  type="button"
                  title={t("chat.copyToolArgs")}
                  aria-label={t("chat.copyToolArgs")}
                  onClick={() => void handleCopy("args", prettyArgs)}
                  className="hx-pressable inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--hx-text-3)] hover:bg-[var(--hx-surface)] hover:text-[var(--hx-text)]"
                >
                  {copiedField === "args" ? (
                    <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[var(--hx-text-2)]">
                {prettyArgs}
              </pre>
            </div>

            {outputText && (
              <div className="rounded-lg bg-[var(--hx-subtle)] p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium text-[var(--hx-text-3)]">
                    {t("chat.toolOutput")}
                  </span>
                  <button
                    type="button"
                    title={t("chat.copyToolOutput")}
                    aria-label={t("chat.copyToolOutput")}
                    onClick={() => void handleCopy("output", outputText)}
                    className="hx-pressable inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--hx-text-3)] hover:bg-[var(--hx-surface)] hover:text-[var(--hx-text)]"
                  >
                    {copiedField === "output" ? (
                      <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[var(--hx-text)]">
                  {outputText}
                  {tc.truncated && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">
                      {t("chat.truncated")}
                    </span>
                  )}
                </pre>
              </div>
            )}

            {tc.error && (
              <div className="whitespace-pre-wrap rounded-lg bg-rose-50 p-2 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                {tc.error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReasoningRow({
  text,
  defaultExpanded,
  liveScroll,
}: {
  text: string;
  defaultExpanded: boolean;
  liveScroll: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (liveScroll && expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, liveScroll, expanded]);

  return (
    <div data-testid="reasoning-row" className="hx-item-enter text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-[var(--hx-text-3)] transition-colors hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text-2)]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Brain className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium text-[12px]">{t("chat.reasoningLabel")}</span>
        </span>
        <ChevronRight
          data-open={expanded ? "true" : "false"}
          className="hx-chevron-right h-3.5 w-3.5 shrink-0"
        />
      </button>

      <div className="hx-collapse" data-open={expanded ? "true" : "false"}>
        <div className="hx-collapse-inner">
          <div
            ref={bodyRef}
            className="mt-1 ml-2 max-h-56 overflow-y-auto border-l border-[var(--hx-border)] pl-3.5 pr-2 text-[12px] leading-relaxed text-[var(--hx-text-3)]"
          >
            <MarkdownProse content={text} className="text-[12px] text-[var(--hx-text-3)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function TurnActivityFeed({
  activities,
  toolOutputs = {},
  isStreaming = false,
  startedAt,
  elapsedMs,
}: {
  activities: readonly ActivityTimelineItem[];
  toolOutputs?: Record<string, string>;
  isStreaming?: boolean;
  startedAt?: number;
  elapsedMs?: number;
}) {
  const { t } = useI18n();
  const [liveElapsedMs, setLiveElapsedMs] = useState<number>(() =>
    startedAt ? Math.max(0, Date.now() - startedAt) : 0,
  );
  const [expanded, setExpanded] = useState<boolean>(isStreaming);

  useEffect(() => {
    if (!isStreaming || !startedAt) return;
    setExpanded(true);
    setLiveElapsedMs(Math.max(0, Date.now() - startedAt));
    const timer = window.setInterval(() => {
      setLiveElapsedMs(Math.max(0, Date.now() - startedAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming, startedAt]);

  const { commandCount, toolCount, latestToolPreview, lastReasoningId } = useMemo(() => {
    let cmds = 0;
    let tools = 0;
    let preview = "";
    let lastReason: string | null = null;
    for (const item of activities) {
      if (item.kind === "reasoning") {
        lastReason = item.id;
      } else {
        if (isCommandTool(item.toolCall.name)) cmds += 1;
        else tools += 1;
        const target = summarizeToolTarget(item.toolCall);
        preview = `${item.toolCall.name}${target ? ` ${target}` : ""}`.trim();
      }
    }
    return {
      commandCount: cmds,
      toolCount: tools,
      latestToolPreview: preview,
      lastReasoningId: lastReason,
    };
  }, [activities]);

  if (activities.length === 0 && !isStreaming) return null;

  const shownElapsedMs = isStreaming ? liveElapsedMs : elapsedMs;
  const headerLabel = (() => {
    if (isStreaming) {
      if (commandCount > 0 && toolCount > 0) {
        return t("chat.activityRunningBoth", { commands: commandCount, tools: toolCount });
      }
      if (commandCount > 0) return t("chat.activityRunningCommands", { commands: commandCount });
      if (toolCount > 0) return t("chat.activityRunningTools", { tools: toolCount });
      return t("chat.reasoningLabel");
    }
    if (commandCount > 0 && toolCount > 0) {
      return t("chat.activityDoneBoth", { commands: commandCount, tools: toolCount });
    }
    if (commandCount > 0) return t("chat.activityDoneCommands", { commands: commandCount });
    if (toolCount > 0) return t("chat.activityDoneTools", { tools: toolCount });
    return t("chat.activityReasoningOnly");
  })();

  return (
    <div data-testid="turn-activity-feed" className="space-y-1.5 text-xs">
      {shownElapsedMs !== undefined && shownElapsedMs >= 1000 && (
        <div className="flex items-center gap-2 pb-1 text-[11px] text-[var(--hx-text-3)]">
          <span className="hx-num">{t("chat.workedFor", { time: formatDurationCompact(shownElapsedMs) })}</span>
          <span className="h-px flex-1 bg-[var(--hx-border)]/70" />
        </div>
      )}

      {activities.length > 0 && (
        <div>
          <button
            type="button"
            data-testid="turn-activity-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-left text-[12px] text-[var(--hx-text-2)] transition-colors hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Wrench className="h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]" />
              <span className="shrink-0 font-medium">{headerLabel}</span>
              {latestToolPreview && (
                <span className="truncate font-mono text-[11px] text-[var(--hx-text-3)]">
                  {latestToolPreview}
                </span>
              )}
            </div>
            <ChevronRight
              data-open={expanded ? "true" : "false"}
              className="hx-chevron-right h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]"
            />
          </button>

          <div className="hx-collapse" data-open={expanded ? "true" : "false"}>
            <div className="hx-collapse-inner">
              <div className="mt-1 ml-2.5 space-y-1 border-l border-[var(--hx-border)] pl-3">
                {activities.map((item) =>
                  item.kind === "reasoning" ? (
                    <ReasoningRow
                      key={item.id}
                      text={item.text}
                      defaultExpanded={isStreaming && item.id === lastReasoningId}
                      liveScroll={isStreaming && item.id === lastReasoningId}
                    />
                  ) : (
                    <CompactToolRow
                      key={item.id}
                      tc={item.toolCall}
                      localizedOutput={toolOutputs[item.toolCall.id]}
                    />
                  ),
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {isStreaming && (
        <div className="flex items-center gap-2 px-1.5 pt-1 text-[12px] text-[var(--hx-text-2)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--hx-accent)]" />
          <span className="hx-shimmer">{t("chat.processing")}</span>
        </div>
      )}
    </div>
  );
}
