import { useState } from "react";
import {
  Flame,
  GitBranch,
  Languages,
  MessageSquarePlus,
  Moon,
  PanelLeftOpen,
  ShieldCheck,
  Sparkles,
  Sun,
  Wallet,
} from "lucide-react";
import { AnimatedPopover } from "./ui/AnimatedPopover.tsx";
import { ChoiceMenu } from "./ui/ChoiceMenu.tsx";
import { UpdatePill } from "./UpdatePill.tsx";
import { localizeThreadTitle } from "../i18n/demoContent.ts";
import { SUPPORTED_LOCALES, useI18n } from "../i18n/index.ts";
import {
  formatUnpricedSummary,
  resolveCostSourceBadge,
} from "../features/providers/providerPresets.ts";
import { cn, formatTokens, formatUsd, shortSha } from "../lib/utils.ts";
import { useCommandDeckStore, type ActivePage } from "../stores/useCommandDeckStore.ts";

export function TopBar() {
  const {
    ipc,
    theme,
    toggleTheme,
    activePage,
    setActivePage,
    sidebarCollapsed,
    toggleSidebar,
    threads,
    activeThreadId,
    appConfig,
    setRsiMode,
    budgetStatus,
    systemHealth,
    openOnboarding,
    toggleSideChat,
    sideChatOpen,
  } = useCommandDeckStore();
  const { locale, setLocale, t } = useI18n();
  const [statusOpen, setStatusOpen] = useState(false);

  const isTauriLive = ipc.mode === "tauri";
  const activeThread = threads.find((th) => th.id === activeThreadId) ?? null;
  const rsiMode = appConfig?.rsiMode ?? systemHealth?.rsiMode ?? "manual";
  const spent = budgetStatus?.spentTodayUsd ?? 0;
  const limit = budgetStatus?.dailyLimitUsd ?? 5;
  const tokensToday = budgetStatus?.tokensToday ?? 0;
  const costMeta = resolveCostSourceBadge(budgetStatus?.costSource, locale);
  const unpricedSummary = formatUnpricedSummary(budgetStatus, locale);

  const pageTitleMap: Record<ActivePage, string> = {
    home: t("nav.newTask"),
    thread: activeThread ? localizeThreadTitle(activeThread, locale) : t("nav.newTask"),
    deck: t("nav.deck"),
    lab: t("nav.lab"),
    proposals: t("nav.proposals"),
    history: t("nav.history"),
    security: t("nav.security"),
    providers: t("nav.providers"),
    settings: t("nav.settings"),
  };

  const headVersion = activeThread?.pinnedVersionLabel ?? "v7";
  const headSha = shortSha(
    activeThread?.pinnedCommitSha ?? systemHealth?.activeCommitSha ?? "a7f3c91",
  );

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--hx-border)] bg-[var(--hx-canvas)] px-4 text-xs">
      {/* Left: Sidebar expand + Active Page/Thread Title + Genome Pin */}
      <div className="flex min-w-0 items-center gap-2.5">
        {sidebarCollapsed && (
          <button
            type="button"
            aria-label={t("nav.expandSidebar")}
            title={t("nav.expandSidebar")}
            onClick={() => toggleSidebar(false)}
            className="hx-pressable rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] p-1.5 text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
          </button>
        )}

        <h1 className="truncate text-[13px] font-semibold tracking-tight text-[var(--hx-text)]">
          {pageTitleMap[activePage]}
        </h1>

        <span
          className="hidden sm:inline-flex items-center gap-1 rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-0.5 font-mono text-[10px] text-[var(--hx-text-2)]"
          title={`${headVersion} · ${headSha}`}
        >
          <GitBranch className="h-3 w-3 text-[var(--hx-accent)]" />
          <span>{headVersion}</span>
          <span className="opacity-50">·</span>
          <span>{headSha}</span>
        </span>

        <span
          data-testid="ipc-runtime-badge"
          title={isTauriLive ? t("top.liveTauriTitle") : t("top.demoMockTitle")}
          className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--hx-text-2)]"
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              isTauriLive ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
          <span>{isTauriLive ? t("top.liveTauri") : t("top.demoMock")}</span>
        </span>
      </div>

      {/* Right: Quiet cluster */}
      <div className="flex shrink-0 items-center gap-1.5">
        <UpdatePill />

        {/* Compact System Status Pill + Popover */}
        <AnimatedPopover
          open={statusOpen}
          onOpenChange={setStatusOpen}
          side="bottom-right"
          panelClassName="w-80 p-3.5 space-y-3 text-xs"
          trigger={
            <button
              type="button"
              data-testid="system-status-pill"
              onClick={() => setStatusOpen((v) => !v)}
              className="hx-pressable hidden sm:inline-flex items-center gap-2 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1 text-[11px] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  systemHealth?.sidecarAlive ? "bg-emerald-500" : "bg-rose-500",
                )}
              />
              <span>{t("top.sandboxFull")}</span>
              <span className="opacity-30">|</span>
              <span className="font-medium text-[var(--hx-text)]">
                {rsiMode === "auto" ? t("top.rsiAuto") : t("top.rsiManual")}
              </span>
              <span className="opacity-30">|</span>
              <span className="font-mono">
                {formatUsd(spent)}/{formatUsd(limit)}
              </span>
            </button>
          }
        >
          <div className="space-y-3">
            <div className="text-xs font-semibold text-[var(--hx-text)]">
              {t("top.statusPopoverTitle")}
            </div>

            <div className="space-y-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[var(--hx-text-2)]">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  {systemHealth?.osSandboxLevel === "beta"
                    ? t("top.sandboxBeta")
                    : t("top.sandboxFull")}
                </span>
                <span className="font-mono text-[10px] text-[var(--hx-text-3)]">
                  {systemHealth?.sandboxBackend ?? "sandbox"}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[var(--hx-text-2)]">
                  <Sparkles className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                  {t("top.rsi")}
                </span>
                <div className="inline-flex rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] p-0.5">
                  {(["manual", "auto"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => void setRsiMode(m)}
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                        rsiMode === m
                          ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                          : "text-[var(--hx-text-3)] hover:text-[var(--hx-text)]",
                      )}
                    >
                      {m === "auto" ? t("top.rsiAuto") : t("top.rsiManual")}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5 border-t border-[var(--hx-border)]/70 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[var(--hx-text-2)]">
                    <Wallet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    {t("top.budget")}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span
                      title={costMeta.tooltip}
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                        costMeta.toneClass,
                      )}
                    >
                      {costMeta.label}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--hx-text)]">
                      {formatUsd(spent)} / {formatUsd(limit)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between pl-5 text-[11px] text-[var(--hx-text-3)]">
                  <span>{t("budget.tokensTodayLabel")}</span>
                  <span className="font-mono text-[var(--hx-text-2)]">
                    {formatTokens(tokensToday, locale)}
                  </span>
                </div>

                {unpricedSummary && (
                  <div className="ml-5 flex flex-col gap-1 rounded-lg border border-amber-500/25 bg-amber-50/70 px-2 py-1.5 text-[10px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                    <span>{unpricedSummary}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setStatusOpen(false);
                        setActivePage("providers");
                      }}
                      className="w-fit font-medium underline decoration-amber-500/50 underline-offset-2 hover:text-amber-950 dark:hover:text-amber-100"
                    >
                      {t("budget.configurePricingLink")}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setStatusOpen(false);
                  setActivePage("security");
                }}
                className="hx-pressable flex items-center justify-between rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-[11px] text-[var(--hx-text)] hover:bg-[var(--hx-subtle)]"
              >
                <span>{t("top.openSecurity")}</span>
                <ShieldCheck className="h-3.5 w-3.5 text-[var(--hx-text-3)]" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setStatusOpen(false);
                  setActivePage("providers");
                }}
                className="hx-pressable flex items-center justify-between rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-[11px] text-[var(--hx-text)] hover:bg-[var(--hx-subtle)]"
              >
                <span>{t("top.openProviders")}</span>
                <Wallet className="h-3.5 w-3.5 text-[var(--hx-text-3)]" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setStatusOpen(false);
                  openOnboarding(true);
                }}
                className="hx-pressable flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-50/70 px-2.5 py-1.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100/70 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <span>{t("top.openCrucible")}</span>
                <Flame className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </AnimatedPopover>

        {/* /btw Side Chat */}
        <button
          type="button"
          onClick={() => toggleSideChat()}
          title={t("rail.sideChatTitle")}
          className={cn(
            "hx-pressable inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 font-mono text-[11px]",
            sideChatOpen
              ? "border-violet-500/40 bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
              : "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]",
          )}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          <span>/btw</span>
        </button>

        {/* Theme Toggle */}
        <button
          type="button"
          data-testid="theme-toggle-btn"
          title={theme === "light" ? t("top.themeLight") : t("top.themeDark")}
          onClick={toggleTheme}
          className="hx-pressable flex items-center justify-center rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] p-1.5 text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
        >
          {theme === "light" ? (
            <Sun className="h-3.5 w-3.5 text-amber-500" />
          ) : (
            <Moon className="h-3.5 w-3.5 text-indigo-300" />
          )}
        </button>

        {/* Language ChoiceMenu (zero native <select>) */}
        <ChoiceMenu
          testId="locale-selector"
          ariaLabel={t("top.langTitle")}
          value={locale}
          options={SUPPORTED_LOCALES.map((loc) => ({
            value: loc.code,
            label: loc.nativeLabel,
            badge: loc.shortLabel,
          }))}
          onChange={(code) => setLocale(code)}
          side="bottom-right"
          prefixIcon={<Languages className="h-3.5 w-3.5 text-[var(--hx-accent)]" />}
          buttonClassName="px-2 py-1 text-[11px] rounded-lg"
          menuClassName="w-44"
        />
      </div>
    </header>
  );
}
