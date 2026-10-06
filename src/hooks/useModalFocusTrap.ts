import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function listFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export interface ModalFocusTrapOptions {
  /** When false, the trap is inactive. */
  active: boolean;
  /** Element that contains focusable controls (panel, not overlay). */
  containerRef: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  /** CSS selector preferred for initial focus (e.g. `.btn.primary`). */
  initialFocusSelector?: string;
  /** Restore focus to previously focused element on cleanup. Default true. */
  restoreFocus?: boolean;
}

/**
 * Trap Tab focus inside a modal panel, handle Escape, and restore focus on close.
 */
export function useModalFocusTrap({
  active,
  containerRef,
  onEscape,
  initialFocusSelector,
  restoreFocus = true,
}: ModalFocusTrapOptions): void {
  // Callers pass inline arrows (e.g. `onClose={() => setOpen(false)}`), so
  // `onEscape` is a fresh identity on every parent render. Keeping it in a ref
  // lets the trap effect depend only on real triggers (`active` / `containerRef`),
  // otherwise each keystroke inside the modal would re-run cleanup → refocus.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = containerRef.current;

    requestAnimationFrame(() => {
      const items = listFocusables(panel);
      const preferred = initialFocusSelector
        ? items.find((el) => el.matches(initialFocusSelector))
        : undefined;
      (preferred ?? items[0])?.focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = listFocusables(panel);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (restoreFocus) previouslyFocused?.focus?.();
    };
  }, [active, containerRef, initialFocusSelector, restoreFocus]);
}
