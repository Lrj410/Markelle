import { describe, expect, it } from "vitest";
import {
  allocateUniquePath,
  basename,
  dirname,
  joinPath,
  toDisplayPath,
  toPosixPath,
} from "./paths";

describe("paths", () => {
  it("joins segments with forward slashes", () => {
    expect(joinPath("C:/vault", "notes", "a.md")).toBe("C:/vault/notes/a.md");
    expect(joinPath("C:\\vault\\", "a.md")).toBe("C:/vault/a.md");
    expect(joinPath("/home/u/vault", "子目录", "x.md")).toBe(
      "/home/u/vault/子目录/x.md",
    );
  });

  it("strips trailing separators on dirname/basename", () => {
    expect(dirname("C:/vault/notes/a.md")).toBe("C:/vault/notes");
    expect(basename("C:\\vault\\a.md")).toBe("a.md");
    expect(toPosixPath("C:\\a\\b")).toBe("C:/a/b");
    expect(toDisplayPath("C:/a/b")).toContain("a");
  });

  it("allocates unique note paths without backslash bias", () => {
    const existing = new Set(["c:/vault/未命名.md", "c:/vault/未命名-2.md"]);
    const first = allocateUniquePath("C:/vault", "未命名.md", existing);
    expect(first).toBe("C:/vault/未命名-3.md");
    expect(first.includes("\\")).toBe(false);

    const empty = allocateUniquePath("C:/vault", "新笔记.md", new Set());
    expect(empty).toBe("C:/vault/新笔记.md");
  });
});
