import { useI18n } from "../../i18n/index.ts";
import { cn } from "../../lib/utils.ts";
import type { CompletionOption, CompletionTrigger } from "./promptCompletions.ts";

interface PromptCompletionMenuProps {
  trigger: CompletionTrigger;
  options: CompletionOption[];
  highlightIdx: number;
  onHighlight: (idx: number) => void;
  onSelect: (option: CompletionOption) => void;
  testId?: string;
}

/** Floating `/` and `@` prompt completion listbox shared across task and lab composers. */
export function PromptCompletionMenu({
  trigger,
  options,
  highlightIdx,
  onHighlight,
  onSelect,
  testId = "composer-completion-menu",
}: PromptCompletionMenuProps) {
  const { t } = useI18n();

  return (
    <div
      role="listbox"
      data-testid={testId}
      data-side="top"
      style={{ boxShadow: "var(--hx-shadow-popover)" }}
      className="hx-popover absolute bottom-full left-0 z-50 mb-2 w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--hx-border)] px-3 py-1.5 text-[10px] font-medium text-[var(--hx-text-3)]">
        <span>
          {trigger.kind === "slash" ? t("composer.slashGroup") : t("composer.contextGroup")}
        </span>
        <span className="font-mono">{t("composer.navHint")}</span>
      </div>

      <div className="max-h-60 space-y-0.5 overflow-y-auto p-1.5">
        {options.map((opt, idx) => {
          const active = idx === highlightIdx;
          return (
            <button
              key={opt.id}
              type="button"
              role="option"
              aria-selected={active}
              onMouseEnter={() => onHighlight(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(opt);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs",
                active
                  ? "bg-[var(--hx-accent-soft)] text-[var(--hx-text)]"
                  : "text-[var(--hx-text)] hover:bg-[var(--hx-subtle)]",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[11px] font-semibold text-[var(--hx-accent)]">
                    {opt.label}
                  </span>
                </div>
                {opt.description && (
                  <div className="truncate text-[11px] text-[var(--hx-text-2)]">
                    {opt.description}
                  </div>
                )}
              </div>
              {opt.badge && (
                <span
                  className={cn(
                    "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px]",
                    opt.badgeTone === "emerald"
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                      : opt.badgeTone === "accent"
                        ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                        : "bg-[var(--hx-subtle)] text-[var(--hx-text-3)]",
                  )}
                >
                  {opt.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
