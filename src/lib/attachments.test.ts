import { describe, expect, it } from "vitest";
import {
  buildAttachmentRelativePath,
  filesFromDataTransfer,
  isImageFile,
  markdownImageLink,
  normalizeAttachmentFolder,
  sanitizeFileName,
} from "./attachments";

describe("attachments", () => {
  it("normalizes folder and rejects parent segments", () => {
    expect(normalizeAttachmentFolder("../x")).toBe("attachments");
    expect(normalizeAttachmentFolder(" media / pics ")).toBe("media/pics");
  });

  it("builds yyyy/mm path", () => {
    const d = new Date(2026, 8, 27); // Sep
    expect(buildAttachmentRelativePath("attachments", "a.png", d)).toBe(
      "attachments/2026/09/a.png",
    );
  });

  it("sanitizes file names", () => {
    expect(sanitizeFileName('a<>b|.png')).toBe("a__b_.png");
  });

  it("handles Windows reserved names and trailing dots/spaces", () => {
    expect(sanitizeFileName("CON")).toBe("CON_");
    expect(sanitizeFileName("nul.txt")).toBe("nul_.txt");
    expect(sanitizeFileName("name. ")).toBe("name");
    expect(sanitizeFileName("a b/c d?.png")).toBe("c d_.png");
    // Trailing space in the stem must not let a reserved name slip through.
    expect(sanitizeFileName("con .txt")).toBe("con_.txt");
  });

  it("keeps the extension when truncating long names", () => {
    const out = sanitizeFileName(`${"x".repeat(300)}.png`);
    expect(out.length).toBe(180);
    expect(out.endsWith(".png")).toBe(true);
  });

  it("builds markdown image link", () => {
    expect(markdownImageLink("attachments/2026/09/a.png", "pic")).toBe(
      "![pic](attachments/2026/09/a.png)",
    );
  });

  it("collects clipboard bitmap items with empty names", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const file = new File([blob], "", { type: "image/png" });
    const dt = {
      files: [] as unknown as FileList,
      items: [
        {
          kind: "file",
          getAsFile: () => file,
        },
      ],
    } as unknown as DataTransfer;
    const files = filesFromDataTransfer(dt);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("paste.png");
    expect(isImageFile(files[0])).toBe(true);
  });
});
