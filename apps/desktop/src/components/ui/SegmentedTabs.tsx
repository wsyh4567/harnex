import { cn } from "../../lib/utils.ts";

export interface SegmentedTabItem<T extends string> {
  id: T;
  label: string;
  badge?: number | string;
}

interface SegmentedTabsProps<T extends string> {
  value: T;
  items: Array<SegmentedTabItem<T>>;
  onChange: (id: T) => void;
  className?: string;
}

export function SegmentedTabs<T extends string>({
  value,
  items,
  onChange,
  className,
}: SegmentedTabsProps<T>) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-1",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            className={cn(
              "hx-pressable inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium",
              active
                ? "bg-[var(--hx-surface)] text-[var(--hx-text)] shadow-xs border border-[var(--hx-border)]"
                : "border border-transparent text-[var(--hx-text-2)] hover:text-[var(--hx-text)]",
            )}
          >
            <span>{item.label}</span>
            {item.badge !== undefined && Number(item.badge) > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.2 font-mono text-[10px]",
                  active
                    ? "bg-[var(--hx-accent-soft)] text-[var(--hx-accent)]"
                    : "bg-[var(--hx-muted)] text-[var(--hx-text-2)]",
                )}
              >
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
