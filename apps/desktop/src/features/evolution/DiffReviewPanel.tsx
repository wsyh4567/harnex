import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import { localizeProposal } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";

interface SplitDiffSide {
  lineNumber: number;
  text: string;
  kind: "context" | "add" | "del" | "empty";
}

type SplitDiffRow =
  | { kind: "hunk"; lineNumber: number; text: string }
  | { kind: "pair"; left: SplitDiffSide; right: SplitDiffSide };

export function computeDiffStats(unifiedDiff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

export function buildSplitDiffRows(lines: string[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
      rows.push({ kind: "hunk", lineNumber, text: line });
      i += 1;
      continue;
    }

    if (
      (line.startsWith("-") && !line.startsWith("---")) ||
      (line.startsWith("+") && !line.startsWith("+++"))
    ) {
      const dels: Array<{ lineNumber: number; text: string }> = [];
      const adds: Array<{ lineNumber: number; text: string }> = [];
      while (i < lines.length && lines[i]!.startsWith("-") && !lines[i]!.startsWith("---")) {
        dels.push({ lineNumber: i + 1, text: lines[i]! });
        i += 1;
      }
      while (i < lines.length && lines[i]!.startsWith("+") && !lines[i]!.startsWith("+++")) {
        adds.push({ lineNumber: i + 1, text: lines[i]! });
        i += 1;
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let k = 0; k < maxLen; k += 1) {
        const d = dels[k];
        const a = adds[k];
        rows.push({
          kind: "pair",
          left: d
            ? { lineNumber: d.lineNumber, text: d.text, kind: "del" }
            : { lineNumber: a!.lineNumber, text: "", kind: "empty" },
          right: a
            ? { lineNumber: a.lineNumber, text: a.text, kind: "add" }
            : { lineNumber: d!.lineNumber, text: "", kind: "empty" },
        });
      }
      continue;
    }

    rows.push({
      kind: "pair",
      left: { lineNumber, text: line, kind: "context" },
      right: { lineNumber, text: line, kind: "context" },
    });
    i += 1;
  }

  return rows;
}

