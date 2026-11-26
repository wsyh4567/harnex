import { useEffect, useState } from "react";

/**
 * Keeps an overlay/element mounted briefly while its CSS exit transition runs
 * (`data-state="open"` -> `data-state="closing"`), and immediately cancels exit if re-opened.
 */
export function useAnimatedPresence(
  open: boolean,
  exitMs = 170,
): { rendered: boolean; closing: boolean } {
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
    const timer = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [open, rendered, exitMs]);

  return { rendered, closing };
}
