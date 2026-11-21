import type { GenomeFile } from "@harnex/protocol";
import { localizeComponentTag } from "../../i18n/demoContent.ts";

export interface ParsedSkillItem {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface ParsedMcpServerItem {
  name: string;
  command: string;
  enabled: boolean;
}

export interface CompletionTrigger {
  kind: "slash" | "at";
  query: string;
  startIndex: number;
  endIndex: number;
}

export type CompletionCategory = "command" | "skill" | "mcp" | "context";

export interface CompletionOption {
  id: string;
  category: CompletionCategory;
  label: string;
  description?: string;
  badge?: string;
  badgeTone?: "emerald" | "muted" | "accent";
  insertText?: string;
  action?: "open_btw" | "evolve" | "mode_ask" | "mode_plan" | "mode_craft";
}

/** Extracts skills from skills/<name>/SKILL.md in genomeFiles. */
export function extractSkillsFromGenome(
  genomeFiles: GenomeFile[],
  locale = "en-US",
): ParsedSkillItem[] {
  const isZh = locale.startsWith("zh");
  const skills: ParsedSkillItem[] = [];
  for (const file of genomeFiles) {
    if (!file.path.startsWith("skills/") || !file.path.endsWith("/SKILL.md")) continue;
    const folder = file.path.slice("skills/".length, -"/SKILL.md".length);
    const nameMatch = file.content.match(/^name:\s*(.+)$/m);
    const descMatch = file.content.match(/^description:\s*(.+)$/m);
    const name = nameMatch?.[1]?.trim() || folder;
    let description = descMatch?.[1]?.trim() || file.path;
    if (isZh && name === "csv-audit") {
      description = "校验 CSV 列数与分隔符一致性，防止乱码错列。";
    }
    skills.push({
      id: folder,
      name,
      description,
      path: file.path,
    });
  }
  return skills;
}

/** Extracts MCP server definitions from `mcp/servers.json` in genomeFiles. */
export function extractMcpServersFromGenome(genomeFiles: GenomeFile[]): ParsedMcpServerItem[] {
  const mcpFile = genomeFiles.find((f) => f.path === "mcp/servers.json");
  if (!mcpFile) return [];
  try {
    const parsed = JSON.parse(mcpFile.content) as {
      servers?: Record<string, { command?: string; args?: string[]; enabled?: boolean }>;
    };
    const servers = parsed.servers ?? {};
    return Object.entries(servers).map(([name, cfg]) => ({
      name,
      command: [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" "),
      enabled: Boolean(cfg.enabled),
    }));
  } catch {
    return [];
  }
}

/** Detects `/` or `@` token right before the cursor. */
export function detectCompletionTrigger(
  text: string,
  cursorPos: number,
): CompletionTrigger | null {
  const safeCursor = Math.max(0, Math.min(cursorPos, text.length));
  const before = text.slice(0, safeCursor);

  // Support `/skill foo` or `/mcp bar` multi-word subqueries when line/token starts with `/skill ` or `/mcp `
  const slashSubMatch = before.match(/(?:^|\s)(\/(?:skill|mcp)\s+[^\s]*)$/i);
  if (slashSubMatch && slashSubMatch[1]) {
    const token = slashSubMatch[1];
    return {
      kind: "slash",
      query: token.slice(1),
      startIndex: safeCursor - token.length,
      endIndex: safeCursor,
    };
  }

  // Standard single token starting with `/` or `@`
  const tokenMatch = before.match(/(?:^|\s)([/@][^\s]*)$/);
  if (!tokenMatch || !tokenMatch[1]) return null;
  const token = tokenMatch[1];
  return {
    kind: token.startsWith("/") ? "slash" : "at",
    query: token.slice(1),
    startIndex: safeCursor - token.length,
    endIndex: safeCursor,
  };
}

export function buildCompletionOptions(params: {
  trigger: CompletionTrigger;
  genomeFiles: GenomeFile[];
  activeWorkspace: string;
  locale: string;
}): CompletionOption[] {
  const { trigger, genomeFiles, activeWorkspace, locale } = params;
  const isZh = locale.startsWith("zh");
  const skills = extractSkillsFromGenome(genomeFiles, locale);
  const mcps = extractMcpServersFromGenome(genomeFiles);
  const q = trigger.query.trim().toLowerCase();

  if (trigger.kind === "slash") {
    // If user typed `skill ...` -> prioritize skill items directly
    if (q.startsWith("skill")) {
      const subQ = q.replace(/^skill\s*/, "");
      return skills
        .filter(
          (s) =>
            !subQ ||
            s.name.toLowerCase().includes(subQ) ||
            s.id.toLowerCase().includes(subQ) ||
            s.description.toLowerCase().includes(subQ),
        )
        .map((s) => ({
          id: `skill-${s.id}`,
          category: "skill",
          label: `/skill ${s.name}`,
          description: s.description,
          badge: s.path,
          badgeTone: "accent",
          insertText: `/skill ${s.name} `,
        }));
    }

    // If user typed `mcp ...` -> show MCP servers with enabled/disabled badge
    if (q.startsWith("mcp")) {
      const subQ = q.replace(/^mcp\s*/, "");
      return mcps
        .filter(
          (m) =>
            !subQ ||
            m.name.toLowerCase().includes(subQ) ||
            m.command.toLowerCase().includes(subQ),
        )
        .map((m) => ({
          id: `mcp-${m.name}`,
          category: "mcp",
          label: `/mcp ${m.name}`,
          description: m.command,
          badge: m.enabled
            ? isZh
              ? "已启用"
              : "enabled"
            : isZh
              ? "已禁用"
              : "disabled",
          badgeTone: m.enabled ? "emerald" : "muted",
          insertText: `/mcp ${m.name} `,
        }));
    }

    const baseCommands: CompletionOption[] = [
      ...skills.map((s) => ({
        id: `cmd-skill-${s.id}`,
        category: "skill" as const,
        label: `/skill ${s.name}`,
        description: s.description,
        badge: isZh ? "技能" : "Skill",
        badgeTone: "accent" as const,
        insertText: `/skill ${s.name} `,
      })),
      ...mcps.map((m) => ({
        id: `cmd-mcp-${m.name}`,
        category: "mcp" as const,
        label: `/mcp ${m.name}`,
        description: m.command,
        badge: m.enabled
          ? isZh
            ? "已启用"
            : "enabled"
          : isZh
            ? "已禁用"
            : "disabled",
        badgeTone: m.enabled ? ("emerald" as const) : ("muted" as const),
        insertText: `/mcp ${m.name} `,
      })),
      {
        id: "cmd-btw",
        category: "command",
        label: "/btw",
        description: isZh ? "打开零污染旁路问询 (Ctrl+;)" : "Open zero-pollution Side Chat (Ctrl+;)",
        badge: isZh ? "隔离" : "Isolated",
        action: "open_btw",
      },
      {
        id: "cmd-evolve",
        category: "command",
        label: "/evolve",
        description: isZh ? "基于当前任务触发 Harness² 进化" : "Trigger Harness² evolution on current trace",
        badge: "Harness²",
        action: "evolve",
      },
      {
        id: "cmd-ask",
        category: "command",
        label: "/ask",
        description: isZh ? "切换为「问答」模式（只读）" : "Switch to Ask mode (read-only)",
        action: "mode_ask",
      },
      {
        id: "cmd-plan",
        category: "command",
        label: "/plan",
        description: isZh ? "切换为「规划」模式（先设计方案）" : "Switch to Plan mode (design first)",
        action: "mode_plan",
      },
      {
        id: "cmd-craft",
        category: "command",
        label: "/craft",
        description: isZh ? "切换为「执行」模式（沙盒执行）" : "Switch to Craft mode (sandboxed execution)",
        action: "mode_craft",
      },
    ];

    if (!q) return baseCommands;
    return baseCommands.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        (opt.description?.toLowerCase().includes(q) ?? false),
    );
  }

