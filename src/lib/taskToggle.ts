/** Match GFM task list items at line start (indent + bullet + [ ]/[x]). */
const TASK_RE = /^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]/gm;

/** Count task checkboxes in source (same order as rendered `.task-list-item`). */
export function countTasks(source: string): number {
  TASK_RE.lastIndex = 0;
  let n = 0;
  while (TASK_RE.exec(source)) n += 1;
  return n;
}

/**
 * Toggle the `index`-th task checkbox (0-based, document order).
 * Returns updated source, or `null` if index is out of range.
 */
export function toggleTaskAt(source: string, index: number): string | null {
  if (index < 0) return null;
  TASK_RE.lastIndex = 0;
  let i = 0;
  let found = false;
  const next = source.replace(TASK_RE, (full, _indent: string, _bullet: string, mark: string) => {
    if (i++ !== index) return full;
    found = true;
    const checked = /[xX]/.test(mark);
    // Swap only the checkbox marker so the rest of the line (extra spaces,
    // custom bullets, trailing text) is preserved verbatim.
    return full.replace(/\[([ xX])\]/, checked ? "[ ]" : "[x]");
  });
  return found ? next : null;
}
