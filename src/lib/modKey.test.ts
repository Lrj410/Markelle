import { describe, expect, it } from "vitest";
import { formatChord, localizeChord, modKeyLabel } from "./modKey";

describe("modKey", () => {
  it("exposes a non-empty mod label", () => {
    expect(modKeyLabel().length).toBeGreaterThan(0);
  });

  it("formatChord joins with +", () => {
    const s = formatChord("Shift", "B");
    expect(s.endsWith("Shift+B")).toBe(true);
    expect(s.includes("+")).toBe(true);
  });

  it("localizeChord is idempotent on non-Ctrl text", () => {
    expect(localizeChord("Esc 关闭")).toBe("Esc 关闭");
  });
});
