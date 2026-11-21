import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Dna,
  Download,
  FileCode2,
  GitCommitHorizontal,
  Loader2,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import {
  localizeCommitMessage,
  localizeComponentTag,
  localizeDomainLabel,
} from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import {
  cn,
  formatDeltaPct,
  formatDurationMs,
  formatRelativeTime,
  formatUsd,
  shortSha,
} from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { GenerationAreaMiniChart } from "./CommandDeckCharts.tsx";
import { GenomeEvolutionTree } from "./GenomeEvolutionTree.tsx";

export function GenomeDeckPanel() {
  const {
    commits,
    selectedCommitSha,
    selectCommit,
    proposals,
    selectProposal,
    silentArchiveCount,
    genomeFiles,
    revertToCommit,
    replayComparison,
    replayRunning,
    runReplayCompare,
    exportScanResult,
    scanExport,
    confirmExport,
    clearExportScan,
    importPreview,
    previewImport,
    executeImport,
    clearImportPreview,
    providers,
    systemHealth,
    setActivePage,
    setRightTab,
    ipc,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();
  const isTauriLive = ipc.mode === "tauri";

  const [historyView, setHistoryView] = useState<"tree" | "list">("tree");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [confirmRevertSha, setConfirmRevertSha] = useState<string | null>(null);
  const [replayPrompt, setReplayPrompt] = useState(
    locale.startsWith("zh")
      ? "解析 12 份 GBK 编码月度账单 CSV 并导出标准 UTF-8 汇总表。"
      : "Parse 12 GBK-encoded monthly invoice CSVs and export clean UTF-8 summary.",
  );
  const [v0Sha, setV0Sha] = useState<string>(commits[commits.length - 1]?.sha ?? "");
  const [vNSha, setVNSha] = useState<string>(commits[0]?.sha ?? "");
  const [replayModelId, setReplayModelId] = useState<string>("gpt-4.1-mini");

  const [stripFindings, setStripFindings] = useState(true);
  const [importArchivePath, setImportArchivePath] = useState(
    "~/Downloads/community-csv-pack.harnex.zip",
  );
  const [trustedImportPaths, setTrustedImportPaths] = useState<string[]>([]);

  const activeFile =
    genomeFiles.find((f) => f.path === selectedFilePath) ?? genomeFiles[0] ?? null;

  const allModels = Array.from(new Set(providers.flatMap((p) => p.models)));
  const effectiveV0 = v0Sha || commits[commits.length - 1]?.sha || "";
  const effectiveVN = vNSha || commits[0]?.sha || "";

  // Chronological pass-rate trend (oldest -> newest)
  const trendCommits = [...commits].reverse();

  return (
    <div className="h-full overflow-y-auto p-5 space-y-5">
      {/* Header + Export / Import */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Dna className="h-4 w-4 text-[var(--hx-accent)]" />
          <div>
            <h2 className="text-sm font-semibold text-[var(--hx-text)]">{t("genome.title")}</h2>
            <p className="text-xs text-[var(--hx-text-2)]">
              {t("genome.subtitle")}{" "}
              <code className="font-mono text-[var(--hx-accent)]">
                {shortSha(systemHealth?.activeCommitSha ?? commits[0]?.sha ?? "")}
              </code>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void scanExport()}
            className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 text-xs font-medium text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
          >
            <Download className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
            <span>{t("genome.sanitizedExport")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setTrustedImportPaths([]);
              void previewImport(importArchivePath);
            }}
            className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-1.5 text-xs font-medium text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
          >
            <Upload className="h-3.5 w-3.5 text-amber-500" />
            <span>{t("genome.zeroTrustImport")}</span>
          </button>
        </div>
      </div>

      {/* Tree / Timeline View Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedTabs
          value={historyView}
          onChange={setHistoryView}
          items={[
            { id: "tree", label: t("deck.treeView") },
            { id: "list", label: t("deck.listView") },
          ]}
        />

        {trendCommits.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {trendCommits.map((c, idx) => (
              <div key={c.sha} className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void selectCommit(c.sha)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-[11px] transition-colors",
                    c.sha === selectedCommitSha
                      ? "bg-[var(--hx-accent-soft)] font-semibold text-[var(--hx-accent)]"
                      : "text-[var(--hx-text-2)] hover:bg-[var(--hx-subtle)]",
                  )}
                >
                  <span>{c.versionTag}</span>
                  {c.passRate !== undefined && (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {Math.round(c.passRate * 100)}%
                    </span>
                  )}
                </button>
                {idx < trendCommits.length - 1 && (
                  <span className="text-[var(--hx-text-3)]">→</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Interactive Branching Evolution Tree + Compact Trend Chart */}
      {historyView === "tree" ? (
        <div className="space-y-4">
          <GenomeEvolutionTree
            commits={commits}
            proposals={proposals}
            silentArchiveCount={silentArchiveCount}
            selectedCommitSha={selectedCommitSha}
            onSelectCommit={(sha) => void selectCommit(sha)}
            onSelectProposal={(proposalId) => {
              selectProposal(proposalId);
              setRightTab("triage");
              setActivePage("proposals");
            }}
          />
          <GenerationAreaMiniChart commits={commits} proposals={proposals} />
        </div>
      ) : (
        /* Evolution Timeline */
        <section className="space-y-2.5">
          <h3 className="text-xs font-semibold text-[var(--hx-text-2)]">
            {t("genome.timelineTitle", { count: commits.length })}
          </h3>
          <div className="space-y-2">
            {commits.map((c, idx) => {
              const isSelected = c.sha === selectedCommitSha;
              const isHead = idx === 0;
              const passPct = c.passRate !== undefined ? Math.round(c.passRate * 100) : null;
              const confirmingRevert = confirmRevertSha === c.sha;

              return (
                <div
                  key={c.sha}
                  onClick={() => void selectCommit(c.sha)}
                  className={cn(
                    "cursor-pointer rounded-2xl border bg-[var(--hx-surface)] p-3.5 text-xs transition-colors",
                    isSelected
                      ? "border-[var(--hx-accent-border)]"
                      : "border-[var(--hx-border)] hover:border-[var(--hx-border-strong)]",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <GitCommitHorizontal className="h-4 w-4 shrink-0 text-[var(--hx-accent)]" />
                      <span className="rounded-md bg-[var(--hx-accent-soft)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--hx-accent)]">
                        {c.versionTag}
                      </span>
                      <code className="font-mono text-[11px] text-[var(--hx-text-3)]">
                        {shortSha(c.sha)}
                      </code>
                      {isHead && (
                        <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                          {t("genome.activeBadge")}
                        </span>
                      )}
                      {c.isRollback && (
                        <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                          {t("genome.rollbackBadge")}
                        </span>
                      )}
                      <span className="rounded-md bg-[var(--hx-subtle)] px-2 py-0.5 text-[10px] text-[var(--hx-text-2)]">
                        {localizeDomainLabel(c.domain ?? "general", locale)}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {passPct !== null && (
                        <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                          {t("genome.passRateBadge", { pct: passPct })}
                        </span>
                      )}
                      {!isHead && !confirmingRevert && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmRevertSha(c.sha);
                          }}
                          className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2.5 py-1 text-[11px] text-[var(--hx-text)] hover:border-amber-500/40"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>{t("genome.revert")}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="mt-1.5 text-xs font-medium text-[var(--hx-text)]">
                    {localizeCommitMessage(c, locale)}
                  </p>

                  {confirmingRevert && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-50/75 px-3 py-2 text-xs dark:bg-amber-950/20"
                    >
                      <span className="text-amber-900 dark:text-amber-200">
                        {t("genome.revertConfirm", { tag: c.versionTag })}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmRevertSha(null);
                            void revertToCommit(c.sha, `Operator revert to ${c.versionTag}`);
                          }}
                          className="hx-pressable rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-500"
                        >
                          {t("common.confirm")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRevertSha(null)}
                          className="hx-pressable rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1 text-[11px] text-[var(--hx-text-2)]"
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--hx-text-3)]">
                    <div className="flex flex-wrap gap-1">
                      {c.changedComponents.map((comp) => (
                        <span
                          key={comp}
                          className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[var(--hx-text-2)]"
                        >
                          {localizeComponentTag(comp, locale)}
                        </span>
                      ))}
                    </div>
                    <span>{formatRelativeTime(c.timestamp, locale)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Component & EXPERIENCE.md Browser */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--hx-text-2)]">
          {t("genome.organsTitle", {
            count: genomeFiles.length,
            sha: shortSha(selectedCommitSha ?? ""),
          })}
        </h3>
        <div className="grid grid-cols-1 overflow-hidden rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] md:grid-cols-3">
          <div className="max-h-60 divide-y divide-[var(--hx-border)] overflow-y-auto border-b border-[var(--hx-border)] md:border-b-0 md:border-r">
            {genomeFiles.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelectedFilePath(f.path)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] transition-colors",
                  activeFile?.path === f.path
                    ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                    : "text-[var(--hx-text-2)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5 font-mono">
                  <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{f.path}</span>
                </span>
                <span className="shrink-0 text-[10px] text-[var(--hx-text-3)]">
                  {localizeComponentTag(f.component, locale)}
                </span>
              </button>
            ))}
          </div>
          <div className="max-h-60 overflow-y-auto p-3.5 md:col-span-2">
            {activeFile ? (
              <>
                <div className="mb-2 flex items-center justify-between font-mono text-[10px] text-[var(--hx-text-3)]">
                  <span>{activeFile.path}</span>
                  <span>{activeFile.sizeBytes} bytes</span>
                </div>
                <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--hx-text)]">
                  {activeFile.content}
                </pre>
              </>
            ) : (
              <div className="text-xs text-[var(--hx-text-3)]">{t("genome.selectFile")}</div>
            )}
          </div>
        </div>
      </section>

      {/* Replay & Compare (v0 vs vN) */}
      <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-[var(--hx-text)]">{t("genome.replayTitle")}</h3>
          <span className="text-[11px] text-[var(--hx-text-3)]">{t("genome.replaySub")}</span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
          <ChoiceMenu
            ariaLabel="Baseline version"
            value={effectiveV0}
            options={commits.map((c) => ({
              value: c.sha,
              label: `${c.versionTag} (${shortSha(c.sha)})`,
              description: localizeCommitMessage(c, locale),
            }))}
            onChange={setV0Sha}
            buttonClassName="w-full font-mono"
            menuClassName="w-64"
          />
          <ChoiceMenu
            ariaLabel="Target version"
            value={effectiveVN}
            options={commits.map((c) => ({
              value: c.sha,
              label: `${c.versionTag} (${shortSha(c.sha)})`,
              description: localizeCommitMessage(c, locale),
            }))}
            onChange={setVNSha}
            buttonClassName="w-full font-mono"
            menuClassName="w-64"
          />
          <ChoiceMenu
            ariaLabel="Replay model"
            value={replayModelId}
            options={(allModels.length > 0 ? allModels : ["gpt-4.1-mini"]).map((m) => ({
              value: m,
              label: m,
            }))}
            onChange={setReplayModelId}
            buttonClassName="w-full font-mono"
            menuClassName="w-64"
          />
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={replayPrompt}
            onChange={(e) => setReplayPrompt(e.target.value)}
            className="flex-1 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 text-xs text-[var(--hx-text)]"
          />
          <button
            type="button"
            disabled={replayRunning || !effectiveV0 || !effectiveVN}
            onClick={() =>
              void runReplayCompare({
                taskPrompt: replayPrompt,
                v0Sha: effectiveV0,
                vNSha: effectiveVN,
                modelId: replayModelId,
              })
            }
            className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-3.5 py-1.5 text-xs font-semibold text-[var(--hx-canvas)] hover:opacity-90 disabled:opacity-40"
          >
            {replayRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            <span>{t("genome.compare")}</span>
          </button>
        </div>

        {replayComparison && (
          <div className="grid grid-cols-1 gap-3 pt-1 text-xs sm:grid-cols-2">
            <div className="space-y-1 rounded-xl border border-rose-500/30 bg-rose-50/70 p-3 dark:bg-rose-950/15">
              <div className="font-mono text-[11px] font-semibold text-rose-800 dark:text-rose-300">
                {shortSha(replayComparison.v0Sha)}
              </div>
              <div className="font-mono text-[11px] text-[var(--hx-text)]">
                {replayComparison.v0Metrics.steps} {t("evo.steps")} ·{" "}
                {replayComparison.v0Metrics.errors} {t("evo.errors")} ·{" "}
                {formatDurationMs(replayComparison.v0Metrics.durationMs, locale)} ·{" "}
                {formatUsd(replayComparison.v0Metrics.costUsd)}
              </div>
              <p className="text-[11px] text-[var(--hx-text-2)]">{replayComparison.v0Output}</p>
            </div>

            <div className="space-y-1 rounded-xl border border-emerald-500/30 bg-emerald-50/70 p-3 dark:bg-emerald-950/15">
              <div className="font-mono text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">
                {shortSha(replayComparison.vNSha)} ·{" "}
                {formatDeltaPct(
                  replayComparison.v0Metrics.costUsd,
                  replayComparison.vNMetrics.costUsd,
                )}
              </div>
              <div className="font-mono text-[11px] text-[var(--hx-text)]">
                {replayComparison.vNMetrics.steps} {t("evo.steps")} ·{" "}
                {replayComparison.vNMetrics.errors} {t("evo.errors")} ·{" "}
                {formatDurationMs(replayComparison.vNMetrics.durationMs, locale)} ·{" "}
                {formatUsd(replayComparison.vNMetrics.costUsd)}
              </div>
              <p className="text-[11px] text-[var(--hx-text-2)]">{replayComparison.vNOutput}</p>
            </div>
          </div>
        )}
      </section>

      {/* Secret/PII Scan Export Preview Modal */}
      {exportScanResult && (
        <div
          role="dialog"
          aria-label={t("genome.exportTitle")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
        >
          <div className="hx-modal w-full max-w-xl space-y-3.5 rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                <h3 className="text-sm font-semibold text-[var(--hx-text)]">
                  {t("genome.exportTitle")}
                </h3>
              </div>
              <button
                type="button"
                onClick={clearExportScan}
                className="hx-pressable rounded-lg p-1 text-[var(--hx-text-3)] hover:text-[var(--hx-text)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3 text-xs">
              <div className="text-[var(--hx-text)]">
                {t("genome.included", { count: exportScanResult.includedFiles.length })}{" "}
                <span className="font-mono text-[11px] text-[var(--hx-text-2)]">
                  {exportScanResult.includedFiles.join(", ")}
                </span>
              </div>
              <div className="text-emerald-700 dark:text-emerald-300">
                {t("genome.excluded", { count: exportScanResult.excludedFiles.length })}{" "}
                <span className="font-mono text-[11px]">
                  {exportScanResult.excludedFiles.join(", ")}
                </span>
              </div>
            </div>

            {exportScanResult.findings.length > 0 && (
              <div className="space-y-2 rounded-xl border border-rose-500/35 bg-rose-50/80 p-3 text-xs dark:bg-rose-950/20">
                <div className="flex items-center gap-1.5 font-semibold text-rose-800 dark:text-rose-200">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>
                    {t("genome.findingsDetected", { count: exportScanResult.findings.length })}
                  </span>
                </div>
                {exportScanResult.findings.map((f, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border border-rose-500/25 bg-[var(--hx-surface)] p-2 font-mono text-[11px] text-rose-800 dark:text-rose-200"
                  >
                    {f.file}:{f.line} [{f.rule}] → {f.maskedSnippet}
                  </div>
                ))}
                <label className="flex cursor-pointer items-center gap-2 pt-1 text-[var(--hx-text)]">
                  <input
                    type="checkbox"
                    checked={stripFindings}
                    onChange={(e) => setStripFindings(e.target.checked)}
                  />
                  <span>{t("genome.redactOption")}</span>
                </label>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={clearExportScan}
                className="hx-pressable rounded-xl border border-[var(--hx-border-strong)] px-3 py-1.5 text-xs text-[var(--hx-text-2)]"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmExport(stripFindings)}
                className="hx-pressable rounded-xl bg-[var(--hx-text)] px-3.5 py-1.5 text-xs font-semibold text-[var(--hx-canvas)]"
              >
                {t("genome.confirmExport")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Zero-Trust Import Modal */}
      {importPreview && (
        <div
          role="dialog"
          aria-label={t("genome.importTitle")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
        >
          <div className="hx-modal w-full max-w-xl space-y-3.5 rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-amber-500" />
                <h3 className="text-sm font-semibold text-[var(--hx-text)]">
                  {t("genome.importTitle")}
                </h3>
              </div>
              <button
                type="button"
                onClick={clearImportPreview}
                className="hx-pressable rounded-lg p-1 text-[var(--hx-text-3)] hover:text-[var(--hx-text)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={importArchivePath}
                onChange={(e) => setImportArchivePath(e.target.value)}
                className="flex-1 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 font-mono text-xs text-[var(--hx-text)]"
              />
              <button
                type="button"
                onClick={() => void previewImport(importArchivePath)}
                className="hx-pressable rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 text-xs text-[var(--hx-text)]"
              >
                {t("genome.rescan")}
              </button>
            </div>

            <div className="space-y-2 rounded-xl border border-amber-500/35 bg-amber-50/75 p-3 text-xs dark:bg-amber-950/20">
              <div className="font-semibold text-amber-900 dark:text-amber-200">
                {t("genome.importWarning")}
              </div>
              <p className="text-[11px] text-[var(--hx-text-2)]">
                {isTauriLive ? t("genome.importTauriPolicy") : t("genome.importMockPolicy")}
              </p>
              <div className="space-y-1.5">
                {importPreview.untrustedExecutables.map((exe) => {
                  const checked = !isTauriLive && trustedImportPaths.includes(exe);
                  return (
                    <label
                      key={exe}
                      className="flex cursor-pointer items-center justify-between rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 font-mono text-[11px]"
                    >
                      <span className="flex items-center gap-2 text-[var(--hx-text)]">
                        <input
                          type="checkbox"
                          disabled={isTauriLive}
                          checked={checked}
                          onChange={(e) =>
                            setTrustedImportPaths((prev) =>
                              e.target.checked ? [...prev, exe] : prev.filter((p) => p !== exe),
                            )
                          }
                        />
                        {exe}
                      </span>
                      <span
                        className={
                          checked
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-amber-700 dark:text-amber-300"
                        }
                      >
                        {checked ? t("genome.willTrust") : t("genome.disabledDefault")}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="text-[11px] text-[var(--hx-text-2)]">
              <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              {t("genome.safeAssetsNote", {
                count: importPreview.files.length - importPreview.untrustedExecutables.length,
              })}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={clearImportPreview}
                className="hx-pressable rounded-xl border border-[var(--hx-border-strong)] px-3 py-1.5 text-xs text-[var(--hx-text-2)]"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void executeImport(importArchivePath, trustedImportPaths)}
                className="hx-pressable rounded-xl bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-400 dark:text-zinc-950"
              >
                {t("genome.importBtn", { count: trustedImportPaths.length })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
