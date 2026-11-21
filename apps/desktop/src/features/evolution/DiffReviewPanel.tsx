import { useState } from "react";
import {
  Check,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import { localizeProposal } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";

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

        <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--hx-text-3)]">
          <span>{t("diff.drafts", { count: drafts.length })}</span>
          <span>·</span>
          <span>{t("diff.applied", { count: proposal.inlineComments.length })}</span>
        </div>
      </div>

      {/* File Diffs */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {proposal.diffs.map((diff) => {
          const lines = diff.unifiedDiff.split("\n");
          const fileDrafts = drafts.filter((d) => d.filePath === diff.path);
          const fileApplied = proposal.inlineComments.filter((c) => c.filePath === diff.path);

          return (
            <div
              key={diff.path}
              className="overflow-hidden rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]"
            >
              <div className="flex items-center justify-between border-b border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3.5 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium text-[var(--hx-text)]">{diff.path}</span>
                  <span className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--hx-text-2)]">
                    {diff.changeType}
                  </span>
                </div>
                {diff.isHighPrivilege && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-50 px-2 py-0.5 text-[10px] text-rose-700 dark:bg-rose-500/15 dark:text-rose-200">
                    <ShieldAlert className="h-3 w-3" />
                    {t("diff.highPriv")}
                  </span>
                )}
              </div>

              <div className="divide-y divide-[var(--hx-border)]/40 font-mono text-[11px]">
                {lines.map((line, idx) => {
                  const lineNumber = idx + 1;
                  const isAdd = line.startsWith("+") && !line.startsWith("+++");
                  const isDel = line.startsWith("-") && !line.startsWith("---");
                  const isHunk = line.startsWith("@@");
                  const isSelected =
                    activeLine?.filePath === diff.path && activeLine.lineNumber === lineNumber;

                  const lineDrafts = fileDrafts.filter((d) => d.lineNumber === lineNumber);
                  const lineApplied = fileApplied.filter((c) => c.lineNumber === lineNumber);

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
                          className="flex w-12 shrink-0 items-center justify-end gap-1 border-r border-[var(--hx-border)] px-2 py-0.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-accent-soft)] hover:text-[var(--hx-accent)]"
                        >
                          <MessageSquarePlus className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100" />
                          <span>{lineNumber}</span>
                        </button>
                        <pre className="flex-1 overflow-x-auto whitespace-pre px-3 py-0.5">{line}</pre>
                      </div>

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
                          <span className="font-mono text-[10px] text-[var(--hx-accent)]">
                            L{lineNumber}:
                          </span>
                          <input
                            type="text"
                            autoFocus
                            value={commentText}
                            onChange={(e) => setCommentText(e.target.value)}
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
                    </div>
                  );
                })}
              </div>
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
