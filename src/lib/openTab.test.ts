import { describe, expect, it } from "vitest";
import {
  isPathUnder,
  isSameDirectory,
  normalizePath,
  pathsEqual,
  resolveActiveId,
  upsertOpenedTab,
} from "./openTab";
import { isDirty, type DocTab } from "./tabs";
import type { OpenedFile } from "./files";

describe("path helpers", () => {
  it("normalizes slashes and case", () => {
    expect(normalizePath("C:\\Notes\\A.md")).toBe("c:/notes/a.md");
    expect(pathsEqual("C:/Notes/a.md", "c:\\notes\\A.md")).toBe(true);
  });

  it("keeps POSIX paths case-sensitive when not on Windows", () => {
    // Windows-style drives stay case-insensitive; plain POSIX paths do not.
    expect(normalizePath("/Home/Notes/A.md")).toBe("/Home/Notes/A.md");
    expect(pathsEqual("/Home/Notes/A.md", "/home/notes/a.md")).toBe(false);
    expect(isPathUnder("/Home/Notes/a.md", "/Home/Notes")).toBe(true);
  });

  it("detects path under vault", () => {
    expect(isPathUnder("C:/vault/a.md", "C:/vault")).toBe(true);
    expect(isPathUnder("C:/vault/../secrets.md", "C:/vault")).toBe(false);
    expect(isPathUnder("C:/other/a.md", "C:/vault")).toBe(false);
  });

  it("detects same directory siblings", () => {
    expect(isSameDirectory("C:/notes/a.md", "C:/notes/b.md")).toBe(true);
    expect(isSameDirectory("C:/notes/a.md", "C:/other/b.md")).toBe(false);
  });
});

describe("upsertOpenedTab", () => {
  const opened: OpenedFile = {
    path: "C:/vault/note.md",
    name: "note.md",
    content: "hello",
    size: 5,
    truncated: false,
    encoding: "utf-8",
    mtimeMs: 1,
    bytesRead: 5,
    large: false,
  };

  it("creates a new tab", () => {
    const { tabs, focusId } = upsertOpenedTab([], opened, "C:/vault", false);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.id).toBe(focusId);
    expect(tabs[0]?.encoding).toBe("utf-8");
  });

  it("keeps a truncated preview marked truncated so it can never be saved", () => {
    // The backend returns only a preview for huge files. If the tab claimed
    // `truncated: false`, Ctrl+S would write that preview over the whole note.
    const huge: OpenedFile = {
      ...opened,
      path: "C:/vault/huge.md",
      name: "huge.md",
      content: "# preview only",
      size: 60 * 1024 * 1024,
      truncated: true,
      large: true,
      bytesRead: 256 * 1024,
    };
    const { tabs } = upsertOpenedTab([], huge, "C:/vault", false);
    expect(tabs[0]?.truncated).toBe(true);
    expect(tabs[0]?.large).toBe(true);
    expect(tabs[0]?.mode).toBe("read");
  });

  it("does not mark a fully-loaded 2MB–50MB file as large", () => {
    // Regression: the backend returns the full text for files up to 50MB, so a
    // 20MB file with `large: false` must stay editable/saveable, not be mislabeled.
    const medium: OpenedFile = {
      ...opened,
      path: "C:/vault/medium.md",
      name: "medium.md",
      size: 20 * 1024 * 1024,
      large: false,
    };
    const { tabs } = upsertOpenedTab([], medium, "C:/vault", false);
    expect(tabs[0]?.large).toBe(false);
  });

  it("preserves dirty content unless forceFull", () => {
    const dirty: DocTab = {
      id: "t1",
      path: opened.path,
      name: opened.name,
      content: "edited",
      savedContent: "hello",
      baseDir: "C:/vault",
      size: 5,
      truncated: false,
      mode: "read",
    };
    expect(isDirty(dirty)).toBe(true);
    const { tabs } = upsertOpenedTab([dirty], { ...opened, content: "hello" }, "C:/vault", false);
    expect(tabs[0]?.content).toBe("edited");
    const forced = upsertOpenedTab([dirty], { ...opened, content: "fresh" }, "C:/vault", true);
    expect(forced.tabs[0]?.content).toBe("fresh");
  });
});

describe("resolveActiveId", () => {
  it("falls back when active is missing", () => {
    const tabs = [
      { id: "a" },
      { id: "b" },
    ] as DocTab[];
    expect(resolveActiveId(tabs, null)).toBe("b");
    expect(resolveActiveId(tabs, "a")).toBe("a");
    expect(resolveActiveId([], "a")).toBe(null);
  });
});
