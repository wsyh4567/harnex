import { beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildPaletteItems,
  filterPaletteItems,
} from "../components/CommandPaletteModal.tsx";
import {
  isSafeHttpUrl,
  MarkdownProse,
  parseMarkdownBlocks,
} from "../components/ui/MarkdownProse.tsx";
import {
  buildSplitDiffRows,
  computeDiffStats,
} from "../features/evolution/DiffReviewPanel.tsx";
import { buildTrajectorySpans } from "../features/chat/TrajectoryMiniTimeline.tsx";
import {
  classifyOrganFilter,
  computeTreeFileDiffs,
  parseExperienceEntries,
} from "../features/harness/GenomeOrganExplorer.tsx";
import { enUSMessages, zhCNMessages } from "../i18n/index.ts";
import { MockIpcAdapter } from "../ipc/index.ts";
import { createInitialGenomeTree, INITIAL_COMMIT_SHAS } from "../ipc/mockData.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("UI Craft: MarkdownProse, CommandPaletteModal, Diff Craft & Pure i18n", () => {
  beforeEach(async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);
  });

  it("renders headings, fenced code blocks, lists, blockquotes, and GFM tables safely without XSS links", () => {
    const sample = [
      "# Title One",
      "## Section Two",
      "### Subsection Three",
      "",
      "Here is **bold**, *italic*, ~~old~~, `inlineCode()`, a [safe](https://harnex.dev/docs), and an [evil](javascript:alert(1)).",
      "",
      "> Quoted note with **emphasis**",
      "",
      "- Bullet A",
      "- Bullet B",
      "",
      "1. Step 1",
      "2. Step 2",
      "",
      "```ts",
      "const ok = true;",
      "```",
      "",
      "| Metric | Before | After |",
      "| :--- | :---: | ---: |",
      "| Steps | 7 | 2 |",
      "| Errors | 3 | 0 |",
    ].join("\n");

    const blocks = parseMarkdownBlocks(sample);
    expect(blocks.some((b) => b.type === "heading" && b.level === 1)).toBe(true);
    expect(blocks.some((b) => b.type === "heading" && b.level === 2)).toBe(true);
    expect(blocks.some((b) => b.type === "heading" && b.level === 3)).toBe(true);
    expect(blocks.some((b) => b.type === "code" && b.lang === "ts")).toBe(true);
    expect(blocks.some((b) => b.type === "table" && b.rows.length === 2)).toBe(true);

    expect(isSafeHttpUrl("https://harnex.dev")).toBe(true);
    expect(isSafeHttpUrl("http://localhost:1420")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);

    const html = renderToStaticMarkup(<MarkdownProse content={sample} />);
    expect(html).toContain("<h1>Title One</h1>");
    expect(html).toContain("<h2>Section Two</h2>");
    expect(html).toContain("<h3>Subsection Three</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del");
    expect(html).toContain("inlineCode()");
    expect(html).toContain('<a href="https://harnex.dev/docs"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("evil.");
    expect(html).not.toContain("evil)");
    expect(html).toContain("<pre");
    expect(html).toContain("const ok = true;");
    expect(html).toContain("<table>");
    expect(html).toContain(">Metric</th>");
    expect(html).toContain("Steps");
  });

  it("handles unclosed streaming code fences cleanly", () => {
    const streamingSample = "Analyzing file...\n```python\nprint('hello')";
    const blocks = parseMarkdownBlocks(streamingSample);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: "code",
      lang: "python",
      code: "print('hello')",
    });
  });

  it("indexes pages, threads, ready proposals, and high-value actions and supports fuzzy filtering", () => {
    const { threads, proposals } = useCommandDeckStore.getState();

    const enItems = buildPaletteItems({ locale: "en-US", threads, proposals });
    const pages = enItems.filter((i) => i.category === "pages");
    expect(pages).toHaveLength(8);
    expect(enItems.some((i) => i.category === "threads")).toBe(true);
    expect(enItems.some((i) => i.category === "proposals")).toBe(true);
    expect(enItems.filter((i) => i.category === "actions")).toHaveLength(7);

    // Exact / substring filtering
    const pricingMatches = filterPaletteItems(enItems, "pricing");
    expect(pricingMatches[0]?.id).toBe("action-sync-pricing");

    // Fuzzy subsequence matching (e.g. "evlb" -> "Evolution Lab")
    const fuzzyLab = filterPaletteItems(enItems, "evlb");
    expect(fuzzyLab.some((i) => i.id === "page-lab")).toBe(true);

    // Proposal search
    const propMatches = filterPaletteItems(enItems, "GB18030");
    expect(propMatches.some((i) => i.id === "proposal-prop-8")).toBe(true);

    // Pure Chinese indexing & search
    const zhItems = buildPaletteItems({ locale: "zh-CN", threads, proposals });
    const zhTheme = filterPaletteItems(zhItems, "主题");
    expect(zhTheme.some((i) => i.id === "action-toggle-theme")).toBe(true);
    const zhThread = filterPaletteItems(zhItems, "账单");
    expect(zhThread.some((i) => i.id === "thread-thr-billing-csv")).toBe(true);
  });

  it("computes accurate diff +/- stats and builds aligned split diff rows", () => {
    const unified = [
      "@@ -1,3 +1,4 @@",
      " # Header",
      "-old line",
      "+new line A",
      "+new line B",
      " footer",
    ].join("\n");

    expect(computeDiffStats(unified)).toEqual({ added: 2, removed: 1 });

    const splitRows = buildSplitDiffRows(unified.split("\n"));
    expect(splitRows[0]?.kind).toBe("hunk");
    expect(splitRows[1]?.kind).toBe("pair");
    if (splitRows[2]?.kind === "pair" && splitRows[3]?.kind === "pair") {
      expect(splitRows[2].left.kind).toBe("del");
      expect(splitRows[2].right.kind).toBe("add");
      expect(splitRows[3].left.kind).toBe("empty");
      expect(splitRows[3].right.kind).toBe("add");
    }
  });

  it("enforces 100% pure bilingual separation (no Chinese characters in en-US)", () => {
    const enKeys = Object.keys(enUSMessages).sort();
    const zhKeys = Object.keys(zhCNMessages).sort();
    expect(zhKeys).toEqual(enKeys);

    const cjkRe = /[\u4e00-\u9fff]/;
    for (const key of enKeys) {
      const val = enUSMessages[key as keyof typeof enUSMessages];
      expect(cjkRe.test(val)).toBe(false);
    }
  });

  it("classifies genome organs, parses EXPERIENCE.md entries, and diffs parent->child commits accurately", () => {
    const trees = createInitialGenomeTree();
    const v6 = trees[INITIAL_COMMIT_SHAS.v6]!;
    const v7 = trees[INITIAL_COMMIT_SHAS.v7]!;

    const byPath = (path: string) => v7.find((f) => f.path === path)!;
    expect(classifyOrganFilter(byPath("systemprompt.md"))).toBe("prompt");
    expect(classifyOrganFilter(byPath("skills/csv_audit/SKILL.md"))).toBe("skill");
    expect(classifyOrganFilter(byPath("hooks/example_trim_output.ts"))).toBe("hook");
    expect(classifyOrganFilter(byPath("memory/LongTermMEMORY.md"))).toBe("memory");
    expect(classifyOrganFilter(byPath("meta/domains/file_ops/EXPERIENCE.md"))).toBe("experience");
    expect(classifyOrganFilter(byPath("mcp/servers.json"))).toBe("config");

    const experiences = parseExperienceEntries(v7);
    expect(experiences).toHaveLength(2);
    expect(experiences.map((e) => e.domain).sort()).toEqual(["diagnostics", "file_ops"]);
    const fileOpsExp = experiences.find((e) => e.domain === "file_ops")!;
    expect(fileOpsExp.cue).toContain("Multi-file");
    expect(fileOpsExp.lesson).toContain("Scan filenames");
    expect(fileOpsExp.evidence).toContain("45%");
    expect(fileOpsExp.confidence).toContain("high");

    const diffs = computeTreeFileDiffs(v6, v7);
    const diffPaths = diffs.map((d) => d.path).sort();
    expect(diffPaths).toEqual([
      "manifest.json",
      "meta/domains/file_ops/EXPERIENCE.md",
      "meta/regression_cases.jsonl",
      "tool_descriptions/shell.md",
    ]);
    const shellDiff = diffs.find((d) => d.path === "tool_descriptions/shell.md")!;
    expect(shellDiff.changeType).toBe("modified");
    expect(shellDiff.added).toBe(1);
    expect(shellDiff.removed).toBe(0);
    const expDiff = diffs.find((d) => d.path === "meta/domains/file_ops/EXPERIENCE.md")!;
    expect(expDiff.changeType).toBe("added");
    expect(expDiff.added).toBeGreaterThan(0);
  });

  it("projects thread messages into a 3-lane trajectory timeline with error tracking", () => {
    const { messagesByThread } = useCommandDeckStore.getState();
    const billingMsgs = messagesByThread["thr-billing-csv"] ?? [];
    const proj = buildTrajectorySpans(billingMsgs);

    expect(proj.turnCount).toBeGreaterThanOrEqual(1);
    expect(proj.toolCount).toBeGreaterThanOrEqual(2);
    expect(proj.spans.some((s) => s.lane === 0 && s.kind === "reasoning")).toBe(true);
    expect(proj.spans.some((s) => s.lane === 1 && s.kind === "message")).toBe(true);
    expect(proj.spans.some((s) => s.lane === 2 && s.kind === "tool")).toBe(true);

    // Failed/denied tool calls must increment errorCount
    const withError = buildTrajectorySpans([
      ...billingMsgs,
      {
        id: "msg-err",
        threadId: "thr-billing-csv",
        role: "assistant",
        content: "Command failed",
        toolCalls: [
          {
            id: "tc-err",
            name: "shell.exec",
            args: { command: "false" },
            status: "failed",
            error: "exit 1",
            truncated: false,
            startedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(withError.errorCount).toBe(1);
    expect(withError.spans.some((s) => s.id === "msg-err:tool:tc-err" && s.isError)).toBe(true);
  });

  it("persists per-thread composer drafts, clears on delete, and wires Gardener report + pruning handoff", async () => {
    const store = useCommandDeckStore.getState();

    // Persistent drafts across threads & home
    store.setComposerDraft("home", "Draft on home");
    store.setComposerDraft("thr-billing-csv", "Check GB18030 BOM");
    expect(useCommandDeckStore.getState().composerDrafts["home"]).toBe("Draft on home");
    expect(useCommandDeckStore.getState().composerDrafts["thr-billing-csv"]).toBe(
      "Check GB18030 BOM",
    );

    store.clearComposerDraft("home");
    expect(useCommandDeckStore.getState().composerDrafts["home"]).toBeUndefined();

    // Deleting a thread cleans its draft cleanly
    await useCommandDeckStore.getState().deleteThread("thr-billing-csv");
    expect(useCommandDeckStore.getState().composerDrafts["thr-billing-csv"]).toBeUndefined();

    // Gardener entropy report is loaded on initialize and detects untriggered mock skill honestly
    const report = useCommandDeckStore.getState().gardenerReport;
    expect(report).not.toBeNull();
    expect(report!.healthScore).toBeGreaterThanOrEqual(0);
    expect(report!.healthScore).toBeLessThanOrEqual(100);
    expect(report!.alwaysOnEstimatedTokens).toBeGreaterThan(0);
    expect(report!.modelDiversityOk).toBe(true);
    expect(report!.findings.some((f) => f.kind === "untriggered_skill")).toBe(true);
    expect(report!.suggestedPruningGoal).toBeTruthy();

    // One-click Pruning Evolution handoff sets pendingLabGoal and navigates to Lab
    useCommandDeckStore.getState().launchPruningEvolution(report!.suggestedPruningGoal!);
    expect(useCommandDeckStore.getState().activePage).toBe("lab");
    expect(useCommandDeckStore.getState().pendingLabGoal).toBe(report!.suggestedPruningGoal!);
    useCommandDeckStore.getState().consumePendingLabGoal();
    expect(useCommandDeckStore.getState().pendingLabGoal).toBeNull();
  });
});
