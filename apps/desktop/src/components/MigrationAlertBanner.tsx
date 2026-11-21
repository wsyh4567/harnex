import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Shield, X, Zap } from "lucide-react";
import { useI18n } from "../i18n/index.ts";
import { cn } from "../lib/utils.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

export function MigrationAlertBanner() {
  const {
    compatibilityReport,
    isMigrating,
    dismissedMigrationAlert,
    startHarnessMigration,
    dismissMigrationAlert,
    setActivePage,
  } = useCommandDeckStore();
  const { t } = useI18n();

  const [detailsOpen, setDetailsOpen] = useState(true);

  if (
    !compatibilityReport ||
    (!compatibilityReport.hasBreakingIssues && !compatibilityReport.needsMigration) ||
    dismissedMigrationAlert
  ) {
    return null;
  }

  const breakingCount =
    compatibilityReport.issues.filter((i) => i.severity === "breaking").length ||
    compatibilityReport.issues.length;

  return (
    <div
      role="alert"
      data-testid="migration-alert-banner"
      className="border-b border-rose-500/25 bg-rose-50/75 px-4 py-2.5 text-xs dark:bg-rose-950/25"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="font-semibold text-amber-950 dark:text-amber-100">
            {t("migration.title", { count: breakingCount })}
          </span>
          {compatibilityReport.quarantinedPaths.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
              <Shield className="h-3 w-3" />
              {t("migration.quarantined")}
            </span>
          )}
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="hx-pressable flex items-center gap-0.5 text-[11px] text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
          >
            {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span>{detailsOpen ? t("migration.hideDetails") : t("migration.showDetails")}</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            data-testid="start-harness-migration-btn"
            disabled={isMigrating}
            onClick={() => {
              void startHarnessMigration().then((prop) => {
                if (prop) setActivePage("proposals");
              });
            }}
            className="hx-pressable flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-400 disabled:opacity-50 dark:bg-amber-400 dark:text-zinc-950"
          >
            {isMigrating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            <span>{isMigrating ? t("migration.migrating") : t("migration.autoMigrate")}</span>
          </button>

          <button
            type="button"
            aria-label={t("migration.dismiss")}
            onClick={dismissMigrationAlert}
            className="hx-pressable rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] p-1 text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {detailsOpen && compatibilityReport.issues.length > 0 && (
        <div className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-2">
          {compatibilityReport.issues.map((issue) => (
            <div
              key={`${issue.path}-${issue.kind}`}
              className={cn(
                "rounded-lg border px-2.5 py-1.5 text-[11px]",
                issue.severity === "breaking"
                  ? "border-rose-500/30 bg-[var(--hx-surface)] text-rose-900 dark:text-rose-100"
                  : "border-amber-500/30 bg-[var(--hx-surface)] text-amber-900 dark:text-amber-100",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono font-semibold">{issue.path}</code>
                <span className="rounded border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.2 font-mono text-[9px] uppercase">
                  {issue.severity}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] opacity-90">{issue.message}</p>
              {issue.suggestedFix && (
                <p className="mt-0.5 text-[10px] text-cyan-700 dark:text-cyan-300">
                  {t("migration.suggestedFix", { fix: issue.suggestedFix })}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
