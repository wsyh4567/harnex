import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, X } from "lucide-react";
import { CommandPaletteModal } from "./components/CommandPaletteModal.tsx";
import { MigrationAlertBanner } from "./components/MigrationAlertBanner.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { NewTaskHome } from "./features/chat/NewTaskHome.tsx";
import { SideChatDrawer } from "./features/chat/SideChatDrawer.tsx";
import { ThreadWorkspace } from "./features/chat/ThreadWorkspace.tsx";
import { useI18n } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";
import { useCommandDeckStore, type ToastNotice } from "./stores/useCommandDeckStore.ts";

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

function ToastItem({
  toast,
  closeLabel,
  onDismiss,
}: {
  toast: ToastNotice;
  closeLabel: string;
  onDismiss: (id: string) => void;
}) {
  const durationMs = toast.durationMs ?? 4500;
  const [closing, setClosing] = useState(false);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(durationMs);
  const startedAtRef = useRef(Date.now());
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const triggerClose = () => {
    setClosing(true);
    window.setTimeout(() => dismissRef.current(toast.id), 145);
  };

  useEffect(() => {
    if (closing || paused || durationMs <= 0) return;
    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => {
      setClosing(true);
      window.setTimeout(() => dismissRef.current(toast.id), 145);
    }, Math.max(250, remainingRef.current));
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    };
  }, [closing, paused, durationMs, toast.id]);

  return (
    <div
      data-state={closing ? "closing" : "open"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      style={
        {
          boxShadow: "var(--hx-shadow-popover)",
          "--hx-toast-duration": `${durationMs}ms`,
        } as React.CSSProperties
      }
      className={cn(
        "hx-toast hx-modal relative overflow-hidden flex items-start justify-between gap-2.5 rounded-2xl border px-3.5 py-2.5 text-xs backdrop-blur",
        toast.tone === "success"
          ? "border-emerald-500/35 bg-emerald-50/95 text-emerald-900 dark:bg-emerald-950/90 dark:text-emerald-100"
          : toast.tone === "warning"
            ? "border-amber-500/35 bg-amber-50/95 text-amber-900 dark:bg-amber-950/90 dark:text-amber-100"
            : toast.tone === "error"
              ? "border-rose-500/35 bg-rose-50/95 text-rose-900 dark:bg-rose-950/90 dark:text-rose-100"
              : "border-[var(--hx-border-strong)] bg-[var(--hx-surface)]/95 text-[var(--hx-text)]",
      )}
    >
      <div className="min-w-0">
        <div className="font-semibold">{toast.title}</div>
        {toast.detail && <div className="mt-0.5 break-words text-[11px] opacity-85">{toast.detail}</div>}
      </div>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={triggerClose}
        className="shrink-0 rounded-md p-0.5 opacity-65 transition-opacity hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {durationMs > 0 && (
        <span
          aria-hidden="true"
          className={cn(
            "hx-toast-bar pointer-events-none absolute inset-x-0 bottom-0 h-[2px] opacity-45",
            toast.tone === "success"
              ? "bg-emerald-500"
              : toast.tone === "warning"
                ? "bg-amber-500"
                : toast.tone === "error"
                  ? "bg-rose-500"
                  : "bg-[var(--hx-accent)]",
          )}
        />
      )}
    </div>
  );
}

export function App() {
  const {
    initialized,
    loading,
    initError,
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

  if (!initialized && initError) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--hx-canvas)] p-6">
        <div
          style={{ boxShadow: "var(--hx-shadow-float)" }}
          className="hx-modal w-full max-w-md space-y-4 rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] p-6 text-center text-xs"
        >
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
            <AlertCircle className="h-5 w-5" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-sm font-semibold text-[var(--hx-text)]">
              {t("init.errorTitle")}
            </h1>
            <p className="text-xs leading-relaxed text-[var(--hx-text-2)]">
              {t("init.errorHint")}
            </p>
            <div className="rounded-xl border border-rose-500/25 bg-rose-50/75 px-3 py-2 font-mono text-[11px] break-words text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
              {initError}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void initialize()}
            className="hx-pressable inline-flex items-center gap-1.5 rounded-xl bg-[var(--hx-text)] px-4 py-2 text-xs font-semibold text-[var(--hx-canvas)] hover:opacity-90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t("init.retryBtn")}</span>
          </button>
        </div>
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

        <div key={activePage} className="hx-page-enter flex flex-1 min-h-0 overflow-hidden">
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

      {/* Auto-Dismissing Toast Stack */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-5 z-50 flex w-full max-w-sm flex-col gap-2">
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              closeLabel={t("common.close")}
              onDismiss={dismissToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
