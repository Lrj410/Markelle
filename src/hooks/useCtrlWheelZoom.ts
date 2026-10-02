import { useEffect, useRef } from "react";
import {
  applyFontSizeCss,
  clampFontSize,
  wheelDeltaToSteps,
} from "../lib/fontSize";

/**
 * Ctrl/Meta + wheel → body/source font size.
 * Hot path only touches CSS vars + a CustomEvent (CM remeasure); React state
 * commits on a short debounce so App/toolbar do not re-render every tick.
 */
export function useCtrlWheelZoom(
  fontSize: number,
  onFontSize: (next: number) => void,
  enabled = true,
): void {
  const liveRef = useRef(fontSize);
  const onFontSizeRef = useRef(onFontSize);
  onFontSizeRef.current = onFontSize;
  const accRef = useRef({ value: 0 });
  const commitTimerRef = useRef(0);

  useEffect(() => {
    liveRef.current = fontSize;
    applyFontSizeCss(fontSize);
  }, [fontSize]);

  useEffect(() => {
    if (!enabled) return;

    const commit = () => {
      commitTimerRef.current = 0;
      onFontSizeRef.current(liveRef.current);
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      // Keep graph pan/zoom on plain wheel; Ctrl+wheel is always type size.
      event.preventDefault();

      const steps = wheelDeltaToSteps(event.deltaY, event.deltaMode, accRef.current);
      if (!steps) return;

      const next = clampFontSize(liveRef.current + steps);
      if (next === liveRef.current) return;
      liveRef.current = next;
      applyFontSizeCss(next);

      if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = window.setTimeout(commit, 140);
    };

    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
    };
  }, [enabled]);
}
