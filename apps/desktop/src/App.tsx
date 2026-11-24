import { Suspense, lazy, useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { CommandPaletteModal } from "./components/CommandPaletteModal.tsx";
import { MigrationAlertBanner } from "./components/MigrationAlertBanner.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { NewTaskHome } from "./features/chat/NewTaskHome.tsx";
import { SideChatDrawer } from "./features/chat/SideChatDrawer.tsx";
import { ThreadWorkspace } from "./features/chat/ThreadWorkspace.tsx";
import { useI18n } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";
import { useCommandDeckStore } from "./stores/useCommandDeckStore.ts";

const CommandDeckView = lazy(() =>
  import("./features/harness/CommandDeckView.tsx").then((m) => ({ default: m.CommandDeckView })),
);
const EvolutionLabView = lazy(() =>
  import("./features/evolution/EvolutionLabView.tsx").then((m) => ({
    default: m.EvolutionLabView,
  })),
);
const ProposalsView = lazy(() =>
  import("./features/evolution/ProposalsView.tsx").then((m) => ({ default: m.ProposalsView })),
);
const GenomeDeckPanel = lazy(() =>
  import("./features/harness/GenomeDeckPanel.tsx").then((m) => ({ default: m.GenomeDeckPanel })),
);
const SecurityCenterPanel = lazy(() =>
  import("./features/security/SecurityCenterPanel.tsx").then((m) => ({
    default: m.SecurityCenterPanel,
  })),
);
const ProvidersPanel = lazy(() =>
  import("./features/providers/ProvidersPanel.tsx").then((m) => ({ default: m.ProvidersPanel })),
);
const SettingsView = lazy(() =>
  import("./features/settings/SettingsView.tsx").then((m) => ({ default: m.SettingsView })),
);
const OnboardingCrucibleModal = lazy(() =>
  import("./features/onboarding/OnboardingCrucibleModal.tsx").then((m) => ({
    default: m.OnboardingCrucibleModal,
  })),
);

function ViewSuspenseFallback() {
  return (
    <div className="flex flex-1 items-center justify-center bg-[var(--hx-canvas)]">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--hx-accent)]" />
    </div>
  );
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function App() {
  const {
    initialized,
    loading,
    activePage,
    setActivePage,
    initialize,
    disposeSubscription,
    toggleSideChat,
    toggleSidebar,
    toggleCommandPalette,
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
      if (e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      const lower = e.key.toLowerCase();
      if (lower === "k") {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (e.key === ";") {
        e.preventDefault();
        toggleSideChat();
        return;
      }

      if (isEditableEventTarget(e.target)) return;

      if (lower === "n") {
        e.preventDefault();
        setActivePage("home");
      } else if (lower === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleCommandPalette, toggleSideChat, setActivePage, toggleSidebar]);

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
          <Suspense fallback={<ViewSuspenseFallback />}>
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
          </Suspense>
        </div>
      </div>

      {/* Overlays */}
      <SideChatDrawer />
      <CommandPaletteModal />
      <Suspense fallback={null}>
        <OnboardingCrucibleModal />
      </Suspense>

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
