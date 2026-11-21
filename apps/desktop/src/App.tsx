import { useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { MigrationAlertBanner } from "./components/MigrationAlertBanner.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { NewTaskHome } from "./features/chat/NewTaskHome.tsx";
import { SideChatDrawer } from "./features/chat/SideChatDrawer.tsx";
import { ThreadWorkspace } from "./features/chat/ThreadWorkspace.tsx";
import { EvolutionLabView } from "./features/evolution/EvolutionLabView.tsx";
import { ProposalsView } from "./features/evolution/ProposalsView.tsx";
import { CommandDeckView } from "./features/harness/CommandDeckView.tsx";
import { GenomeDeckPanel } from "./features/harness/GenomeDeckPanel.tsx";
import { OnboardingCrucibleModal } from "./features/onboarding/OnboardingCrucibleModal.tsx";
import { ProvidersPanel } from "./features/providers/ProvidersPanel.tsx";
import { SecurityCenterPanel } from "./features/security/SecurityCenterPanel.tsx";
import { SettingsView } from "./features/settings/SettingsView.tsx";
import { useI18n } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";
import { useCommandDeckStore } from "./stores/useCommandDeckStore.ts";

export function App() {
  const {
    initialized,
    loading,
    activePage,
    initialize,
    disposeSubscription,
    toggleSideChat,
    toasts,
    dismissToast,
  } = useCommandDeckStore();
  const { t } = useI18n();

  useEffect(() => {
    void initialize();
    return () => disposeSubscription();
  }, [initialize, disposeSubscription]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ";") {
        e.preventDefault();
        toggleSideChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSideChat]);

  if (!initialized && loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center gap-2.5 bg-[var(--hx-canvas)] text-sm text-[var(--hx-text-2)]">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--hx-accent)]" />
        <span>{t("common.loading")}</span>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--hx-canvas)] text-[var(--hx-text)]">
      {/* Left Navigation Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <MigrationAlertBanner />

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {activePage === "home" && <NewTaskHome />}
          {activePage === "thread" && <ThreadWorkspace />}
          {activePage === "deck" && <CommandDeckView />}
          {activePage === "lab" && <EvolutionLabView />}
          {activePage === "proposals" && <ProposalsView />}
          {activePage === "history" && (
            <div className="flex-1 overflow-hidden bg-[var(--hx-canvas)]">
              <GenomeDeckPanel />
            </div>
          )}
          {activePage === "security" && (
            <div className="flex-1 overflow-hidden bg-[var(--hx-canvas)]">
              <SecurityCenterPanel />
            </div>
          )}
          {activePage === "providers" && (
            <div className="flex-1 overflow-hidden bg-[var(--hx-canvas)]">
              <ProvidersPanel />
            </div>
          )}
          {activePage === "settings" && <SettingsView />}
        </div>
      </div>

      {/* Overlays */}
      <SideChatDrawer />
      <OnboardingCrucibleModal />

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-5 z-50 flex max-w-sm flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              style={{ boxShadow: "var(--hx-shadow-popover)" }}
              className={cn(
                "hx-modal flex items-start justify-between gap-2.5 rounded-2xl border px-3.5 py-2.5 text-xs backdrop-blur",
                toast.tone === "success"
                  ? "border-emerald-500/35 bg-emerald-50/95 text-emerald-900 dark:bg-emerald-950/90 dark:text-emerald-100"
                  : toast.tone === "warning"
                    ? "border-amber-500/35 bg-amber-50/95 text-amber-900 dark:bg-amber-950/90 dark:text-amber-100"
                    : toast.tone === "error"
                      ? "border-rose-500/35 bg-rose-50/95 text-rose-900 dark:bg-rose-950/90 dark:text-rose-100"
                      : "border-[var(--hx-border-strong)] bg-[var(--hx-surface)]/95 text-[var(--hx-text)]",
              )}
            >
              <div>
                <div className="font-semibold">{toast.title}</div>
                {toast.detail && <div className="mt-0.5 text-[11px] opacity-85">{toast.detail}</div>}
              </div>
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => dismissToast(toast.id)}
                className="rounded-md p-0.5 opacity-65 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
