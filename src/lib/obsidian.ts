import type MarkdownIt from "markdown-it";

export interface ParsedWikiLink {
  embed: boolean;
  target: string;
  heading?: string;
  alias?: string;
}

export interface EmbedSize {
  width?: number;
  height?: number;
  /** True when the whole alias was a size token (e.g. `|200`). */
  isSizeOnly: boolean;
  /** Remaining display alias after peeling a trailing size. */
  displayAlias?: string;
}

const SIZE_TOKEN = /^(\d{1,5})(?:x(\d{1,5}))?$/i;

/** Obsidian image size: `|200` or `|200x100` (optionally after a caption). */
export function parseEmbedSize(alias?: string): EmbedSize {
  if (!alias) return { isSizeOnly: false };
  const trimmed = alias.trim();
  const direct = SIZE_TOKEN.exec(trimmed);
  if (direct) {
    return {
      width: Number(direct[1]),
      height: direct[2] ? Number(direct[2]) : undefined,
      isSizeOnly: true,
    };
  }
  const pipe = trimmed.lastIndexOf("|");
  if (pipe >= 0) {
    const maybe = trimmed.slice(pipe + 1).trim();
    const rest = trimmed.slice(0, pipe).trim();
    const nested = SIZE_TOKEN.exec(maybe);
    if (nested) {
      return {
        width: Number(nested[1]),
        height: nested[2] ? Number(nested[2]) : undefined,
        isSizeOnly: false,
        displayAlias: rest || undefined,
      };
    }
  }
  return { isSizeOnly: false, displayAlias: trimmed };
}

/** Parse inner content of [[...]] */
export function parseWikiInner(inner: string): Omit<ParsedWikiLink, "embed"> {
  let target = inner.trim();
  let alias: string | undefined;
  let heading: string | undefined;

  const pipe = target.indexOf("|");
  if (pipe >= 0) {
    alias = target.slice(pipe + 1).trim();
    target = target.slice(0, pipe).trim();
  }

  const hash = target.indexOf("#");
  if (hash >= 0) {
    heading = target.slice(hash + 1).trim() || undefined;
    target = target.slice(0, hash).trim();
  }

  return { target, heading, alias };
}

export function extractWikiLinks(source: string): ParsedWikiLink[] {
  const links: ParsedWikiLink[] = [];
  const re = /(!)?\[\[([^\]]+?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const embed = Boolean(match[1]);
    const parsed = parseWikiInner(match[2] ?? "");
    if (!parsed.target && !parsed.heading) continue;
    links.push({ embed, ...parsed });
  }
  return links;
}

/**
 * Convert Obsidian callouts into fenced `callout` blocks so the renderer
 * can emit structured HTML without enabling raw HTML.
 */
export function preprocessCallouts(source: string): string {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const head = /^>\s*\[!([^\]]+)\]([+-]?)(?:\s+(.*))?$/.exec(line);
    if (!head) {
      out.push(line);
      i += 1;
      continue;
    }

    const type = (head[1] ?? "note").trim().toLowerCase();
    const fold = head[2] ?? "";
    const customTitle = (head[3] ?? "").trim();
    const title =
      customTitle ||
      type.replace(/(^|[-_/])(\w)/g, (_m, _a: string, c: string) => c.toUpperCase());

    const body: string[] = [];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.startsWith(">")) {
        body.push(next.replace(/^>\s?/, ""));
        i += 1;
        continue;
      }
      if (next.trim() === "" && i + 1 < lines.length && (lines[i + 1] ?? "").startsWith(">")) {
        body.push("");
        i += 1;
        continue;
      }
      break;
    }

    out.push("```callout");
    out.push(JSON.stringify({ type, title, fold }));
    out.push(...body);
    out.push("```");
  }

  return out.join("\n");
}

function readWikiAt(
  src: string,
  start: number,
): { embed: boolean; inner: string; end: number } | null {
  let pos = start;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    embed = true;
    pos += 1;
  }
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) {
    return null;
  }
  pos += 2;
  const close = src.indexOf("]]", pos);
  if (close < 0) return null;
  const inner = src.slice(pos, close);
  if (inner.includes("\n")) return null;
  return { embed, inner, end: close + 2 };
}

