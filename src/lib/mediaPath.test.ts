import { describe, expect, it } from "vitest";
import {
  decodeFsPath,
  formatMdImageDestination,
  parseMdImageDestination,
  softenImageDestinations,
} from "./mediaPath";
import { collectMediaTargets } from "./mediaResolve";
import { renderMarkdown } from "./markdown";
import { toGatedAssetUrl } from "./assets";
import { markdownImageLink } from "./attachments";

describe("mediaPath", () => {
  it("decodes percent-encoding without looping forever", () => {
    expect(decodeFsPath("foo%20bar.png")).toBe("foo bar.png");
    expect(decodeFsPath("foo%2520bar.png")).toBe("foo bar.png");
    expect(decodeFsPath("C:/vault/a.png")).toBe("C:/vault/a.png");
  });

  it("parses destinations with spaces and titles", () => {
    expect(parseMdImageDestination("foo bar.png")).toBe("foo bar.png");
    expect(parseMdImageDestination("<foo bar.png>")).toBe("foo bar.png");
    expect(parseMdImageDestination('path/x.png "title"')).toBe("path/x.png");
    expect(parseMdImageDestination("foo%20bar.png")).toBe("foo bar.png");
  });

  it("softens bare spaced destinations into angle brackets", () => {
    expect(softenImageDestinations("![a](foo bar.png)")).toBe("![a](<foo bar.png>)");
    expect(softenImageDestinations("![a](<foo bar.png>)")).toBe("![a](<foo bar.png>)");
    expect(softenImageDestinations("![a](plain.png)")).toBe("![a](plain.png)");
  });

  it("keeps balanced parentheses inside destinations", () => {
    expect(softenImageDestinations("![s](Screenshot (1).png)")).toBe(
      "![s](<Screenshot (1).png>)",
    );
    expect(softenImageDestinations("![s](a(b(c)).png)")).toBe("![s](<a(b(c)).png>)");
    expect(softenImageDestinations('![s](shot (1).png "title")')).toBe(
      '![s](<shot (1).png> "title")',
    );
  });

  it("decodes a gated asset URL at most once", () => {
    expect(toGatedAssetUrl("C:/vault/a%2520b.png")).toBe(
      `mklasset://localhost/${encodeURIComponent("C:/vault/a%20b.png")}`,
    );
  });

  it("quotes spaced paths when building markdown links", () => {
    expect(markdownImageLink("attachments/2026/09/my pic.png", "x")).toBe(
      "![x](<attachments/2026/09/my pic.png>)",
    );
    expect(formatMdImageDestination("a.png")).toBe("a.png");
  });
});

describe("image space / encoding regression", () => {
  it("collects and renders spaced image paths", () => {
    const src = "![a](foo bar.png)";
    expect(collectMediaTargets(src)).toEqual(["foo bar.png"]);
    const { html } = renderMarkdown(src, {
      baseDir: "C:/vault/notes",
      toAssetUrl: toGatedAssetUrl,
    });
    expect(html).toContain("mklasset://localhost/");
    expect(html).toContain(encodeURIComponent("C:/vault/notes/foo bar.png"));
    expect(html).not.toContain("%2520");
  });

  it("does not double-encode percent-encoded destinations", () => {
    const { html } = renderMarkdown("![a](foo%20bar.png)", {
      baseDir: "C:/vault/notes",
      toAssetUrl: toGatedAssetUrl,
    });
    expect(html).toContain(encodeURIComponent("C:/vault/notes/foo bar.png"));
    expect(html).not.toContain("%2520");
  });

  it("renders angle-bracket destinations", () => {
    const { html } = renderMarkdown("![a](<foo bar.png>)", {
      baseDir: "C:/vault/notes",
      toAssetUrl: toGatedAssetUrl,
    });
    expect(html).toContain(encodeURIComponent("C:/vault/notes/foo bar.png"));
  });
});
