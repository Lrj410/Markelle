import { describe, expect, it } from "vitest";
import { applyScrollRatio, scrollRatio } from "./scrollSync";
import { MIN_RIGHT_SIZE, MIN_SIDE_SIZE, setSlotSize, DEFAULT_DOCK } from "./dock";

describe("scrollSync", () => {
  it("maps scroll ratio both ways", () => {
    const el = {
      scrollTop: 250,
      scrollHeight: 1000,
      clientHeight: 500,
    } as HTMLElement;
    expect(scrollRatio(el)).toBeCloseTo(0.5, 5);

    const dst = {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 400,
    } as HTMLElement;
    applyScrollRatio(dst, 0.5);
    expect(dst.scrollTop).toBe(800);
  });
});

describe("dock min sizes", () => {
  it("right dock cannot shrink below MIN_RIGHT_SIZE", () => {
    const next = setSlotSize(DEFAULT_DOCK, "right", 100);
    expect(next.right.size).toBe(MIN_RIGHT_SIZE);
    expect(MIN_RIGHT_SIZE).toBe(270);
    expect(MIN_RIGHT_SIZE).toBeGreaterThanOrEqual(MIN_SIDE_SIZE);
  });
});
