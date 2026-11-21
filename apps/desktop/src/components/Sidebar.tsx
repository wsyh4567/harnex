import {
  Cpu,
  FlaskConical,
  GitCommitHorizontal,
  KeyRound,
  LayoutDashboard,
  PanelLeftClose,
  Plus,
  Settings,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { ChoiceMenu } from "./ui/ChoiceMenu.tsx";
import { localizeThreadTitle } from "../i18n/demoContent.ts";
import { useI18n } from "../i18n/index.ts";
import { cn, formatRelativeTime } from "../lib/utils.ts";
import { useCommandDeckStore, type ActivePage } from "../stores/useCommandDeckStore.ts";

const STATUS_DOT: Record<string, string> = {
  running: "bg-cyan-500 animate-pulse",
  awaiting_approval: "bg-amber-500 animate-pulse",
  paused: "bg-violet-500",
  completed: "bg-emerald-500",
  failed: "bg-rose-500",
  aborted: "bg-slate-400",
  idle: "bg-slate-400/70",
};

export function Sidebar() {
  const {
    activePage,
    setActivePage,
    sidebarCollapsed,
    toggleSidebar,
    threads,
    activeThreadId,
    activeWorkspace,
    setActiveWorkspace,
    setActiveThread,
    proposals,
    pendingApprovals,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  if (sidebarCollapsed) return null;

  const readyProposalCount = proposals.filter(
    (p) => p.status === "ready" || p.status === "needs_reprobe",
  ).length;
  const runtimeApprovalsCount = pendingApprovals.length;

  const workspaces = Array.from(
    new Set(["~/Work", "~/Projects/acme-data", ...threads.map((th) => th.workspacePath)]),
  );

  const visibleThreads = threads.filter((th) => th.workspacePath === activeWorkspace);

  const evolutionNav: Array<{
    id: ActivePage;
    label: string;
    icon: typeof LayoutDashboard;
    badge?: number;
  }> = [
    { id: "deck", label: t("nav.deck"), icon: LayoutDashboard },
    { id: "lab", label: t("nav.lab"), icon: FlaskConical },
    {
      id: "proposals",
      label: t("nav.proposals"),
      icon: Sparkles,
      badge: readyProposalCount > 0 ? readyProposalCount : undefined,
    },
    { id: "history", label: t("nav.history"), icon: GitCommitHorizontal },
  ];

  const footerNav: Array<{
    id: ActivePage;
    label: string;
    icon: typeof ShieldAlert;
    badge?: number;
  }> = [
    {
      id: "security",
      label: t("nav.security"),
      icon: ShieldAlert,
      badge: runtimeApprovalsCount > 0 ? runtimeApprovalsCount : undefined,
    },
    { id: "providers", label: t("nav.providers"), icon: KeyRound },
    { id: "settings", label: t("nav.settings"), icon: Settings },
  ];

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-[var(--hx-border)] bg-[var(--hx-sidebar)] select-none">
      {/* Header: Brand Mark + Collapse */}
      <div className="flex h-12 shrink-0 items-center justify-between px-3.5">
        <button
          type="button"
          onClick={() => setActivePage("home")}
          className="flex items-center gap-2 text-left hover:opacity-85 transition-opacity"
        >
          <img src="/harnex-mark.png" alt="Harnex" className="h-6 w-6 object-contain" />
          <span className="text-[14px] font-semibold tracking-tight text-[var(--hx-text)]">
            Harnex
          </span>
        </button>

        <button
          type="button"
          aria-label={t("nav.collapseSidebar")}
          title={t("nav.collapseSidebar")}
          onClick={() => toggleSidebar(true)}
          className="hx-pressable rounded-lg p-1.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-muted)]/60 hover:text-[var(--hx-text)]"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Primary Action: + New Task */}
      <div className="px-3 pb-3">
        <button
          type="button"
          data-testid="sidebar-new-task-btn"
          onClick={() => setActivePage("home")}
          className={cn(
            "hx-pressable flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium",
            activePage === "home"
              ? "border-[var(--hx-accent-border)] bg-[var(--hx-surface)] text-[var(--hx-text)] shadow-xs"
              : "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]",
          )}
        >
          <Plus className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
          <span>{t("nav.newTask")}</span>
        </button>
      </div>

      {/* Scrollable Nav Body */}
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-3">
        {/* Section: Harness² Evolution */}
        <div className="space-y-0.5">
          <div className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-[var(--hx-text-3)]">
            {t("nav.sectionEvolution")}
          </div>
          {evolutionNav.map((item) => {
            const Icon = item.icon;
            const active = activePage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`nav-${item.id}`}
                onClick={() => setActivePage(item.id)}
                className={cn(
                  "hx-pressable flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs font-medium",
                  active
                    ? "bg-[var(--hx-surface)] text-[var(--hx-text)] shadow-xs border border-[var(--hx-border)]"
                    : "border border-transparent text-[var(--hx-text-2)] hover:bg-[var(--hx-surface)]/70 hover:text-[var(--hx-text)]",
                )}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-[var(--hx-accent)]" : "text-[var(--hx-text-3)]",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <span className="rounded-full bg-[var(--hx-accent-soft)] px-1.5 py-0.2 font-mono text-[10px] font-semibold text-[var(--hx-accent)]">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Section: Workspace & Recent Tasks */}
        <div className="space-y-2 border-t border-[var(--hx-border)] pt-3">
          <div className="px-2 text-[10px] font-semibold tracking-wider text-[var(--hx-text-3)]">
            {t("nav.sectionWorkspace")}
          </div>

          <ChoiceMenu
            ariaLabel={t("top.workspace")}
            value={activeWorkspace}
            options={workspaces.map((ws) => ({ value: ws, label: ws }))}
            onChange={(ws) => setActiveWorkspace(ws)}
            side="bottom"
            className="w-full"
            buttonClassName="w-full justify-between px-2.5 py-1.5 text-[11px] font-mono rounded-xl"
            menuClassName="w-56"
          />

          <div className="space-y-0.5">
            {visibleThreads.length === 0 ? (
              <div className="px-2.5 py-2 text-[11px] text-[var(--hx-text-3)]">
                {t("nav.noTasks")}
              </div>
            ) : (
              visibleThreads.map((th) => {
                const active = activePage === "thread" && th.id === activeThreadId;
                return (
                  <button
                    key={th.id}
                    type="button"
                    data-testid={`thread-item-${th.id}`}
                    onClick={() => void setActiveThread(th.id)}
                    className={cn(
                      "hx-pressable w-full rounded-xl px-2.5 py-2 text-left border",
                      active
                        ? "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text)] shadow-xs"
                        : "border-transparent text-[var(--hx-text-2)] hover:bg-[var(--hx-surface)]/70 hover:text-[var(--hx-text)]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            STATUS_DOT[th.status] ?? "bg-slate-400",
                          )}
                        />
                        <span className="truncate text-xs font-medium">
                          {localizeThreadTitle(th, locale)}
                        </span>
                      </span>
                      {th.hadHumanSteer && (
                        <span className="shrink-0 rounded bg-violet-500/12 px-1.5 py-0.5 text-[9px] font-medium text-violet-700 dark:text-violet-300">
                          {t("rail.steerBadge")}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--hx-text-3)]">
                      <span>{formatRelativeTime(th.updatedAt, locale)}</span>
                      <span className="inline-flex items-center gap-1 font-mono">
                        <Cpu className="h-2.5 w-2.5" />
                        {th.pinnedVersionLabel ?? "v7"}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Footer: Security, Providers, Settings */}
      <div className="border-t border-[var(--hx-border)] p-3 space-y-0.5">
        {footerNav.map((item) => {
          const Icon = item.icon;
          const active = activePage === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`nav-${item.id}`}
              onClick={() => setActivePage(item.id)}
              className={cn(
                "hx-pressable flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-xs font-medium",
                active
                  ? "bg-[var(--hx-surface)] text-[var(--hx-text)] shadow-xs border border-[var(--hx-border)]"
                  : "border border-transparent text-[var(--hx-text-2)] hover:bg-[var(--hx-surface)]/70 hover:text-[var(--hx-text)]",
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                <Icon
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    active ? "text-[var(--hx-accent)]" : "text-[var(--hx-text-3)]",
                  )}
                />
                <span className="truncate">{item.label}</span>
              </span>
              {item.badge !== undefined && (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
