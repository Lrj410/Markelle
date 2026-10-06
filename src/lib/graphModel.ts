import type { GraphLink, GraphNode } from "./graph";

export function labelOf(n: Pick<GraphNode, "name">): string {
  return n.name.replace(/\.md$/i, "");
}

export function buildDegreeMap(links: GraphLink[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return degree;
}

export function buildAdjacency(links: GraphLink[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let s = adj.get(a);
    if (!s) {
      s = new Set();
      adj.set(a, s);
    }
    s.add(b);
  };
  for (const l of links) {
    add(l.source, l.target);
    add(l.target, l.source);
  }
  return adj;
}

/** 目录色阶：矿物颜料感（石青 / 苔绿 / 赭石 / 紫檀 / 松石 / 陶土 / 石墨 / 沙褐），不发光。 */
const FOLDER_DARK = [
  "#9bb0be",
  "#8fb58c",
  "#c9a05e",
  "#b394a4",
  "#7fb5ae",
  "#cf8a68",
  "#9aa0a8",
  "#c0ad86",
];
const FOLDER_LIGHT = [
  "#5c6b78",
  "#4d6b4a",
  "#8a6118",
  "#6b4f5c",
  "#3f6b66",
  "#9a5a3a",
  "#5a5f66",
  "#7a6a4a",
];

export function folderTint(folder: string, dark: boolean): string {
  const palette = dark ? FOLDER_DARK : FOLDER_LIGHT;
  let h = 2166136261;
  for (let i = 0; i < folder.length; i++) {
    h ^= folder.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return palette[(h >>> 0) % palette.length]!;
}

export function nodeRadius(kind: string, isFocus: boolean, degree: number): number {
  if (isFocus) return 12;
  if (kind === "conflict") return 7;
  if (kind === "orphan") return 5;
  return Math.min(14, 5.5 + Math.sqrt(degree) * 1.35);
}

export interface GraphFilters {
  hideOrphans: boolean;
  hideIsolates: boolean;
  minDegree: number;
  query: string;
}

export function filterGraphNodes(
  nodes: GraphNode[],
  degree: Map<string, number>,
  filters: GraphFilters,
): GraphNode[] {
  const q = filters.query.trim().toLowerCase();
  return nodes.filter((n) => {
    if (filters.hideOrphans && (n.kind === "orphan" || n.kind === "conflict")) {
      return false;
    }
    const deg = degree.get(n.id) ?? 0;
    if (filters.hideIsolates && deg === 0 && n.kind === "note" && !n.isFocus) {
      return false;
    }
    if (deg < filters.minDegree && !n.isFocus) return false;
    if (!q) return true;
    const label = labelOf(n).toLowerCase();
    return (
      label.includes(q) ||
      n.name.toLowerCase().includes(q) ||
      (n.path?.toLowerCase().includes(q) ?? false)
    );
  });
}

export function filterGraphLinks(
  links: GraphLink[],
  keep: Set<string>,
): GraphLink[] {
  return links.filter((l) => keep.has(l.source) && keep.has(l.target));
}

/** Stable hash → [0,1) for deterministic initial scatter. */
export function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

