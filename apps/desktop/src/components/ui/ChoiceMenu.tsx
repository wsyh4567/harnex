import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "../../lib/utils.ts";
import { AnimatedPopover, type PopoverSide } from "./AnimatedPopover.tsx";

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
}

interface ChoiceMenuProps {
  value: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  side?: PopoverSide;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  prefixIcon?: ReactNode;
  testId?: string;
  disabled?: boolean;
}

export function ChoiceMenu({
  value,
  options,
  onChange,
  placeholder = "Select…",
  ariaLabel,
  searchable = false,
  searchPlaceholder = "Search…",
  side = "bottom",
  className,
  buttonClassName,
  menuClassName,
  prefixIcon,
  testId,
  disabled = false,
}: ChoiceMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.description?.toLowerCase().includes(q) ?? false),
    );
  }, [options, query]);

  const handleOpenChange = (next: boolean) => {
    if (disabled) return;
    setOpen(next);
    if (next) {
      const idx = Math.max(
        0,
        options.findIndex((o) => o.value === value),
      );
      setHighlightIdx(idx);
    } else {
      setQuery("");
    }
  };

  const selectOption = (opt: ChoiceOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    setQuery("");
  };

  return (
    <AnimatedPopover
      open={open}
      onOpenChange={handleOpenChange}
      side={side}
      className={className}
      panelClassName={cn("min-w-44 w-60 overflow-hidden p-1", menuClassName)}
      trigger={
        <button
          type="button"
          data-testid={testId}
          aria-label={ariaLabel}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => handleOpenChange(!open)}
          onKeyDown={(e) => {
            if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              handleOpenChange(true);
            } else if (open) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightIdx((i) => (filtered.length > 0 ? (i + 1) % filtered.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightIdx((i) =>
                  filtered.length > 0 ? (i - 1 + filtered.length) % filtered.length : 0,
                );
              } else if (e.key === "Enter" && filtered[highlightIdx]) {
                e.preventDefault();
                selectOption(filtered[highlightIdx]!);
              }
            }
          }}
          className={cn(
            "hx-pressable inline-flex items-center justify-between gap-2 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1.5 text-xs text-[var(--hx-text)] hover:border-[var(--hx-border-strong)] hover:bg-[var(--hx-subtle)] disabled:opacity-50",
            open && "border-[var(--hx-accent-border)] bg-[var(--hx-subtle)]",
            buttonClassName,
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {prefixIcon}
            <span className="truncate font-medium">{selected?.label ?? placeholder}</span>
          </span>
          <ChevronDown
            data-open={open ? "true" : "false"}
            className="hx-chevron h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]"
          />
        </button>
      }
    >
      {searchable && (
        <div className="mb-1 flex items-center gap-1.5 border-b border-[var(--hx-border)] px-2 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlightIdx(0);
            }}
            placeholder={searchPlaceholder}
            className="w-full bg-transparent text-xs text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)]"
          />
        </div>
      )}

      <div role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto space-y-0.5">
        {filtered.length === 0 ? (
          <div className="px-2.5 py-3 text-center text-[11px] text-[var(--hx-text-3)]">—</div>
        ) : (
          filtered.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isHighlighted = idx === highlightIdx;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={opt.disabled}
                onMouseEnter={() => setHighlightIdx(idx)}
                onClick={() => selectOption(opt)}
                className={cn(
                  "flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-40",
                  isSelected
                    ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                    : isHighlighted
                      ? "bg-[var(--hx-subtle)] text-[var(--hx-text)]"
                      : "text-[var(--hx-text)] hover:bg-[var(--hx-subtle)]",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{opt.label}</span>
                    {opt.badge && (
                      <span className="rounded bg-[var(--hx-muted)] px-1.5 py-0.2 font-mono text-[10px] text-[var(--hx-text-2)]">
                        {opt.badge}
                      </span>
                    )}
                  </div>
                  {opt.description && (
                    <div className="mt-0.5 truncate text-[11px] text-[var(--hx-text-3)]">
                      {opt.description}
                    </div>
                  )}
                </div>
                {isSelected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              </button>
            );
          })
        )}
      </div>
    </AnimatedPopover>
  );
}
