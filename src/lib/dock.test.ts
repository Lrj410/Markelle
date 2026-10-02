import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCK,
  MAX_BOTTOM_SIZE,
  MAX_SIDE_SIZE,
  normalizeDock,
  togglePanel,
} from "./dock";

describe("dock slot size clamping", () => {
  it("clamps the bottom slot to MAX_BOTTOM_SIZE", () => {
    const dock = normalizeDock({
      bottom: { panels: ["query"], active: "query", size: 9999 },
    });
    expect(dock.bottom.size).toBe(MAX_BOTTOM_SIZE);
  });

  it("clamps side slots to MAX_SIDE_SIZE", () => {
    const dock = normalizeDock({
      left: { panels: ["vault"], active: "vault", size: 9999 },
      right: { panels: ["toc"], active: "toc", size: 9999 },
    });
    expect(dock.left.size).toBe(MAX_SIDE_SIZE);
    expect(dock.right.size).toBe(MAX_SIDE_SIZE);
  });

  it("preserves active: null when slot is collapsed", () => {
    const dock = normalizeDock({
      right: { panels: ["history", "toc"], active: null, size: 300 },
    });
    expect(dock.right.active).toBeNull();
    expect(dock.right.panels).toEqual(["history", "toc"]);
  });

  it("toggles active panel to null without erasing panels", () => {
    const base = structuredClone(DEFAULT_DOCK);
    const toggledOff = togglePanel(base, "history");
    expect(toggledOff.right.active).toBeNull();
    expect(toggledOff.right.panels).toContain("history");

    const toggledOn = togglePanel(toggledOff, "history");
    expect(toggledOn.right.active).toBe("history");
  });
});
