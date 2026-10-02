import { extractWikiLinks } from "./obsidian";

/** Raster / safe embeds only — SVG is intentionally excluded (scriptable). */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|ico|heic|heif)$/i;
const SVG_RE = /\.svgz?$/i;

export function isImageWikiTarget(target: string): boolean {
  return IMAGE_RE.test(target.trim());
}

export function isSvgWikiTarget(target: string): boolean {
  return SVG_RE.test(target.trim());
}

/** Unique note-embed targets in document order (excludes image embeds). */
export function collectNoteEmbedTargets(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of extractWikiLinks(source)) {
    if (!link.embed || !link.target) continue;
    if (isImageWikiTarget(link.target) || isSvgWikiTarget(link.target)) continue;
    const key = link.target;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Downgrade `![[...]]` note embeds to `[[...]]` so nested render cannot recurse. */
export function stripNoteEmbeds(source: string): string {
  return source.replace(/!\[\[([^\]]+?)\]\]/g, (_full, inner: string) => {
    const target = String(inner).split("|")[0]?.split("#")[0]?.trim() ?? "";
    if (isImageWikiTarget(target) || isSvgWikiTarget(target)) return `![[${inner}]]`;
    return `[[${inner}]]`;
  });
}
