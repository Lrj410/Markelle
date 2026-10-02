/** Adjust ATX heading levels in markdown source by heading id (slug). */

import { slugify } from "./toc";

export interface HeadingHit {
  id: string;
  level: number;
  /** Absolute start index of the line in source. */
  lineStart: number;
  /** Length of leading `#` run. */
  hashes: number;
  text: string;
}

interface LineHit extends HeadingHit {
  /** 0-based line index of the heading. */
  line: number;
}

/** Split source into lines and locate ATX headings with ids + line indices. */
function listHeadingLines(source: string): { lines: string[]; hits: LineHit[] } {
  const lines = source.split("\n");
  const hits: LineHit[] = [];
  const used = new Map<string, number>();
  let offset = 0;
  let line = 0;
  /** Open fenced-code marker char (`` ` `` or `~`), or null when outside a fence. */
  let fence: string | null = null;
  for (const text of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
      // Fence delimiters are never headings.
    } else if (!fence) {
      // `#` inside a fenced code block is not a heading — skipping fences keeps
      // this list aligned with what the renderer emits.
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
      if (m) {
        const hashes = m[1]!.length;
        const body = m[2]!.trim();
        hits.push({
          id: slugify(body, used),
          level: hashes,
          lineStart: offset,
          hashes,
          text: body,
          line,
        });
      }
    }
    offset += text.length + 1;
    line += 1;
  }
  return { lines, hits };
}

/** First line index at/after `idx + 1` whose heading is same-or-higher level. */
function blockEndLine(hits: LineHit[], idx: number, total: number): number {
  const level = hits[idx]!.level;
  for (let j = idx + 1; j < hits.length; j++) {
    if (hits[j]!.level <= level) return hits[j]!.line;
  }
  return total;
}

/** Find ATX headings (`#`…`######`) with stable ids matching slugify rules. */
export function listAtxHeadings(source: string): HeadingHit[] {
  return listHeadingLines(source).hits.map((h) => ({
    id: h.id,
    level: h.level,
    lineStart: h.lineStart,
    hashes: h.hashes,
    text: h.text,
  }));
}

/**
 * Change heading level for `headingId` by `delta` (-1 = promote, +1 = demote).
 * Clamped to 1–6. Returns original source if not found / no change.
 */
export function adjustHeadingLevel(
  source: string,
  headingId: string,
  delta: number,
): string {
  if (!delta) return source;
  const hits = listAtxHeadings(source);
  const hit = hits.find((h) => h.id === headingId);
  if (!hit) return source;
  const nextLevel = Math.min(6, Math.max(1, hit.level + delta));
  if (nextLevel === hit.level) return source;

  const before = source.slice(0, hit.lineStart);
  const rest = source.slice(hit.lineStart);
  const nl = rest.indexOf("\n");
  const line = nl >= 0 ? rest.slice(0, nl) : rest;
  const after = nl >= 0 ? rest.slice(nl) : "";
  const body = line.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trimEnd();
  const nextLine = `${"#".repeat(nextLevel)} ${body}`;
  return before + nextLine + after;
}

/**
 * Move a heading one slot relative to the nearest same-or-higher heading,
 * carrying its whole section (heading + body + nested sub-headings).
 *
 * `direction = 1` swaps with the next same-or-higher heading; `direction = -1`
 * swaps with the previous one. Nested (deeper) sub-headings are skipped, so a
 * child heading can never be lifted above its own parent heading.
 */
export function reorderHeading(
  source: string,
  headingId: string,
  direction: -1 | 1,
): string {
  const { lines, hits } = listHeadingLines(source);
  const idx = hits.findIndex((h) => h.id === headingId);
  if (idx < 0) return source;

  const level = hits[idx]!.level;
  let j = -1;
  if (direction === 1) {
    for (let k = idx + 1; k < hits.length; k++) {
      if (hits[k]!.level <= level) {
        j = k;
        break;
      }
    }
  } else {
    for (let k = idx - 1; k >= 0; k--) {
      if (hits[k]!.level <= level) {
        j = k;
        break;
      }
    }
  }
  if (j < 0) return source;

  const aStart = hits[idx]!.line;
  const aEnd = blockEndLine(hits, idx, lines.length);
  const bStart = hits[j]!.line;
  const bEnd = blockEndLine(hits, j, lines.length);

  if (j > idx) {
    // Neighbour section sits right after the current one (aEnd === bStart):
    // exchange the two whole blocks.
    return [
      ...lines.slice(0, aStart),
      ...lines.slice(bStart, bEnd),
      ...lines.slice(aStart, aEnd),
      ...lines.slice(bEnd),
    ].join("\n");
  }

  // Moving up: if the neighbour's section contains the current heading it is an
  // ancestor (parent), so lifting the child above it is not allowed.
  if (bEnd > aStart) return source;

  return [
    ...lines.slice(0, bStart),
    ...lines.slice(aStart, aEnd),
    ...lines.slice(bStart, bEnd),
    ...lines.slice(aEnd),
  ].join("\n");
}

/** Move a heading to `targetIndex` among ATX headings (0-based). */
export function moveHeadingTo(
  source: string,
  headingId: string,
  targetIndex: number,
): string {
  const initial = listAtxHeadings(source);
  const startIdx = initial.findIndex((h) => h.id === headingId);
  if (startIdx < 0) return source;
  if (targetIndex < 0 || targetIndex >= initial.length) return source;

  let next = source;
  let best = source;
  let bestDistance = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();

  for (let guard = 0; guard < 256; guard++) {
    const hits = listAtxHeadings(next);
    const idx = hits.findIndex((h) => h.id === headingId);
    if (idx < 0) return next;

    const distance = Math.abs(idx - targetIndex);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = next;
    }
    if (idx === targetIndex) return next;

    // Reordering only permutes the heading order; a repeated signature means we
    // are cycling, so stop at the closest legal position found so far.
    const signature = hits.map((h) => h.id).join("\u0000");
    if (seen.has(signature)) return best;
    seen.add(signature);

    const moved = reorderHeading(next, headingId, idx < targetIndex ? 1 : -1);
    if (moved === next) return best;
    next = moved;
  }
  return best;
}
