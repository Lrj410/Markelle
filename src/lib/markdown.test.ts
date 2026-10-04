import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { toGatedAssetUrl } from "./assets";

describe("markdown XSS hardening", () => {
  it("clips multi-MB source instead of parsing the whole blob", () => {
    const huge = `${"x".repeat(2 * 1024 * 1024 + 4096)}\n\n# TailHeading`;
    const { html, toc } = renderMarkdown(huge);
    expect(html).toMatch(/truncated for render safety/i);
    expect(toc.some((t) => t.text.includes("TailHeading"))).toBe(false);
  });

  it("does not render raw HTML tags", () => {
    const { html } = renderMarkdown('<script>alert(1)</script>\n\nHello');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Hello");
  });

  it("does not emit clickable javascript: anchors", () => {
    const { html } = renderMarkdown("[x](javascript:alert(1))");
    // markdown-it may leave plaintext or our sanitizer drops the scheme from <a href>.
    expect(html).not.toMatch(/<a[^>]+href=["']javascript:/i);
  });

  it("keeps http(s) and wikilinks", () => {
    const { html } = renderMarkdown("[a](https://example.com)\n\n[[Note]]");
    expect(html).toContain("https://example.com");
    expect(html).toContain("wikilink:");
  });

  it("strips remote https images unless allowRemoteHttpMedia is true", () => {
    const blocked = renderMarkdown("![x](https://evil.test/t.png)");
    expect(blocked.html).toContain("md-remote-media-blocked");
    expect(blocked.html).not.toMatch(/<img[^>]+src=["']https:\/\/evil\.test/i);

    const allowed = renderMarkdown("![x](https://evil.test/t.png)", {
      allowRemoteHttpMedia: true,
    });
    expect(allowed.html).toMatch(/<img[^>]+src=["']https:\/\/evil\.test/i);
  });
});

describe("markdown local links", () => {
  const opts = { baseDir: "C:/vault/notes", toAssetUrl: toGatedAssetUrl };

  it("keeps relative .md links navigable", () => {
    for (const src of ["[a](b.md)", "[a](./sub/c.md)", "[a](d.md#标题)"]) {
      const { html } = renderMarkdown(src, opts);
      expect(html).toContain("markelle-file://");
      expect(html).not.toMatch(/href="#"/);
    }
  });

  it("carries the resolved absolute path for relative md links", () => {
    const { html } = renderMarkdown("[a](./sub/c.md)", opts);
    expect(html).toContain('data-path="C:/vault/notes/sub/c.md"');
    const nested = renderMarkdown("[a](d.md#标题)", opts).html;
    expect(nested).toContain('data-path="C:/vault/notes/d.md"');
    expect(nested).toContain('data-heading="标题"');
  });

  it("renders wikilink targets containing % or spaces without throwing", () => {
    const files = [
      {
        path: "C:/vault/notes/100%完成.md",
        name: "100%完成.md",
        stem: "100%完成",
        relative: "100%完成.md",
      },
      {
        path: "C:/vault/notes/my note.md",
        name: "my note.md",
        stem: "my note",
        relative: "my note.md",
      },
    ];
    expect(() => renderMarkdown("[[100%完成]] [[my note]]", { vaultFiles: files })).not.toThrow();
    const { html } = renderMarkdown("[[100%完成]] [[my note]]", { vaultFiles: files });
    expect(html).toContain('data-target="100%完成"');
    expect(html).toContain('data-target="my note"');
    expect(html).toContain("is-resolved");
  });
});
