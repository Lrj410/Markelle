import { describe, expect, it } from "vitest";
import { slicePreviewPage } from "./previewPage";

describe("slicePreviewPage", () => {
  it("pages by character budget", () => {
    const source = "a".repeat(450_000);
    const p1 = slicePreviewPage(source, 1, 200_000);
    expect(p1.pageCount).toBe(3);
    expect(p1.text.length).toBe(200_000);
    const p3 = slicePreviewPage(source, 3, 200_000);
    expect(p3.page).toBe(3);
    expect(p3.text.length).toBe(50_000);
  });

  it("clamps page", () => {
    const p = slicePreviewPage("hi", 99, 200_000);
    expect(p.page).toBe(1);
    expect(p.pageCount).toBe(1);
  });
});
