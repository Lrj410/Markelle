import { describe, expect, it } from "vitest";
import { adjustHeadingLevel, listAtxHeadings, moveHeadingTo, reorderHeading } from "./headingLevel";

/** Sorted multiset of lines — asserts content is only permuted, never lost. */
function sortedLines(source: string): string[] {
  return source.split("\n").slice().sort();
}

describe("headingLevel", () => {
  const sample = `# Alpha\n\n## Beta\n\ntext\n\n## Gamma\n`;

  it("lists ATX headings with ids", () => {
    const hits = listAtxHeadings(sample);
    expect(hits.map((h) => h.text)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(hits[0]!.level).toBe(1);
    expect(hits[1]!.level).toBe(2);
  });

  it("ignores headings inside fenced code blocks", () => {
    const src = "# Real\n\n```\n# not a heading\n## also not\n```\n\n## Also real\n";
    expect(listAtxHeadings(src).map((h) => h.text)).toEqual(["Real", "Also real"]);
    // Tilde fences behave the same way.
    const tilde = "~~~\n# hidden\n~~~\n\n# Shown\n";
    expect(listAtxHeadings(tilde).map((h) => h.text)).toEqual(["Shown"]);
    // And moving a section must not touch fenced content.
    const moved = reorderHeading("# A\n\n```\n# fake\n```\n\n## B\n", listAtxHeadings("# A\n\n```\n# fake\n```\n\n## B\n")[0]!.id, 1);
    expect(sortedLines(moved)).toEqual(sortedLines("# A\n\n```\n# fake\n```\n\n## B\n"));
  });

  it("demotes and promotes", () => {
    const hits = listAtxHeadings(sample);
    const id = hits[1]!.id;
    const demoted = adjustHeadingLevel(sample, id, 1);
    expect(demoted).toContain("### Beta");
    const promoted = adjustHeadingLevel(demoted, listAtxHeadings(demoted)[1]!.id, -1);
    expect(promoted).toContain("## Beta");
  });

  it("reorders sibling headings", () => {
    const hits = listAtxHeadings(sample);
    const next = reorderHeading(sample, hits[1]!.id, 1);
    expect(next.indexOf("## Gamma")).toBeLessThan(next.indexOf("## Beta"));
  });

  it("swaps sibling sections together with their body text", () => {
    const src = "## A\n\nalpha body\n\n## B\n\nbeta body\n";
    const hits = listAtxHeadings(src);
    const next = reorderHeading(src, hits[0]!.id, 1);
    expect(next).toBe("## B\n\nbeta body\n\n## A\n\nalpha body\n");
  });

  it("moves a parent down without lifting its child above it", () => {
    const src = "## A\n\n### A1\n\na1\n\n## B\n";
    const hits = listAtxHeadings(src);
    const next = reorderHeading(src, hits[0]!.id, 1);
    expect(next).toBe("## B\n\n## A\n\n### A1\n\na1\n");
    expect(next.indexOf("## B")).toBeLessThan(next.indexOf("## A"));
    expect(next.indexOf("## A")).toBeLessThan(next.indexOf("### A1"));
    expect(next.indexOf("### A1")).toBeLessThan(next.indexOf("a1"));
  });

  it("does not lift a child heading above its parent", () => {
    const src = "## A\n\n### A1\n\na1\n\n## B\n";
    const hits = listAtxHeadings(src);
    const a1 = hits.find((h) => h.text === "A1")!;
    expect(reorderHeading(src, a1.id, -1)).toBe(src);
  });

  it("returns the source when there is no same-or-higher neighbour", () => {
    const src = "## A\n\n### A1\n\na1\n\n## B\n";
    const [a, , b] = listAtxHeadings(src);
    // First heading moving up / last heading moving down → no-op.
    expect(reorderHeading(src, a!.id, -1)).toBe(src);
    expect(reorderHeading(src, b!.id, 1)).toBe(src);
  });

  it("moves a heading across several same-level siblings", () => {
    const src = "## A\n\nalpha body\n\n## B\n\nbeta body\n\n## C\n\nc body\n";
    const hits = listAtxHeadings(src);
    const next = moveHeadingTo(src, hits[0]!.id, 2); // A → last sibling
    expect(listAtxHeadings(next).map((h) => h.text)).toEqual(["B", "C", "A"]);
    expect(next.indexOf("alpha body")).toBeGreaterThan(next.indexOf("## A"));
  });

  it("stops at the closest legal position when hierarchy blocks the target", () => {
    // Beta and Gamma are children of Alpha, so Alpha cannot move past them.
    const hits = listAtxHeadings(sample);
    const next = moveHeadingTo(sample, hits[0]!.id, 2);
    expect(next).toBe(sample);
  });

  it("moveHeadingTo stays bounded and never loses lines", () => {
    const src = "## A\n\n### A1\n\na1\n\n## B\n\n### B1\n\nb1\n\n## C\n";
    const hits = listAtxHeadings(src);
    const next = moveHeadingTo(src, hits[0]!.id, 4); // cannot pass the trailing child
    expect(listAtxHeadings(next).map((h) => h.text)).toEqual(["B", "B1", "C", "A", "A1"]);
    expect(sortedLines(next)).toEqual(sortedLines(src));
  });

  it("moveHeadingTo returns the source for an out-of-range target", () => {
    const hits = listAtxHeadings(sample);
    expect(moveHeadingTo(sample, hits[0]!.id, 9)).toBe(sample);
    expect(moveHeadingTo(sample, hits[0]!.id, -1)).toBe(sample);
  });
});
