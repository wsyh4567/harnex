import { useEffect, useMemo, useState } from "react";
import type { GenomeCommit, GenomeFile } from "@harnex/protocol";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  GitCompare,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";
import { MarkdownProse } from "../../components/ui/MarkdownProse.tsx";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import { localizeComponentTag, localizeDomainLabel } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, shortSha } from "../../lib/utils.ts";

export type OrganFilterCategory =
  | "prompt"
  | "skill"
  | "hook"
  | "memory"
  | "experience"
  | "config";

export interface ParsedExperienceEntry {
  domain: string;
  path: string;
  cue: string;
  lesson: string;
  evidence: string;
  confidence: string;
  raw: string;
}

export interface CommitDiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

export interface CommitFileDiff {
  path: string;
  changeType: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  lines: CommitDiffLine[];
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function classifyOrganFilter(file: GenomeFile): OrganFilterCategory {
  const norm = normalizePath(file.path);
  if (/EXPERIENCE\.md$/i.test(norm)) {
    return "experience";
  }
  if (
    norm === "systemprompt.md" ||
    norm === "guardrails.md" ||
    norm.startsWith("tool_descriptions/") ||
    file.component === "systemprompt" ||
    file.component === "guardrails" ||
    file.component === "tool_descriptions"
  ) {
    return "prompt";
  }
  if (norm.startsWith("skills/") || file.component === "skills") {
    return "skill";
  }
  if (norm.startsWith("hooks/") || file.component === "hooks") {
    return "hook";
  }
  if (norm.startsWith("memory/") || file.component === "memory") {
    return "memory";
  }
  return "config";
}

function extractDomainFromExperiencePath(filePath: string): string {
  const norm = normalizePath(filePath);
  const domainsMatch = /(?:^|\/)domains\/([^/]+)\//i.exec(norm);
  if (domainsMatch?.[1]) {
    return domainsMatch[1];
  }
  const parts = norm.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2]!;
    if (parent !== "meta" && parent !== "domains") {
      return parent;
    }
  }
  return "general";
}

function parseFieldLine(
  line: string,
): { field: "cue" | "lesson" | "evidence" | "confidence"; value: string } | null {
  const stripped = line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/\*\*|__/g, "");
  const match = /^(cue|lesson|evidence|confidence)\s*[:：]\s*(.+)$/i.exec(stripped);
  if (!match) return null;
  const field = match[1]!.toLowerCase() as "cue" | "lesson" | "evidence" | "confidence";
  const value = match[2]!.trim();
  return value ? { field, value } : null;
}

export function parseExperienceEntries(files: GenomeFile[]): ParsedExperienceEntry[] {
  const entries: ParsedExperienceEntry[] = [];

  for (const file of files) {
    if (!/EXPERIENCE\.md$/i.test(file.path)) continue;
    const rawContent = file.content.trim();
    if (!rawContent) continue;

    const domain = extractDomainFromExperiencePath(file.path);
    const normalizedLines = rawContent.replace(/\r\n/g, "\n").split("\n");

    // Split into logical blocks if multiple ## Entry headings exist
    const blocks: string[] = [];
    let currentBlock: string[] = [];
    for (const line of normalizedLines) {
      if (/^##\s+entry\b/i.test(line.trim()) && currentBlock.some((l) => l.trim().length > 0)) {
        blocks.push(currentBlock.join("\n"));
        currentBlock = [line];
      } else {
        currentBlock.push(line);
      }
    }
    if (currentBlock.some((l) => l.trim().length > 0)) {
      blocks.push(currentBlock.join("\n"));
    }

    for (const block of blocks) {
      const lines = block.split("\n");
      let cue = "";
      let lesson = "";
      let evidence = "";
      let confidence = "";
      const fallbackLines: string[] = [];

      for (const line of lines) {
        const parsed = parseFieldLine(line);
        if (parsed) {
          if (parsed.field === "cue" && !cue) cue = parsed.value;
          else if (parsed.field === "lesson" && !lesson) lesson = parsed.value;
          else if (parsed.field === "evidence" && !evidence) evidence = parsed.value;
          else if (parsed.field === "confidence" && !confidence) confidence = parsed.value;
          continue;
        }
        const clean = line.trim().replace(/^#+\s*/, "").replace(/^[-*+]\s+/, "");
        if (clean) fallbackLines.push(clean);
      }

      if (!cue && !lesson && !evidence) {
        const summary = fallbackLines.slice(0, 2).join(" — ");
        if (!summary) continue;
        lesson = summary;
      }

      entries.push({
        domain,
        path: file.path,
        cue,
        lesson,
        evidence,
        confidence,
        raw: block.trim(),
      });
    }
  }

  return entries;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.replace(/\r\n/g, "\n").split("\n");
}

function computeRawDiffOps(oldLines: string[], newLines: string[]): CommitDiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Guard against quadratic memory on unexpectedly large snapshots
  if (m * n > 300_000) {
    let prefix = 0;
    while (prefix < m && prefix < n && oldLines[prefix] === newLines[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < m - prefix &&
      suffix < n - prefix &&
      oldLines[m - 1 - suffix] === newLines[n - 1 - suffix]
    ) {
      suffix += 1;
    }
    const ops: CommitDiffLine[] = [];
    for (let i = 0; i < prefix; i += 1) ops.push({ kind: "ctx", text: oldLines[i]! });
    for (let i = prefix; i < m - suffix; i += 1) ops.push({ kind: "del", text: oldLines[i]! });
    for (let j = prefix; j < n - suffix; j += 1) ops.push({ kind: "add", text: newLines[j]! });
    for (let i = m - suffix; i < m; i += 1) ops.push({ kind: "ctx", text: oldLines[i]! });
    return ops;
  }

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        row[j] = nextRow[j + 1]! + 1;
      } else {
        const down = nextRow[j]!;
        const right = row[j + 1]!;
        row[j] = down >= right ? down : right;
      }
    }
  }

  const ops: CommitDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "ctx", text: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "del", text: oldLines[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", text: newLines[j]! });
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ kind: "del", text: oldLines[i]! });
    i += 1;
  }
  while (j < n) {
    ops.push({ kind: "add", text: newLines[j]! });
    j += 1;
  }
  return ops;
}

