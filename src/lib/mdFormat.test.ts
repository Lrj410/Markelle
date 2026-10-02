import { describe, expect, it } from "vitest";
import { linkRange, TABLE_SNIPPET, wrapRange } from "./mdFormat";

describe("mdFormat", () => {
  it("wraps selection with bold markers", () => {
    expect(wrapRange("hello world", 0, 5, "**")).toEqual({
      doc: "**hello** world",
      from: 2,
      to: 7,
    });
  });

  it("inserts markers for empty selection", () => {
    expect(wrapRange("ab", 1, 1, "*")).toEqual({
      doc: "a**b",
      from: 2,
      to: 2,
    });
  });

  it("inserts markdown link with selection as label", () => {
    expect(linkRange("docs", 0, 4).doc).toBe("[docs](url)");
  });

  it("table snippet contains separator row", () => {
    expect(TABLE_SNIPPET).toContain("| --- |");
  });

  it("identifies table lines correctly", async () => {
    const { isTableLine } = await import("./mdFormat");
    expect(isTableLine("| A | B |")).toBe(true);
    expect(isTableLine("  | col1 | col2 |   ")).toBe(true);
    expect(isTableLine("not a table")).toBe(false);
    expect(isTableLine("| only start")).toBe(false);
  });
});
