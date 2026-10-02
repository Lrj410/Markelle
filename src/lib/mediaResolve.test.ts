import { describe, expect, it } from "vitest";
import {
  candidateMediaAbsPaths,
  collectMediaTargets,
  isMediaTarget,
} from "./mediaResolve";
import { renderMarkdown } from "./markdown";
import { toGatedAssetUrl } from "./assets";

describe("mediaResolve", () => {
  it("detects media extensions", () => {
    expect(isMediaTarget("3840x2160.jpg")).toBe(true);
    expect(isMediaTarget("shot.PNG")).toBe(true);
    expect(isMediaTarget("note.md")).toBe(false);
  });

  it("collects wiki and markdown image targets", () => {
    const src = [
      "#测试/日记",
      "![[3840x2160.jpg]]",
      "![alt](attachments/a.png)",
      "[[plain-note]]",
      "![[other.md]]",
    ].join("\n");
    expect(collectMediaTargets(src)).toEqual([
      "3840x2160.jpg",
      "attachments/a.png",
    ]);
  });

  it("builds Obsidian-style candidate paths", () => {
    const cands = candidateMediaAbsPaths(
      "3840x2160.jpg",
      "C:/vault/日记",
      "C:/vault",
      "attachments",
    );
    expect(cands).toContain("C:/vault/日记/3840x2160.jpg");
    expect(cands).toContain("C:/vault/3840x2160.jpg");
    expect(cands).toContain("C:/vault/attachments/3840x2160.jpg");
    const yyyy = String(new Date().getFullYear());
    const mm = String(new Date().getMonth() + 1).padStart(2, "0");
    expect(cands).toContain(`C:/vault/attachments/${yyyy}/${mm}/3840x2160.jpg`);
  });

  it("recovers absolute path from broken ../../../../C:/ links", () => {
    const cands = candidateMediaAbsPaths(
      "../../../../../../C:/Users/18755/Desktop/test/attachments/2026/09/3840x2160.jpg",
      "C:/Users/18755/Desktop/test/日记",
      "C:/Users/18755/Desktop/test",
    );
    expect(cands[0]).toBe(
      "C:/Users/18755/Desktop/test/attachments/2026/09/3840x2160.jpg",
    );
  });
});

describe("renderMarkdown mediaPaths", () => {
  it("uses resolved absolute path for wiki images", () => {
    const { html } = renderMarkdown("![[3840x2160.jpg|400]]", {
      baseDir: "C:/vault/日记",
      toAssetUrl: toGatedAssetUrl,
      mediaPaths: {
        "3840x2160.jpg": "C:/vault/attachments/2026/09/3840x2160.jpg",
      },
    });
    expect(html).toContain("wiki-embed-img");
    expect(html).toContain(
      encodeURIComponent("C:/vault/attachments/2026/09/3840x2160.jpg"),
    );
    expect(html).toContain('width="400"');
  });

  it("uses mediaPaths for standard markdown images", () => {
    const { html } = renderMarkdown("![](photo.png)", {
      baseDir: "C:/vault/notes",
      toAssetUrl: toGatedAssetUrl,
      mediaPaths: { "photo.png": "C:/vault/assets/photo.png" },
    });
    expect(html).toContain(encodeURIComponent("C:/vault/assets/photo.png"));
  });
});
