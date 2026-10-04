import { describe, expect, it } from "vitest";
import { canWriteTabContent, getWriteBlockReason } from "./documentGuards";

describe("documentGuards", () => {
  it("blocks truncated and backendBuffer tabs", () => {
    expect(getWriteBlockReason({ truncated: true, backendBuffer: false })).toBe("truncated");
    expect(getWriteBlockReason({ truncated: false, backendBuffer: true })).toBe(
      "backendBuffer",
    );
    expect(canWriteTabContent({ truncated: false, backendBuffer: false })).toBe(true);
  });

  it("prefers truncated over backendBuffer when both set", () => {
    expect(getWriteBlockReason({ truncated: true, backendBuffer: true })).toBe("truncated");
  });
});
