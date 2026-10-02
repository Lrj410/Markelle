import { describe, expect, it } from "vitest";
import { buildVirtualInitialText, VIRTUAL_CHUNK_SIZE } from "./virtualDoc";

describe("virtualDoc", () => {
  it("pads empty lines accurately up to target line count", () => {
    const raw = "first line\nsecond line";
    const padded = buildVirtualInitialText(raw, 5);
    const lines = padded.split("\n");
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe("first line");
    expect(lines[1]).toBe("second line");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("");
  });

  it("leaves text alone when target line count is less than or equal to current", () => {
    const raw = "a\nb\nc";
    expect(buildVirtualInitialText(raw, 3)).toBe(raw);
    expect(buildVirtualInitialText(raw, 2)).toBe(raw);
  });

  it("handles empty initial text", () => {
    const padded = buildVirtualInitialText("", 3);
    expect(padded.split("\n").length).toBe(3);
  });

  it("calculates virtual chunk size as 500", () => {
    expect(VIRTUAL_CHUNK_SIZE).toBe(500);
  });
});
