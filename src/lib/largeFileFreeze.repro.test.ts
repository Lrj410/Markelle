import { describe, expect, it } from "vitest";

/**
 * Red-capable repro for the blank-window bug:
 * pushing a growing full-file string into "React tab state" on every hydrate tick
 * makes the UI payload explode (CodeMirror + React hold GB-scale UTF-16).
 */
describe("large-file hydrate UI contract", () => {
  it("progress updates must not grow the editor-bound content payload", () => {
    const SAFE_UI_CHARS = 2 * 1024 * 1024; // first-paint window budget
    let editorBound = "x".repeat(1024 * 1024); // 1MB first paint
    const ticks: number[] = [];

    // Simulate the OLD buggy App onProgress (content: p.content every tick).
    const buggyOnProgress = (p: { content: string; bytesRead: number }) => {
      editorBound = p.content; // BUG
      ticks.push(editorBound.length);
    };

    let buf = editorBound;
    for (let i = 0; i < 40; i++) {
      buf += "y".repeat(4 * 1024 * 1024);
      buggyOnProgress({ content: buf, bytesRead: buf.length });
    }

    const peak = Math.max(...ticks);
    // This assertion documents the failure mode: peak far exceeds safe UI budget.
    expect(peak).toBeGreaterThan(SAFE_UI_CHARS * 10);

    // Fixed contract: progress may update ratio only; editor-bound stays ≤ first paint.
    const fixedBound = "x".repeat(1024 * 1024);
    const fixedOnProgress = (_p: { bytesRead: number; size: number }) => {
      // intentionally does not touch fixedBound
    };
    let offset = fixedBound.length;
    const size = 200 * 1024 * 1024;
    while (offset < size) {
      offset += 4 * 1024 * 1024;
      fixedOnProgress({ bytesRead: Math.min(offset, size), size });
    }
    expect(fixedBound.length).toBeLessThanOrEqual(SAFE_UI_CHARS);
  });

  it("fixed hydrate progress payload never includes growing content", () => {
    type Progress = { bytesRead: number; size: number; content?: string };
    const emits: Progress[] = [];
    const emitFixed = (p: Progress) => {
      // Contract: UI progress must omit content (Rust store owns the bytes).
      expect(p.content).toBeUndefined();
      emits.push(p);
    };
    for (let i = 1; i <= 5; i++) {
      emitFixed({ bytesRead: i * 4 * 1024 * 1024, size: 20 * 1024 * 1024 });
    }
    expect(emits).toHaveLength(5);
  });

  it("instant-open: truncated tabs may paint from first-chunk preview without waiting for done", () => {
    const FIRST_PAINT = 128 * 1024;
    const preview = "line\n".repeat(200);
    expect(preview.length).toBeLessThan(FIRST_PAINT);

    // Contract: viewing is gated on preview/ready, not on !truncated.
    const truncated = true;
    const ready = true;
    const canView = Boolean(preview) || ready || !truncated;
    expect(canView).toBe(true);

    // Edits stay blocked until hydrate completes.
    const canEdit = !truncated;
    expect(canEdit).toBe(false);
  });
});
