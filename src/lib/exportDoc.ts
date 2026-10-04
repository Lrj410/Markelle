/** Print / HTML export helpers for the reader. */

/** Strip absolute paths and internal schemes before sharing/printing. */
export function sanitizeExportHtml(bodyHtml: string): string {
  if (typeof document === "undefined") {
    return bodyHtml
      .replace(/\sdata-path="[^"]*"/gi, "")
      .replace(/\shref="markelle-file:[^"]*"/gi, ' href="#"')
      .replace(/\ssrc="mklasset:[^"]*"/gi, ' src=""')
      .replace(/\ssrc="https?:\/\/mklasset\.localhost[^"]*"/gi, ' src=""');
  }
  const wrap = document.createElement("div");
  wrap.innerHTML = bodyHtml;
  wrap.querySelectorAll("[data-path]").forEach((el) => el.removeAttribute("data-path"));
  wrap.querySelectorAll("a[href]").forEach((el) => {
    const href = el.getAttribute("href") || "";
    if (href.startsWith("markelle-file:") || href.startsWith("wikilink:")) {
      el.setAttribute("href", "#");
    }
  });
  wrap.querySelectorAll("[src]").forEach((el) => {
    const src = el.getAttribute("src") || "";
    if (
      src.startsWith("mklasset:") ||
      src.includes("mklasset.localhost") ||
      src.startsWith("asset:")
    ) {
      el.setAttribute("src", "");
      el.setAttribute("data-export-missing", "1");
    }
  });
  return wrap.innerHTML;
}

export function buildExportHtml(opts: {
  title: string;
  bodyHtml: string;
  dark?: boolean;
}): string {
  const title = escapeXml(opts.title || "Markelle");
  const theme = opts.dark
    ? `color-scheme:dark;
     --mk-page:#17140f; --mk-ink:#f2ebdf; --mk-ink-soft:#b5a793;
     --mk-rule:rgba(243,235,221,0.18); --mk-fill:rgba(243,235,221,0.07);
     --mk-accent:#e88a6a;`
    : `color-scheme:light;
     --mk-page:#fdfbf5; --mk-ink:#201b15; --mk-ink-soft:#6b5f50;
     --mk-rule:rgba(38,31,23,0.18); --mk-fill:rgba(38,31,23,0.05);
     --mk-accent:#b4452b;`;
  const safeBody = sanitizeExportHtml(opts.bodyHtml);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  :root { ${theme} }
  body { font-family: "Source Serif 4", "Songti SC", Georgia, serif; line-height: 1.75; letter-spacing: 0.01em; max-width: 44rem; margin: 2.5rem auto; padding: 0 1.25rem; background: var(--mk-page); color: var(--mk-ink); }
  h1, h2, h3, h4 { line-height: 1.28; letter-spacing: -0.005em; }
  h1 { font-size: 1.8em; } h2 { font-size: 1.4em; margin-top: 2em; } h3 { font-size: 1.16em; }
  img, video { max-width: 100%; height: auto; border-radius: 6px; }
  pre, code { font-family: "JetBrains Mono", Consolas, monospace; font-size: 0.86em; }
  pre { overflow: auto; padding: 0.75rem 1rem; background: var(--mk-fill); border: 1px solid var(--mk-rule); border-radius: 6px; }
  code:not(pre code) { background: var(--mk-fill); padding: 0.12em 0.35em; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; font-size: 0.95em; }
  th, td { border: 1px solid var(--mk-rule); padding: 0.5rem 0.75rem; text-align: left; }
  th { background: var(--mk-fill); font-weight: 600; }
  blockquote { border-left: 2px solid var(--mk-rule); margin: 1.25rem 0; padding: 0.15rem 0 0.15rem 1rem; color: var(--mk-ink-soft); }
  hr { border: none; border-top: 1px solid var(--mk-rule); margin: 2rem 0; }
  ul.contains-task-list { list-style: none; padding-left: 0; }
  .task-list-item input { margin-right: 0.5rem; }
  .katex-display { overflow-x: auto; overflow-y: hidden; padding: 0.5rem 0; margin: 1em 0; text-align: center; }
  .katex { font-family: KaTeX_Main, Times New Roman, serif; line-height: 1.2; text-indent: 0; text-rendering: auto; }
  .katex .base { position: relative; display: inline-block; white-space: nowrap; width: min-content; }
  .katex .mord, .katex .mbin, .katex .mrel, .katex .mopen, .katex .mclose, .katex .mpunct { position: relative; }
  .katex .mfrac { display: inline-block; vertical-align: -0.5em; text-align: center; }
  .katex .mfrac .frac-line { border-bottom: 0.04em solid; display: block; }
  .katex .msupsub { display: inline-block; vertical-align: -0.3em; }
  .katex .vlist-t { display: inline-table; table-layout: fixed; }
  .katex .vlist-r { display: table-row; }
  .katex .vlist { display: table-cell; vertical-align: bottom; position: relative; }
  a { color: var(--mk-accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
  @media print {
    :root { --mk-page:#fff; --mk-ink:#000; --mk-ink-soft:#444; --mk-rule:rgba(0,0,0,0.35); --mk-fill:#f2f2f2; --mk-accent:#000; }
    body { max-width: none; margin: 0; padding: 0; }
  }
</style>
</head>
<body>
<article class="md-export">
${safeBody}
</article>
</body>
</html>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Rewrite `mklasset:` / localhost asset URLs into data: URLs so exported HTML
 * works outside the Markelle WebView.
 */
export async function embedLocalImagesInHtml(
  html: string,
  opts?: { maxImages?: number; maxBytesEach?: number },
): Promise<string> {
  const maxImages = opts?.maxImages ?? 40;
  const maxBytes = opts?.maxBytesEach ?? 12 * 1024 * 1024;
  if (typeof document === "undefined") return html;

  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const nodes = Array.from(
    wrap.querySelectorAll<HTMLImageElement | HTMLSourceElement | HTMLMediaElement>(
      "img[src], audio[src], video[src], source[src]",
    ),
  ).slice(0, maxImages);

  await Promise.all(
    nodes.map(async (el) => {
      const src = el.getAttribute("src");
      if (!src) return;
      const isLocal =
        src.startsWith("mklasset:") ||
        src.includes("mklasset.localhost") ||
        src.startsWith("asset:");
      if (!isLocal) return;
      try {
        const res = await fetch(src);
        if (!res.ok) return;
        const blob = await res.blob();
        if (blob.size > maxBytes) return;
        const dataUrl = await blobToDataUrl(blob);
        el.setAttribute("src", dataUrl);
      } catch {
        /* leave original src */
      }
    }),
  );

  return wrap.innerHTML;
}

export function printHtmlDocument(html: string): void {
  // Prefer an iframe in the current WebView so print inherits app CSP,
  // instead of an unconstrained about:blank popup + document.write.
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  const cleanup = () => {
    try {
      iframe.remove();
    } catch {
      /* ignore */
    }
  };
  try {
    iframe.contentWindow?.addEventListener("afterprint", cleanup);
  } catch {
    /* ignore */
  }
  window.setTimeout(() => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      cleanup();
    }
    window.setTimeout(cleanup, 60_000);
  }, 250);
}

export function downloadTextFile(
  filename: string,
  content: string,
  mime = "text/html;charset=utf-8",
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some WebViews — release later.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
