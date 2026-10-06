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

    const leftInitial = findScrollable(leftHost);
    const rightInitial = findScrollable(rightHost);
    if (!leftInitial || !rightInitial) return;
    let left: HTMLElement = leftInitial;
    let right: HTMLElement = rightInitial;

    // Track every element we attach a listener to. The 200ms re-bind can swap
    // the scrollable node, so the cleanup must unbind each element explicitly
    // rather than trusting a single (reassigned) variable.
    const leftBound = new Set<HTMLElement>();
    const rightBound = new Set<HTMLElement>();

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
      const r = findScrollable(rightHost);
      if (r) right = r;
      syncFrom("left", left, right);
    };
    const onRight = () => {
      const l = findScrollable(leftHost);
      if (l) left = l;
      syncFrom("right", right, left);
    };

    const bindLeft = (el: HTMLElement) => {
      if (leftBound.has(el)) return;
      leftBound.add(el);
      el.addEventListener("scroll", onLeft, { passive: true });
    };
    const bindRight = (el: HTMLElement) => {
      if (rightBound.has(el)) return;
      rightBound.add(el);
      el.addEventListener("scroll", onRight, { passive: true });
    };

    bindLeft(left);
    bindRight(right);

    // Re-bind when layout settles (CM mount, markdown paint).
    const timer = window.setTimeout(() => {
      const l2 = findScrollable(leftHost);
      const r2 = findScrollable(rightHost);
      if (l2 && l2 !== left) {
        left.removeEventListener("scroll", onLeft);
        leftBound.delete(left);
        left = l2;
        bindLeft(left);
      }
      if (r2 && r2 !== right) {
        right.removeEventListener("scroll", onRight);
        rightBound.delete(right);
        right = r2;
        bindRight(right);
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
      // Unbind every element we ever attached to, even if the node was swapped.
      for (const el of leftBound) el.removeEventListener("scroll", onLeft);
      for (const el of rightBound) el.removeEventListener("scroll", onRight);
      leftBound.clear();
      rightBound.clear();
    };
  }, [leftRoot, rightRoot, enabled]);
}
