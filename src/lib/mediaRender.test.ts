import { describe, expect, it } from "vitest";
import { parseEmbedSize } from "./obsidian";
import { promoteMediaElements, renderMarkdown, resolveLocalUrl } from "./markdown";
import { toGatedAssetUrl } from "./assets";

describe("parseEmbedSize", () => {
  it("parses bare width and WxH", () => {
    expect(parseEmbedSize("200")).toEqual({
      width: 200,
      height: undefined,
      isSizeOnly: true,
    });
    expect(parseEmbedSize("200x100")).toEqual({
      width: 200,
      height: 100,
      isSizeOnly: true,
    });
  });

  it("peels trailing size after caption", () => {
    expect(parseEmbedSize("封面|320")).toEqual({
      width: 320,
      height: undefined,
      isSizeOnly: false,
      displayAlias: "封面",
    });
  });

  it("leaves normal aliases alone", () => {
    expect(parseEmbedSize("显示名")).toEqual({
      isSizeOnly: false,
      displayAlias: "显示名",
    });
  });
});

describe("media rendering", () => {
  it("keeps remote https images", () => {
    const { html } = renderMarkdown(
      "![remote](https://via.placeholder.com/640x200.png)",
      { baseDir: "C:/vault/notes", toAssetUrl: toGatedAssetUrl },
    );
    expect(html).toContain('src="https://via.placeholder.com/640x200.png"');
    expect(html).not.toContain("mklasset:");
  });

  it("promotes mp3 markdown images to audio", () => {
    const { html } = renderMarkdown(
      "![audio](https://example.com/a.mp3)",
      { baseDir: "C:/vault", toAssetUrl: toGatedAssetUrl },
    );
    expect(html).toMatch(/<audio[^>]+src="https:\/\/example.com\/a\.mp3"/);
    expect(html).not.toMatch(/<img[^>]+a\.mp3/);
  });

  it("applies Obsidian wiki image width", () => {
    const { html } = renderMarkdown("![[photo.png|200]]", {
      baseDir: "C:/vault/notes",
      toAssetUrl: toGatedAssetUrl,
      vaultFiles: [],
    });
    expect(html).toContain("wiki-embed-img");
    expect(html).toContain('width="200"');
    expect(html).toContain("width:200px");
    expect(html).not.toContain('alt="200"');
  });

  it("promoteMediaElements upgrades local-looking audio src", () => {
    const out = promoteMediaElements(
      '<img src="mklasset://localhost/C%3A%2Fa.mp3" alt="clip">',
    );
    expect(out).toContain("<audio");
    expect(out).toContain("mklasset://localhost/C%3A%2Fa.mp3");
  });

  it("resolveLocalUrl leaves https untouched", () => {
    expect(
      resolveLocalUrl("https://example.com/x.png", "C:/vault", toGatedAssetUrl),
    ).toBe("https://example.com/x.png");
  });
});

describe("resolveLocalUrl vault root", () => {
  it("joins attachments/… from vault root for nested notes", () => {
    const url = resolveLocalUrl(
      "attachments/2026/09/a.jpg",
      "C:/vault/日记",
      toGatedAssetUrl,
      "C:/vault",
    );
    expect(url).toContain(encodeURIComponent("C:/vault/attachments/2026/09/a.jpg"));
    expect(url).not.toContain("%E6%97%A5%E8%AE%B0"); // 日记
  });

  it("keeps ../ and bare names note-relative", () => {
    expect(
      resolveLocalUrl("../attachments/a.jpg", "C:/vault/日记", toGatedAssetUrl, "C:/vault"),
    ).toContain(encodeURIComponent("C:/vault/attachments/a.jpg"));
    expect(
      resolveLocalUrl("shot.png", "C:/vault/日记", toGatedAssetUrl, "C:/vault"),
    ).toContain(encodeURIComponent("C:/vault/日记/shot.png"));
  });
});
