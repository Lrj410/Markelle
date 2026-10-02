import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import {
  enqueuePendingOpen,
  setPendingOpenConsumer,
  hasPendingOpen,
  installEarlyOpenListeners,
} from "./pendingOpen";
import { listen } from "@tauri-apps/api/event";

describe("pendingOpen queue", () => {
  beforeEach(() => {
    setPendingOpenConsumer(null);
    // Drain any leftover by attaching a no-op consumer then clearing.
    setPendingOpenConsumer(() => undefined);
    setPendingOpenConsumer(null);
  });

  it("buffers until a consumer attaches (startup race)", () => {
    enqueuePendingOpen({ kind: "file", path: "C:/notes/a.md" });
    enqueuePendingOpen({ kind: "file", path: "C:/notes/a.md" }); // dedupe
    expect(hasPendingOpen()).toBe(true);

    const seen: string[] = [];
    setPendingOpenConsumer((item) => {
      if (item.kind === "file") seen.push(item.path);
    });
    expect(seen).toEqual(["C:/notes/a.md"]);
    expect(hasPendingOpen()).toBe(false);
  });

  it("delivers immediately when consumer is live", () => {
    const seen: string[] = [];
    setPendingOpenConsumer((item) => {
      if (item.kind === "file") seen.push(item.path);
    });
    enqueuePendingOpen({ kind: "file", path: "C:/b.md" });
    expect(seen).toEqual(["C:/b.md"]);
  });

  it("going red if buffer were dropped — consumer late still gets path", () => {
    // This is the exact user symptom: OS emit before React listen → lost → Welcome.
    enqueuePendingOpen({
      kind: "file",
      path: "C:/Users/18755/Desktop/AIModel-Test/CHECKLIST-2026-09-21.md",
    });
    let opened: string | null = null;
    setPendingOpenConsumer((item) => {
      if (item.kind === "file") opened = item.path;
    });
    expect(opened).toContain("CHECKLIST-2026-09-21.md");
  });
});

describe("pendingOpen listener install", () => {
  it("registers listeners once under concurrent installs", async () => {
    await Promise.all([installEarlyOpenListeners(), installEarlyOpenListeners()]);
    // Two events (file + vault) — never four from a duplicated install.
    expect(vi.mocked(listen).mock.calls.length).toBe(2);
  });
});
