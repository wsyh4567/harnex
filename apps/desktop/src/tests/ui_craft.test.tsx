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
import { enUSMessages, zhCNMessages } from "../i18n/index.ts";
import { MockIpcAdapter } from "../ipc/index.ts";
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
});