function boundContextLines(ops: CommitDiffLine[], contextRadius = 2): CommitDiffLine[] {
  const keep = new Uint8Array(ops.length);
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (ops[idx]!.kind !== "ctx") {
      const start = Math.max(0, idx - contextRadius);
      const end = Math.min(ops.length - 1, idx + contextRadius);
      for (let k = start; k <= end; k += 1) {
        keep[k] = 1;
      }
    }
  }
  return ops.filter((_, idx) => keep[idx] === 1);
}

function isBinaryContent(content: string): boolean {
  return content.includes("\u0000");
}

export function computeTreeFileDiffs(
  parentFiles: GenomeFile[],
  currentFiles: GenomeFile[],
): CommitFileDiff[] {
  const parentMap = new Map(parentFiles.map((f) => [f.path, f]));
  const currentMap = new Map(currentFiles.map((f) => [f.path, f]));
  const allPaths = Array.from(new Set([...parentMap.keys(), ...currentMap.keys()])).sort();

  const diffs: CommitFileDiff[] = [];

  for (const path of allPaths) {
    const prev = parentMap.get(path);
    const curr = currentMap.get(path);

    if (!prev && curr) {
      if (isBinaryContent(curr.content)) continue;
      const lines: CommitDiffLine[] = splitLines(curr.content).map((text) => ({
        kind: "add",
        text,
      }));
      diffs.push({
        path,
        changeType: "added",
        added: lines.length,
        removed: 0,
        lines,
      });
      continue;
    }

    if (prev && !curr) {
      if (isBinaryContent(prev.content)) continue;
      const lines: CommitDiffLine[] = splitLines(prev.content).map((text) => ({
        kind: "del",
        text,
      }));
      diffs.push({
        path,
        changeType: "deleted",
        added: 0,
        removed: lines.length,
        lines,
      });
      continue;
    }

    if (prev && curr) {
      if (prev.content === curr.content) continue;
      if (isBinaryContent(prev.content) || isBinaryContent(curr.content)) continue;

      const rawOps = computeRawDiffOps(splitLines(prev.content), splitLines(curr.content));
      const bounded = boundContextLines(rawOps, 2);
      const added = bounded.filter((l) => l.kind === "add").length;
      const removed = bounded.filter((l) => l.kind === "del").length;
      if (added === 0 && removed === 0) continue;

      diffs.push({
        path,
        changeType: "modified",
        added,
        removed,
        lines: bounded,
      });
    }
  }

  return diffs;
}

