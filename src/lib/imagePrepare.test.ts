import { describe, expect, it } from "vitest";
import { isHeicLike, targetSize } from "./imagePrepare";

describe("imagePrepare", () => {
  it("detects HEIC/HEIF names and mime", () => {
    expect(isHeicLike("IMG_0001.HEIC")).toBe(true);
    expect(isHeicLike("a.heif")).toBe(true);
    expect(isHeicLike("a.png")).toBe(false);
    expect(isHeicLike("x.bin", "image/heic")).toBe(true);
  });

  it("computes downscale target keeping aspect", () => {
    expect(targetSize(4000, 3000, 2048)).toEqual({
      width: 2048,
      height: 1536,
      scale: 2048 / 4000,
    });
    expect(targetSize(800, 600, 2048)).toEqual({
      width: 800,
      height: 600,
      scale: 1,
    });
  });
});
