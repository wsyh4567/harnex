import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export type PopoverSide = "bottom" | "bottom-right" | "top" | "top-right";

interface AnimatedPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  side?: PopoverSide;
  className?: string;
  panelClassName?: string;
}

const SIDE_POSITION: Record<PopoverSide, string> = {
  bottom: "top-full left-0 mt-1.5",
  "bottom-right": "top-full right-0 mt-1.5",
  top: "bottom-full left-0 mb-1.5",
  "top-right": "bottom-full right-0 mb-1.5",
};

export function AnimatedPopover({
  open,
  onOpenChange,
  trigger,
  children,
  side = "bottom",
  className,
  panelClassName,
}: AnimatedPopoverProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, 135);
    return () => clearTimeout(timer);
  }, [open, rendered]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      {trigger}
      {rendered && (
        <div
          data-side={side}
          data-state={closing ? "closing" : "open"}
          style={{ boxShadow: "var(--hx-shadow-popover)" }}
          className={cn(
            "hx-popover absolute z-50 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)]",
            SIDE_POSITION[side],
            panelClassName,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
