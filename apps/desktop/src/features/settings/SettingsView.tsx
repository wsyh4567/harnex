import { useState } from "react";
import { CheckCircle2, Flame, Keyboard, Languages, Moon, RefreshCw, ShieldCheck, Sun } from "lucide-react";
import tauriConfig from "../../../src-tauri/tauri.conf.json";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs.tsx";
import { SUPPORTED_LOCALES, useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";

type SettingsTab = "general" | "updates" | "crucible";

export function SettingsView() {
  const {
    theme,
    setTheme,
    updateStatus,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    compatibilityReport,
    checkHarnessCompatibility,
    startHarnessMigration,
    isMigrating,
    openOnboarding,
  } = useCommandDeckStore();
  const { locale, setLocale, t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--hx-canvas)]">
      {/* Header + Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hx-border)] px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--hx-text)]">{t("settings.title")}</h2>
          <p className="text-xs text-[var(--hx-text-3)]">{t("settings.subtitle")}</p>
        </div>

        <SegmentedTabs
          value={tab}
          onChange={setTab}
          items={[
            { id: "general", label: t("settings.tabGeneral") },
            { id: "updates", label: t("settings.tabUpdates") },
            { id: "crucible", label: t("settings.tabCrucible") },
          ]}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">

        {tab === "general" && (
          <div className="h-full overflow-y-auto p-6">
            <div className="mx-auto max-w-2xl space-y-6">
              {/* Theme Selection */}
              <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-5">
                <h3 className="text-xs font-semibold text-[var(--hx-text)]">
                  {t("settings.themeTitle")}
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setTheme("light")}
                    className={cn(
                      "hx-pressable flex items-center gap-3 rounded-xl border p-3.5 text-left text-xs",
                      theme === "light"
                        ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-text)]"
                        : "border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text-2)]",
                    )}
                  >
                    <Sun className="h-4 w-4 text-amber-500" />
                    <span className="font-medium">{t("settings.themeLight")}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTheme("dark")}
                    className={cn(
                      "hx-pressable flex items-center gap-3 rounded-xl border p-3.5 text-left text-xs",
                      theme === "dark"
                        ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-text)]"
                        : "border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text-2)]",
                    )}
                  >
                    <Moon className="h-4 w-4 text-indigo-400" />
                    <span className="font-medium">{t("settings.themeDark")}</span>
                  </button>
                </div>
              </section>

              {/* Language Selection */}
              <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-5">
                <div>
                  <h3 className="text-xs font-semibold text-[var(--hx-text)]">
                    {t("settings.languageTitle")}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--hx-text-3)]">
                    {t("settings.languageDesc")}
                  </p>
                </div>

                <ChoiceMenu
                  ariaLabel={t("settings.languageTitle")}
                  value={locale}
                  options={SUPPORTED_LOCALES.map((loc) => ({
                    value: loc.code,
                    label: loc.nativeLabel,
                    badge: loc.shortLabel,
                  }))}
                  onChange={setLocale}
                  prefixIcon={<Languages className="h-3.5 w-3.5 text-[var(--hx-accent)]" />}
                  buttonClassName="min-w-40"
                  menuClassName="w-48"
                />
              </section>

              {/* Keyboard Shortcuts Reference */}
              {(() => {
                const isMac =
                  typeof navigator !== "undefined" &&
                  /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? "");
                const mod = isMac ? "⌘" : "Ctrl+";
                const shortcuts = [
                  { keys: [`${mod}K`], label: t("settings.shortcutPalette") },
                  { keys: [`${mod}N`], label: t("settings.shortcutNewTask") },
                  { keys: [`${mod}B`], label: t("settings.shortcutSidebar") },
                  { keys: [`${mod};`], label: t("settings.shortcutSideChat") },
                  { keys: ["j", "k"], label: t("settings.shortcutProposalsNav") },
                  { keys: ["d"], label: t("settings.shortcutProposalsDiff") },
                  { keys: ["Esc"], label: t("settings.shortcutEsc") },
                ];

                return (
                  <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-5">
                    <div className="flex items-start gap-2.5">
                      <Keyboard className="mt-0.5 h-4 w-4 shrink-0 text-[var(--hx-accent)]" />
                      <div>
                        <h3 className="text-xs font-semibold text-[var(--hx-text)]">
                          {t("settings.shortcutsTitle")}
                        </h3>
                        <p className="mt-0.5 text-xs text-[var(--hx-text-3)]">
                          {t("settings.shortcutsDesc")}
                        </p>
                      </div>
                    </div>

                    <div className="divide-y divide-[var(--hx-border)] rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)]/50">
                      {shortcuts.map((item) => (
                        <div
                          key={item.label}
                          className="flex items-center justify-between gap-3 px-3.5 py-2 text-xs"
                        >
                          <span className="text-[var(--hx-text-2)]">{item.label}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            {item.keys.map((keyLabel, idx) => (
                              <span key={keyLabel} className="inline-flex items-center gap-1">
                                {idx > 0 && (
                                  <span className="text-[10px] text-[var(--hx-text-3)]">/</span>
                                )}
                                <kbd className="rounded-md border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--hx-text)] shadow-2xs">
                                  {keyLabel}
                                </kbd>
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })()}
            </div>
          </div>
        )}

        {tab === "updates" && (
          <div className="h-full overflow-y-auto p-6">
            <div className="mx-auto max-w-2xl space-y-5">
              {/* Auto-Updater */}
              <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-5 text-xs">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-[var(--hx-text)]">{t("update.dialogTitle")}</h3>
                    <p className="mt-0.5 font-mono text-[11px] text-[var(--hx-text-3)]">
                      {t("update.currentVersion", {
                        version: updateStatus?.info.currentVersion ?? tauriConfig.version,
                      })}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void checkForUpdates()}
                      className="hx-pressable inline-flex items-center gap-1.5 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 font-medium text-[var(--hx-text)]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>{t("settings.checkUpdatesBtn")}</span>
                    </button>
                    {updateStatus?.phase === "available" && (
                      <button
                        type="button"
                        onClick={() => void downloadUpdate()}
                        className="hx-pressable rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white"
                      >
                        {t("update.downloadBtn")}
                      </button>
                    )}
                    {updateStatus?.phase === "ready" && (
                      <button
                        type="button"
                        onClick={() => void installUpdate()}
                        className="hx-pressable rounded-xl bg-emerald-600 px-3 py-1.5 font-semibold text-white"
                      >
                        {t("update.installNow")}
                      </button>
                    )}
                  </div>
                </div>
              </section>

              {/* Compatibility Check */}
              <section className="space-y-3 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <h3 className="font-semibold text-[var(--hx-text)]">
                      {t("settings.compatTitle")}
                    </h3>
                  </div>

                  <button
                    type="button"
                    onClick={() => void checkHarnessCompatibility()}
                    className="hx-pressable rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 font-medium text-[var(--hx-text)]"
                  >
                    {t("settings.checkCompatBtn")}
                  </button>
                </div>

                {compatibilityReport?.hasBreakingIssues ? (
                  <div className="space-y-2 rounded-xl border border-amber-500/35 bg-amber-50/75 p-3 dark:bg-amber-950/20">
                    <div className="font-medium text-amber-900 dark:text-amber-200">
                      {t("migration.title", { count: compatibilityReport.issues.length })}
                    </div>
                    <button
                      type="button"
                      disabled={isMigrating}
                      onClick={() => void startHarnessMigration()}
                      className="hx-pressable rounded-xl bg-amber-500 px-3 py-1.5 font-semibold text-white"
                    >
                      {isMigrating ? t("migration.migrating") : t("migration.autoMigrate")}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-[var(--hx-text-2)]">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span>
                      {t("settings.compatClean", {
                        version: compatibilityReport?.expectedSchemaVersion ?? 1,
                      })}
                    </span>
                  </div>
                )}
              </section>
            </div>
          </div>
        )}

        {tab === "crucible" && (
          <div className="h-full overflow-y-auto p-6">
            <div className="mx-auto max-w-xl rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-6 text-center space-y-4">
              <Flame className="mx-auto h-8 w-8 text-amber-500" />
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[var(--hx-text)]">{t("onb.title")}</h3>
                <p className="text-xs text-[var(--hx-text-2)]">{t("onb.estDurationDesc")}</p>
              </div>
              <button
                type="button"
                onClick={() => openOnboarding(true)}
                className="hx-pressable inline-flex items-center gap-2 rounded-xl bg-[var(--hx-text)] px-4 py-2 text-xs font-semibold text-[var(--hx-canvas)]"
              >
                <Flame className="h-3.5 w-3.5 text-amber-400" />
                <span>{t("top.openCrucible")}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
