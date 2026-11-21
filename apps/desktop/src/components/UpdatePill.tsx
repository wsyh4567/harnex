import { useState } from "react";
import type { UpdateCompatLevel } from "@harnex/protocol";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { AnimatedPopover } from "./ui/AnimatedPopover.tsx";
import { useI18n, type TranslationKey } from "../i18n/index.ts";
import { cn } from "../lib/utils.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const COMPAT_STYLE: Record<UpdateCompatLevel, { key: TranslationKey; className: string }> = {
  safe: {
    key: "update.compatSafe",
    className:
      "border-emerald-500/30 bg-emerald-50/80 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200",
  },
  auto_migrate: {
    key: "update.compatAuto",
    className:
      "border-amber-500/35 bg-amber-50/80 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
  },
  breaking: {
    key: "update.compatBreaking",
    className:
      "border-rose-500/40 bg-rose-50/80 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200",
  },
};

export function UpdatePill() {
  const { updateStatus, checkForUpdates, downloadUpdate, installUpdate } =
    useCommandDeckStore();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const phase = updateStatus?.phase ?? "idle";
  const info = updateStatus?.info;
  const currentVersion = info?.currentVersion ?? "0.1.0";
  const latestVersion = info?.latestVersion;
  const totalBytes = updateStatus?.totalBytes || info?.sizeBytes || 0;
  const downloadedBytes = updateStatus?.downloadedBytes ?? 0;
  const pct =
    totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;

  const compat = COMPAT_STYLE[info?.compatLevel ?? "safe"];

  const renderTrigger = () => {
    if (phase === "available") {
      return (
        <button
          type="button"
          data-testid="update-pill-btn"
          onClick={() => setOpen((v) => !v)}
          className="hx-pressable flex items-center gap-1.5 rounded-full border border-indigo-500/35 bg-indigo-50/80 px-2.5 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100/80 dark:bg-indigo-500/15 dark:text-indigo-200 dark:hover:bg-indigo-500/25"
        >
          <ArrowUp className="h-3 w-3" />
          <span>{t("update.pillAvailable")}</span>
          {latestVersion && <span className="font-mono text-[10px]">v{latestVersion}</span>}
        </button>
      );
    }

    if (phase === "downloading") {
      return (
        <button
          type="button"
          data-testid="update-pill-btn"
          onClick={() => setOpen((v) => !v)}
          className="hx-pressable flex items-center gap-1.5 rounded-full border border-cyan-500/35 bg-cyan-50/80 px-2.5 py-1 text-[11px] font-medium text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-200"
        >
          <ArrowDown className="h-3 w-3 animate-bounce" />
          <span>{t("update.pillDownloading", { pct })}</span>
        </button>
      );
    }

    if (phase === "ready") {
      return (
        <button
          type="button"
          data-testid="update-pill-btn"
          onClick={() => setOpen((v) => !v)}
          className="hx-pressable flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-50/80 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100/80 dark:bg-emerald-500/15 dark:text-emerald-200"
        >
          <Check className="h-3 w-3" />
          <span>{t("update.pillReady")}</span>
        </button>
      );
    }

    if (phase === "installing") {
      return (
        <button
          type="button"
          data-testid="update-pill-btn"
          onClick={() => setOpen((v) => !v)}
          className="hx-pressable flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-50/80 px-2.5 py-1 text-[11px] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{t("update.pillInstalling")}</span>
        </button>
      );
    }

    if (phase === "error") {
      return (
        <button
          type="button"
          data-testid="update-pill-btn"
          onClick={() => setOpen((v) => !v)}
          className="hx-pressable flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-50/80 px-2.5 py-1 text-[11px] text-rose-700 dark:bg-rose-500/15 dark:text-rose-200"
        >
          <AlertTriangle className="h-3 w-3" />
          <span>{t("update.pillError")}</span>
        </button>
      );
    }

    return (
      <button
        type="button"
        data-testid="update-pill-btn"
        title={t("update.checkTitle", { version: currentVersion })}
        onClick={() => {
          void checkForUpdates();
          setOpen(true);
        }}
        className="hx-pressable flex items-center justify-center rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] p-1.5 text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", phase === "checking" && "animate-spin text-cyan-500")} />
      </button>
    );
  };

  return (
    <AnimatedPopover
      open={open}
      onOpenChange={setOpen}
      side="bottom-right"
      panelClassName="w-80 p-3.5 space-y-3 text-xs"
      trigger={renderTrigger()}
    >
      <div role="dialog" aria-label={t("update.dialogTitle")} className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-semibold text-[var(--hx-text)]">{t("update.dialogTitle")}</div>
            <div className="font-mono text-[11px] text-[var(--hx-text-3)]">
              {latestVersion
                ? `v${currentVersion} → v${latestVersion}`
                : t("update.currentVersion", { version: currentVersion })}
            </div>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setOpen(false)}
            className="hx-pressable rounded-md p-1 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {info && (phase === "available" || phase === "downloading" || phase === "ready") && (
          <>
            <div className={cn("rounded-lg border px-2.5 py-1.5 text-[11px] font-medium", compat.className)}>
              <div>{t(compat.key)}</div>
              {info.compatLevel === "breaking" && (
                <p className="mt-1 text-[10px] opacity-90">{t("update.breakingHint")}</p>
              )}
              {info.migrationNotes && <p className="mt-1 text-[10px] opacity-85">{info.migrationNotes}</p>}
            </div>

            {info.releaseNotes && (
              <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-2 font-sans text-[11px] leading-relaxed text-[var(--hx-text-2)]">
                {info.releaseNotes}
              </pre>
            )}
          </>
        )}

        {phase === "available" && (
          <div className="space-y-2">
            {totalBytes > 0 && (
              <div className="font-mono text-[11px] text-[var(--hx-text-2)]">
                {t("update.packageSize", { size: formatMegabytes(totalBytes) })}
              </div>
            )}
            <button
              type="button"
              onClick={() => void downloadUpdate()}
              className="hx-pressable flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              <span>{t("update.downloadBtn")}</span>
            </button>
          </div>
        )}

        {phase === "downloading" && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-mono text-[11px] text-cyan-700 dark:text-cyan-300">
              <span>{t("update.downloading")}</span>
              <span>
                {formatMegabytes(downloadedBytes)} / {formatMegabytes(totalBytes)} ({pct}%)
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--hx-muted)]">
              <div
                className="h-full rounded-full bg-cyan-500 transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {phase === "ready" && (
          <div className="space-y-2.5">
            <div className="space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-50/80 px-2.5 py-2 text-[11px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
              {updateStatus?.verifiedSha256 && (
                <div className="flex items-center gap-1.5 font-mono font-semibold">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>{t("update.shaVerified")}</span>
                </div>
              )}
              <div>{t("update.backupNotice")}</div>
            </div>
            <button
              type="button"
              onClick={() => void installUpdate()}
              className="hx-pressable flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
            >
              <Check className="h-3.5 w-3.5" />
              <span>{t("update.installNow")}</span>
            </button>
          </div>
        )}

        {phase === "installing" && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-50/80 px-3 py-2.5 text-[11px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>
              {t("update.installingBackup", { tag: updateStatus?.backupTag ?? "pre-update" })}
            </span>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-2">
            <div className="rounded-lg border border-rose-500/35 bg-rose-50/80 p-2.5 text-[11px] text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
              {updateStatus?.error ?? t("update.errorDefault")}
            </div>
            <button
              type="button"
              onClick={() => void checkForUpdates()}
              className="hx-pressable flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-50 px-3 py-1.5 font-medium text-rose-800 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-200"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{t("common.retry")}</span>
            </button>
          </div>
        )}

        {(phase === "idle" || phase === "up_to_date" || phase === "checking") && (
          <div className="flex items-center justify-between text-[11px] text-[var(--hx-text-2)]">
            <span>
              {phase === "checking"
                ? t("update.checking")
                : phase === "up_to_date"
                  ? t("update.upToDate")
                  : t("update.clickToCheck")}
            </span>
            <button
              type="button"
              onClick={() => void checkForUpdates()}
              className="hx-pressable rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2.5 py-1 text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
            >
              {t("update.checkBtn")}
            </button>
          </div>
        )}
      </div>
    </AnimatedPopover>
  );
}
