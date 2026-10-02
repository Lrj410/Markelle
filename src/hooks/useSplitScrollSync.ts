import { useEffect, useRef, type RefObject } from "react";
import { applyScrollRatio, findScrollable, scrollRatio } from "../lib/scrollSync";

/**
 * Keep two panes' scroll positions in sync by ratio.
 * Ignores echo events for a short window after programmatic applies.
 */
export function useSplitScrollSync(
  leftRoot: RefObject<HTMLElement | null>,
  rightRoot: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  const lockUntil = useRef(0);
  const lastSrc = useRef<"left" | "right" | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const leftHost = leftRoot.current;
    const rightHost = rightRoot.current;
    if (!leftHost || !rightHost) return;

    let left = findScrollable(leftHost);
    let right = findScrollable(rightHost);
    if (!left || !right) return;

    const syncFrom = (
      side: "left" | "right",
      src: HTMLElement,
      dst: HTMLElement,
    ) => {
      const now = performance.now();
      // Ignore echo from the other pane; allow the same side to keep driving.
      if (now < lockUntil.current && lastSrc.current && lastSrc.current !== side) {
        return;
      }
      const before = dst.scrollTop;
      applyScrollRatio(dst, scrollRatio(src));
      if (Math.abs(dst.scrollTop - before) > 1) {
        lastSrc.current = side;
        lockUntil.current = now + 80;
      }
    };

    const onLeft = () => {
      right = findScrollable(rightHost) ?? right;
      if (right) syncFrom("left", left!, right);
    };
    const onRight = () => {
      left = findScrollable(leftHost) ?? left;
      if (left) syncFrom("right", right!, left);
    };

    left.addEventListener("scroll", onLeft, { passive: true });
    right.addEventListener("scroll", onRight, { passive: true });

    // Re-bind when layout settles (CM mount, markdown paint).
    const timer = window.setTimeout(() => {
      const l2 = findScrollable(leftHost);
      const r2 = findScrollable(rightHost);
      if (l2 && left && l2 !== left) {
        left.removeEventListener("scroll", onLeft);
        left = l2;
        left.addEventListener("scroll", onLeft, { passive: true });
      }
      if (r2 && right && r2 !== right) {
        right.removeEventListener("scroll", onRight);
        right = r2;
        right.addEventListener("scroll", onRight, { passive: true });
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
      left?.removeEventListener("scroll", onLeft);
      right?.removeEventListener("scroll", onRight);
    };
  }, [leftRoot, rightRoot, enabled]);
}
