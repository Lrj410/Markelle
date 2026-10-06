import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown, type TocItem } from "../lib/markdown";
import { renderMermaidBlocks } from "../lib/mermaid";
import { collectNoteEmbedTargets, stripNoteEmbeds } from "../lib/embeds";
import { collectMediaTargets, resolveMediaMap } from "../lib/mediaResolve";
import { filesFromDataTransfer, isImageFile } from "../lib/attachments";
import { formatBytes, PREVIEW_PAGE_CHARS, readMarkdownFile, statMarkdownFile } from "../lib/files";
import type { OpenedFile } from "../lib/files";
import { isGatedAssetUrl, toGatedAssetUrl } from "../lib/assets";
import { resolveWikiTarget, type VaultFile } from "../lib/vaultIndex";
import { slicePreviewPage } from "../lib/previewPage";
import { largeFileLines } from "../lib/largeFile";
import type { LayoutPreset } from "../lib/types";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";
import { EditorContextMenu, type ContextMenuItem } from "./EditorContextMenu";
// KaTeX + highlight.js theme + Source Serif 4. Loading these statically inside a
// lazy chunk keeps them out of the cold start; Vite pulls the CSS in before this
// module executes, so the first rendered document is never unstyled.
import "../styles/reader-assets.css";

interface Props {
  docKey: string;
  source: string;
  baseDir: string;
  /** Vault root for Obsidian-style media basename lookup. */
  vaultRoot?: string | null;
  /** Settings attachment folder (vault-relative). */
  attachmentFolder?: string;
  layout: LayoutPreset;
  lineWidth: number;
  dark: boolean;
  vaultFiles?: VaultFile[];
  /** When true, keep remote https images in the reader (default false). */
  allowRemoteHttpMedia?: boolean;
  /** Bumps when vault index identity changes so wikilinks re-resolve. */
  vaultEpoch?: string;
  /** Native large-file configuration for streaming pages directly from Rust memmap store */
  largeDoc?: {
    path: string;
    totalLines: number;
    totalSize: number;
    isHydrating?: boolean;
  };
  onSwitchToSource?: () => void;
  onToc: (toc: TocItem[]) => void;
  onWikiOpen: (path: string, heading?: string, wikiTarget?: string) => void;
  /** Toggle the n-th GFM task checkbox (0-based) in the source document. */
  onTaskToggle?: (index: number) => void;
  /** Read-mode paste: import images and append markdown snippets. */
  onPasteImages?: (
    files: File[],
  ) => Promise<string[] | false | void | boolean> | string[] | false | void;
}

function isAssetUrl(href: string): boolean {
  return isGatedAssetUrl(href);
}

/* --------------------------------------------------------------------------
   Embedded-note render cache
   --------------------------------------------------------------------------
   Split-mode typing re-runs the embed effect on every keystroke. Each embed
   used to be re-read from disk and re-rendered (renderMarkdown + KaTeX /
   highlight), which hammered the disk and dropped frames. Cache the rendered
   HTML keyed by the target's path + on-disk identity (mtime/size) + the render
   context, so an unchanged embed is neither re-read nor re-rendered. Bounded
   Map (LRU-ish), no new dependencies.
   -------------------------------------------------------------------------- */
const EMBED_HTML_CACHE_LIMIT = 50;
const embedHtmlCache = new Map<string, { key: string; html: string }>();

function readEmbedHtmlCache(path: string, key: string): string | null {
  const hit = embedHtmlCache.get(path);
  if (!hit || hit.key !== key) return null;
  // Refresh recency so frequently-visible embeds survive eviction.
  embedHtmlCache.delete(path);
  embedHtmlCache.set(path, hit);
  return hit.html;
}

function writeEmbedHtmlCache(path: string, key: string, html: string): void {
  embedHtmlCache.delete(path);
  embedHtmlCache.set(path, { key, html });
  while (embedHtmlCache.size > EMBED_HTML_CACHE_LIMIT) {
    const oldest = embedHtmlCache.keys().next().value;
    if (oldest === undefined) break;
    embedHtmlCache.delete(oldest);
  }
}

