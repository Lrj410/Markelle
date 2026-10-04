import MarkdownIt from "markdown-it";
import markdownItFootnote from "markdown-it-footnote";
import markdownItTaskLists from "markdown-it-task-lists";
import texmath from "markdown-it-texmath";
import katex from "katex";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import java from "highlight.js/lib/languages/java";
import go from "highlight.js/lib/languages/go";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import {
  extractWikiLinks,
  markdownItMark,
  markdownItWikilink,
  parseEmbedSize,
  preprocessCallouts,
  renderCalloutFence,
  type ParsedWikiLink,
} from "./obsidian";
import { resolveWikiTarget, type VaultFile } from "./vaultIndex";
import { slugify, type TocItem } from "./toc";
import { decodeFsPath, softenImageDestinations } from "./mediaPath";
import { t } from "./i18n";

export type { TocItem } from "./toc";
export { resolveHeadingId } from "./toc";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("java", java);
hljs.registerLanguage("go", go);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);

function createEngine() {
  const md: MarkdownIt = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight(str: string, lang: string): string {
      const info = (lang || "").trim();
      const langName = info.toLowerCase();

      if (langName === "callout") {
        return renderCalloutFence(md, str);
      }

      if (langName === "mermaid") {
        const escaped: string = MarkdownIt().utils.escapeHtml(str.trim());
        return `<div class="mermaid-host"><pre class="mermaid">${escaped}</pre></div>`;
      }
      if (langName && hljs.getLanguage(langName)) {
        try {
          return `<pre class="hljs"><code class="language-${langName}">${
            hljs.highlight(str, { language: langName, ignoreIllegals: true }).value
          }</code></pre>`;
        } catch {
          /* fall through */
        }
      }
      const escaped: string = MarkdownIt().utils.escapeHtml(str);
      return `<pre class="hljs"><code>${escaped}</code></pre>`;
    },
  });

  md.use(markdownItFootnote as never);
  md.use(markdownItTaskLists as never, { enabled: true, label: true });
  md.use(texmath as never, {
    engine: katex,
    delimiters: ["dollars", "brackets"],
    katexOptions: { throwOnError: false, strict: "ignore" },
  });
  md.use(markdownItWikilink as never);
  md.use(markdownItMark as never);

  return md;
}

const engine = createEngine();

export interface RenderResult {
  html: string;
  toc: TocItem[];
  wikiLinks: ParsedWikiLink[];
}

