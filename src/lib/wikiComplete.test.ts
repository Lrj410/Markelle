import { describe, expect, it } from "vitest";
import { wikiLinkCompletion } from "./wikiComplete";
import type { VaultFile } from "./vaultIndex";

const files: VaultFile[] = [
  { path: "C:/v/a.md", name: "a.md", stem: "Alpha", relative: "a.md" },
  { path: "C:/v/b.md", name: "b.md", stem: "Beta", relative: "notes/b.md" },
];

describe("wikiLinkCompletion", () => {
  it("returns matching stems", () => {
    const source = wikiLinkCompletion(files);
    const result = source({
      matchBefore: (re: RegExp) => {
        const text = "see [[Al";
        const m = text.match(re);
        if (!m) return null;
        return { from: text.indexOf("[["), to: text.length, text: m[0]! };
      },
      explicit: false,
      from: 0,
      to: 0,
      state: {} as never,
      pos: 0,
      abort: () => undefined,
      tokenBefore: () => null,
    } as never);
    expect(result?.options.map((o) => o.label)).toContain("Alpha");
    expect(result?.options.map((o) => o.label)).not.toContain("Beta");
  });
});