export function markdownItWikilink(md: MarkdownIt): void {
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const ch = state.src.charCodeAt(state.pos);
    if (ch !== 0x5b && ch !== 0x21) return false;
    const found = readWikiAt(state.src, state.pos);
    if (!found) return false;
    if (silent) return true;

    const parsed = parseWikiInner(found.inner);
    // Size tokens (`|200`) only apply to embeds; links keep `|alias` as display text.
    const size = found.embed
      ? parseEmbedSize(parsed.alias)
      : { isSizeOnly: false as const, displayAlias: parsed.alias, width: undefined, height: undefined };
    const displayLabel = size.isSizeOnly
      ? parsed.target || (parsed.heading ? `#${parsed.heading}` : "link")
      : size.displayAlias ||
        parsed.alias ||
        parsed.target ||
        (parsed.heading ? `#${parsed.heading}` : "link");
    const token = state.push(found.embed ? "wiki_embed" : "wiki_link", "a", 0);
    token.content = displayLabel;
    token.meta = {
      target: parsed.target,
      heading: parsed.heading ?? "",
      alias: parsed.alias ?? "",
      embed: found.embed,
      width: size.width ?? 0,
      height: size.height ?? 0,
    };
    state.pos = found.end;
    return true;
  });

  md.renderer.rules.wiki_link = (tokens, idx) => {
    const token = tokens[idx]!;
    const meta = token.meta as { target: string; heading: string };
    const label = md.utils.escapeHtml(token.content);
    const target = md.utils.escapeHtml(meta.target);
    const heading = md.utils.escapeHtml(meta.heading);
    return `<a class="wikilink" href="wikilink://${encodeURIComponent(meta.target)}" data-target="${target}" data-heading="${heading}">${label}</a>`;
  };

  md.renderer.rules.wiki_embed = (tokens, idx) => {
    const token = tokens[idx]!;
    const meta = token.meta as {
      target: string;
      heading: string;
      width?: number;
      height?: number;
    };
    const label = md.utils.escapeHtml(token.content || meta.target);
    const target = md.utils.escapeHtml(meta.target);
    const heading = md.utils.escapeHtml(meta.heading);
    const sizeAttr =
      meta.width && meta.width > 0
        ? ` data-width="${meta.width}"${meta.height && meta.height > 0 ? ` data-height="${meta.height}"` : ""}`
        : "";
    const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(meta.target);
    const isAudio = /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(meta.target);
    const isVideo = /\.(mp4|webm|ogv|mov)$/i.test(meta.target);
    if (isImage) {
      return `<span class="wiki-embed wiki-embed-image" data-target="${target}" data-heading="${heading}" data-label="${label}"${sizeAttr}></span>`;
    }
    if (isAudio || isVideo) {
      const kind = isAudio ? "audio" : "video";
      return `<span class="wiki-embed wiki-embed-media" data-kind="${kind}" data-target="${target}" data-heading="${heading}" data-label="${label}"${sizeAttr}></span>`;
    }
    return `<div class="wiki-embed wiki-embed-note" data-target="${target}" data-heading="${heading}" role="link" tabindex="0"><span class="wiki-embed-label">${label}</span><span class="wiki-embed-hint">嵌入 · 点击打开</span></div>`;
  };
}

/** ==highlight== */
export function markdownItMark(md: MarkdownIt): void {
  md.inline.ruler.before("emphasis", "mark", (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== "==") return false;
    const close = state.src.indexOf("==", state.pos + 2);
    if (close < 0) return false;
    if (silent) return true;
    const text = state.src.slice(state.pos + 2, close);
    const token = state.push("mark_text", "mark", 0);
    token.content = text;
    state.pos = close + 2;
    return true;
  });
  md.renderer.rules.mark_text = (tokens, idx) =>
    `<mark>${md.utils.escapeHtml(tokens[idx]!.content)}</mark>`;
}

export function renderCalloutFence(md: MarkdownIt, body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let type = "note";
  let title = "Note";
  let fold = "";
  let start = 0;
  if (lines[0]?.trim().startsWith("{")) {
    try {
      const meta = JSON.parse(lines[0]!) as { type?: string; title?: string; fold?: string };
      type = (meta.type ?? "note").toLowerCase();
      title = meta.title ?? type;
      fold = meta.fold ?? "";
      start = 1;
    } catch {
      /* keep defaults */
    }
  }
  const inner = md.render(lines.slice(start).join("\n"));
  return `<aside class="callout callout-${md.utils.escapeHtml(type)}${
    fold === "-" ? " is-collapsed" : ""
  }" data-callout="${md.utils.escapeHtml(type)}"><div class="callout-title">${md.utils.escapeHtml(
    title,
  )}</div><div class="callout-body">${inner}</div></aside>`;
}