  // `@` workspace & Harness genome context items
  const workspaceItems: CompletionOption[] = [
    {
      id: "ctx-ws-invoices",
      category: "context",
      label: `@${activeWorkspace}/invoices/`,
      description: isZh ? "当前工作区目录" : "Workspace directory",
      badge: isZh ? "工作区" : "Workspace",
      insertText: `@${activeWorkspace}/invoices/ `,
    },
    {
      id: "ctx-ws-briefs",
      category: "context",
      label: `@${activeWorkspace}/briefs/`,
      description: isZh ? "当前工作区目录" : "Workspace directory",
      badge: isZh ? "工作区" : "Workspace",
      insertText: `@${activeWorkspace}/briefs/ `,
    },
  ];

  const genomeItems: CompletionOption[] = genomeFiles.map((f) => {
    const localizedComp = localizeComponentTag(f.component, locale);
    return {
      id: `ctx-genome-${f.path}`,
      category: "context",
      label: `@${f.path}`,
      description: `${localizedComp} · ${f.sizeBytes} B`,
      badge: localizedComp,
      insertText: `@${f.path} `,
    };
  });

  const allAt = [...workspaceItems, ...genomeItems];
  if (!q) return allAt;
  return allAt.filter(
    (opt) =>
      opt.label.toLowerCase().includes(q) ||
      (opt.description?.toLowerCase().includes(q) ?? false) ||
      (opt.badge?.toLowerCase().includes(q) ?? false),
  );
}

export function applyCompletion(
  text: string,
  trigger: CompletionTrigger,
  replacement: string,
): { nextText: string; nextCursor: number } {
  const prefix = text.slice(0, trigger.startIndex);
  const suffix = text.slice(trigger.endIndex);
  const cleanSuffix = suffix.startsWith(" ") ? suffix.slice(1) : suffix;
  const nextText = `${prefix}${replacement}${cleanSuffix}`;
  const nextCursor = prefix.length + replacement.length;
  return { nextText, nextCursor };
}