export function DiffReviewPanel({ embedded = false }: { embedded?: boolean }) {
  const {
    proposals,
    selectedProposalId,
    selectProposal,
    inlineCommentDrafts,
    addInlineCommentDraft,
    removeInlineCommentDraft,
    submitInlineRevision,
    adoptProposal,
    rejectProposal,
    evolutionRunning,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const proposal =
    proposals.find((p) => p.id === selectedProposalId) ??
    proposals.find((p) => p.status === "ready") ??
    proposals[0] ??
    null;

  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [activeLine, setActiveLine] = useState<{ filePath: string; lineNumber: number } | null>(
    null,
  );
  const [commentText, setCommentText] = useState("");

  if (!proposal) {
    return (
      <div className="p-8 text-center text-xs text-[var(--hx-text-3)]">{t("diff.none")}</div>
    );
  }

  const drafts = inlineCommentDrafts[proposal.id] ?? [];

  const handleSaveComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeLine || !commentText.trim()) return;
    addInlineCommentDraft(proposal.id, activeLine.filePath, activeLine.lineNumber, commentText);
    setCommentText("");
    setActiveLine(null);
  };

  const handleCopyPath = async (filePath: string) => {
    try {
      await navigator.clipboard?.writeText(filePath);
      setCopiedPath(filePath);
      window.setTimeout(() => setCopiedPath((prev) => (prev === filePath ? null : prev)), 1400);
    } catch {
      // Clipboard may be unavailable in headless environments
    }
  };

  const renderLineNotesAndForm = (
    filePath: string,
    lineNumber: number,
    fileDrafts: typeof drafts,
    fileApplied: typeof proposal.inlineComments,
  ) => {
    const isSelected = activeLine?.filePath === filePath && activeLine.lineNumber === lineNumber;
    const lineDrafts = fileDrafts.filter((d) => d.lineNumber === lineNumber);
    const lineApplied = fileApplied.filter((c) => c.lineNumber === lineNumber);

    if (lineApplied.length === 0 && lineDrafts.length === 0 && !isSelected) return null;

    return (
      <>
        {lineApplied.map((c) => (
          <div
            key={c.id}
            className="border-t border-emerald-500/25 bg-emerald-50/60 px-4 py-1.5 font-sans text-[11px] text-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-200"
          >
            <span className="font-semibold">
              {t("diff.appliedComment", { line: c.lineNumber })}
            </span>{" "}
            {c.comment}
          </div>
        ))}

        {lineDrafts.map((d) => (
          <div
            key={d.id}
            className="flex items-center justify-between border-t border-amber-500/25 bg-amber-50/75 px-4 py-1.5 font-sans text-[11px] text-amber-900 dark:bg-amber-950/20 dark:text-amber-200"
          >
            <span>
              <span className="font-semibold">
                {t("diff.draftComment", { line: d.lineNumber })}
              </span>{" "}
              {d.comment}
            </span>
            <button
              type="button"
              onClick={() => removeInlineCommentDraft(proposal.id, d.id)}
              className="text-amber-700 hover:text-rose-600 dark:text-amber-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        {isSelected && (
          <form
            onSubmit={handleSaveComment}
            className="flex items-center gap-2 border-t border-[var(--hx-accent-border)] bg-[var(--hx-subtle)] p-2.5 font-sans"
          >
            <span className="hx-num font-mono text-[10px] text-[var(--hx-accent)]">
              L{lineNumber}:
            </span>
            <input
              type="text"
              autoFocus
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setActiveLine(null);
                }
              }}
              placeholder={t("diff.commentPlaceholder")}
              className="flex-1 rounded-lg border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-2.5 py-1 text-xs text-[var(--hx-text)]"
            />
            <button
              type="submit"
              className="hx-pressable rounded-lg bg-cyan-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-cyan-500"
            >
              {t("diff.addNote")}
            </button>
            <button
              type="button"
              onClick={() => setActiveLine(null)}
              className="hx-pressable rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2 py-1 text-xs text-[var(--hx-text-2)]"
            >
              {t("common.cancel")}
            </button>
          </form>
        )}
      </>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hx-border)] bg-[var(--hx-surface)] px-4 py-2.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="text-[11px] font-semibold text-[var(--hx-text-2)]">{t("diff.header")}</div>
          {!embedded && (
            <ChoiceMenu
              ariaLabel={t("diff.header")}
              value={proposal.id}
              options={proposals.map((p) => {
                const loc = localizeProposal(p, locale);
                return {
                  value: p.id,
                  label: loc.title,
                  badge: loc.statusLabel,
                };
              })}
              onChange={(id) => selectProposal(id)}
              buttonClassName="w-full max-w-lg justify-between"
              menuClassName="w-96"
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="hx-num flex items-center gap-2 text-[11px] font-mono text-[var(--hx-text-3)]">
            <span>{t("diff.drafts", { count: drafts.length })}</span>
            <span>·</span>
            <span>{t("diff.applied", { count: proposal.inlineComments.length })}</span>
          </div>

          <SegmentedTabs
            value={viewMode}
            onChange={setViewMode}
            items={[
              { id: "unified", label: t("diff.modeUnified") },
              { id: "split", label: t("diff.modeSplit") },
            ]}
          />
        </div>
      </div>

      {/* File Diffs */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {proposal.diffs.map((diff) => {
          const lines = diff.unifiedDiff.split("\n");
          const stats = computeDiffStats(diff.unifiedDiff);
          const isCollapsed = Boolean(collapsedFiles[diff.path]);
          const fileDrafts = drafts.filter((d) => d.filePath === diff.path);
          const fileApplied = proposal.inlineComments.filter((c) => c.filePath === diff.path);
          const splitRows = viewMode === "split" ? buildSplitDiffRows(lines) : [];

          return (
            <div
              key={diff.path}
              className="overflow-hidden rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3.5 py-2 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    aria-label={isCollapsed ? t("diff.expandFile") : t("diff.collapseFile")}
                    onClick={() =>
                      setCollapsedFiles((prev) => ({ ...prev, [diff.path]: !isCollapsed }))
                    }
                    className="hx-pressable rounded-md p-0.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-surface)] hover:text-[var(--hx-text)]"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <span className="truncate font-mono font-medium text-[var(--hx-text)]">
                    {diff.path}
                  </span>
                  <span className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--hx-text-2)]">
                    {diff.changeType}
                  </span>
                  <span className="hx-num inline-flex items-center gap-1 rounded-md border border-[var(--hx-border)] bg-[var(--hx-surface)] px-1.5 py-0.5 font-mono text-[10px]">
                    <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
                    <span className="text-rose-600 dark:text-rose-400">-{stats.removed}</span>
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title={t("diff.copyPath")}
                    onClick={() => void handleCopyPath(diff.path)}
                    className="hx-pressable inline-flex items-center gap-1 rounded-md border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2 py-0.5 text-[10px] text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
                  >
                    {copiedPath === diff.path ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-500" />
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {t("diff.copiedPath")}
                        </span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>{t("diff.copyPath")}</span>
                      </>
                    )}
                  </button>
                  {diff.isHighPrivilege && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-50 px-2 py-0.5 text-[10px] text-rose-700 dark:bg-rose-500/15 dark:text-rose-200">
                      <ShieldAlert className="h-3 w-3" />
                      {t("diff.highPriv")}
                    </span>
                  )}
                </div>
              </div>

              {!isCollapsed && viewMode === "unified" && (
                <div className="divide-y divide-[var(--hx-border)]/40 font-mono text-[11px]">
                  {lines.map((line, idx) => {
                    const lineNumber = idx + 1;
                    const isAdd = line.startsWith("+") && !line.startsWith("+++");
                    const isDel = line.startsWith("-") && !line.startsWith("---");
                    const isHunk = line.startsWith("@@");

                    return (
                      <div key={`${diff.path}-${lineNumber}`}>
                        <div
                          className={cn(
                            "group flex items-stretch",
                            isAdd
                              ? "bg-emerald-50/80 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"
                              : isDel
                                ? "bg-rose-50/80 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200"
                                : isHunk
                                  ? "bg-cyan-50/70 text-cyan-800 dark:bg-cyan-950/25 dark:text-cyan-300"
                                  : "text-[var(--hx-text)]",
                          )}
                        >
                          <button
                            type="button"
                            title={`L${lineNumber}`}
                            onClick={() => setActiveLine({ filePath: diff.path, lineNumber })}
                            className="hx-num flex w-12 shrink-0 items-center justify-end gap-1 border-r border-[var(--hx-border)] px-2 py-0.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-accent-soft)] hover:text-[var(--hx-accent)]"
                          >
                            <MessageSquarePlus className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100" />
                            <span>{lineNumber}</span>
                          </button>
                          <pre className="flex-1 overflow-x-auto whitespace-pre px-3 py-0.5">{line}</pre>
                        </div>

                        {renderLineNotesAndForm(diff.path, lineNumber, fileDrafts, fileApplied)}
                      </div>
                    );
                  })}
                </div>
              )}

              {!isCollapsed && viewMode === "split" && (
                <div className="divide-y divide-[var(--hx-border)]/40 font-mono text-[11px]">
                  <div className="grid grid-cols-2 border-b border-[var(--hx-border)] bg-[var(--hx-subtle)]/50 font-sans text-[10px] font-semibold text-[var(--hx-text-3)]">
                    <div className="border-r border-[var(--hx-border)] px-3 py-1">
                      {t("diff.originalPane")}
                    </div>
                    <div className="px-3 py-1">{t("diff.modifiedPane")}</div>
                  </div>
                  {splitRows.map((row, rIdx) => {
                    if (row.kind === "hunk") {
                      return (
                        <div key={`${diff.path}-hunk-${rIdx}`}>
                          <div className="bg-cyan-50/70 px-3 py-0.5 text-cyan-800 dark:bg-cyan-950/25 dark:text-cyan-300">
                            {row.text}
                          </div>
                          {renderLineNotesAndForm(diff.path, row.lineNumber, fileDrafts, fileApplied)}
                        </div>
                      );
                    }

                    const primaryLine =
                      row.right.kind !== "empty" ? row.right.lineNumber : row.left.lineNumber;
                    const secondaryLine =
                      row.left.kind !== "empty" && row.left.lineNumber !== primaryLine
                        ? row.left.lineNumber
                        : null;

                    return (
                      <div key={`${diff.path}-split-${rIdx}`}>
                        <div className="grid grid-cols-2 divide-x divide-[var(--hx-border)]">
                          {/* Left (Before) */}
                          <div
                            className={cn(
                              "group flex min-w-0 items-stretch",
                              row.left.kind === "del"
                                ? "bg-rose-50/80 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200"
                                : row.left.kind === "empty"
                                  ? "bg-[var(--hx-subtle)]/40 text-transparent"
                                  : "text-[var(--hx-text)]",
                            )}
                          >
                            <button
                              type="button"
                              disabled={row.left.kind === "empty"}
                              title={row.left.kind === "empty" ? undefined : `L${row.left.lineNumber}`}
                              onClick={() =>
                                setActiveLine({
                                  filePath: diff.path,
                                  lineNumber: row.left.lineNumber,
                                })
                              }
                              className="hx-num flex w-11 shrink-0 items-center justify-end gap-1 border-r border-[var(--hx-border)] px-1.5 py-0.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-accent-soft)] hover:text-[var(--hx-accent)] disabled:opacity-30"
                            >
                              {row.left.kind !== "empty" && (
                                <>
                                  <MessageSquarePlus className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100" />
                                  <span>{row.left.lineNumber}</span>
                                </>
                              )}
                            </button>
                            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2.5 py-0.5">
                              {row.left.text}
                            </pre>
                          </div>

                          {/* Right (After) */}
                          <div
                            className={cn(
                              "group flex min-w-0 items-stretch",
                              row.right.kind === "add"
                                ? "bg-emerald-50/80 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"
                                : row.right.kind === "empty"
                                  ? "bg-[var(--hx-subtle)]/40 text-transparent"
                                  : "text-[var(--hx-text)]",
                            )}
                          >
                            <button
                              type="button"
                              disabled={row.right.kind === "empty"}
                              title={
                                row.right.kind === "empty" ? undefined : `L${row.right.lineNumber}`
                              }
                              onClick={() =>
                                setActiveLine({
                                  filePath: diff.path,
                                  lineNumber: row.right.lineNumber,
                                })
                              }
                              className="hx-num flex w-11 shrink-0 items-center justify-end gap-1 border-r border-[var(--hx-border)] px-1.5 py-0.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-accent-soft)] hover:text-[var(--hx-accent)] disabled:opacity-30"
                            >
                              {row.right.kind !== "empty" && (
                                <>
                                  <MessageSquarePlus className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100" />
                                  <span>{row.right.lineNumber}</span>
                                </>
                              )}
                            </button>
                            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2.5 py-0.5">
                              {row.right.text}
                            </pre>
                          </div>
                        </div>

                        {secondaryLine !== null &&
                          renderLineNotesAndForm(diff.path, secondaryLine, fileDrafts, fileApplied)}
                        {renderLineNotesAndForm(diff.path, primaryLine, fileDrafts, fileApplied)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hx-border)] bg-[var(--hx-surface)] px-4 py-3">
        <button
          type="button"
          disabled={drafts.length === 0 || evolutionRunning}
          onClick={() => void submitInlineRevision(proposal.id)}
          className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] px-3.5 py-1.5 text-xs font-semibold text-[var(--hx-accent)] disabled:opacity-40"
        >
          {evolutionRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span>{t("diff.reEvolve", { count: drafts.length })}</span>
        </button>

        {proposal.status === "ready" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void adoptProposal(proposal.id, true)}
              className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              <Check className="h-3.5 w-3.5" />
              <span>{t("evo.adoptTrust")}</span>
            </button>
            <button
              type="button"
              onClick={() => void rejectProposal(proposal.id)}
              className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3 py-1.5 text-xs text-[var(--hx-text-2)] hover:text-rose-600"
            >
              <X className="h-3.5 w-3.5" />
              <span>{t("evo.reject")}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
