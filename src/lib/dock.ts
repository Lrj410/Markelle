import { t, type MessageKey } from "./i18n";

export type PanelId =
  | "vault"
  | "toc"
  | "backlinks"
  | "tags"
  | "query"
  | "history"
  | "calendar"
  | "ai";
export type DockSide = "left" | "right" | "bottom";
export type ActivityId = PanelId | "graph" | "plugins" | "settings";

export interface DockSlot {
  panels: PanelId[];
  active: PanelId | null;
  size: number;
}

export interface DockLayout {
  left: DockSlot;
  right: DockSlot;
  bottom: DockSlot;
}

const PANEL_MSG: Record<PanelId, MessageKey> = {
  vault: "panel.vault",
  toc: "panel.toc",
  backlinks: "panel.backlinks",
  tags: "panel.tags",
  query: "panel.query",
  history: "panel.history",
  calendar: "panel.calendar",
  ai: "panel.ai",
};

/** Localized dock tab label (call during render so locale changes apply). */
export function panelLabel(id: PanelId): string {
  return t(PANEL_MSG[id]);
}

export const DEFAULT_AUX_PANELS: PanelId[] = [
  "ai",
  "history",
  "query",
  "tags",
  "backlinks",
  "toc",
  "calendar",
];

export const DEFAULT_DOCK: DockLayout = {
  left: { panels: ["vault"], active: "vault", size: 240 },
  right: { panels: DEFAULT_AUX_PANELS, active: "history", size: 270 },
  bottom: { panels: [], active: null, size: 220 },
};

const ALL_PANELS: PanelId[] = [
  "vault",
  "toc",
  "backlinks",
  "tags",
  "query",
  "history",
  "calendar",
  "ai",
];

/** Side dock min width (px) — keep vault chrome + right aux tabs readable. */
export const MIN_SIDE_SIZE = 240;
/**
 * Right dock floor — fits 日历/历史/查询/标签/反向链接/大纲 tab row + calendar grid
 * snugly without extra empty space, and ensures collapse button is aligned.
 */
export const MIN_RIGHT_SIZE = 270;
export const MIN_BOTTOM_SIZE = 120;
export const MAX_SIDE_SIZE = 560;
export const MAX_BOTTOM_SIZE = 420;

function sideMin(side: DockSide): number {
  if (side === "bottom") return MIN_BOTTOM_SIZE;
  if (side === "right") return MIN_RIGHT_SIZE;
  return MIN_SIDE_SIZE;
}

function sanitizeSlot(
  slot: Partial<DockSlot> | undefined,
  fallback: DockSlot,
  side: DockSide = "left",
): DockSlot {
  const panels = (slot?.panels ?? fallback.panels).filter((p): p is PanelId =>
    ALL_PANELS.includes(p as PanelId),
  );
  const unique = [...new Set(panels)];
  const active =
    slot?.active === null
      ? null
      : slot?.active && unique.includes(slot.active)
        ? slot.active
        : slot && "active" in slot
          ? null
          : (fallback.active && unique.includes(fallback.active) ? fallback.active : (unique[0] ?? null));
  const min = sideMin(side);
  const max = side === "bottom" ? MAX_BOTTOM_SIZE : MAX_SIDE_SIZE;
  const rawSize = slot?.size;
  // Migrate old defaults (380, 320, 310) to the new snug 270px width
  const migratedSize =
    side === "right" && (rawSize === 380 || rawSize === 320 || rawSize === 310)
      ? fallback.size
      : (rawSize ?? fallback.size);
  const size = Math.min(max, Math.max(min, migratedSize));
  return { panels: unique, active, size };
}

export function normalizeDock(raw: Partial<DockLayout> | null | undefined): DockLayout {
  const base = DEFAULT_DOCK;
  if (!raw) return structuredClone(base);

  let left = sanitizeSlot(raw.left, base.left, "left");
  let right = sanitizeSlot(raw.right, base.right, "right");
  let bottom = sanitizeSlot(raw.bottom, base.bottom, "bottom");

  // Ensure each panel appears in at most one slot (prefer left > right > bottom).
  // Legacy "plugins" dock entries are dropped — plugins open as a modal.
  const seen = new Set<PanelId>();
  const dedupe = (slot: DockSlot): DockSlot => {
    const panels = slot.panels.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });
    const active =
      slot.active && panels.includes(slot.active)
        ? slot.active
        : slot.active === null
          ? null
          : (panels[0] ?? null);
    return { ...slot, panels, active };
  };
  left = dedupe(left);
  right = dedupe(right);
  bottom = dedupe(bottom);

  return { left, right, bottom };
}

export function findPanelSide(layout: DockLayout, id: PanelId): DockSide | null {
  if (layout.left.panels.includes(id)) return "left";
  if (layout.right.panels.includes(id)) return "right";
  if (layout.bottom.panels.includes(id)) return "bottom";
  return null;
}

export function isPanelVisible(layout: DockLayout, id: PanelId): boolean {
  const side = findPanelSide(layout, id);
  if (!side) return false;
  const slot = layout[side];
  return slot.panels.includes(id) && slot.active === id;
}

export function togglePanel(layout: DockLayout, id: PanelId): DockLayout {
  const side = findPanelSide(layout, id);
  if (side) {
    const slot = layout[side];
    if (slot.active === id) {
      return {
        ...layout,
        [side]: {
          ...slot,
          active: null,
        },
      };
    }
    return {
      ...layout,
      [side]: { ...slot, active: id },
    };
  }

  const prefer: DockSide = id === "vault" ? "left" : "right";
  const slot = layout[prefer];
  return {
    ...layout,
    [prefer]: {
      panels: slot.panels.includes(id) ? slot.panels : [...slot.panels, id],
      active: id,
      size: slot.size,
    },
  };
}

export function movePanel(
  layout: DockLayout,
  id: PanelId,
  to: DockSide,
  index?: number,
): DockLayout {
  const next = structuredClone(layout) as DockLayout;
  for (const side of ["left", "right", "bottom"] as DockSide[]) {
    const slot = next[side];
    slot.panels = slot.panels.filter((p) => p !== id);
    if (slot.active === id) slot.active = slot.panels[0] ?? null;
  }
  const dest = next[to];
  const at = index == null ? dest.panels.length : Math.max(0, Math.min(index, dest.panels.length));
  dest.panels.splice(at, 0, id);
  dest.active = id;
  return next;
}

export function setSlotSize(layout: DockLayout, side: DockSide, size: number): DockLayout {
  const min = sideMin(side);
  const max = side === "bottom" ? MAX_BOTTOM_SIZE : MAX_SIDE_SIZE;
  return {
    ...layout,
    [side]: {
      ...layout[side],
      size: Math.min(max, Math.max(min, size)),
    },
  };
}

export function setSlotActive(layout: DockLayout, side: DockSide, id: PanelId): DockLayout {
  const slot = layout[side];
  if (!slot.panels.includes(id)) return layout;
  return { ...layout, [side]: { ...slot, active: id } };
}
