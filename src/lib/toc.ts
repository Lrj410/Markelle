/** Lightweight TOC helpers — kept separate from markdown.ts so App shell
 *  does not pull katex / highlight.js on cold start. */

export interface TocItem {
  id: string;
  level: number;
  text: string;
}

export function slugify(text: string, used: Map<string, number>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function slugifyOnce(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

/** Resolve a wikilink heading fragment against a TOC (handles duplicate titles). */
export function resolveHeadingId(heading: string, toc: TocItem[]): string {
  const raw = heading.trim();
  if (!raw) return "";
  const byText = toc.find(
    (t) => t.text === raw || t.text.toLowerCase() === raw.toLowerCase(),
  );
  if (byText) return byText.id;
  const once = slugifyOnce(raw);
  const byId = toc.find((t) => t.id === raw || t.id === once);
  if (byId) return byId.id;
  return once;
}