interface GenomeOrganExplorerProps {
  files: GenomeFile[];
  selectedCommit: GenomeCommit | null;
  parentCommit: GenomeCommit | null;
  readGenomeTree: (commitSha: string) => Promise<GenomeFile[]>;
}

type ExplorerTab = "organs" | "diff" | "experience";

const FILTER_ORDER: OrganFilterCategory[] = [
  "prompt",
  "skill",
  "hook",
  "memory",
  "experience",
  "config",
];

export function GenomeOrganExplorer({
  files,
  selectedCommit,
  parentCommit,
  readGenomeTree,
}: GenomeOrganExplorerProps) {
  const { locale, t } = useI18n();

  const [tab, setTab] = useState<ExplorerTab>("organs");
  const [filter, setFilter] = useState<"all" | OrganFilterCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [mdViewMode, setMdViewMode] = useState<"preview" | "raw">("preview");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const [parentCache, setParentCache] = useState<Record<string, GenomeFile[]>>({});
  const [loadingParentSha, setLoadingParentSha] = useState<string | null>(null);
  const [collapsedDiffs, setCollapsedDiffs] = useState<Record<string, boolean>>({});

  const experienceEntries = useMemo(() => parseExperienceEntries(files), [files]);

  const categoryCounts = useMemo(() => {
    const counts: Record<OrganFilterCategory, number> = {
      prompt: 0,
      skill: 0,
      hook: 0,
      memory: 0,
      experience: 0,
      config: 0,
    };
    for (const file of files) {
      counts[classifyOrganFilter(file)] += 1;
    }
    return counts;
  }, [files]);

  const activeFilter =
    filter !== "all" && categoryCounts[filter] === 0 ? "all" : filter;

  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return files.filter((file) => {
      if (activeFilter !== "all" && classifyOrganFilter(file) !== activeFilter) {
        return false;
      }
      if (!q) return true;
      return (
        file.path.toLowerCase().includes(q) ||
        file.component.toLowerCase().includes(q)
      );
    });
  }, [files, activeFilter, searchQuery]);

  const activeFile =
    filteredFiles.find((f) => f.path === selectedFilePath) ??
    filteredFiles[0] ??
    null;

  const parentSha = parentCommit?.sha ?? null;

  useEffect(() => {
    if (tab !== "diff" || !parentSha || parentCache[parentSha]) return;
    let cancelled = false;
    setLoadingParentSha(parentSha);
    void readGenomeTree(parentSha)
      .then((parentFiles) => {
        if (!cancelled) {
          setParentCache((prev) => ({ ...prev, [parentSha]: parentFiles }));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingParentSha((prev) => (prev === parentSha ? null : prev));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab, parentSha, parentCache, readGenomeTree]);

  const commitDiffs = useMemo(() => {
    if (!parentSha || !parentCache[parentSha]) return null;
    return computeTreeFileDiffs(parentCache[parentSha]!, files);
  }, [parentSha, parentCache, files]);

  const handleCopyFile = async (file: GenomeFile) => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopiedPath(file.path);
      setTimeout(() => {
        setCopiedPath((prev) => (prev === file.path ? null : prev));
      }, 1500);
    } catch {
      // Clipboard unavailable in headless environments
    }
  };

  const filterLabel = (cat: OrganFilterCategory): string => {
    const map: Record<OrganFilterCategory, string> = {
      prompt: t("genome.filterPrompt"),
      skill: t("genome.filterSkill"),
      hook: t("genome.filterHook"),
      memory: t("genome.filterMemory"),
      experience: t("genome.filterExperience"),
      config: t("genome.filterConfig"),
    };
    return map[cat];
  };

  const isMarkdown = activeFile ? /\.md$/i.test(activeFile.path) : false;
  const activeLineCount = activeFile ? splitLines(activeFile.content).length : 0;

  return (
    <div className="space-y-3">
      {/* Top Mode Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          items={[
            { id: "organs", label: t("genome.tabOrgans"), badge: files.length },
            { id: "diff", label: t("genome.tabDiff") },
            {
              id: "experience",
              label: t("genome.tabExperience", { count: experienceEntries.length }),
            },
          ]}
        />

        {selectedCommit && (
          <span className="hx-num font-mono text-[11px] text-[var(--hx-text-3)]">
            {selectedCommit.versionTag} · {shortSha(selectedCommit.sha)}
          </span>
        )}
      </div>

      {/* Tab 1: Genome Organs Master-Detail Explorer */}
      {tab === "organs" && (
        <div className="space-y-2.5">
          {/* Category Filter Pills & Quiet Search */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setFilter("all")}
                className={cn(
                  "hx-pressable hx-num inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  activeFilter === "all"
                    ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                    : "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text-2)] hover:text-[var(--hx-text)]",
                )}
              >
                <span>{t("genome.filterAll")}</span>
                <span className="font-mono text-[10px] opacity-75">{files.length}</span>
              </button>

              {FILTER_ORDER.filter((cat) => categoryCounts[cat] > 0).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setFilter(cat)}
                  className={cn(
                    "hx-pressable hx-num inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    activeFilter === cat
                      ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                      : "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text-2)] hover:text-[var(--hx-text)]",
                  )}
                >
                  <span>{filterLabel(cat)}</span>
                  <span className="font-mono text-[10px] opacity-75">
                    {categoryCounts[cat]}
                  </span>
                </button>
              ))}
            </div>

            {files.length > 6 && (
              <div className="relative w-full sm:w-52">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--hx-text-3)]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("genome.filterSearch")}
                  className="w-full rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] py-1 pl-8 pr-2.5 text-[11px] text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)] focus:border-[var(--hx-accent-border)] focus:outline-none"
                />
              </div>
            )}
          </div>

          {/* Master-Detail Split */}
          <div className="grid min-h-[300px] max-h-[420px] grid-cols-1 overflow-hidden rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] md:grid-cols-3">
            <div className="divide-y divide-[var(--hx-border)] overflow-y-auto border-b border-[var(--hx-border)] md:border-b-0 md:border-r">
              {filteredFiles.map((f) => {
                const isSelected = activeFile?.path === f.path;
                const lineCount = splitLines(f.content).length;
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setSelectedFilePath(f.path)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] transition-colors",
                      isSelected
                        ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                        : "text-[var(--hx-text-2)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-mono">
                      <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{f.path}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="text-[10px] text-[var(--hx-text-3)]">
                        {localizeComponentTag(f.component, locale)}
                      </span>
                      <span className="hx-num rounded bg-[var(--hx-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--hx-text-3)]">
                        {lineCount}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex min-h-0 flex-col overflow-hidden md:col-span-2">
              {activeFile ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hx-border)] bg-[var(--hx-subtle)]/50 px-3.5 py-2 text-[11px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <code className="truncate font-mono font-medium text-[var(--hx-text)]">
                        {activeFile.path}
                      </code>
                      <span className="hx-num shrink-0 font-mono text-[10px] text-[var(--hx-text-3)]">
                        {t("genome.linesBytes", {
                          lines: activeLineCount,
                          bytes: activeFile.sizeBytes,
                        })}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {isMarkdown && (
                        <div className="inline-flex rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] p-0.5 text-[10px]">
                          <button
                            type="button"
                            onClick={() => setMdViewMode("preview")}
                            className={cn(
                              "rounded-md px-2 py-0.5 font-medium transition-colors",
                              mdViewMode === "preview"
                                ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                                : "text-[var(--hx-text-2)] hover:text-[var(--hx-text)]",
                            )}
                          >
                            {t("genome.viewPreview")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setMdViewMode("raw")}
                            className={cn(
                              "rounded-md px-2 py-0.5 font-medium transition-colors",
                              mdViewMode === "raw"
                                ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                                : "text-[var(--hx-text-2)] hover:text-[var(--hx-text)]",
                            )}
                          >
                            {t("genome.viewRaw")}
                          </button>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => void handleCopyFile(activeFile)}
                        className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2 py-1 text-[10px] font-medium text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
                      >
                        {copiedPath === activeFile.path ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-500" />
                            <span>{t("genome.copiedFile")}</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            <span>{t("genome.copyFile")}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-3.5">
                    {isMarkdown && mdViewMode === "preview" ? (
                      <MarkdownProse content={activeFile.content} className="text-xs" />
                    ) : (
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--hx-text)]">
                        {activeFile.content}
                      </pre>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center p-4 text-xs text-[var(--hx-text-3)]">
                  {t("genome.selectFile")}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Commit Diff vs Parent Snapshot */}
      {tab === "diff" && (
        <div className="space-y-2.5">
          {!parentCommit || !selectedCommit ? (
            <div className="rounded-2xl border border-dashed border-[var(--hx-border)] bg-[var(--hx-surface)]/50 p-6 text-center text-xs text-[var(--hx-text-3)]">
              {t("genome.diffInitial")}
            </div>
          ) : loadingParentSha === parentCommit.sha && !commitDiffs ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-6 text-xs text-[var(--hx-text-2)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--hx-accent)]" />
              <span>{t("genome.diffLoading")}</span>
            </div>
          ) : !commitDiffs || commitDiffs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--hx-border)] bg-[var(--hx-surface)]/50 p-6 text-center text-xs text-[var(--hx-text-3)]">
              {t("genome.diffNoChanges")}
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-medium text-[var(--hx-text-2)]">
                <GitCompare className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
                <span>
                  {t("genome.diffComparing", {
                    parent: parentCommit.versionTag,
                    current: selectedCommit.versionTag,
                    count: commitDiffs.length,
                  })}
                </span>
              </div>

              {commitDiffs.map((diff) => {
                const collapsed = Boolean(collapsedDiffs[diff.path]);
                return (
                  <div
                    key={diff.path}
                    className="overflow-hidden rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedDiffs((prev) => ({ ...prev, [diff.path]: !collapsed }))
                      }
                      className="flex w-full items-center justify-between gap-2 bg-[var(--hx-subtle)]/60 px-3.5 py-2 text-left text-xs hover:bg-[var(--hx-subtle)]"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {collapsed ? (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]" />
                        )}
                        <span
                          className={cn(
                            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold",
                            diff.changeType === "added"
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : diff.changeType === "deleted"
                                ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                                : "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
                          )}
                        >
                          {diff.changeType === "added"
                            ? "+"
                            : diff.changeType === "deleted"
                              ? "-"
                              : "~"}
                        </span>
                        <code className="truncate font-mono text-[11px] text-[var(--hx-text)]">
                          {diff.path}
                        </code>
                      </span>

                      <span className="hx-num flex shrink-0 items-center gap-2 font-mono text-[11px]">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{diff.added}
                        </span>
                        <span className="text-rose-600 dark:text-rose-400">-{diff.removed}</span>
                      </span>
                    </button>

                    {!collapsed && (
                      <div className="max-h-72 overflow-y-auto border-t border-[var(--hx-border)] font-mono text-[11px] leading-relaxed">
                        {diff.lines.map((line, idx) => (
                          <div
                            key={idx}
                            className={cn(
                              "flex gap-2 px-3 py-0.5 whitespace-pre-wrap break-words",
                              line.kind === "add"
                                ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                                : line.kind === "del"
                                  ? "bg-rose-500/10 text-rose-800 dark:text-rose-200"
                                  : "text-[var(--hx-text-2)]",
                            )}
                          >
                            <span className="w-3 shrink-0 select-none opacity-70">
                              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                            </span>
                            <span className="min-w-0 flex-1">{line.text || " "}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Harness² Experience Library */}
      {tab === "experience" && (
        <div className="space-y-2.5">
          {experienceEntries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--hx-border)] bg-[var(--hx-surface)]/50 p-6 text-center text-xs text-[var(--hx-text-3)]">
              {t("genome.expEmpty")}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5">
              {experienceEntries.map((entry, idx) => (
                <article
                  key={`${entry.path}-${idx}`}
                  className="space-y-2 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <BookOpen className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span className="rounded-md bg-[var(--hx-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--hx-accent)]">
                        {localizeDomainLabel(entry.domain, locale)}
                      </span>
                      <code className="truncate font-mono text-[10px] text-[var(--hx-text-3)]">
                        {entry.path}
                      </code>
                    </div>

                    {entry.confidence && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                        <Sparkles className="h-3 w-3" />
                        <span>
                          {t("genome.expConfidence")}: {entry.confidence}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="space-y-1.5 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-3">
                    {entry.cue && (
                      <div>
                        <span className="font-semibold text-[var(--hx-accent)]">
                          {t("theater.cue")}{" "}
                        </span>
                        <span className="text-[var(--hx-text)]">{entry.cue}</span>
                      </div>
                    )}
                    {entry.lesson && (
                      <div>
                        <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                          {t("theater.lesson")}{" "}
                        </span>
                        <span className="text-[var(--hx-text)]">{entry.lesson}</span>
                      </div>
                    )}
                    {entry.evidence && (
                      <div>
                        <span className="font-semibold text-violet-700 dark:text-violet-300">
                          {t("theater.evidence")}{" "}
                        </span>
                        <span className="text-[var(--hx-text-2)]">{entry.evidence}</span>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
