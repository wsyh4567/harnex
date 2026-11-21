import { AlertTriangle, Settings2, ShieldCheck, X } from "lucide-react";
import { selectGlobalHookAlerts } from "../hooks/globalHookSelectors.ts";
import { useI18n } from "../i18n/index.ts";
import { shortSha } from "../lib/utils.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

export function GlobalHookTrustBar() {
  const {
    globalHooks,
    pendingApprovals,
    dismissedHookShaByPath,
    trustGlobalHook,
    dismissGlobalHookNotice,
    setRightTab,
    setActivePage,
  } = useCommandDeckStore();
  const { t } = useI18n();

  const alerts = selectGlobalHookAlerts(globalHooks, pendingApprovals, dismissedHookShaByPath);
  const current = alerts[0];
  if (!current) return null;

  const remainingCount = alerts.length - 1;

  return (
    <div
      data-testid="global-hook-trust-bar"
      className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)]/85 px-3 py-1.5 text-[11px]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="shrink-0 font-medium text-[var(--hx-text-2)]">
          {t("hooks.trustBarTitle")}
        </span>
        <code className="truncate font-mono text-[11px] text-[var(--hx-text)]">
          {current.path}
        </code>
        {current.previousSha256 && (
          <span className="hidden sm:inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/12 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-2.5 w-2.5" />
            {shortSha(current.previousSha256, 6)}→{shortSha(current.sha256, 6)}
          </span>
        )}
        {remainingCount > 0 && (
          <span className="shrink-0 text-[10px] text-[var(--hx-text-3)]">
            {t("hooks.moreCount", { count: remainingCount })}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="global-hook-trust-btn"
          onClick={() => void trustGlobalHook(current.path)}
          className="hx-pressable inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500"
        >
          <ShieldCheck className="h-3 w-3" />
          <span>{t("hooks.trustHook")}</span>
        </button>
        <button
          type="button"
          data-testid="global-hook-dismiss-btn"
          onClick={() => dismissGlobalHookNotice(current.path, current.sha256)}
          className="hx-pressable inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] text-[var(--hx-text-3)] hover:bg-[var(--hx-surface)] hover:text-[var(--hx-text)]"
        >
          <X className="h-3 w-3" />
          <span className="hidden sm:inline">{t("hooks.dismiss")}</span>
        </button>
        <button
          type="button"
          data-testid="global-hook-manage-btn"
          onClick={() => {
            setRightTab("security");
            setActivePage("security");
          }}
          className="hx-pressable inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] text-[var(--hx-text-2)] hover:bg-[var(--hx-surface)] hover:text-[var(--hx-text)]"
        >
          <Settings2 className="h-3 w-3" />
          <span className="hidden md:inline">{t("hooks.manageHooks")}</span>
        </button>
      </div>
    </div>
  );
}
