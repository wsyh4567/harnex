import { useEffect, useMemo, useRef, useState } from "react";
import type { EvolutionProposal, Thread } from "@harnex/protocol";
import {
  FlaskConical,
  GitCommitHorizontal,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Zap,
} from "lucide-react";
import { localizeProposal, localizeThreadTitle } from "../i18n/demoContent.ts";
import { translate, useI18n, type Locale, type TranslationKey } from "../i18n/index.ts";
import { cn, shortSha } from "../lib/utils.ts";
import { useCommandDeckStore, type ActivePage } from "../stores/useCommandDeckStore.ts";

export type PaletteCategory = "pages" | "threads" | "proposals" | "actions";

export type PaletteActionKind =
  | { type: "page"; page: ActivePage }
  | { type: "thread"; threadId: string }
  | { type: "proposal"; proposalId: string }
  | {
      type: "action";
      id:
        | "toggle_theme"
        | "switch_language"
        | "toggle_side_chat"
        | "toggle_sidebar"
        | "run_evolution"
        | "sync_pricing"
        | "open_crucible";
    };

export interface PaletteItem {
  id: string;
  category: PaletteCategory;
  label: string;
  subtitle?: string;
  keywords: string;
  shortcut?: string;
  payload: PaletteActionKind;
}

export function buildPaletteItems(params: {
  locale: Locale;
  threads: Thread[];
  proposals: EvolutionProposal[];
}): PaletteItem[] {
  const { locale, threads, proposals } = params;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const pages: Array<{ page: ActivePage; label: string; keywords: string; shortcut?: string }> = [
    { page: "home", label: t("nav.newTask"), keywords: "new task home prompt", shortcut: "Ctrl+N" },
    { page: "deck", label: t("nav.deck"), keywords: "command deck telemetry cockpit" },
    { page: "lab", label: t("nav.lab"), keywords: "evolution lab theater guided" },
    { page: "proposals", label: t("nav.proposals"), keywords: "proposals triage diff review" },
    { page: "history", label: t("nav.history"), keywords: "version history genome commits" },
    { page: "security", label: t("nav.security"), keywords: "security trust hooks sandbox" },
    { page: "providers", label: t("nav.providers"), keywords: "providers budget pricing api key" },
    { page: "settings", label: t("nav.settings"), keywords: "settings preferences theme language" },
  ];

  const pageItems: PaletteItem[] = pages.map((p) => ({
    id: `page-${p.page}`,
    category: "pages",
    label: p.label,
    keywords: `${p.label} ${p.keywords}`,
    shortcut: p.shortcut,
    payload: { type: "page", page: p.page },
  }));

  const threadItems: PaletteItem[] = threads.map((th) => {
    const title = localizeThreadTitle(th, locale);
    return {
      id: `thread-${th.id}`,
      category: "threads",
      label: title,
      subtitle: `${th.workspacePath} · ${th.pinnedVersionLabel ?? "v7"} · ${shortSha(th.pinnedCommitSha)}`,
      keywords: `${title} ${th.title} ${th.workspacePath} ${th.domain}`,
      payload: { type: "thread", threadId: th.id },
    };
  });

  const readyProposals = proposals.filter(
    (p) => p.status === "ready" || p.status === "needs_reprobe",
  );
  const proposalItems: PaletteItem[] = readyProposals.map((p) => {
    const loc = localizeProposal(p, locale);
    return {
      id: `proposal-${p.id}`,
      category: "proposals",
      label: loc.title,
      subtitle: `${loc.statusLabel} · ${p.domain}`,
      keywords: `${loc.title} ${p.title} ${p.domain} ${loc.statusLabel}`,
      payload: { type: "proposal", proposalId: p.id },
    };
  });

  const actionItems: PaletteItem[] = [
    {
      id: "action-toggle-theme",
      category: "actions",
      label: t("cmdPalette.actionToggleTheme"),
      keywords: "theme light dark toggle appearance",
      payload: { type: "action", id: "toggle_theme" },
    },
    {
      id: "action-switch-language",
      category: "actions",
      label: t("cmdPalette.actionSwitchLanguage"),
      keywords: "language locale english chinese zh en",
      payload: { type: "action", id: "switch_language" },
    },
    {
      id: "action-toggle-side-chat",
      category: "actions",
      label: t("cmdPalette.actionToggleSideChat"),
      keywords: "btw side chat isolated",
      shortcut: "Ctrl+;",
      payload: { type: "action", id: "toggle_side_chat" },
    },
    {
      id: "action-toggle-sidebar",
      category: "actions",
      label: t("cmdPalette.actionToggleSidebar"),
      keywords: "sidebar collapse expand navigation",
      shortcut: "Ctrl+B",
      payload: { type: "action", id: "toggle_sidebar" },
    },
    {
      id: "action-run-evolution",
      category: "actions",
      label: t("cmdPalette.actionRunEvolution"),
      keywords: "run evolution cycle rsi theater",
      payload: { type: "action", id: "run_evolution" },
    },
    {
      id: "action-sync-pricing",
      category: "actions",
      label: t("cmdPalette.actionSyncPricing"),
      keywords: "sync model pricing rates cost",
      payload: { type: "action", id: "sync_pricing" },
    },
    {
      id: "action-open-crucible",
      category: "actions",
      label: t("cmdPalette.actionOpenCrucible"),
      keywords: "onboarding crucible replay f0",
      payload: { type: "action", id: "open_crucible" },
    },
  ];

  return [...pageItems, ...threadItems, ...proposalItems, ...actionItems];
}

