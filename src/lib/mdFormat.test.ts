import { describe, expect, it } from "vitest";

describe("mdFormat", () => {
  it("identifies table lines correctly", async () => {
    const { isTableLine } = await import("./mdFormat");
    expect(isTableLine("| A | B |")).toBe(true);
    expect(isTableLine("  | col1 | col2 |   ")).toBe(true);
    expect(isTableLine("not a table")).toBe(false);
    expect(isTableLine("| only start")).toBe(false);
  });
});
