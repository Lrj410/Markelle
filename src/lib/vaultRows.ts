import type { VaultNode } from "./vault";

/**
 * Pure, React-free helpers that turn the recursive vault tree into the flat list
 * of lines the sidebar actually renders, plus the windowing maths used to render
 * only the visible slice of a very large vault.
 */

/** A single, flat line in the vault tree view. */
export interface VaultRow {
  /** Source node. For `empty` hint rows this is the parent directory node. */
  node: VaultNode;
  /** Nesting depth; root children are `0`. */
  depth: number;
  /** Stable React key, unique within a single flatten result. */
  key: string;
  /** True for the synthetic "empty folder" hint row shown under an open empty dir. */
  empty?: boolean;
}

/**
 * Which directories are expanded: either an explicit set of expanded paths, or a
 * predicate. The predicate form lets a caller express a default rule (e.g. every
 * directory shallower than depth 2 starts open) without pre-walking the tree.
 */
export type ExpandedInput =
  | ReadonlySet<string>
  | ((node: VaultNode, depth: number) => boolean);

export interface FlattenVaultRowsOptions {
  expanded: ExpandedInput;
  /**
   * Optional visibility filter (e.g. a search result set). When supplied, only
   * accepted nodes are emitted; a directory is kept — and implicitly expanded —
   * when it or any of its descendants is accepted, so matches stay reachable.
   */
  isVisible?: (node: VaultNode) => boolean;
}

export interface RowWindow {
  /** First rendered row index (inclusive). */
  start: number;
  /** Last rendered row index (exclusive). */
  end: number;
  /** Spacer height above the rendered rows, in px. */
  padTop: number;
  /** Spacer height below the rendered rows, in px. */
  padBottom: number;
}

/** Fixed row height for the virtualised tree; matches `.vault-row` metrics. */
export const VAULT_ROW_HEIGHT = 30;
/** Extra rows rendered above/below the viewport to mask scroll tearing. */
export const VAULT_OVERSCAN = 6;
/** At or below this many visible rows the tree renders in one pass. */
export const VAULT_VIRTUALIZE_THRESHOLD = 200;
/** Hard cap on tree depth — guards against a malformed/absurdly deep tree. */
export const VAULT_MAX_DEPTH = 256;

/**
 * Depth-first flatten of `root`'s descendants into render rows.
 *
 * `root` itself is never emitted; its children start at depth `0`. A directory
 * emits its own row even when collapsed — collapsing only hides descendants.
 */
export function flattenVaultRows(
  root: VaultNode,
  options: FlattenVaultRowsOptions,
): VaultRow[] {
  const { expanded, isVisible } = options;
  const isExpanded =
    typeof expanded === "function"
      ? expanded
      : (node: VaultNode) => expanded.has(node.path);

  const rows: VaultRow[] = [];
  const keepCache = isVisible ? new Map<VaultNode, boolean>() : null;

  const keep = (node: VaultNode): boolean => {
    if (!isVisible || !keepCache) return true;
    const cached = keepCache.get(node);
    if (cached !== undefined) return cached;
    keepCache.set(node, false); // guard against a malformed cyclic tree
    let result = isVisible(node);
    if (!result && node.kind === "dir") {
      for (const child of node.children ?? []) {
        if (keep(child)) {
          result = true;
          break;
        }
      }
    }
    keepCache.set(node, result);
    return result;
  };

  const walk = (node: VaultNode, depth: number): void => {
    if (!keep(node)) return;
    rows.push({ node, depth, key: node.path });
    if (node.kind !== "dir") return;
    // Never recurse past the depth cap (prevents a stack overflow on bad input).
    if (depth >= VAULT_MAX_DEPTH) return;

    // A filtered tree always reveals matches, regardless of collapse state.
    if (isVisible ? false : !isExpanded(node, depth)) return;

    const children = node.children ?? [];
    const shown = isVisible ? children.filter(keep) : children;
    if (shown.length === 0) {
      // Only the unfiltered view shows the "empty folder" hint; under a filter
      // an empty child list just means "no matches down here".
      if (!isVisible) {
        rows.push({
          node,
          depth: depth + 1,
          key: `${node.path}::empty`,
          empty: true,
        });
      }
      return;
    }
    for (const child of shown) walk(child, depth + 1);
  };

  for (const child of root.children ?? []) walk(child, 0);
  return rows;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Window slice for a fixed-height list. Returns the row range to render plus the
 * spacer heights that keep the scrollbar's total height correct.
 */
export function computeRowWindow(
  totalRows: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number = VAULT_OVERSCAN,
): RowWindow {
  if (!Number.isFinite(totalRows) || totalRows <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  const height =
    Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : VAULT_ROW_HEIGHT;
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const viewport = Math.max(
    0,
    Number.isFinite(viewportHeight) ? viewportHeight : 0,
  );
  const pad = Math.max(0, Math.floor(Number.isFinite(overscan) ? overscan : 0));

  const firstVisible = Math.floor(top / height);
  const lastVisible = Math.ceil((top + viewport) / height);

  const start = clamp(firstVisible - pad, 0, totalRows);
  const end = clamp(lastVisible + pad, start, totalRows);

  return {
    start,
    end,
    padTop: start * height,
    padBottom: (totalRows - end) * height,
  };
}