function scoreFuzzyMatch(text: string, query: string): number {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;

  if (hay.startsWith(needle)) return 100;
  const idx = hay.indexOf(needle);
  if (idx >= 0) return 80 - Math.min(idx, 30);

  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => hay.includes(tok))) {
    return 65;
  }

  // Fuzzy subsequence match
  let qIdx = 0;
  let consecutive = 0;
  let bonus = 0;
  for (let i = 0; i < hay.length && qIdx < needle.length; i += 1) {
    if (hay[i] === needle[qIdx]) {
      consecutive += 1;
      bonus += consecutive * 2;
      qIdx += 1;
    } else {
      consecutive = 0;
    }
  }
  if (qIdx === needle.length) {
    return 25 + Math.min(bonus, 30);
  }
  return 0;
}

export function filterPaletteItems(items: PaletteItem[], query: string): PaletteItem[] {
  const trimmed = query.trim();
  if (!trimmed) return items;

  const scored: Array<{ item: PaletteItem; score: number }> = [];
  for (const item of items) {
    const labelScore = scoreFuzzyMatch(item.label, trimmed) * 2;
    const kwScore = scoreFuzzyMatch(item.keywords, trimmed);
    const subScore = item.subtitle ? scoreFuzzyMatch(item.subtitle, trimmed) : 0;
    const best = Math.max(labelScore, kwScore, subScore);
    if (best > 0) {
      scored.push({ item, score: best });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}

function renderItemIcon(item: PaletteItem) {
  if (item.payload.type === "page") {
    switch (item.payload.page) {
      case "home":
        return <Plus className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
      case "deck":
        return <LayoutDashboard className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
      case "lab":
        return <FlaskConical className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
      case "proposals":
        return <Sparkles className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
      case "history":
        return <GitCommitHorizontal className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
      case "security":
        return <ShieldAlert className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
      case "providers":
        return <KeyRound className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
      case "settings":
        return <Settings className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
      default:
        return <LayoutDashboard className="h-3.5 w-3.5 text-[var(--hx-accent)]" />;
    }
  }
  if (item.payload.type === "thread") {
    return <MessageSquare className="h-3.5 w-3.5 text-[var(--hx-text-2)]" />;
  }
  if (item.payload.type === "proposal") {
    return <Sparkles className="h-3.5 w-3.5 text-emerald-500" />;
  }
  return <Zap className="h-3.5 w-3.5 text-amber-500" />;
}

export function CommandPaletteModal() {
  const {
    commandPaletteOpen,
    toggleCommandPalette,
    threads,
    activeThreadId,
    proposals,
    setActivePage,
    setActiveThread,
    selectProposal,
    setRightTab,
    toggleTheme,
    toggleLocale,
    toggleSideChat,
    toggleSidebar,
    triggerEvolution,
    syncPricingCatalog,
    openOnboarding,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const allItems = useMemo(
    () => buildPaletteItems({ locale, threads, proposals }),
    [locale, threads, proposals],
  );
  const filtered = useMemo(() => filterPaletteItems(allItems, query), [allItems, query]);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery("");
      setHighlightIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [commandPaletteOpen]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    const activeEl = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-idx="${highlightIdx}"]`,
    );
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [commandPaletteOpen, highlightIdx]);

  if (!commandPaletteOpen) return null;

  const activeThread = threads.find((th) => th.id === activeThreadId) ?? threads[0] ?? null;

  const executeItem = (item: PaletteItem) => {
    toggleCommandPalette(false);
    const { payload } = item;
    if (payload.type === "page") {
      setActivePage(payload.page);
      return;
    }
    if (payload.type === "thread") {
      void setActiveThread(payload.threadId);
      return;
    }
    if (payload.type === "proposal") {
      selectProposal(payload.proposalId);
      setRightTab("triage");
      setActivePage("proposals");
      return;
    }
    switch (payload.id) {
      case "toggle_theme":
        toggleTheme();
        break;
      case "switch_language":
        toggleLocale();
        break;
      case "toggle_side_chat":
        toggleSideChat();
        break;
      case "toggle_sidebar":
        toggleSidebar();
        break;
      case "run_evolution":
        setActivePage("lab");
        void triggerEvolution({ domain: activeThread?.domain ?? "file_ops" });
        break;
      case "sync_pricing":
        void syncPricingCatalog(true);
        break;
      case "open_crucible":
        openOnboarding(true);
        break;
    }
  };

  const categoryLabels: Record<PaletteCategory, string> = {
    pages: t("cmdPalette.groupPages"),
    threads: t("cmdPalette.groupThreads"),
    proposals: t("cmdPalette.groupProposals"),
    actions: t("cmdPalette.groupActions"),
  };

  return (
    <div
      data-testid="command-palette-backdrop"
      onClick={() => toggleCommandPalette(false)}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/35 px-4 pt-[14vh] backdrop-blur-[2px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("cmdPalette.trigger")}
        data-testid="command-palette-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: "var(--hx-shadow-popover)" }}
        className="hx-modal flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)]"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--hx-border)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--hx-text-3)]" />
          <input
            ref={inputRef}
            type="text"
            data-testid="command-palette-input"
            value={query}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const nativeComposing = (e.nativeEvent as KeyboardEvent).isComposing;
              if (isComposing || nativeComposing) return;

              if (e.key === "Escape") {
                e.preventDefault();
                toggleCommandPalette(false);
                return;
              }
              if (filtered.length === 0) return;

              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightIdx((i) => (i + 1) % filtered.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightIdx((i) => (i - 1 + filtered.length) % filtered.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const chosen = filtered[highlightIdx];
                if (chosen) executeItem(chosen);
              }
            }}
            placeholder={t("cmdPalette.placeholder")}
            className="flex-1 bg-transparent text-xs text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)] focus:outline-none"
          />
          <kbd className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--hx-text-3)]">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto p-2 text-xs">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[var(--hx-text-3)]">
              {t("cmdPalette.empty")}
            </div>
          ) : (
            filtered.map((item, idx) => {
              const prevCategory = idx > 0 ? filtered[idx - 1]?.category : null;
              const showGroup = !query.trim() && item.category !== prevCategory;
              const active = idx === highlightIdx;

              return (
                <div key={item.id}>
                  {showGroup && (
                    <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold tracking-wider text-[var(--hx-text-3)]">
                      {categoryLabels[item.category]}
                    </div>
                  )}
                  <button
                    type="button"
                    data-palette-idx={idx}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    onClick={() => executeItem(item)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
                      active
                        ? "bg-[var(--hx-accent-soft)] text-[var(--hx-text)]"
                        : "text-[var(--hx-text-2)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      {renderItemIcon(item)}
                      <div className="min-w-0">
                        <div className="truncate font-medium text-[var(--hx-text)]">
                          {item.label}
                        </div>
                        {item.subtitle && (
                          <div className="truncate font-mono text-[10px] text-[var(--hx-text-3)]">
                            {item.subtitle}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {item.shortcut && (
                        <kbd className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--hx-text-3)]">
                          {item.shortcut}
                        </kbd>
                      )}
                      <span className="rounded-md bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--hx-text-3)]">
                        {categoryLabels[item.category]}
                      </span>
                    </div>
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--hx-border)] bg-[var(--hx-subtle)]/55 px-4 py-2 text-[10px] text-[var(--hx-text-3)]">
          <span>{t("cmdPalette.navHint")}</span>
          <span className="hx-num font-mono">{filtered.length}</span>
        </div>
      </div>
    </div>
  );
}
