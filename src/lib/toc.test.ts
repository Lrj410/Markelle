import { describe, expect, it } from "vitest";
import { resolveHeadingId, slugify, type TocItem } from "./toc";

describe("toc helpers", () => {
  it("slugify de-dupes headings", () => {
    const used = new Map<string, number>();
    expect(slugify("Hello World", used)).toBe("hello-world");
    expect(slugify("Hello World", used)).toBe("hello-world-1");
  });

  it("resolveHeadingId matches text then id", () => {
    const toc: TocItem[] = [
      { id: "wang-wu", level: 1, text: "王五" },
      { id: "notes", level: 2, text: "Notes" },
    ];
    expect(resolveHeadingId("王五", toc)).toBe("wang-wu");
    expect(resolveHeadingId("notes", toc)).toBe("notes");
    expect(resolveHeadingId("Missing", toc)).toBe("missing");
  });
});
