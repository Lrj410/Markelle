import { describe, expect, it } from "vitest";
import {
  buildDegreeMap,
  filterGraphNodes,
  folderTint,
  getNodeNeighbors,
  labelOf,
  nodeRadius,
} from "./graphModel";
import type { GraphNode } from "./graph";

describe("graphModel", () => {
  it("labels strip md extension", () => {
    expect(labelOf({ name: "Alpha.md" })).toBe("Alpha");
  });

  it("computes degrees", () => {
    const d = buildDegreeMap([
      { source: "a", target: "b" },
      { source: "a", target: "c" },
    ]);
    expect(d.get("a")).toBe(2);
    expect(d.get("b")).toBe(1);
  });

  it("filters orphans and isolates", () => {
    const nodes: GraphNode[] = [
      { id: "a", path: "a.md", name: "a.md", kind: "note", isFocus: false },
      { id: "b", path: "b.md", name: "b.md", kind: "note", isFocus: false },
      {
        id: "orphan:x",
        path: null,
        name: "x",
        kind: "orphan",
        isFocus: false,
      },
    ];
    const degree = buildDegreeMap([{ source: "a", target: "b" }]);
    const kept = filterGraphNodes(nodes, degree, {
      hideOrphans: true,
      hideIsolates: false,
      minDegree: 0,
      query: "",
    });
    expect(kept.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("folderTint is stable", () => {
    expect(folderTint("笔记", true)).toBe(folderTint("笔记", true));
    expect(nodeRadius("note", true, 0)).toBeGreaterThan(nodeRadius("note", false, 0));
  });

  it("finds node neighbors accurately", () => {
    const links = [
      { source: "a", target: "b" },
      { source: "c", target: "a" },
      { source: "x", target: "y" },
    ];
    const neighbors = getNodeNeighbors("a", links).sort();
    expect(neighbors).toEqual(["b", "c"]);
    expect(getNodeNeighbors("y", links)).toEqual(["x"]);
    expect(getNodeNeighbors("z", links)).toEqual([]);
  });
});

