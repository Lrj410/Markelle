import type { MessageKey } from "./i18n";
import { SECONDARY_AUX_PANELS, type PanelId } from "./dock";

/** Single source of truth for activity-rail / CmdK panel discovery. */
export interface PanelDescriptor {
  id: PanelId;
  labelKey: MessageKey;
  /** Shown on the primary activity rail (not under “More”). */
  primary?: boolean;
  /** Default right-dock membership for fresh installs (see dock.ts). */
  defaultAux?: boolean;
}

export const PANEL_REGISTRY: readonly PanelDescriptor[] = [
  { id: "vault", labelKey: "panel.vault", primary: true },
  { id: "toc", labelKey: "panel.toc", primary: true, defaultAux: true },
  { id: "ai", labelKey: "panel.ai", primary: true, defaultAux: true },
  { id: "history", labelKey: "panel.history", defaultAux: true },
  { id: "backlinks", labelKey: "panel.backlinks" },
  { id: "tags", labelKey: "panel.tags" },
  { id: "query", labelKey: "panel.query" },
  { id: "calendar", labelKey: "panel.calendar" },
] as const;

export function primaryPanelIds(): PanelId[] {
  return PANEL_REGISTRY.filter((p) => p.primary).map((p) => p.id);
}

export function moreMenuPanelIds(): PanelId[] {
  const secondary = new Set<PanelId>(SECONDARY_AUX_PANELS);
  secondary.add("history");
  return PANEL_REGISTRY.filter((p) => secondary.has(p.id)).map((p) => p.id);
}
