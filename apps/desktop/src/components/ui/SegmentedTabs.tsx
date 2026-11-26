import { useCallback, useEffect, useRef, useState } from "react";
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const container = listRef.current;
    const activeEl = buttonRefs.current[value];
    if (!container || !activeEl) return;
    setIndicator({
      left: activeEl.offsetLeft,
      width: activeEl.offsetWidth,
    });
  }, [value]);

  useEffect(() => {
    measure();
    const container = listRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    for (const item of items) {
      const btn = buttonRefs.current[item.id];
      if (btn) observer.observe(btn);
    }
    return () => observer.disconnect();
  }, [measure, items]);

  return (
    <div
      ref={listRef}
      role="tablist"
      className={cn(
        "relative inline-flex items-center gap-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] p-1",
        className,
      )}
    >
      {indicator && indicator.width > 0 && (
        <span
          aria-hidden="true"
          style={{
            width: `${indicator.width}px`,
            transform: `translate3d(${indicator.left}px, 0, 0)`,
            boxShadow: "var(--hx-seg-edge)",
            transition:
              "transform 220ms var(--ease-out-fluid), width 220ms var(--ease-out-fluid)",
          }}
          className="pointer-events-none absolute top-1 bottom-1 left-0 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)]"
        />
      )}

      {items.map((item) => {
        const active = item.id === value;
        const useFallbackSurface = active && (!indicator || indicator.width === 0);
        return (
          <button
            key={item.id}
            ref={(el) => {
              buttonRefs.current[item.id] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            style={useFallbackSurface ? { boxShadow: "var(--hx-seg-edge)" } : undefined}
            className={cn(
              "hx-pressable relative z-10 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium",
              active
                ? useFallbackSurface
                  ? "border-[var(--hx-border)] bg-[var(--hx-surface)] text-[var(--hx-text)]"
                  : "border-transparent text-[var(--hx-text)]"
                : "border-transparent text-[var(--hx-text-2)] hover:text-[var(--hx-text)]",
            )}
          >
            <span>{item.label}</span>
            {item.badge !== undefined && Number(item.badge) > 0 && (
              <span
                className={cn(
                  "hx-num rounded-full px-1.5 py-0.2 font-mono text-[10px] transition-colors",
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
