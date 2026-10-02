/**
 * Lightweight, zero-dependency HTML to Markdown converter.
 * Runs in any JS environment (Node, WebView2, Web Worker) without DOMParser or JSDOM.
 */

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function htmlToMarkdown(html: string): string {
  if (!html || typeof html !== "string") return "";

  let s = html
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Remove scripts, styles, metadata
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Headings
  s = s.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n\n# ${stripTags(c).trim()}\n\n`);
  s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n\n## ${stripTags(c).trim()}\n\n`);
  s = s.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n\n### ${stripTags(c).trim()}\n\n`);
  s = s.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `\n\n#### ${stripTags(c).trim()}\n\n`);
  s = s.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `\n\n##### ${stripTags(c).trim()}\n\n`);
  s = s.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `\n\n###### ${stripTags(c).trim()}\n\n`);

  // Code blocks: <pre><code ...>...</code></pre>
  s = s.replace(/<pre\b[^>]*><code(?:\s+class="[^"]*(?:lang|language)-(\w+)[^"]*")?[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, lang, code) => {
    const l = lang || "";
    const decoded = decodeHtmlEntities(stripTags(code)).replace(/\n$/, "");
    return `\n\n\`\`\`${l}\n${decoded}\n\`\`\`\n\n`;
  });
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    const decoded = decodeHtmlEntities(stripTags(code)).replace(/\n$/, "");
    return `\n\n\`\`\`\n${decoded}\n\`\`\`\n\n`;
  });

  // Inline code
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => {
    const decoded = decodeHtmlEntities(stripTags(c));
    return `\`${decoded}\``;
  });

  // Blockquotes
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c) => {
    const inner = htmlToMarkdown(c).trim();
    const quoted = inner.split("\n").map((line) => `> ${line}`).join("\n");
    return `\n\n${quoted}\n\n`;
  });

  // Bold / Italic / Strike
  s = s.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, c) => `**${stripTags(c).trim()}**`);
  s = s.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, c) => `*${stripTags(c).trim()}*`);
  s = s.replace(/<(?:del|s|strike)\b[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi, (_, c) => `~~${stripTags(c).trim()}~~`);

  // Links: <a href="...">...</a>
  s = s.replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = stripTags(text).trim() || href;
    return `[${t}](${href})`;
  });

  // Images: <img src="..." alt="...">
  s = s.replace(/<img\b[^>]*\bsrc="([^"]*)"[^>]*\balt="([^"]*)"[^>]*\/?>/gi, (_, src, alt) => `![${alt}](${src})`);
  s = s.replace(/<img\b[^>]*\bsrc="([^"]*)"[^>]*\/?>/gi, (_, src) => `![](${src})`);

  // Lists: <li ...>...</li>
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => {
    const isTaskChecked = /<input[^>]*type="checkbox"[^>]*checked[^>]*>/i.test(c);
    const isTaskUnchecked = /<input[^>]*type="checkbox"[^>]*>/i.test(c);
    const cleaned = stripTags(c.replace(/<input[^>]*>/gi, "")).trim();
    if (isTaskChecked) return `\n- [x] ${cleaned}`;
    if (isTaskUnchecked) return `\n- [ ] ${cleaned}`;
    return `\n- ${cleaned}`;
  });

  // Tables
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
    const rows: string[][] = [];
    const trMatches = tableContent.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const tr of trMatches) {
      const cellMatches = tr.match(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) || [];
      const row = cellMatches.map((cell: string) => stripTags(cell).replace(/\|/g, "\\|").trim());
      if (row.length) rows.push(row);
    }
    if (!rows.length) return "";
    const colCount = Math.max(...rows.map((r) => r.length));
    const padRow = (r: string[]) => {
      while (r.length < colCount) r.push("");
      return `| ${r.join(" | ")} |`;
    };
    const mdLines = [padRow(rows[0]!)];
    mdLines.push(`| ${Array(colCount).fill("---").join(" | ")} |`);
    for (let i = 1; i < rows.length; i++) {
      mdLines.push(padRow(rows[i]!));
    }
    return `\n\n${mdLines.join("\n")}\n\n`;
  });

  // Paragraphs & Breaks
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `\n\n${stripTags(c).trim()}\n\n`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

  // Divs / Spans / remaining tags
  s = stripTags(s);
  s = decodeHtmlEntities(s);

  // Normalize multi-newlines
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}
