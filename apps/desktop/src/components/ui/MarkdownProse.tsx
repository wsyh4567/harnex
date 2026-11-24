import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "hr" }
  | { type: "blockquote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | {
      type: "table";
      headers: string[];
      alignments: Array<"left" | "center" | "right">;
      rows: string[][];
    }
  | { type: "paragraph"; text: string };

export function isSafeHttpUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "\\" && i + 1 < inner.length && inner[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (inner[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += inner[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableSeparator(line: string): Array<"left" | "center" | "right"> | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !trimmed.includes("-")) return null;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;
  const alignments: Array<"left" | "center" | "right"> = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(":") && cell.endsWith(":")) {
      alignments.push("center");
    } else if (cell.endsWith(":")) {
      alignments.push("right");
    } else {
      alignments.push("left");
    }
  }
  return alignments;
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block (supports unclosed fence while streaming)
    const fenceMatch = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing ```
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // ATX headings h1-h3 (clamp h4-h6 cleanly to h3)
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = Math.min(3, headingMatch[1]!.length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: headingMatch[2]! });
      i += 1;
      continue;
    }

    // GFM Table (header row + separator row)
    if (trimmed.includes("|") && i + 1 < lines.length) {
      const alignments = parseTableSeparator(lines[i + 1]!);
      if (alignments) {
        const headers = splitTableRow(line);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length) {
          const rowLine = lines[i]!;
          if (!rowLine.trim() || !rowLine.includes("|")) break;
          if (/^\s*```/.test(rowLine)) break;
          rows.push(splitTableRow(rowLine));
          i += 1;
        }
        blocks.push({ type: "table", headers, alignments, rows });
        continue;
      }
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    // Bullet / ordered list
    const bulletMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (bulletMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const match = ordered ? cur.match(/^\s*\d+\.\s+(.+)$/) : cur.match(/^\s*[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]!);
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph (collect contiguous plain lines)
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!;
      const nextTrim = next.trim();
      if (
        !nextTrim ||
        /^\s*```/.test(next) ||
        /^\s*#{1,6}\s+/.test(next) ||
        /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(next) ||
        /^\s*>\s?/.test(next) ||
        /^\s*[-*+]\s+/.test(next) ||
        /^\s*\d+\.\s+/.test(next) ||
        (nextTrim.includes("|") && i + 1 < lines.length && parseTableSeparator(lines[i + 1]!))
      ) {
        break;
      }
      paraLines.push(next);
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paraLines.join("\n") });
  }

  return blocks;
}

const INLINE_TOKEN_SOURCE =
  "(`[^`\\n]+`)|(\\[[^\\]\\n]+\\]\\((?:[^()\\n]+|\\([^()\\n]*\\))+\\))|(\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)|(~~[^~\\n]+~~)|(\\*[^*\\n]+\\*|(?:^|(?<=\\s))_[^_\\n]+_(?=\\s|$|[.,!?;:]))";

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = new RegExp(INLINE_TOKEN_SOURCE, "g");
  let lastIndex = 0;
  let matchIdx = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const k = `${keyPrefix}-${matchIdx++}`;

    if (match[1]) {
      // Inline code pill
      nodes.push(
        <code
          key={k}
          className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 font-mono text-[0.86em] text-[var(--hx-text)]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      const linkMatch = token.match(/^\[([^\]\n]+)\]\((.+)\)$/);
      if (linkMatch) {
        const [, label, href] = linkMatch;
        if (isSafeHttpUrl(href!)) {
          nodes.push(
            <a key={k} href={href!.trim()} target="_blank" rel="noopener noreferrer">
              {renderInlineMarkdown(label!, `${k}-a`)}
            </a>,
          );
        } else {
          nodes.push(<Fragment key={k}>{renderInlineMarkdown(label!, `${k}-txt`)}</Fragment>);
        }
      } else {
        nodes.push(token);
      }
    } else if (match[3]) {
      nodes.push(
        <strong key={k}>{renderInlineMarkdown(token.slice(2, -2), `${k}-b`)}</strong>,
      );
    } else if (match[4]) {
      nodes.push(
        <del key={k} className="opacity-70">
          {renderInlineMarkdown(token.slice(2, -2), `${k}-s`)}
        </del>,
      );
    } else if (match[5]) {
      nodes.push(<em key={k}>{renderInlineMarkdown(token.slice(1, -1), `${k}-i`)}</em>);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function FencedCodeBlock({ lang, code }: { lang: string; code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in headless environments
    }
  };

  return (
    <div className="my-2.5 overflow-hidden rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)]">
      <div className="flex items-center justify-between border-b border-[var(--hx-border)] bg-[var(--hx-surface)]/80 px-3 py-1.5 text-[11px]">
        <span className="font-mono font-medium text-[var(--hx-text-3)]">{lang || "text"}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="hx-pressable inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-[var(--hx-text-2)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-500" />
              <span className="text-emerald-600 dark:text-emerald-400">
                {t("markdown.copied")}
              </span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>{t("markdown.copy")}</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-[var(--hx-text)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownProse({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const blocks = parseMarkdownBlocks(content);

  return (
    <div className={cn("hx-prose", className)}>
      {blocks.map((block, idx) => {
        const key = `md-${idx}`;
        switch (block.type) {
          case "heading": {
            const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
            return <Tag key={key}>{renderInlineMarkdown(block.text, key)}</Tag>;
          }
          case "code":
            return <FencedCodeBlock key={key} lang={block.lang} code={block.code} />;
          case "hr":
            return <hr key={key} className="my-3 border-[var(--hx-border)]" />;
          case "blockquote":
            return (
              <blockquote key={key}>
                {block.lines.map((line, lIdx) => (
                  <p key={`${key}-q-${lIdx}`}>{renderInlineMarkdown(line, `${key}-q-${lIdx}`)}</p>
                ))}
              </blockquote>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag key={key}>
                {block.items.map((item, iIdx) => (
                  <li key={`${key}-li-${iIdx}`}>{renderInlineMarkdown(item, `${key}-li-${iIdx}`)}</li>
                ))}
              </ListTag>
            );
          }
          case "table":
            return (
              <div
                key={key}
                className="my-2.5 overflow-x-auto rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)]"
              >
                <table>
                  <thead>
                    <tr>
                      {block.headers.map((header, cIdx) => (
                        <th key={`${key}-th-${cIdx}`} style={{ textAlign: block.alignments[cIdx] }}>
                          {renderInlineMarkdown(header, `${key}-th-${cIdx}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={`${key}-tr-${rIdx}`}>
                        {block.headers.map((_, cIdx) => (
                          <td
                            key={`${key}-td-${rIdx}-${cIdx}`}
                            style={{ textAlign: block.alignments[cIdx] }}
                          >
                            {renderInlineMarkdown(row[cIdx] ?? "", `${key}-td-${rIdx}-${cIdx}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "paragraph":
            return (
              <p key={key} className="whitespace-pre-wrap">
                {renderInlineMarkdown(block.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
