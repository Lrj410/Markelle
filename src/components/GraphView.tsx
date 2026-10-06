import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import {
  buildVaultGraph,
  folderOfNode,
  loadGraphLayout,
  saveGraphLayout,
  type GraphData,
  type GraphHops,
  type GraphMode,
  type GraphNode,
} from "../lib/graph";
import {
  buildAdjacency,
  buildDegreeMap,
  filterGraphLinks,
  filterGraphNodes,
  folderTint,
  hash01,
  labelOf,
  nodeRadius,
  type GraphFilters,
} from "../lib/graphModel";
import { formatAppError } from "../lib/errors";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

interface SimNode extends SimulationNodeDatum, GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  folder: string;
  degree: number;
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
}

interface Props {
  vaultRoot: string;
  focusPath: string | null;
  mode: GraphMode;
  dark: boolean;
  epoch?: number;
  localHops?: GraphHops;
  keepOpenOnNavigate?: boolean;
  onOpenFile: (path: string) => void;
  onBusy?: (busy: boolean) => void;
  onStatus?: (msg: string) => void;
  onLocalHopsChange?: (hops: GraphHops) => void;
  onKeepOpenChange?: (keep: boolean) => void;
}

const HIT_PAD_PX = 12;
const LABEL_CACHE_MAX = 400;
const LIST_CAP = 250;
const CULL_PAD = 48;
const ALPHA_PAUSE = 0.02;
const TOP_DEGREE_LABELS = 40;

function linkId(l: SimLink): { s: string; t: string } {
  const s = typeof l.source === "string" ? l.source : l.source.id;
  const t = typeof l.target === "string" ? l.target : l.target.id;
  return { s, t };
}

function linkEnds(l: SimLink): { s: SimNode; t: SimNode } | null {
  const s = l.source as SimNode;
  const t = l.target as SimNode;
  if (s?.x == null || s?.y == null || t?.x == null || t?.y == null) return null;
  return { s, t };
}

/** Folder hash → mild cluster offsets in [-1, 1]. */
function folderCluster(folder: string): { cx: number; cy: number } {
  const a = hash01(folder);
  const b = hash01(`${folder}\0y`);
  return { cx: a * 2 - 1, cy: b * 2 - 1 };
}

/**
 * Canvas palette. Kept in a ref that the long-lived draw loop reads at paint
 * time, so a light/dark toggle can re-colour in place instead of tearing down
 * and rebuilding the whole force simulation (which discarded the layout).
 */
interface GraphPalette {
  isDark: boolean;
  ink: string;
  inkSoft: string;
  accent: string;
  baseFill: string;
  orphanFill: string;
  conflictFill: string;
  linkDim: string;
  linkHot: string;
  linkMid: string;
  paper: string;
  halo: string;
  ring: string;
  vignetteEdge: string;
  nodeStroke: string;
  labelBg: string;
}

function graphPalette(dark: boolean): GraphPalette {
  return dark
    ? {
        isDark: true,
        ink: "rgba(242, 235, 223, 0.96)",
        inkSoft: "rgba(181, 167, 147, 0.78)",
        accent: "#e88a6a",
        baseFill: "#8b7c68",
        orphanFill: "rgba(139, 124, 104, 0.45)",
        conflictFill: "#d9a05b",
        linkDim: "rgba(181, 167, 147, 0.08)",
        linkHot: "rgba(224, 112, 79, 0.5)",
        linkMid: "rgba(181, 167, 147, 0.2)",
        paper: "#1e1a14",
        halo: "rgba(217, 160, 91, 0.18)",
        ring: "rgba(242, 235, 223, 0.72)",
        vignetteEdge: "rgba(0,0,0,0.28)",
        nodeStroke: "rgba(8, 6, 4, 0.38)",
        labelBg: "rgba(26, 22, 17, 0.9)",
      }
    : {
        isDark: false,
        ink: "rgba(32, 27, 21, 0.94)",
        inkSoft: "rgba(107, 95, 80, 0.9)",
        accent: "#a63d24",
        baseFill: "#6b5f50",
        orphanFill: "rgba(154, 139, 119, 0.42)",
        conflictFill: "#8a6118",
        linkDim: "rgba(56, 48, 38, 0.07)",
        linkHot: "rgba(166, 61, 36, 0.42)",
        linkMid: "rgba(56, 48, 38, 0.16)",
        paper: "#f6f2e9",
        halo: "rgba(150, 104, 29, 0.14)",
        ring: "rgba(32, 27, 21, 0.5)",
        vignetteEdge: "rgba(56,44,30,0.08)",
        nodeStroke: "rgba(253, 251, 245, 0.7)",
        labelBg: "rgba(253, 251, 245, 0.95)",
      };
}

