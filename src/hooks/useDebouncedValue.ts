import { useEffect, useRef, useState } from "react";

/**
 * Debounce a rapidly changing value.
 *
 * Returns `value` unchanged once it has been stable for `delayMs`.
 * When `resetKey` changes, the new value is returned immediately (no delay),
 * so switching tabs never paints the previous document's value for a frame.
 */
export function useDebouncedValue<T>(
  value: T,
  delayMs: number,
  resetKey?: unknown,
): T {
  const [debounced, setDebounced] = useState(value);
  const prevResetKey = useRef(resetKey);
  const resetKeyChanged = resetKey !== prevResetKey.current;

  if (resetKeyChanged) {
    // Adjust during render so the fresh value is returned synchronously.
    prevResetKey.current = resetKey;
    setDebounced(value);
  }

  useEffect(() => {
    if (resetKeyChanged) return;
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs, resetKeyChanged]);

  return resetKeyChanged ? value : debounced;
}
