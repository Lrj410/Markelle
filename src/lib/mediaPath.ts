/**
 * Shared path normalization for markdown media destinations.
 * Prevents double-encoding and recovers CommonMark / Obsidian quirks.
 */

/** Decode %XX sequences until stable (cap 3) so encodeURIComponent is safe once. */
export function decodeFsPath(path: string): string {
  let p = path.replace(/\\/g, "/");
  for (let i = 0; i < 3; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(p)) break;
    try {
      const next = decodeURIComponent(p);
      if (next === p) break;
      p = next;
    } catch {
      break;
    }
  }
  return p;
}

/**
 * Parse the inside of `![…](HERE)` — supports `<path with spaces>`,
 * bare paths, and an optional trailing `"title"` / `'title'`.
 */
export function parseMdImageDestination(inside: string): string | null {
  const s = inside.trim();
  if (!s) return null;

  if (s.startsWith("<")) {
    const end = s.indexOf(">");
    if (end > 1) return decodeFsPath(s.slice(1, end).trim());
    return null;
  }

  const withTitle = /^(.*?)\s+("[^"]*"|'[^']*')\s*$/.exec(s);
  if (withTitle) {
    return decodeFsPath((withTitle[1] ?? "").trim());
  }

  // Non-standard but common: path with spaces and no title.
  return decodeFsPath(s);
}

/**
 * Rewrite non-standard `![alt](path with spaces)` into CommonMark
 * `![alt](<path with spaces>)` so markdown-it emits a real <img>.
 * The destination is scanned with balanced parentheses so `Screenshot (1).png`
 * and `a(b(c)).png` are not cut at the first `)`.
 */
export function softenImageDestinations(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "!" && source[i + 1] === "[") {
      const altEnd = source.indexOf("]", i + 2);
      if (altEnd > -1 && source[altEnd + 1] === "(") {
        const dest = scanImageDestination(source, altEnd + 2);
        if (dest) {
          const rewritten = rewriteImageInside(dest.inner);
          if (rewritten !== null) {
            out += source.slice(i, altEnd + 2) + rewritten + ")";
            i = dest.end + 1;
            continue;
          }
        }
      }
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** Scan a `(`…`)` destination starting just past the opening `(` (balanced parens). */
function scanImageDestination(
  source: string,
  start: number,
): { inner: string; end: number } | null {
  let depth = 1;
  const chars: string[] = [];
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\n") return null;
    if (ch === "\\" && i + 1 < source.length) {
      chars.push(ch, source[i + 1]!);
      i += 2;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { inner: chars.join(""), end: i };
    }
    chars.push(ch);
    i += 1;
  }
  return null;
}

/** Angle-bracket the destination when it needs it, else null (leave as-is). */
function rewriteImageInside(inside: string): string | null {
  const trimmed = inside.trim();
  if (trimmed.startsWith("<")) return null;

  let pathPart = trimmed;
  let titlePart = "";
  const tm = /^(.*?)\s+("[^"]*"|'[^']*')\s*$/.exec(trimmed);
  if (tm) {
    pathPart = (tm[1] ?? "").trim();
    titlePart = ` ${tm[2]}`;
  }

  // Already a single token without spaces/parens — leave alone.
  if (!/[\s()]/.test(pathPart)) return null;
  return `<${pathPart}>${titlePart}`;
}

/** Quote a vault-relative path for markdown image destination. */
export function formatMdImageDestination(path: string): string {
  const p = path.replace(/\\/g, "/");
  if (/[\s()]/.test(p)) return `<${p}>`;
  return p;
}