/** Join `base` + relative segments, honoring `.` / `..` (Windows drive-safe). */
function joinFsRelative(base: string, rel: string): string {
  const root = base.replace(/\\/g, "/").replace(/\/$/, "");
  const parts = `${root}/${rel.replace(/\\/g, "/")}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (/^[a-zA-Z]:$/.test(stack[0] ?? "")) {
    return `${stack[0]}/${stack.slice(1).join("/")}`;
  }
  return stack.join("/");
}

/**
 * Markelle paste/import writes vault-root paths like `attachments/yyyy/mm/x.jpg`.
 * Those must NOT be joined onto the note directory (`日记/attachments/...`).
 * Note-relative forms (`./x`, `../attachments/x`, bare `x.jpg`) stay on `baseDir`.
 */
export function isVaultRootRelativePath(href: string): boolean {
  const n = decodeFsPath(href.replace(/\\/g, "/")).trim();
  if (!n) return false;
  if (/^[a-zA-Z]:\//.test(n) || n.startsWith("/")) return false;
  if (n.startsWith("./") || n.startsWith("../")) return false;
  const segs = n.split("/").filter(Boolean);
  if (segs.includes("..") || segs.includes(".")) return false;
  return segs.length >= 2;
}

/** Rewrite relative image / link targets against vault root and/or document directory. */
export function resolveLocalUrl(
  href: string,
  baseDir: string,
  toAssetUrl: (absolutePath: string) => string,
  vaultRoot?: string | null,
): string {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("data:") ||
    href.startsWith("blob:") ||
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("wikilink:") ||
    href.startsWith("mklasset:") ||
    href.includes("mklasset.localhost")
  ) {
    return href;
  }

  const normalized = decodeFsPath(href.replace(/\\/g, "/"));
  let abs: string;
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/")) {
    abs = normalized.startsWith("/") && /^\/[A-Za-z]:\//.test(normalized)
      ? normalized.slice(1)
      : normalized;
  } else if (vaultRoot && isVaultRootRelativePath(normalized)) {
    abs = joinFsRelative(vaultRoot, normalized);
  } else if (baseDir) {
    abs = joinFsRelative(baseDir, normalized);
  } else if (vaultRoot) {
    abs = joinFsRelative(vaultRoot, normalized);
  } else {
    return href;
  }

  try {
    return toAssetUrl(decodeFsPath(abs));
  } catch {
    return href;
  }
}

function decorateWikiLinks(
  html: string,
  vaultFiles: VaultFile[] | undefined,
  baseDir: string | undefined,
  toAssetUrl: ((absolutePath: string) => string) | undefined,
  embedHtml?: Record<string, string>,
  mediaPaths?: Record<string, string>,
  vaultRoot?: string | null,
): string {
  const files = vaultFiles ?? [];

  if (!files.length) {
    html = html
      .replace(/class="wikilink"/g, 'class="wikilink is-unresolved"')
      .replace(
        /class="wiki-embed wiki-embed-note"/g,
        'class="wiki-embed wiki-embed-note is-unresolved"',
      );
  } else {
    html = html.replace(
      /<a class="wikilink" href="wikilink:\/\/([^"]*)" data-target="([^"]*)" data-heading="([^"]*)">([\s\S]*?)<\/a>/g,
      (_full, _href: string, target: string, heading: string, label: string) => {
        // `data-target` is the raw (HTML-escaped) wikilink body; decodeURIComponent
        // would throw URIError on a literal `%` such as `[[100%完成]]`.
        const file = resolveWikiTarget(target, files);
        if (!file) {
          return `<a class="wikilink is-unresolved" href="wikilink://${encodeURIComponent(target)}" data-target="${target}" data-heading="${heading}">${label}</a>`;
        }
        return `<a class="wikilink is-resolved" href="wikilink://${encodeURIComponent(target)}" data-target="${target}" data-heading="${heading}" data-path="${engine.utils.escapeHtml(file.path)}">${label}</a>`;
      },
    );

    html = html.replace(
      /<div class="wiki-embed wiki-embed-note" data-target="([^"]*)" data-heading="([^"]*)"([\s\S]*?)<\/div>/g,
      (full, target: string, heading: string) => {
        const file = resolveWikiTarget(target, files);
        if (!file) {
          return full.replace(
            'class="wiki-embed wiki-embed-note"',
            'class="wiki-embed wiki-embed-note is-unresolved"',
          );
        }
        const pathEsc = engine.utils.escapeHtml(file.path);
        const body = embedHtml?.[file.path];
        if (body) {
          return `<div class="wiki-embed wiki-embed-note is-resolved is-expanded" data-target="${target}" data-heading="${heading}" data-path="${pathEsc}" role="link" tabindex="0"><div class="wiki-embed-head"><span class="wiki-embed-label">${engine.utils.escapeHtml(file.stem || file.name)}</span><span class="wiki-embed-hint">${t("md.embed")}</span></div><div class="wiki-embed-body">${body}</div></div>`;
        }
        return full
          .replace(
            'class="wiki-embed wiki-embed-note"',
            'class="wiki-embed wiki-embed-note is-resolved"',
          )
          .replace(
            `data-heading="${heading}"`,
            `data-heading="${heading}" data-path="${pathEsc}"`,
          );
      },
    );
  }

  if (baseDir && toAssetUrl) {
    const mediaOrImage =
      /<span class="wiki-embed wiki-embed-(?:image|media)"([^>]*)><\/span>/g;
    html = html.replace(mediaOrImage, (_full, attrBlob: string) => {
      const target = /data-target="([^"]*)"/.exec(attrBlob)?.[1] ?? "";
      const label = /data-label="([^"]*)"/.exec(attrBlob)?.[1] ?? "";
      const kind = /data-kind="([^"]*)"/.exec(attrBlob)?.[1];
      const width = Number(/data-width="(\d+)"/.exec(attrBlob)?.[1] ?? 0) || undefined;
      const height = Number(/data-height="(\d+)"/.exec(attrBlob)?.[1] ?? 0) || undefined;
      const file = files.length ? resolveWikiTarget(target, files) : undefined;
      let absPath =
        mediaPaths?.[target] ||
        mediaPaths?.[target.replace(/\\/g, "/")] ||
        file?.path;
      if (!absPath && baseDir) {
        absPath = resolveLocalUrl(target, baseDir, (p) => p, vaultRoot);
      }
      try {
        if (!absPath) {
          return `<span class="wiki-embed is-unresolved">${engine.utils.escapeHtml(target)}</span>`;
        }
        if (/\.svgz?$/i.test(target)) {
          return `<span class="wiki-embed wiki-embed-denied" title="${engine.utils.escapeHtml(t("md.svgDenied"))}">${engine.utils.escapeHtml(t("md.svgDeniedLabel", { target }))}</span>`;
        }
        const src = engine.utils.escapeHtml(toAssetUrl(absPath));
        const alt = engine.utils.escapeHtml(label || target);
        const sizeAttrs = sizeHtmlAttrs(width, height);
        if (kind === "audio" || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(target)) {
          return `<audio class="md-audio" controls preload="metadata" src="${src}">${alt}</audio>`;
        }
        if (kind === "video" || /\.(mp4|webm|ogv|mov)$/i.test(target)) {
          return `<video class="md-video" controls preload="metadata" src="${src}"${sizeAttrs}></video>`;
        }
        return `<img class="wiki-embed-img" src="${src}" alt="${alt}"${sizeAttrs} loading="lazy" />`;
      } catch {
        return `<span class="wiki-embed is-unresolved">${engine.utils.escapeHtml(target)}</span>`;
      }
    });
  }

  return html;
}

function sizeHtmlAttrs(width?: number, height?: number): string {
  if (!width || width <= 0) return "";
  if (height && height > 0) {
    return ` width="${width}" height="${height}" style="width:${width}px;height:${height}px;max-width:100%"`;
  }
  return ` width="${width}" style="width:${width}px;height:auto;max-width:100%"`;
}

/**
 * Promote audio/video URLs wrongly emitted as <img>, and apply Obsidian-style
 * size tokens in alt text (`|200`, `caption|200x100`).
 */
export function promoteMediaElements(html: string): string {
  return html.replace(/<img\s+([^>]*?)>/gi, (full, attrs: string) => {
    const srcM = /\bsrc="([^"]+)"/i.exec(attrs);
    if (!srcM) return full;
    const src = srcM[1] ?? "";
    const altM = /\balt="([^"]*)"/i.exec(attrs);
    const alt = altM?.[1] ?? "";
    const pathOnly = (src.split("?")[0] ?? src).split("#")[0] ?? src;

    if (/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(pathOnly)) {
      return `<audio class="md-audio" controls preload="metadata" src="${src}">${engine.utils.escapeHtml(alt)}</audio>`;
    }
    if (/\.(mp4|webm|ogv|mov)$/i.test(pathOnly)) {
      return `<video class="md-video" controls preload="metadata" src="${src}"></video>`;
    }

    // `![|200](url)` or `![caption|200](url)`
    const size = parseEmbedSize(alt.startsWith("|") ? alt.slice(1) : alt);
    const looksLikeSize =
      size.width != null &&
      (size.isSizeOnly || SIZE_IN_ALT.test(alt) || alt.startsWith("|"));
    if (looksLikeSize && size.width) {
      const cleanAlt = size.isSizeOnly ? "" : size.displayAlias || "";
      const withoutAlt = attrs.replace(/\s*\balt="[^"]*"/i, "");
      const withoutStyle = withoutAlt.replace(/\s*\bstyle="[^"]*"/i, "");
      const withoutWh = withoutStyle
        .replace(/\s*\bwidth="[^"]*"/i, "")
        .replace(/\s*\bheight="[^"]*"/i, "");
      return `<img ${withoutWh.trim()} alt="${engine.utils.escapeHtml(cleanAlt)}"${sizeHtmlAttrs(size.width, size.height)} loading="lazy">`;
    }
    return full;
  });
}

const SIZE_IN_ALT = /(?:^|\|)\d{1,5}(?:x\d{1,5})?$/i;

/** Hard ceiling — never run markdown-it on multi‑MB blobs (use the paged large-file reader). */
const MAX_RENDER_CHARS = 2 * 1024 * 1024;

export function renderMarkdown(
  source: string,
  options: {
    baseDir?: string;
    /** Vault root — required to sync-resolve `attachments/yyyy/mm/…` from nested notes. */
    vaultRoot?: string | null;
    toAssetUrl?: (absolutePath: string) => string;
    vaultFiles?: VaultFile[];
    /** Pre-rendered HTML for note embeds keyed by absolute path. */
    embedHtml?: Record<string, string>;
    /** Resolved absolute paths for media targets (wiki + markdown images). */
    mediaPaths?: Record<string, string>;
    /**
     * When false (default), strip remote http(s) images/media to prevent
     * tracking beacons in untrusted notes. data: URLs remain allowed.
     */
    allowRemoteHttpMedia?: boolean;
  } = {},
): RenderResult {
  const allowRemoteHttpMedia = options.allowRemoteHttpMedia === true;
  const clipped =
    source.length > MAX_RENDER_CHARS
      ? `${source.slice(0, MAX_RENDER_CHARS)}\n\n<!-- markelle: truncated for render safety -->\n`
      : source;
  const softened = softenImageDestinations(clipped);
  const wikiLinks = extractWikiLinks(softened);
  const prepared = preprocessCallouts(softened);
  const env: Record<string, unknown> = {};
  let html = engine.render(prepared, env);

  const used = new Map<string, number>();
  const toc: TocItem[] = [];

  html = html.replace(
    /<h([1-6])>([\s\S]*?)<\/h\1>/g,
    (_match: string, levelStr: string, inner: string) => {
      const level = Number(levelStr);
      const text = inner.replace(/<[^>]+>/g, "").trim();
      const id = slugify(text, used);
      toc.push({ id, level, text });
      return `<h${level} id="${id}">${inner}</h${level}>`;
    },
  );

  html = decorateWikiLinks(
    html,
    options.vaultFiles,
    options.baseDir,
    options.toAssetUrl,
    options.embedHtml,
    options.mediaPaths,
    options.vaultRoot,
  );

  // Drop dangerous / non-navigable schemes at render time (defense in depth).
  html = html.replace(
    /<a\s+([^>]*?)href="([^"]*)"/gi,
    (full, before: string, href: string) => {
      const h = href.trim().toLowerCase();
      if (
        h.startsWith("http://") ||
        h.startsWith("https://") ||
        h.startsWith("mailto:") ||
        h.startsWith("#") ||
        h.startsWith("wikilink:") ||
        h.startsWith("markelle-file:") ||
        h.startsWith("mklasset:")
      ) {
        return full;
      }
      // Relative / fragment paths carry no scheme — leave them untouched so the
      // `.md` → markelle-file:// rewrite below can still resolve them.
      if (!/^[a-z][a-z0-9+.-]*:/i.test(h)) return full;
      // Drop file: and other schemes — never emit navigable file:// in the WebView.
      return `<a ${before}href="#"`;
    },
  );

  // Always gate remote media (independent of baseDir / asset rewrite path).
  if (!allowRemoteHttpMedia) {
    html = html.replace(
      /<img\s+([^>]*?)src="(https?:\/\/[^"]+)"([^>]*)>/gi,
      (_full, before: string, url: string, after: string) => {
        void before;
        void after;
        return `<span class="md-remote-media-blocked" title="remote media blocked">${engine.utils.escapeHtml(url.slice(0, 64))}</span>`;
      },
    );
  }

  if (options.baseDir && options.toAssetUrl) {
    const { baseDir, toAssetUrl, vaultRoot } = options;
    const mediaPaths = options.mediaPaths;
    html = html.replace(
      /<(img|a)\s+([^>]*?)(src|href)="([^"]+)"/g,
      (full: string, tag: string, before: string, attr: string, url: string) => {
        if (
          tag === "a" &&
          (url.startsWith("http") ||
            url.startsWith("#") ||
            url.startsWith("mailto:") ||
            url.startsWith("wikilink:") ||
            url.startsWith("markelle-file:"))
        ) {
          return full;
        }
        if (tag === "img" && (url.startsWith("mklasset:") || url.includes("mklasset.localhost"))) {
          return full;
        }

        // Markdown note links → in-app open, never WebView navigation
        if (tag === "a" && /\.(md|markdown|mdown|mkd)(#.*)?$/i.test(url.split("?")[0] ?? url)) {
          const pathPart = url.split("#")[0] ?? url;
          const headingPart = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
          const abs = resolveLocalUrl(pathPart, baseDir, (p) => p, vaultRoot);
          const esc = engine.utils.escapeHtml(abs);
          const headingAttr = headingPart
            ? ` data-heading="${engine.utils.escapeHtml(decodeURIComponent(headingPart))}"`
            : "";
          return `<a ${before}href="markelle-file://${encodeURIComponent(abs)}" data-path="${esc}"${headingAttr}`;
        }

        // Remote http(s)/data images — allow path already gated above when denied.
        if (
          tag === "img" &&
          (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:"))
        ) {
          return full;
        }

        const decoded = decodeFsPath(url);
        const mapped =
          mediaPaths?.[url] ||
          mediaPaths?.[decoded] ||
          mediaPaths?.[url.replace(/\\/g, "/")] ||
          mediaPaths?.[decoded.replace(/\\/g, "/")];
        const resolved = mapped
          ? toAssetUrl(decodeFsPath(mapped))
          : resolveLocalUrl(url, baseDir, toAssetUrl, vaultRoot);
        return `<${tag} ${before}${attr}="${engine.utils.escapeHtml(resolved)}"`;
      },
    );
  }

  html = promoteMediaElements(html);

  return { html, toc, wikiLinks };
}
