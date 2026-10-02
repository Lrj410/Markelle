import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export type GraphMode = "local" | "full";

export type GraphHops = 1 | 2 | 3;

export interface GraphNode {
  id: string;
  path: string | null;
  name: string;
  kind: "note" | "orphan" | "conflict" | string;
  isFocus: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphData {
  mode: GraphMode | string;
  nodes: GraphNode[];
  links: GraphLink[];
  fileCount: number;
  linkCount: number;
  truncated: boolean;
  vaultNoteCount: number;
  maxNodes: number;
}

export async function buildVaultGraph(
  root: string,
  mode: GraphMode,
  focusPath?: string | null,
  localHops: GraphHops = 1,
): Promise<GraphData> {
  return invoke<GraphData>("build_vault_graph", {
    root,
    mode,
    focusPath: focusPath ?? null,
    localHops,
  });
}

/** Parent folder label for coloring (posix). */
export function folderOfNode(n: GraphNode): string {
  if (!n.path) {
    return n.kind === "conflict"
      ? t("graph.folderConflict")
      : n.kind === "orphan"
        ? t("graph.folderOrphan")
        : "";
  }
  const norm = n.path.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length < 2) return t("graph.folderRoot");
  return parts[parts.length - 2] ?? t("graph.folderRoot");
}

const LAYOUT_PREFIX = "markelle-graph-layout:";

export type GraphLayoutMap = Record<string, { x: number; y: number }>;

export function loadGraphLayout(vaultRoot: string, mode: string): GraphLayoutMap {
  try {
    const raw = localStorage.getItem(`${LAYOUT_PREFIX}${vaultRoot}:${mode}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as GraphLayoutMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveGraphLayout(vaultRoot: string, mode: string, map: GraphLayoutMap): void {
  try {
    const entries = Object.entries(map).slice(0, 900);
    localStorage.setItem(
      `${LAYOUT_PREFIX}${vaultRoot}:${mode}`,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    /* quota */
  }
}
