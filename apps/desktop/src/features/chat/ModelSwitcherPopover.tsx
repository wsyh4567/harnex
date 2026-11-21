import { useMemo, useState } from "react";
import type { AggregatedModelEntry, ProviderConfig, SlotBinding } from "@harnex/protocol";
import { Check, ChevronDown, Cpu, KeyRound, RotateCcw, Search, Star } from "lucide-react";
import { AnimatedPopover } from "../../components/ui/AnimatedPopover.tsx";
import { useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";
import { filterCatalogEntries, groupCatalogByProvider } from "../providers/modelCatalog.ts";

interface ModelSwitcherPopoverProps {
  catalog: AggregatedModelEntry[];
  providers?: ProviderConfig[];
  activeBinding: SlotBinding | undefined;
  isOverride: boolean;
  onSelect: (binding: SlotBinding) => void;
  onResetOverride: () => void;
  resetLabel?: string;
  testId?: string;
}

export function ModelSwitcherPopover({
  catalog,
  activeBinding,
  isOverride,
  onSelect,
  onResetOverride,
  resetLabel,
  testId = "chat-model-switcher-btn",
}: ModelSwitcherPopoverProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const providerGroups = useMemo(
    () => groupCatalogByProvider(filterCatalogEntries(catalog, query)),
    [catalog, query],
  );

  return (
    <AnimatedPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      side="top-right"
      panelClassName="w-80 overflow-hidden"
      trigger={
        <button
          type="button"
          data-testid={testId}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "hx-pressable flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-mono",
            isOverride
              ? "border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
              : "border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text-2)] hover:border-[var(--hx-border-strong)] hover:text-[var(--hx-text)]",
          )}
        >
          <Cpu className="h-3 w-3 shrink-0" />
          <span className="max-w-40 truncate">
            {activeBinding?.modelId ?? t("chat.selectModel")}
          </span>
          <ChevronDown
            data-open={open ? "true" : "false"}
            className="hx-chevron h-3 w-3 shrink-0 opacity-70"
          />
        </button>
      }
    >
      <div role="listbox" aria-label={t("chat.selectModel")}>
        <div className="flex items-center gap-2 border-b border-[var(--hx-border)] px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]" />
          <input
            type="text"
            autoFocus
            aria-label={t("chat.searchModels")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("chat.searchModels")}
            className="flex-1 bg-transparent text-xs text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)]"
          />
          {isOverride && (
            <button
              type="button"
              onClick={() => {
                onResetOverride();
                setOpen(false);
              }}
              className="hx-pressable flex items-center gap-1 rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              <span>{resetLabel ?? t("chat.resetSolver")}</span>
            </button>
          )}
        </div>

        <div className="max-h-72 space-y-2 overflow-y-auto p-1.5">
          {providerGroups.length === 0 ? (
            <div className="p-3 text-center text-xs text-[var(--hx-text-3)]">
              {t("chat.noMatchingModels")}
            </div>
          ) : (
            providerGroups.map((group) => (
              <div key={group.providerId} className="space-y-0.5">
                <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold tracking-wide text-[var(--hx-text-3)]">
                  <span className="truncate">{group.providerName}</span>
                  {group.entries[0] && group.entries[0].activeKeyCount > 1 && (
                    <span className="inline-flex items-center gap-0.5 font-mono text-[9px]">
                      <KeyRound className="h-2.5 w-2.5" />
                      {group.entries[0].activeKeyCount}
                    </span>
                  )}
                </div>
                {group.entries.map((entry) => {
                  const selected =
                    activeBinding?.providerId === entry.providerId &&
                    activeBinding?.modelId === entry.modelId;

                  return (
                    <button
                      key={entry.catalogId}
                      type="button"
                      onClick={() => {
                        onSelect({ providerId: entry.providerId, modelId: entry.modelId });
                        setOpen(false);
                        setQuery("");
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors",
                        selected
                          ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                          : "text-[var(--hx-text)] hover:bg-[var(--hx-subtle)]",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {entry.pinned && (
                          <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" />
                        )}
                        <span className="truncate">{entry.modelId}</span>
                      </span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </AnimatedPopover>
  );
}
