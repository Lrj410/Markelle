import { describe, expect, it } from "vitest";
import { clampFontSize, FONT_SIZE_MAX, FONT_SIZE_MIN, wheelDeltaToSteps } from "./fontSize";

describe("clampFontSize", () => {
  it("clamps to the free-zoom range", () => {
    expect(clampFontSize(11)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(40)).toBe(FONT_SIZE_MAX);
    expect(clampFontSize(17.4)).toBe(17);
    expect(clampFontSize(Number.NaN)).toBe(17);
  });
});

describe("wheelDeltaToSteps", () => {
  it("needs accumulated delta before stepping", () => {
    const acc = { value: 0 };
    expect(wheelDeltaToSteps(10, 0, acc)).toBe(0);
    expect(wheelDeltaToSteps(35, 0, acc)).toBe(-1);
    expect(acc.value).toBe(5);
  });

  it("zooms in on negative deltaY (wheel up)", () => {
    const acc = { value: 0 };
    expect(wheelDeltaToSteps(-80, 0, acc)).toBe(2);
  });
});
