import { useCallback, useRef, useState } from "react";

/** Debounced busy flag so short ops don't flash chrome. */
export function useBusy(delayMs = 160) {
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);

  const beginBusy = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setBusy(true), delayMs);
  }, [delayMs]);

  const endBusy = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setBusy(false);
  }, []);

  return { busy, setBusy, beginBusy, endBusy };
}
