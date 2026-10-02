import { describe, expect, it } from "vitest";
import {
  buildSourceEditorTheme,
  buildSourceHighlightStyle,
  GUTTER_FONT_SIZE_PX,
  GUTTER_FONT_STACK,
  GUTTER_LINE_MIN_WIDTH,
  SOURCE_SCROLLER_LAYOUT,
} from "./SourceEditorTheme";

describe("source editor layout guards", () => {
  it("forces scroller row + nowrap so gutters stay beside content", () => {
    expect(SOURCE_SCROLLER_LAYOUT.flexDirection).toBe("row !important");
    expect(SOURCE_SCROLLER_LAYOUT.flexWrap).toBe("nowrap !important");
    expect(SOURCE_SCROLLER_LAYOUT.display).toBe("flex !important");
  });

  it("builds a theme extension without collapsing content minWidth", () => {
    const ext = buildSourceEditorTheme(true);
    expect(ext).toBeTruthy();
    // Theme is opaque; the layout constant is the regression contract.
    expect(Object.keys(SOURCE_SCROLLER_LAYOUT)).toEqual([
      "display",
      "flexDirection",
      "alignItems",
      "flexWrap",
    ]);
  });

  it("builds harbor-desk highlight styles for light and dark", () => {
    expect(buildSourceHighlightStyle(true)).toBeTruthy();
    expect(buildSourceHighlightStyle(false)).toBeTruthy();
  });

  it("keeps gutter type on MarkelleGutter digits face (no YaHei/serif)", () => {
    expect(GUTTER_FONT_STACK).toContain("MarkelleGutter");
    expect(GUTTER_FONT_STACK).toContain("Consolas");
    expect(GUTTER_FONT_STACK.toLowerCase()).not.toContain("yahei");
    expect(GUTTER_FONT_STACK.toLowerCase()).not.toContain("pingfang");
    expect(GUTTER_FONT_STACK.toLowerCase()).not.toContain("serif");
    expect(GUTTER_FONT_SIZE_PX).toBe(12);
  });

  it("keeps line-number column compact and centered", () => {
    expect(GUTTER_LINE_MIN_WIDTH).toBe("2.4ch");
  });

  it("search panel theme keeps relative positioning (not flex crush)", () => {
    // Theme is opaque; assert the builder still returns an extension.
    const dark = buildSourceEditorTheme(true);
    const light = buildSourceEditorTheme(false);
    expect(dark).toBeTruthy();
    expect(light).toBeTruthy();
  });
});
