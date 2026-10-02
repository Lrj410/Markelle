import { describe, expect, it } from "vitest";
import { collectNoteEmbedTargets, stripNoteEmbeds } from "./embeds";

describe("embeds", () => {
  it("collects note embed targets, skips images", () => {
    const src = `See ![[Alpha]] and ![[pic.png]] and [[Beta]]`;
    expect(collectNoteEmbedTargets(src)).toEqual(["Alpha"]);
  });

  it("strips note embeds to links for nested render", () => {
    expect(stripNoteEmbeds("x ![[Note#H|Alias]] y")).toBe(
      "x [[Note#H|Alias]] y",
    );
  });
});
