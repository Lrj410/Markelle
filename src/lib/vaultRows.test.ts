import { describe, expect, it } from "vitest";
import type { VaultNode } from "./vault";
import {
  computeRowWindow,
  flattenVaultRows,
  VAULT_OVERSCAN,
  VAULT_ROW_HEIGHT,
  type VaultRow,
} from "./vaultRows";

function tree(): VaultNode {
  return {
    name: "root",
    path: "/root",
    kind: "dir",
    children: [
      {
        name: "a",
        path: "/root/a",
        kind: "dir",
        children: [
          { name: "a1.md", path: "/root/a/a1.md", kind: "file" },
          {
            name: "deep",
            path: "/root/a/deep",
            kind: "dir",
            children: [
              { name: "d1.md", path: "/root/a/deep/d1.md", kind: "file" },
            ],
          },
        ],
      },
      { name: "b.md", path: "/root/b.md", kind: "file" },
      { name: "empty", path: "/root/empty", kind: "dir", children: [] },
    ],
  };
}

const keys = (rows: VaultRow[]) => rows.map((r) => r.key);
const depths = (rows: VaultRow[]) => rows.map((r) => r.depth);

describe("flattenVaultRows", () => {
  it("emits only top-level rows when everything is collapsed", () => {
    const rows = flattenVaultRows(tree(), { expanded: new Set<string>() });
    expect(keys(rows)).toEqual(["/root/a", "/root/b.md", "/root/empty"]);
    expect(depths(rows)).toEqual([0, 0, 0]);
    expect(rows.every((r) => !r.empty)).toBe(true);
  });

  it("reveals children of an expanded directory only", () => {
    const rows = flattenVaultRows(tree(), {
      expanded: new Set(["/root/a"]),
    });
    expect(keys(rows)).toEqual([
      "/root/a",
      "/root/a/a1.md",
      "/root/a/deep",
      "/root/b.md",
      "/root/empty",
    ]);
    expect(depths(rows)).toEqual([0, 1, 1, 0, 0]);
  });

  it("walks arbitrarily deep nesting via a predicate", () => {
    const rows = flattenVaultRows(tree(), {
      expanded: (_node, depth) => depth < 3,
    });
    expect(keys(rows)).toEqual([
      "/root/a",
      "/root/a/a1.md",
      "/root/a/deep",
      "/root/a/deep/d1.md",
      "/root/b.md",
      "/root/empty",
      "/root/empty::empty",
    ]);
    expect(depths(rows)).toEqual([0, 1, 1, 2, 0, 0, 1]);
  });

  it("emits an empty-folder hint only while the empty dir is open", () => {
    const collapsed = flattenVaultRows(tree(), { expanded: new Set<string>() });
    expect(collapsed.some((r) => r.empty)).toBe(false);

    const rows = flattenVaultRows(tree(), {
      expanded: new Set(["/root/empty"]),
    });
    const hint = rows.find((r) => r.empty);
    expect(hint?.key).toBe("/root/empty::empty");
    expect(hint?.depth).toBe(1);
    expect(hint?.node.path).toBe("/root/empty");
  });

  it("returns nothing for an empty tree (and tolerates a missing children list)", () => {
    const empty: VaultNode = { name: "root", path: "/root", kind: "dir" };
    expect(flattenVaultRows(empty, { expanded: new Set() })).toEqual([]);
    expect(
      flattenVaultRows({ ...empty, children: [] }, { expanded: new Set() }),
    ).toEqual([]);
  });

  it("filters to matches and auto-expands their ancestors", () => {
    const rows = flattenVaultRows(tree(), {
      expanded: new Set<string>(),
      isVisible: (node) => node.name.endsWith(".md"),
    });
    expect(keys(rows)).toEqual([
      "/root/a",
      "/root/a/a1.md",
      "/root/a/deep",
      "/root/a/deep/d1.md",
      "/root/b.md",
    ]);
    expect(depths(rows)).toEqual([0, 1, 1, 2, 0]);
    expect(rows.some((r) => r.empty)).toBe(false);
  });

  it("keeps a directly-matching directory even without matching descendants", () => {
    const rows = flattenVaultRows(tree(), {
      expanded: new Set<string>(),
      isVisible: (node) => node.name === "empty",
    });
    expect(keys(rows)).toEqual(["/root/empty"]);
  });

  it("flattens a 10k-file tree in a single linear pass", () => {
    const files: VaultNode[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      files.push({ name: `f${i}.md`, path: `/vault/big/f${i}.md`, kind: "file" });
    }
    const root: VaultNode = {
      name: "vault",
      path: "/vault",
      kind: "dir",
      children: [{ name: "big", path: "/vault/big", kind: "dir", children: files }],
    };
    const rows = flattenVaultRows(root, { expanded: new Set(["/vault/big"]) });
    expect(rows).toHaveLength(10_001);
    expect(rows[0]!.key).toBe("/vault/big");
    expect(rows[0]!.depth).toBe(0);
    expect(rows[10_000]!.depth).toBe(1);
  });
});

