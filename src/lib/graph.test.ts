import { describe, expect, it } from "vitest";
import { folderOfNode, type GraphNode } from "./graph";

describe("graph helpers", () => {
  it("folderOfNode extracts parent folder", () => {
    const n: GraphNode = {
      id: "C:\\vault\\笔记\\Alpha.md",
      path: "C:\\vault\\笔记\\Alpha.md",
      name: "Alpha.md",
      kind: "note",
      isFocus: false,
    };
    expect(folderOfNode(n)).toBe("笔记");
  });

  it("folderOfNode labels orphans and conflicts", () => {
    expect(
      folderOfNode({
        id: "orphan:x",
        path: null,
        name: "x",
        kind: "orphan",
        isFocus: false,
      }),
    ).toBe("未解析");
    expect(
      folderOfNode({
        id: "conflict:a",
        path: null,
        name: "a",
        kind: "conflict",
        isFocus: false,
      }),
    ).toBe("冲突");
  });
});
