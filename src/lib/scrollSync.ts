/** Sync scroll ratio between two overflow containers (split source ↔ preview). */

export function scrollRatio(el: HTMLElement): number {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 1) return 0;
  return Math.min(1, Math.max(0, el.scrollTop / max));
}

export function applyScrollRatio(el: HTMLElement, ratio: number): void {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 1) return;
  const next = Math.round(ratio * max);
  if (Math.abs(el.scrollTop - next) > 1) el.scrollTop = next;
}

/**
 * Find the nearest scrollable descendant (CodeMirror scroller / reader-scroll).
 */
export function findScrollable(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  if (root.scrollHeight > root.clientHeight + 2) return root;
  const preferred = root.querySelector<HTMLElement>(
    ".cm-scroller, .reader-scroll, .large-file-page, .markdown-body",
  );
  if (preferred && preferred.scrollHeight > preferred.clientHeight + 2) {
    return preferred;
  }
  const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
  for (const el of all) {
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if (
      (oy === "auto" || oy === "scroll" || oy === "overlay") &&
      el.scrollHeight > el.clientHeight + 2
    ) {
      return el;
    }
  }
  return root;
}