describe("computeRowWindow", () => {
  const total = 1000;

  it("clamps to the very top", () => {
    const w = computeRowWindow(total, VAULT_ROW_HEIGHT, 0, 300);
    expect(w.start).toBe(0);
    expect(w.end).toBe(10 + VAULT_OVERSCAN);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((total - w.end) * VAULT_ROW_HEIGHT);
  });

  it("centres a mid-list window and keeps the total height correct", () => {
    const w = computeRowWindow(total, VAULT_ROW_HEIGHT, 3000, 300);
    expect(w.start).toBe(100 - VAULT_OVERSCAN);
    expect(w.end).toBe(110 + VAULT_OVERSCAN);
    expect(w.padTop).toBe(94 * VAULT_ROW_HEIGHT);
    expect(w.padBottom).toBe(26520);
    expect(w.padTop + (w.end - w.start) * VAULT_ROW_HEIGHT + w.padBottom).toBe(
      total * VAULT_ROW_HEIGHT,
    );
  });

  it("clamps to the very bottom with no trailing spacer", () => {
    const w = computeRowWindow(total, VAULT_ROW_HEIGHT, 29700, 300);
    expect(w.end).toBe(total);
    expect(w.padBottom).toBe(0);
    expect(w.start).toBe(984);
  });

  it("clamps scroll positions beyond the content", () => {
    const w = computeRowWindow(total, VAULT_ROW_HEIGHT, 10_000_000, 300);
    expect(w.start).toBe(total);
    expect(w.end).toBe(total);
    expect(w.padTop).toBe(total * VAULT_ROW_HEIGHT);
    expect(w.padBottom).toBe(0);
  });

  it("treats a negative scroll offset as the top", () => {
    const w = computeRowWindow(total, VAULT_ROW_HEIGHT, -500, 300);
    expect(w.start).toBe(0);
  });

  it("returns an empty window for no rows", () => {
    expect(computeRowWindow(0, VAULT_ROW_HEIGHT, 0, 300)).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
    });
  });

  it("honours the overscan argument", () => {
    const none = computeRowWindow(total, VAULT_ROW_HEIGHT, 3000, 300, 0);
    expect(none.start).toBe(100);
    expect(none.end).toBe(110);

    const wide = computeRowWindow(total, VAULT_ROW_HEIGHT, 3000, 300, 20);
    expect(wide.start).toBe(80);
    expect(wide.end).toBe(130);
  });

  it("never returns end < start", () => {
    const w = computeRowWindow(100, VAULT_ROW_HEIGHT, 0, 0, 0);
    expect(w.end).toBeGreaterThanOrEqual(w.start);
  });

  it("keeps the mounted window bounded no matter how many rows exist", () => {
    // 10000 rows, 800px viewport, row height 30 → at most ~27 visible + overscan.
    const w = computeRowWindow(10_000, VAULT_ROW_HEIGHT, 15_000, 800);
    expect(w.end - w.start).toBeLessThanOrEqual(40);
  });
});