function GraphViewInner({
  vaultRoot,
  focusPath,
  mode,
  dark,
  epoch = 0,
  localHops = 1,
  keepOpenOnNavigate = false,
  onOpenFile,
  onBusy,
  onStatus,
  onLocalHopsChange,
  onKeepOpenChange,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState("");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [hideIsolates, setHideIsolates] = useState(false);
  const [minDegree, setMinDegree] = useState(0);
  const [listQuery, setListQuery] = useState("");
  const [tipFollow, setTipFollow] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipPosRef = useRef<{ x: number; y: number } | null>(null);
  /** Canvas palette read by the draw loop; updated in place on theme change. */
  const themeRef = useRef<GraphPalette>(graphPalette(dark));
  /** Post-drag flag reset; tracked so it cannot fire after unmount. */
  const dragResetTimerRef = useRef(0);

  const hoverIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const rafRef = useRef(0);
  const needsDrawRef = useRef(false);
  const simRunningRef = useRef(false);
  const drawLoopRef = useRef<() => void>(() => {});
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const zoomerRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const nodeByIdRef = useRef<Map<string, SimNode>>(new Map());
  const linksRef = useRef<SimLink[]>([]);
  const adjRef = useRef<Map<string, Set<string>>>(new Map());
  const degreeRef = useRef<Map<string, number>>(new Map());
  const topDegreeRef = useRef<Set<string>>(new Set());
  const labelWidthCache = useRef(new Map<string, number>());
  const draggedRef = useRef(false);
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  useLocale();

  const filters: GraphFilters = useMemo(
    () => ({
      hideOrphans,
      hideIsolates,
      minDegree,
      query: "",
    }),
    [hideOrphans, hideIsolates, minDegree],
  );

  const filtered = useMemo(() => {
    if (!data) return { nodes: [] as GraphNode[], links: [] as { source: string; target: string }[] };
    const degree = buildDegreeMap(data.links);
    const nodes = filterGraphNodes(data.nodes, degree, filters);
    const keep = new Set(nodes.map((n) => n.id));
    const links = filterGraphLinks(data.links, keep);
    return { nodes, links };
  }, [data, filters]);

  const listNodes = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    const degree = buildDegreeMap(filtered.links);
    return filtered.nodes
      .filter((n) => n.path && n.kind !== "orphan" && n.kind !== "conflict")
      .filter(
        (n) =>
          !q ||
          labelOf(n).toLowerCase().includes(q) ||
          n.name.toLowerCase().includes(q) ||
          (n.path?.toLowerCase().includes(q) ?? false),
      )
      .map((n) => ({
        node: n,
        folder: folderOfNode(n),
        degree: degree.get(n.id) ?? 0,
      }))
      .sort((a, b) => {
        if (a.degree !== b.degree) return b.degree - a.degree;
        return labelOf(a.node).localeCompare(labelOf(b.node), undefined, {
          sensitivity: "base",
        });
      });
  }, [filtered, listQuery]);

  const listTotal = listNodes.length;
  const listShown = listNodes.slice(0, LIST_CAP);

  const selectedNode = useMemo(() => {
    if (!selectedId) return null;
    return filtered.nodes.find((n) => n.id === selectedId) ?? null;
  }, [selectedId, filtered.nodes]);

  const selectedDegree = useMemo(() => {
    if (!selectedId) return 0;
    return filtered.links.filter((l) => l.source === selectedId || l.target === selectedId).length;
  }, [selectedId, filtered.links]);

  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [];
    const neighborIds = new Set<string>();
    for (const l of filtered.links) {
      if (l.source === selectedId) neighborIds.add(l.target);
      if (l.target === selectedId) neighborIds.add(l.source);
    }
    const nodeMap = new Map(filtered.nodes.map((n) => [n.id, n]));
    const result: GraphNode[] = [];
    for (const id of neighborIds) {
      const n = nodeMap.get(id);
      if (n) result.push(n);
    }
    return result.sort((a, b) =>
      labelOf(a).localeCompare(labelOf(b), undefined, {
        sensitivity: "base",
      }),
    );
  }, [selectedId, filtered]);

  const kickDraw = useCallback(() => {
    needsDrawRef.current = true;
    drawLoopRef.current();
  }, []);

  const setHover = useCallback(
    (id: string | null) => {
      if (id === hoverIdRef.current) return;
      hoverIdRef.current = id;
      setHoverId(id);
      kickDraw();
    },
    [kickDraw],
  );

  const setSelected = useCallback(
    (id: string | null) => {
      selectedIdRef.current = id;
      setSelectedId(id);
      kickDraw();
    },
    [kickDraw],
  );

  // Tooltip position lives in a ref so pointermove never re-renders the graph.
  const applyTip = useCallback(() => {
    const el = tipRef.current;
    const pos = tipPosRef.current;
    if (!el || !pos) return;
    const stageW = stageRef.current?.clientWidth ?? 400;
    el.style.left = `${Math.min(stageW - 200, Math.max(12, pos.x + 14))}px`;
    el.style.top = `${Math.max(12, pos.y + 14)}px`;
  }, []);

  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    if (hoverId && tipFollow) {
      applyTip();
    } else {
      el.style.left = "";
      el.style.top = "";
    }
  }, [hoverId, tipFollow, applyTip]);

  useEffect(() => {
    let cancelled = false;
    let busyTimer = 0;
    setError("");
    busyTimer = window.setTimeout(() => {
      if (!cancelled) onBusy?.(true);
    }, 200);
    void (async () => {
      try {
        if (mode === "local" && !focusPath) {
          throw new Error(t("graph.needFocus"));
        }
        const result = await buildVaultGraph(vaultRoot, mode, focusPath, localHops);
        if (cancelled) return;
        setData(result);
        const scope =
          mode === "local"
            ? `${t("graph.scopeLocal")}·${localHops}${t("graph.hopsUnit")}`
            : t("graph.scopeFull");
        const trunc = result.truncated
          ? ` · ${t("graph.truncatedShort")} ${result.fileCount}/${result.vaultNoteCount}`
          : "";
        onStatus?.(
          `${t("graph.label")} · ${scope} · ${result.fileCount} ${t("graph.nodes")} · ${result.linkCount} ${t("graph.edges")}${trunc}`,
        );
      } catch (e) {
        if (cancelled) return;
        setData(null);
        setError(formatAppError(e));
        onStatus?.(formatAppError(e));
      } finally {
        window.clearTimeout(busyTimer);
        if (!cancelled) onBusy?.(false);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(busyTimer);
      onBusy?.(false);
    };
  }, [vaultRoot, focusPath, mode, epoch, localHops, onBusy, onStatus]);

  // Re-colour on theme change WITHOUT rebuilding the force simulation: update
  // the palette ref the draw loop reads, then repaint the existing layout.
  // Declared before the main effect so it runs first on mount.
  useEffect(() => {
    themeRef.current = graphPalette(dark);
    kickDraw();
  }, [dark, kickDraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || !data) return;

    const dpr = window.devicePixelRatio || 1;
    let width = stage.clientWidth;
    let height = stage.clientHeight;

    // Colours are read from the palette ref at paint time (see the theme
    // effect above) so a dark/light toggle repaints without rebuilding `sim`.
    const saved = loadGraphLayout(vaultRoot, mode);
    const degree = buildDegreeMap(filtered.links);
    degreeRef.current = degree;

    const ranked = [...filtered.nodes]
      .map((n) => ({ id: n.id, d: degree.get(n.id) ?? 0 }))
      .sort((a, b) => b.d - a.d)
      .slice(0, TOP_DEGREE_LABELS);
    topDegreeRef.current = new Set(ranked.map((r) => r.id));

    const nodes: SimNode[] = filtered.nodes.map((n) => {
      const folder = folderOfNode(n);
      const prev = saved[n.id];
      const deg = degree.get(n.id) ?? 0;
      const scatter = hash01(n.id);
      const cluster = folderCluster(folder);
      const cx = width / 2 + cluster.cx * Math.min(width, height) * 0.22;
      const cy = height / 2 + cluster.cy * Math.min(width, height) * 0.22;
      const pinned = prev != null;
      return {
        ...n,
        folder,
        degree: deg,
        x: prev?.x ?? cx + (scatter - 0.5) * 80,
        y: prev?.y ?? cy + (hash01(`${n.id}:y`) - 0.5) * 80,
        fx: pinned ? prev.x : undefined,
        fy: pinned ? prev.y : undefined,
      };
    });

    const nodeIds = new Set(nodes.map((n) => n.id));
    const linkKeys = new Set<string>();
    const links: SimLink[] = [];
    for (const l of filtered.links) {
      if (!nodeIds.has(l.source) || !nodeIds.has(l.target)) continue;
      const key = l.source < l.target ? `${l.source}\0${l.target}` : `${l.target}\0${l.source}`;
      if (linkKeys.has(key)) continue;
      linkKeys.add(key);
      links.push({ source: l.source, target: l.target });
    }

    nodesRef.current = nodes;
    nodeByIdRef.current = new Map(nodes.map((n) => [n.id, n]));
    linksRef.current = links;
    adjRef.current = buildAdjacency(
      links.map((l) => {
        const { s, t } = linkId(l);
        return { source: s, target: t };
      }),
    );
    labelWidthCache.current.clear();

    const measureLabel = (ctx: CanvasRenderingContext2D, text: string, font: string) => {
      const key = `${font}\0${text}`;
      const cached = labelWidthCache.current.get(key);
      if (cached != null) return cached;
      ctx.font = font;
      const w = ctx.measureText(text).width;
      if (labelWidthCache.current.size > LABEL_CACHE_MAX) labelWidthCache.current.clear();
      labelWidthCache.current.set(key, w);
      return w;
    };

    const radiusOf = (n: SimNode) => nodeRadius(n.kind, n.isFocus, n.degree);

    const draw = () => {
      needsDrawRef.current = false;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const theme = themeRef.current;
      const {
        ink,
        inkSoft,
        accent,
        baseFill,
        orphanFill,
        conflictFill,
        linkDim,
        linkHot,
        linkMid,
        paper,
        halo,
        ring,
      } = theme;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, width, height);

      // Soft vignette
      const grd = ctx.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.2,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.72,
      );
      grd.addColorStop(0, "rgba(0,0,0,0)");
      grd.addColorStop(1, theme.vignetteEdge);
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, width, height);

      const tr = transformRef.current;
      const inv = 1 / Math.max(tr.k, 0.001);
      ctx.save();
      ctx.translate(tr.x, tr.y);
      ctx.scale(tr.k, tr.k);

      const viewLeft = (-tr.x) / tr.k - CULL_PAD * inv;
      const viewTop = (-tr.y) / tr.k - CULL_PAD * inv;
      const viewRight = (width - tr.x) / tr.k + CULL_PAD * inv;
      const viewBottom = (height - tr.y) / tr.k + CULL_PAD * inv;
      const inView = (x: number, y: number, pad = 0) =>
        x + pad >= viewLeft && x - pad <= viewRight && y + pad >= viewTop && y - pad <= viewBottom;

      const hover = hoverIdRef.current;
      const selected = selectedIdRef.current;
      const hotId = hover ?? selected;
      const neighbors = hotId ? adjRef.current.get(hotId) : undefined;
      const hasFocus = Boolean(hotId);
      const edgeStep =
        !hasFocus && tr.k < 0.5 && links.length > 180
          ? 3
          : !hasFocus && tr.k < 0.7 && links.length > 120
            ? 2
            : 1;

      const strokeEdges = (pred: (s: SimNode, t: SimNode) => boolean, color: string, lw: number) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = lw * inv;
        ctx.lineCap = "round";
        for (let i = 0; i < links.length; i += edgeStep) {
          const ends = linkEnds(links[i]!);
          if (!ends) continue;
          const { s, t } = ends;
          if (!pred(s, t)) continue;
          if (!inView(s.x!, s.y!, 8) && !inView(t.x!, t.y!, 8)) continue;
          ctx.moveTo(s.x!, s.y!);
          ctx.lineTo(t.x!, t.y!);
        }
        ctx.stroke();
      };

      if (hasFocus && neighbors) {
        const hotId = hover ?? selected;
        strokeEdges(
          (s, t) =>
            !(
              s.id === hotId ||
              t.id === hotId ||
              neighbors.has(s.id) ||
              neighbors.has(t.id)
            ),
          linkDim,
          1,
        );
        strokeEdges(
          (s, t) => s.id === hotId || t.id === hotId,
          linkHot,
          2.1,
        );
        strokeEdges(
          (s, t) =>
            (neighbors.has(s.id) || neighbors.has(t.id)) && s.id !== hotId && t.id !== hotId,
          linkMid,
          1.35,
        );
      } else {
        strokeEdges(() => true, linkMid, 1.1);
      }

      const isHot = (n: SimNode) =>
        n.isFocus ||
        n.id === hover ||
        n.id === selected ||
        (neighbors?.has(n.id) ?? false);

      const zoomedIn = tr.k >= 1.05;
      const shouldLabel = (n: SimNode) =>
        n.isFocus ||
        n.id === hover ||
        n.id === selected ||
        (neighbors?.has(n.id) ?? false) ||
        zoomedIn ||
        topDegreeRef.current.has(n.id);

      const paintNode = (n: SimNode) => {
        if (n.x == null || n.y == null) return;
        const rBase = radiusOf(n);
        if (!inView(n.x, n.y, rBase + 20 * inv)) return;

        const hot = isHot(n);
        const dimmed = hasFocus && !hot;
        const r = n.id === hover ? rBase * 1.4 : n.id === selected ? rBase * 1.25 : hot ? rBase * 1.1 : rBase;

        if (n.id === hover || n.isFocus || n.id === selected) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 7 * inv, 0, Math.PI * 2);
          ctx.fillStyle = halo;
          ctx.fill();
        }

        let fill = baseFill;
        if (n.isFocus) fill = accent;
        else if (n.kind === "orphan") fill = orphanFill;
        else if (n.kind === "conflict") fill = conflictFill;
        else if (n.folder) fill = folderTint(n.folder, theme.isDark);

        ctx.globalAlpha = dimmed ? 0.2 : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = theme.nodeStroke;
        ctx.lineWidth = (n.id === hover ? 1.55 : 1) * inv;
        ctx.stroke();

        if (n.id === hover || n.isFocus || n.id === selected) {
          ctx.strokeStyle = ring;
          ctx.lineWidth = 2 * inv;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3.5 * inv, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        if (!shouldLabel(n) || dimmed) return;

        const label = labelOf(n);
        const fontPx = (n.id === hover || n.id === selected ? 12.5 : 11) * inv;
        const font = `600 ${fontPx}px "DM Sans", "Segoe UI", "Microsoft YaHei", sans-serif`;
        const twRaw = measureLabel(ctx, label, font);
        const padX = 5.5 * inv;
        const padY = 3 * inv;
        const tw = twRaw + padX * 2;
        const th = fontPx + padY * 2;
        const rx = 4 * inv;
        const ty = n.y + r + 5.5 * inv;
        const bx = n.x - tw / 2;
        const by = ty - padY;
        ctx.beginPath();
        ctx.moveTo(bx + rx, by);
        ctx.arcTo(bx + tw, by, bx + tw, by + th, rx);
        ctx.arcTo(bx + tw, by + th, bx, by + th, rx);
        ctx.arcTo(bx, by + th, bx, by, rx);
        ctx.arcTo(bx, by, bx + tw, by, rx);
        ctx.closePath();
        ctx.fillStyle = theme.labelBg;
        ctx.fill();
        ctx.font = font;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = n.id === hover || n.isFocus || n.id === selected ? ink : inkSoft;
        ctx.fillText(label, n.x, ty);
      };

      for (const n of nodes) {
        if (!isHot(n)) paintNode(n);
      }
      for (const n of nodes) {
        if (isHot(n) && n.id !== hover) paintNode(n);
      }
      const hoverNode = hover ? nodeByIdRef.current.get(hover) ?? null : null;
      if (hoverNode) paintNode(hoverNode);

      ctx.restore();
    };

    const ensureLoop = () => {
      if (rafRef.current) return;
      const loop = () => {
        rafRef.current = 0;
        const sim = simRef.current;
        const alpha = sim?.alpha() ?? 0;
        if (sim && alpha < ALPHA_PAUSE && simRunningRef.current) {
          sim.stop();
          simRunningRef.current = false;
          persistLayout();
        }
        if (needsDrawRef.current || simRunningRef.current) {
          draw();
          if (simRunningRef.current || needsDrawRef.current) {
            rafRef.current = requestAnimationFrame(loop);
          }
        }
      };
      rafRef.current = requestAnimationFrame(loop);
    };
    drawLoopRef.current = () => {
      needsDrawRef.current = true;
      ensureLoop();
    };

    const resize = () => {
      width = stage.clientWidth;
      height = stage.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      kickDraw();
    };

    const nCount = Math.max(nodes.length, 1);
    const linkDist = Math.max(86, Math.min(150, 36 + Math.sqrt(nCount) * 16));
    const charge = Math.max(-380, Math.min(-90, -80 - nCount * 2.6));
    const hasSaved = Object.keys(saved).length > 0;
    const clusterSpan = Math.min(width, height) * 0.28;

    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(linkDist)
          .strength(0.32),
      )
      .force("charge", forceManyBody().strength(charge).distanceMax(380))
      .force("center", forceCenter(width / 2, height / 2).strength(0.05))
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius((d) => radiusOf(d) + (d.isFocus ? 20 : 12))
          .strength(0.88),
      )
      .force(
        "x",
        forceX<SimNode>((d) => width / 2 + folderCluster(d.folder).cx * clusterSpan).strength(0.04),
      )
      .force(
        "y",
        forceY<SimNode>((d) => height / 2 + folderCluster(d.folder).cy * clusterSpan).strength(0.04),
      )
      .alpha(hasSaved ? 0.16 : nCount > 500 ? 0.55 : 0.88)
      // Large graphs settle faster — full force ticks dominate CPU more than layout quality.
      .alphaDecay(nCount > 500 ? 0.055 : nCount > 250 ? 0.04 : 0.028)
      .velocityDecay(nCount > 500 ? 0.45 : 0.36);

    simRef.current = sim;
    simRunningRef.current = true;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const persistLayout = () => {
      const map: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) {
        if (n.x != null && n.y != null) map[n.id] = { x: n.x, y: n.y };
      }
      saveGraphLayout(vaultRoot, mode, map);
    };

    if (reduceMotion) {
      for (let i = 0; i < 100; i++) sim.tick();
      sim.stop();
      simRunningRef.current = false;
      for (const n of nodes) {
        if (n.x != null && n.y != null) {
          n.fx = n.x;
          n.fy = n.y;
        }
      }
      persistLayout();
      kickDraw();
    } else {
      sim.on("tick", () => {
        simRunningRef.current = true;
        kickDraw();
      });
      sim.on("end", () => {
        simRunningRef.current = false;
        for (const n of nodes) {
          if (n.x != null && n.y != null) {
            n.fx = n.x;
            n.fy = n.y;
          }
        }
        persistLayout();
        kickDraw();
      });
      kickDraw();
    }

    /** Graph-space hit test with screen-stable radius + early AABB reject. */
    const findNode = (mx: number, my: number): SimNode | null => {
      const tr = transformRef.current;
      const x = (mx - tr.x) / tr.k;
      const y = (my - tr.y) / tr.k;
      const padGraph = (HIT_PAD_PX + 16) / Math.max(tr.k, 0.15);
      let hit: SimNode | null = null;
      let best = Infinity;
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        if (Math.abs(n.x - x) > padGraph || Math.abs(n.y - y) > padGraph) continue;
        const dist = Math.hypot(n.x - x, n.y - y);
        const rHit = radiusOf(n) + HIT_PAD_PX / Math.max(tr.k, 0.15);
        if (dist <= rHit && dist < best) {
          best = dist;
          hit = n;
        }
      }
      return hit;
    };

    const zoomer = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.18, 4.5])
      .filter((event) => {
        if (event.type === "wheel") return true;
        if (event.type === "mousedown" || event.type === "pointerdown") {
          const e = event as MouseEvent;
          if (typeof e.offsetX === "number") {
            return !findNode(e.offsetX, e.offsetY);
          }
        }
        return true;
      })
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        kickDraw();
      });
    zoomerRef.current = zoomer;

    const canvasSel = select(canvas);
    canvasSel.call(zoomer);

    const dragBehavior = drag<HTMLCanvasElement, unknown>()
      .container(() => canvas)
      .subject((event) => findNode(event.x, event.y) ?? undefined)
      .on("start", (event) => {
        if (!event.subject) return;
        draggedRef.current = false;
        const n = event.subject as SimNode;
        n.fx = n.x ?? null;
        n.fy = n.y ?? null;
        if (!event.active && !reduceMotion) {
          for (const other of nodes) {
            if (other.id === n.id) continue;
            if (other.x != null) {
              other.fx = other.x;
              other.fy = other.y;
            }
          }
          sim.alphaTarget(0.12).restart();
          simRunningRef.current = true;
          kickDraw();
        }
      })
      .on("drag", (event) => {
        if (!event.subject) return;
        draggedRef.current = true;
        const tr = transformRef.current;
        const n = event.subject as SimNode;
        n.fx = (event.x - tr.x) / tr.k;
        n.fy = (event.y - tr.y) / tr.k;
        kickDraw();
      })
      .on("end", (event) => {
        if (!event.subject) return;
        if (!event.active) sim.alphaTarget(0);
        const n = event.subject as SimNode;
        n.fx = n.x ?? null;
        n.fy = n.y ?? null;
        persistLayout();
        if (dragResetTimerRef.current) window.clearTimeout(dragResetTimerRef.current);
        dragResetTimerRef.current = window.setTimeout(() => {
          draggedRef.current = false;
          dragResetTimerRef.current = 0;
        }, 0);
      });

    canvasSel.call(dragBehavior as never);

    let downPos: { x: number; y: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      downPos = { x: e.offsetX, y: e.offsetY };
    };

    const onClick = (e: MouseEvent) => {
      if (draggedRef.current) return;
      if (downPos) {
        const dist = Math.hypot(e.offsetX - downPos.x, e.offsetY - downPos.y);
        if (dist > 5) return;
      }
      const n = findNode(e.offsetX, e.offsetY);
      if (n) {
        setSelected(n.id);
      } else {
        setSelected(null);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const n = findNode(e.offsetX, e.offsetY);
      setHover(n?.id ?? null);
      if (n) {
        tipPosRef.current = { x: e.offsetX, y: e.offsetY };
        setTipFollow(true);
        applyTip();
      } else {
        tipPosRef.current = null;
        setTipFollow(false);
      }
      canvas.style.cursor = n ? (n.path ? "pointer" : "default") : "grab";
    };

    const onPointerLeave = () => {
      setHover(null);
      tipPosRef.current = null;
      setTipFollow(false);
      canvas.style.cursor = "grab";
    };

    const onDblClick = (e: MouseEvent) => {
      if (draggedRef.current) return;
      const n = findNode(e.offsetX, e.offsetY);
      if (n?.path) onOpenFileRef.current(n.path);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("dblclick", onDblClick);

    const ro = new ResizeObserver(() => {
      resize();
      sim.force("center", forceCenter(width / 2, height / 2).strength(0.04));
      kickDraw();
    });
    ro.observe(stage);
    resize();

    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (dragResetTimerRef.current) {
        window.clearTimeout(dragResetTimerRef.current);
        dragResetTimerRef.current = 0;
      }
      persistLayout();
      sim.stop();
      simRef.current = null;
      zoomerRef.current = null;
      simRunningRef.current = false;
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("dblclick", onDblClick);
      canvasSel.on(".zoom", null).on(".drag", null);
    };
    // `dark` is intentionally NOT a dep: the palette ref (theme effect above)
    // repaints in place so a theme toggle never rebuilds the simulation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, vaultRoot, mode, filtered, setHover, setSelected, kickDraw]);

  const fitView = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const zoomer = zoomerRef.current;
    const nodes = nodesRef.current;
    if (!canvas || !stage || !zoomer || !nodes.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    if (!Number.isFinite(minX)) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const bw = Math.max(maxX - minX, 40);
    const bh = Math.max(maxY - minY, 40);
    const pad = 64;
    const k = Math.min(2.6, Math.max(0.28, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const transform = zoomIdentity.translate(w / 2 - cx * k, h / 2 - cy * k).scale(k);
    select(canvas).call(zoomer.transform, transform);
    transformRef.current = transform;
    kickDraw();
  }, [kickDraw]);

  const panToNode = useCallback(
    (id: string) => {
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      const zoomer = zoomerRef.current;
      const node = nodeByIdRef.current.get(id);
      if (!canvas || !stage || !zoomer || !node || node.x == null || node.y == null) return;
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      const k = Math.max(transformRef.current.k, 1.05);
      const transform = zoomIdentity.translate(w / 2 - node.x * k, h / 2 - node.y * k).scale(k);
      select(canvas).call(zoomer.transform, transform);
      transformRef.current = transform;
      setSelected(id);
      kickDraw();
    },
    [setSelected, kickDraw],
  );

  const zoomByFactor = useCallback((factor: number) => {
    const canvas = canvasRef.current;
    const zoomer = zoomerRef.current;
    if (!canvas || !zoomer) return;
    select(canvas).transition().duration(120).call(zoomer.scaleBy, factor);
  }, []);

  const moveSelection = useCallback(
    (delta: number) => {
      const nodes = listShown;
      if (nodes.length === 0) return;
      const cur = selectedId
        ? nodes.findIndex(({ node }) => node.id === selectedId)
        : -1;
      const next = nodes[(cur + delta + nodes.length) % nodes.length];
      if (!next) return;
      panToNode(next.node.id);
    },
    [listShown, selectedId, panToNode],
  );

  const onCanvasKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomByFactor(1.2);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomByFactor(1 / 1.2);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        fitView();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        moveSelection(1);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        moveSelection(-1);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        const n = selectedId ? nodeByIdRef.current.get(selectedId) : null;
        if (n?.path) {
          e.preventDefault();
          onOpenFileRef.current(n.path);
        }
      }
    },
    [zoomByFactor, moveSelection, selectedId, fitView],
  );

  const relayout = () => {
    const sim = simRef.current;
    const nodes = nodesRef.current;
    if (!sim || !nodes.length) return;
    for (const n of nodes) {
      n.fx = null;
      n.fy = null;
    }
    sim.alpha(0.85).restart();
    simRunningRef.current = true;
    kickDraw();
  };

  const focusNote = () => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const zoomer = zoomerRef.current;
    const focus = nodesRef.current.find((n) => n.isFocus);
    if (!canvas || !stage || !zoomer || !focus || focus.x == null || focus.y == null) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const k = Math.max(transformRef.current.k, 1.15);
    const transform = zoomIdentity.translate(w / 2 - focus.x * k, h / 2 - focus.y * k).scale(k);
    select(canvas).call(zoomer.transform, transform);
    transformRef.current = transform;
    setHover(focus.id);
    setSelected(focus.id);
    kickDraw();
  };

  const exportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `markelle-graph-${mode}.png`;
      a.click();
      // Revoking synchronously can cancel the download before the WebView has
      // started it — release later (same deferred pattern as downloadTextFile).
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  const hoverNode = hoverId ? nodeByIdRef.current.get(hoverId) ?? null : null;
  const hoverLabel = hoverNode ? labelOf(hoverNode) : null;
  const hoverDegree = hoverNode
    ? (degreeRef.current.get(hoverNode.id) ?? hoverNode.degree ?? 0)
    : 0;

  const hopOptions: GraphHops[] = [1, 2, 3];

  return (
    <div className="graph-view">
      <div className="graph-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="graph-canvas"
          tabIndex={0}
          role="application"
          aria-label={t("graph.label")}
          aria-roledescription={t("graph.canvasRole")}
          aria-keyshortcuts="Equal Minus Digit0 ArrowUp ArrowDown Enter"
          aria-describedby="graph-canvas-kbd-hint"
          onKeyDown={onCanvasKeyDown}
        />
        <p id="graph-canvas-kbd-hint" className="sr-only">
          {t("graph.canvasKeys")}
        </p>

        <div className="graph-hud" role="toolbar" aria-label={t("graph.toolbar")}>
          {mode === "local" && (
            <div className="graph-hud-seg" role="group" aria-label={t("graph.hops")}>
              {hopOptions.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`graph-hud-btn${localHops === h ? " is-active" : ""}`}
                  onClick={() => onLocalHopsChange?.(h)}
                >
                  {h}
                  {t("graph.hopsUnit")}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="graph-hud-btn" onClick={fitView}>
            {t("graph.fit")}
          </button>
          <button type="button" className="graph-hud-btn" onClick={relayout}>
            {t("graph.relayout")}
          </button>
          <button
            type="button"
            className="graph-hud-btn"
            onClick={focusNote}
            disabled={!focusPath}
          >
            {t("graph.focus")}
          </button>
          <button type="button" className="graph-hud-btn" onClick={exportPng}>
            {t("graph.export")}
          </button>
          <label className="graph-hud-check">
            <input
              type="checkbox"
              className="ui-check"
              checked={keepOpenOnNavigate}
              onChange={(e) => onKeepOpenChange?.(e.target.checked)}
            />
            <span>{t("graph.keepOpen")}</span>
          </label>
          <span className="graph-hud-sep" aria-hidden />
          <button
            type="button"
            className={`graph-hud-btn${hideOrphans ? " is-active" : ""}`}
            onClick={() => setHideOrphans((v) => !v)}
            aria-pressed={hideOrphans}
          >
            {hideOrphans ? t("graph.showOrphans") : t("graph.hideOrphans")}
          </button>
          <button
            type="button"
            className={`graph-hud-btn${hideIsolates ? " is-active" : ""}`}
            onClick={() => setHideIsolates((v) => !v)}
            aria-pressed={hideIsolates}
          >
            {hideIsolates ? t("graph.showIsolates") : t("graph.hideIsolates")}
          </button>
          <div className="graph-hud-stepper" role="group" aria-label={t("graph.minDegree")}>
            <button
              type="button"
              className="graph-hud-btn graph-hud-step"
              disabled={minDegree <= 0}
              onClick={() => setMinDegree((d) => Math.max(0, d - 1))}
              aria-label="−"
            >
              −
            </button>
            <span className="graph-hud-step-val">
              {t("graph.minDegree")} {minDegree}
            </span>
            <button
              type="button"
              className="graph-hud-btn graph-hud-step"
              disabled={minDegree >= 3}
              onClick={() => setMinDegree((d) => Math.min(3, d + 1))}
              aria-label="+"
            >
              +
            </button>
          </div>
        </div>

        {error && <div className="graph-banner is-error">{error}</div>}
        {!error && data?.truncated && (
          <div className="graph-banner">
            {t("graph.truncated", {
              shown: String(data.fileCount),
              total: String(data.vaultNoteCount),
              max: String(data.maxNodes || 800),
            })}
          </div>
        )}
        {!error && data && filtered.nodes.length === 0 && (
          <div className="graph-banner">{t("graph.empty")}</div>
        )}
        {!error && data && filtered.nodes.length > 0 && filtered.links.length === 0 && (
          <div className="graph-banner">{t("graph.noEdges")}</div>
        )}

        {hoverLabel && (
          <div
            ref={tipRef}
            className={`graph-tip${tipFollow ? " is-cursor" : ""}`}
            aria-live="polite"
          >
            <strong>{hoverLabel}</strong>
            {hoverNode?.folder ? <span>{hoverNode.folder}</span> : null}
            <em>
              {t("graph.degree")} {hoverDegree}
              {hoverNode?.path ? ` · ${t("graph.dblOpen")}` : ""}
            </em>
          </div>
        )}
      </div>

      <aside className="graph-inspector" aria-label={t("graph.inspector")}>
        <div className="graph-inspector-stats">
          <div className="graph-stat">
            <span className="graph-stat-val">{filtered.nodes.length}</span>
            <span className="graph-stat-lbl">{t("graph.nodes")}</span>
          </div>
          <div className="graph-stat">
            <span className="graph-stat-val">{filtered.links.length}</span>
            <span className="graph-stat-lbl">{t("graph.edges")}</span>
          </div>
          <div className="graph-stat">
            <span className="graph-stat-val">{data?.vaultNoteCount ?? "—"}</span>
            <span className="graph-stat-lbl">{t("graph.vaultNotes")}</span>
          </div>
        </div>

        {selectedNode && (
          <div className="graph-inspector-card" role="region" aria-label={t("graph.selected")}>
            <div className="graph-card-header">
              <span className="graph-card-title" title={selectedNode.path ?? labelOf(selectedNode)}>
                {labelOf(selectedNode)}
              </span>
              <button
                type="button"
                className="graph-card-close"
                onClick={() => setSelected(null)}
                aria-label={t("graph.closeSelection")}
                title={t("graph.closeSelection")}
              >
                ✕
              </button>
            </div>
            <div className="graph-card-meta">
              <span>{folderOfNode(selectedNode)}</span>
              <span>·</span>
              <span>
                {t("graph.degree")} {selectedDegree}
              </span>
            </div>
            <div className="graph-card-actions">
              {selectedNode.path && (
                <button
                  type="button"
                  className="graph-card-btn graph-card-btn-primary"
                  onClick={() => onOpenFile(selectedNode.path!)}
                >
                  {t("graph.openNote")}
                </button>
              )}
              <button
                type="button"
                className="graph-card-btn"
                onClick={() => panToNode(selectedNode.id)}
              >
                {t("graph.focus")}
              </button>
            </div>
            {selectedNeighbors.length > 0 && (
              <div className="graph-card-neighbors">
                <span className="graph-card-neighbor-label">
                  {t("graph.connectedNodes")} ({selectedNeighbors.length})
                </span>
                {selectedNeighbors.map((nb) => (
                  <button
                    key={nb.id}
                    type="button"
                    className="graph-card-neighbor-item"
                    onClick={() => {
                      setSelected(nb.id);
                      panToNode(nb.id);
                    }}
                    title={nb.path ?? labelOf(nb)}
                  >
                    <span>{labelOf(nb)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <input
          type="search"
          className="graph-inspector-search"
          value={listQuery}
          onChange={(e) => setListQuery(e.target.value)}
          placeholder={t("graph.filterNodes")}
          aria-label={t("graph.filterNodes")}
        />

        {listTotal > LIST_CAP && (
          <p className="graph-inspector-meta">
            {t("graph.listTruncated", {
              shown: String(LIST_CAP),
              total: String(listTotal),
            })}
          </p>
        )}

        <ul className="graph-inspector-list" role="listbox" aria-label={t("graph.nodeList")}>
          {listShown.map(({ node: n, folder, degree }) => (
            <li key={n.id} role="none">
              <button
                type="button"
                role="option"
                className="graph-inspector-item"
                aria-selected={selectedId === n.id}
                aria-label={`${t("graph.openNote")}: ${labelOf(n)}`}
                onFocus={() => {
                  setHover(n.id);
                  panToNode(n.id);
                }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  setSelected(n.id);
                  panToNode(n.id);
                }}
                onDoubleClick={() => {
                  if (n.path) onOpenFile(n.path);
                }}
              >
                <span className="graph-inspector-item-name">{labelOf(n)}</span>
                <span className="graph-inspector-item-meta">
                  {folder} · {degree}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

export const GraphView = memo(GraphViewInner);
