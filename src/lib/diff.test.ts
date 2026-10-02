import { describe, expect, it } from "vitest";
import { computeLineDiff } from "./diff";

describe("computeLineDiff", () => {
  it("detects identical content", () => {
    const text = "line 1\nline 2\nline 3";
    const diff = computeLineDiff(text, text);
    expect(diff.every((d) => d.type === "same")).toBe(true);
    expect(diff.length).toBe(3);
  });

  it("detects added lines", () => {
    const oldText = "line 1\nline 3";
    const newText = "line 1\nline 2\nline 3";
    const diff = computeLineDiff(oldText, newText);
    expect(diff.map((d) => d.type)).toEqual(["same", "add", "same"]);
    expect(diff[1]?.text).toBe("line 2");
  });

  it("detects deleted lines", () => {
    const oldText = "line 1\nline 2\nline 3";
    const newText = "line 1\nline 3";
    const diff = computeLineDiff(oldText, newText);
    expect(diff.map((d) => d.type)).toEqual(["same", "del", "same"]);
    expect(diff[1]?.text).toBe("line 2");
  });

  it("detects modified lines as del + add", () => {
    const oldText = "hello world";
    const newText = "hello there";
    const diff = computeLineDiff(oldText, newText);
    expect(diff.some((d) => d.type === "del")).toBe(true);
    expect(diff.some((d) => d.type === "add")).toBe(true);
  });
});