/** Shallow string-record equality so an unchanged map does not trigger a render. */
function sameStringRecord(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function MarkdownViewInner({
  docKey,
  source,
  baseDir,
  vaultRoot = null,
  attachmentFolder = "attachments",
  layout,
  lineWidth,
  dark,
  vaultFiles,
  allowRemoteHttpMedia = false,
  vaultEpoch,
  largeDoc,
  onSwitchToSource,
  onToc,
  onWikiOpen,
  onTaskToggle,
  onPasteImages,
}: Props) {
  useLocale();
  const articleRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const [embedHtml, setEmbedHtml] = useState<Record<string, string>>({});
  const [mediaPaths, setMediaPaths] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [largeDocLines, setLargeDocLines] = useState<{ page: number; text: string } | null>(null);
  const [largeDocLoading, setLargeDocLoading] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );

  const closeLightbox = useCallback(() => setLightbox(null), []);
  const [hoverPreview, setHoverPreview] = useState<{
    x: number;
    y: number;
    target: string;
    snippet?: string;
    isUnresolved?: boolean;
  } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useModalFocusTrap({
    active: Boolean(lightbox),
    containerRef: lightboxRef,
    onEscape: closeLightbox,
    initialFocusSelector: ".img-lightbox-close",
  });

  useEffect(() => {
    setPage(1);
    setLargeDocLines(null);
  }, [docKey]);

  // Fast tab / panel switches can unmount mid-hover; clear the pending timer so
  // it never calls setHoverPreview on a dead component.
  useEffect(
    () => () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    },
    [],
  );

  const LARGE_DOC_LINES_PER_PAGE = 400;
  const largeDocPath = largeDoc?.path;
  const largeDocTotalLines = largeDoc?.totalLines;

  // Latest in-memory source, read by the paging effect WITHOUT making `source`
  // a dependency. Page 1 is always served from memory (renderSource falls back
  // to `source`), so the effect only needs to react to path/total/page changes —
  // a keystroke must not re-issue a backend fetch.
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  });

  useEffect(() => {
    if (!largeDocPath) {
      setLargeDocLines(null);
      return;
    }
    // Page 1 already lives in memory (the read seed / buffer): skip the
    // redundant backend fetch and let `renderSource` supply the text.
    if (page === 1 && sourceRef.current) {
      setLargeDocLines((prev) => (prev === null ? prev : null));
      setLargeDocLoading(false);
      return;
    }
    let cancelled = false;
    const totalLines = Math.max(1, largeDocTotalLines || 2000);
    const startLine = (page - 1) * LARGE_DOC_LINES_PER_PAGE + 1;
    const count = Math.min(LARGE_DOC_LINES_PER_PAGE, Math.max(1, totalLines - startLine + 1));

    setLargeDocLoading(true);
    largeFileLines(largeDocPath, startLine, count)
      .then((res) => {
        if (!cancelled && res.lines) {
          setLargeDocLines({ page, text: res.lines.join("\n") });
          setLargeDocLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLargeDocLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [largeDocPath, largeDocTotalLines, page]);

  const inMemoryPaged = !largeDoc && source.length > PREVIEW_PAGE_CHARS;
  const inMemoryPageInfo = useMemo(
    () => (inMemoryPaged ? slicePreviewPage(source, page, PREVIEW_PAGE_CHARS) : null),
    [inMemoryPaged, source, page],
  );

  const activePageCount = useMemo(() => {
    if (largeDoc) {
      return Math.max(1, Math.ceil((largeDoc.totalLines || 2000) / LARGE_DOC_LINES_PER_PAGE));
    }
    if (inMemoryPageInfo) {
      return inMemoryPageInfo.pageCount;
    }
    return 1;
  }, [largeDoc, inMemoryPageInfo]);

  const renderSource = useMemo(() => {
    if (largeDoc) {
      if (largeDocLines && largeDocLines.page === page) {
        return largeDocLines.text;
      }
      return page === 1 ? source : "";
    }
    if (inMemoryPageInfo) {
      return inMemoryPageInfo.text;
    }
    // Same threshold as `inMemoryPaged` above (single source of truth), so the
    // fallback slice can never disagree with the computed page count.
    if (source.length > PREVIEW_PAGE_CHARS) {
      return source.slice(0, PREVIEW_PAGE_CHARS);
    }
    return source;
  }, [largeDoc, largeDocLines, page, source, inMemoryPageInfo]);

  useEffect(() => {
    let cancelled = false;
    const targets = collectMediaTargets(renderSource);
    if (!targets.length || !baseDir) {
      setMediaPaths((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    void resolveMediaMap(vaultRoot, baseDir, targets, attachmentFolder).then((map) => {
      if (cancelled) return;
      // resolveMediaMap always returns a fresh object; without this check every
      // run re-renders (and re-runs the embed effect that depends on mediaPaths).
      setMediaPaths((prev) => (sameStringRecord(prev, map) ? prev : map));
    });
    return () => {
      cancelled = true;
    };
  }, [renderSource, baseDir, vaultRoot, vaultEpoch, attachmentFolder]);

  useEffect(() => {
    let cancelled = false;
    const targets = collectNoteEmbedTargets(renderSource);
    if (!targets.length || !vaultFiles?.length) {
      setEmbedHtml((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }

    // Nested embeds are rendered with this context, so a change to it must
    // invalidate the HTML cache alongside the on-disk identity.
    const mediaSig = Object.keys(mediaPaths)
      .sort()
      .map((key) => `${key}=${mediaPaths[key]}`)
      .join(";");
    const ctxSig = `${baseDir}|${vaultRoot ?? ""}|${allowRemoteHttpMedia ? 1 : 0}|${
      vaultEpoch ?? ""
    }|${mediaSig}`;

    void (async () => {
      const slice = targets.slice(0, 12);
      const settled = await Promise.all(
        slice.map(async (target) => {
          const file = resolveWikiTarget(target, vaultFiles);
          if (!file) return null;
          try {
            // Stat is cheap compared to a full read + renderMarkdown. Typing in
            // split mode re-runs this effect per keystroke, so an embed whose
            // mtime/size + context are unchanged is served from cache.
            const stat = await statMarkdownFile(file.path).catch(() => null);
            let opened: OpenedFile | null = null;
            let mtimeMs: number;
            let size: number;
            if (stat) {
              mtimeMs = stat.mtimeMs;
              size = stat.size;
            } else {
              opened = await readMarkdownFile(file.path, false);
              mtimeMs = opened.mtimeMs;
              size = opened.size;
            }

            const cacheKey = `${file.path}|${mtimeMs}|${size}|${ctxSig}`;
            const cached = readEmbedHtmlCache(file.path, cacheKey);
            if (cached !== null) return [file.path, cached] as const;

            if (!opened) opened = await readMarkdownFile(file.path, false);
            const nested = stripNoteEmbeds(opened.content);
            const { html: body } = renderMarkdown(nested, {
              baseDir: file.path.replace(/[/\\][^/\\]+$/, "") || baseDir,
              vaultRoot,
              vaultFiles,
              toAssetUrl: toGatedAssetUrl,
              mediaPaths,
              allowRemoteHttpMedia,
            });
            writeEmbedHtmlCache(file.path, cacheKey, body);
            return [file.path, body] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const row of settled) {
        if (row) map[row[0]] = row[1];
      }
      setEmbedHtml((prev) => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(map);
        if (
          prevKeys.length === nextKeys.length &&
          nextKeys.every((key) => prev[key] === map[key])
        ) {
          return prev;
        }
        return map;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    renderSource,
    vaultFiles,
    vaultEpoch,
    baseDir,
    mediaPaths,
    vaultRoot,
    allowRemoteHttpMedia,
  ]);

  const { html, toc } = useMemo(
    () =>
      renderMarkdown(renderSource, {
        baseDir,
        vaultRoot,
        vaultFiles,
        embedHtml,
        mediaPaths,
        allowRemoteHttpMedia,
        toAssetUrl: toGatedAssetUrl,
      }),
    [renderSource, baseDir, vaultRoot, vaultFiles, embedHtml, mediaPaths, allowRemoteHttpMedia],
  );

  useEffect(() => {
    onToc(toc);
  }, [toc, onToc]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [docKey, page]);

  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;

    root.querySelectorAll("table").forEach((table) => {
      if (table.parentElement?.classList.contains("md-table-wrap")) return;
      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      table.parentNode?.insertBefore(wrap, table);
      wrap.appendChild(table);
    });

    if (onTaskToggle) {
      root.querySelectorAll(".task-list-item input[type=checkbox]").forEach((el) => {
        const input = el as HTMLInputElement;
        input.disabled = false;
        input.style.cursor = "pointer";
      });
    }

    root.querySelectorAll("img").forEach((el) => {
      const img = el as HTMLImageElement;
      if (img.dataset.mklBound) return;
      img.dataset.mklBound = "1";
      const markBroken = () => {
        img.classList.add("is-broken");
        const label = img.alt || img.getAttribute("data-target") || t("md.image");
        img.alt = label;
        img.title = t("md.imageBroken");
      };
      // Defer: sync vaultRoot rewrite + async mediaPaths may replace src on next paint.
      const check = () => {
        if (!img.isConnected) return;
        if (img.complete && img.naturalWidth === 0 && Boolean(img.getAttribute("src"))) {
          markBroken();
        }
      };
      window.setTimeout(check, 0);
      img.addEventListener("error", markBroken, { once: true });
      img.addEventListener(
        "load",
        () => {
          img.classList.remove("is-broken");
        },
        { once: true },
      );
    });

    let cancelled = false;
    let raf = 0;
    let idle = 0;
    let fallbackTimer = 0;

    const runMermaid = () => {
      if (cancelled) return;
      void renderMermaidBlocks(root, dark);
    };

    // Paint markdown first; Mermaid after paint / idle to avoid switch jank.
    raf = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const ric = (
        window as Window & {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        }
      ).requestIdleCallback;
      if (ric) {
        idle = ric(runMermaid, { timeout: 400 });
      } else {
        fallbackTimer = window.setTimeout(runMermaid, 32);
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      const cic = (
        window as Window & { cancelIdleCallback?: (id: number) => void }
      ).cancelIdleCallback;
      if (idle && cic) cic(idle);
    };
  }, [html, dark, onTaskToggle]);

  return (
    <div
      ref={scrollRef}
      className={`reader-scroll layout-${layout}`}
      style={
        {
          /* Font size lives on :root (--reader-font-size) for Ctrl+wheel hot path. */
          "--reader-measure": `${lineWidth}ch`,
        } as CSSProperties
      }
      onPaste={(event) => {
        if (!onPasteImages || !event.clipboardData) return;
        const files = filesFromDataTransfer(event.clipboardData).filter(isImageFile);
        if (!files.length) return;
        event.preventDefault();
        void Promise.resolve(onPasteImages(files)).then((r) => {
          if (Array.isArray(r) && r.length) {
            /* App patches document content */
          }
        });
      }}
    >
      {activePageCount > 1 ? (
        <div className="preview-page-bar" role="navigation" aria-label={t("md.pagerAria")}>
          <button
            type="button"
            className="btn ghost"
            disabled={page <= 1 || largeDocLoading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("md.prevPage")}
          </button>
          <span className="preview-page-meta">
            {t("md.pageOf", { page, count: activePageCount })}
          </span>
          <button
            type="button"
            className="btn ghost"
            disabled={page >= activePageCount || largeDocLoading}
            onClick={() => setPage((p) => Math.min(activePageCount, p + 1))}
          >
            {t("md.nextPage")}
          </button>
          {activePageCount > 2 && (
            <div className="page-jump-wrap">
              <span className="page-jump-label">{t("md.jumpTo")}</span>
              <input
                type="number"
                min={1}
                max={activePageCount}
                defaultValue={page}
                key={`page-input-${page}`}
                className="page-jump-input"
                title={t("md.jumpToTitle")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const val = parseInt((e.target as HTMLInputElement).value, 10);
                    if (!isNaN(val) && val >= 1 && val <= activePageCount) {
                      setPage(val);
                    }
                  }
                }}
              />
              <span className="page-jump-label">{t("md.pageUnit")}</span>
            </div>
          )}
          {onSwitchToSource && (
            <button
              type="button"
              className="btn ghost page-switch-btn"
              onClick={onSwitchToSource}
              title="Ctrl+E"
            >
              {t("md.switchToSource")}
            </button>
          )}
        </div>
      ) : null}
      {largeDoc ? (
        <div className="large-doc-notice">
          <span>
            {t("app.largeDocReadNotice", {
              page,
              count: activePageCount,
              from: (page - 1) * LARGE_DOC_LINES_PER_PAGE + 1,
              to: Math.min(page * LARGE_DOC_LINES_PER_PAGE, largeDoc.totalLines || 2000),
              lines: largeDoc.totalLines || 2000,
              size: formatBytes(largeDoc.totalSize),
            })}
            {largeDoc.isHydrating && (
              <span className="large-doc-hydrating-badge">（{t("app.indexingBackground")}）</span>
            )}
          </span>
          {onSwitchToSource && (
            <button
              type="button"
              className="btn small"
              onClick={onSwitchToSource}
            >
              {t("md.switchToSource")}
            </button>
          )}
        </div>
      ) : activePageCount > 1 && !largeDoc ? (
        <div className="large-doc-notice">
          <span>
            {t("app.largeDocPagedNotice", {
              page,
              count: activePageCount,
              size: formatBytes(source.length),
            })}
          </span>
          {onSwitchToSource && (
            <button
              type="button"
              className="btn small"
              onClick={onSwitchToSource}
            >
              {t("md.switchToSource")}
            </button>
          )}
        </div>
      ) : null}
      <article
        key={`${docKey}:${page}`}
        ref={articleRef}
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
        onContextMenu={(event: ReactMouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const sel = window.getSelection()?.toString() ?? "";
          const img = (event.target as HTMLElement).closest("img") as HTMLImageElement | null;
          const items: ContextMenuItem[] = [
            {
              id: "copy",
              label: sel ? t("md.copySelected") : t("md.copy"),
              disabled: !sel,
              onSelect: () => {
                void navigator.clipboard.writeText(sel).catch(() => undefined);
              },
            },
            {
              id: "select-all",
              label: t("md.selectAll"),
              onSelect: () => {
                const range = document.createRange();
                if (articleRef.current) {
                  range.selectNodeContents(articleRef.current);
                  const s = window.getSelection();
                  s?.removeAllRanges();
                  s?.addRange(range);
                }
              },
            },
            { id: "sep-ai", label: "", separator: true },
            ...(sel.trim()
              ? [
                  {
                    id: "ai-summarize-sel",
                    label: t("ai.menuSummarize"),
                    onSelect: () => {
                      window.dispatchEvent(
                        new CustomEvent("markelle:ai-action", {
                          detail: { action: "summarize" },
                        }),
                      );
                    },
                  },
                  {
                    id: "ai-translate-sel",
                    label: t("ai.menuTranslate"),
                    onSelect: () => {
                      window.dispatchEvent(
                        new CustomEvent("markelle:ai-action", {
                          detail: { action: "translate" },
                        }),
                      );
                    },
                  },
                ]
              : []),
            {
              id: "ai-panel",
              label: t("ai.menuOpen"),
              onSelect: () => {
                window.dispatchEvent(new CustomEvent("markelle:open-ai"));
              },
            },
          ];
          if (img?.src) {
            items.push({ id: "sep-img", label: "", separator: true });
            items.push({
              id: "copy-img-url",
              label: t("md.copyImageUrl"),
              onSelect: () => {
                void navigator.clipboard.writeText(img.src).catch(() => undefined);
              },
            });
            if (img.alt) {
              items.push({
                id: "copy-img-alt",
                label: t("md.copyImageName"),
                onSelect: () => {
                  void navigator.clipboard.writeText(img.alt).catch(() => undefined);
                },
              });
            }
          }
          setCtx({ x: event.clientX, y: event.clientY, items });
        }}
        onMouseOver={(event) => {
          const link = (event.target as HTMLElement).closest(".wikilink") as HTMLElement | null;
          if (!link) return;
          const wikiTarget = link.getAttribute("data-target") || link.textContent || "";
          if (!wikiTarget) return;

          const isUnresolved = link.classList.contains("is-unresolved");
          const filePath = link.getAttribute("data-path");

          if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
          }

          const clientX = Math.min(window.innerWidth - 320, Math.max(16, event.clientX - 40));
          const clientY = Math.min(window.innerHeight - 200, event.clientY + 20);

          hoverTimerRef.current = setTimeout(async () => {
            let snippet = "";
            if (filePath && !isUnresolved) {
              try {
                const res = await readMarkdownFile(filePath, true);
                if (res && res.content) {
                  snippet = res.content
                    .replace(/^---[\s\S]*?---\s*/, "")
                    .replace(/#+\s+/g, "")
                    .replace(/\[\[.*?\]\]/g, (m) => m.slice(2, -2))
                    .trim()
                    .slice(0, 240);
                }
              } catch {
                snippet = "";
              }
            }
            setHoverPreview({
              x: clientX,
              y: clientY,
              target: wikiTarget,
              snippet,
              isUnresolved,
            });
          }, 200);
        }}
        onMouseLeave={(event) => {
          const related = event.relatedTarget as HTMLElement | null;
          if (related?.closest(".wikilink") || related?.closest(".wiki-hover-preview")) return;
          if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
          }
          hoverTimerRef.current = setTimeout(() => {
            setHoverPreview(null);
          }, 150);
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement;

          const imgHit = target.closest("img") as HTMLImageElement | null;
          if (imgHit?.src && !imgHit.classList.contains("is-broken")) {
            // Don't steal wiki/task clicks — only bare image taps open lightbox.
            if (!target.closest("a") && !target.closest(".task-list-item")) {
              event.preventDefault();
              setLightbox({ src: imgHit.src, alt: imgHit.alt || "" });
              return;
            }
          }

          if (onTaskToggle) {
            const item = target.closest(".task-list-item") as HTMLElement | null;
            if (item && articleRef.current?.contains(item)) {
              const boxes = Array.from(
                articleRef.current.querySelectorAll(".task-list-item"),
              );
              const index = boxes.indexOf(item);
              if (index >= 0) {
                event.preventDefault();
                event.stopPropagation();
                onTaskToggle(index);
                return;
              }
            }
          }

          const embed = target.closest(".wiki-embed-note") as HTMLElement | null;
          if (embed) {
            // Expanded embeds: only the head opens the note; body stays readable.
            if (embed.classList.contains("is-expanded")) {
              const head = target.closest(".wiki-embed-head");
              if (!head || !embed.contains(head)) return;
            }
            event.preventDefault();
            const path = embed.getAttribute("data-path");
            const heading = embed.getAttribute("data-heading") || undefined;
            if (path) onWikiOpen(path, heading || undefined);
            return;
          }

          const anchor = target.closest("a");
          if (!anchor) return;
          const href = anchor.getAttribute("href");
          if (!href) return;

          // Default-deny: never let the WebView navigate on its own.
          event.preventDefault();

          if (href.startsWith("wikilink:") || href.startsWith("markelle-file:")) {
            const path = anchor.getAttribute("data-path");
            const heading = anchor.getAttribute("data-heading") || undefined;
            const wikiTarget = anchor.getAttribute("data-target") || undefined;
            if (path) onWikiOpen(path, heading || undefined, wikiTarget);
            return;
          }

          if (href.startsWith("#")) {
            const id = decodeURIComponent(href.slice(1));
            document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
          }

          if (isAssetUrl(href)) {
            const path = anchor.getAttribute("data-path");
            if (path && /\.(md|markdown|mdown|mkd)$/i.test(path)) {
              onWikiOpen(path);
            }
            return;
          }

          // Never navigate to file: — already stripped at render; defense in depth.
          if (href.startsWith("file:")) {
            return;
          }

          if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
            void openUrl(href).catch(() => {
              /* opener may be blocked; status is owned by App */
            });
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const target = event.target as HTMLElement;
          const embed = target.closest(".wiki-embed-note") as HTMLElement | null;
          if (!embed) return;
          event.preventDefault();
          const path = embed.getAttribute("data-path");
          const heading = embed.getAttribute("data-heading") || undefined;
          if (path) onWikiOpen(path, heading || undefined);
        }}
      />
      {ctx ? (
        <EditorContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.items}
          onClose={() => setCtx(null)}
        />
      ) : null}
      {lightbox ? (
        <div
          ref={lightboxRef}
          className="img-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.alt || t("md.imagePreview")}
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setLightbox(null);
          }}
        >
          <button
            type="button"
            className="img-lightbox-close"
            aria-label={t("common.close")}
            onClick={() => setLightbox(null)}
          >
            ×
          </button>
          <img
            src={lightbox.src}
            alt={lightbox.alt || t("md.imagePreview")}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
      {hoverPreview ? (
        <div
          className="wiki-hover-preview"
          style={{
            left: `${hoverPreview.x}px`,
            top: `${hoverPreview.y}px`,
          }}
          onMouseEnter={() => {
            if (hoverTimerRef.current) {
              clearTimeout(hoverTimerRef.current);
              hoverTimerRef.current = null;
            }
          }}
          onMouseLeave={() => {
            setHoverPreview(null);
          }}
        >
          <div className="wiki-hover-header">
            <span className="wiki-hover-title">{hoverPreview.target}</span>
            {hoverPreview.isUnresolved ? (
              <span className="wiki-hover-badge unresolved">{t("vault.unresolvedLink")}</span>
            ) : (
              <span className="wiki-hover-badge resolved">{t("vault.resolvedLink")}</span>
            )}
          </div>
          {hoverPreview.snippet ? (
            <div className="wiki-hover-snippet">{hoverPreview.snippet}</div>
          ) : (
            <div className="wiki-hover-empty">
              {hoverPreview.isUnresolved ? t("vault.clickToCreate") : t("vault.emptyNote")}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export const MarkdownView = memo(MarkdownViewInner);
