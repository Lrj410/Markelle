import { describe, expect, it } from "vitest";
import {
  refactorWikilinks,
  refactorMarkdownFileLinks,
  refactorAllLinks,
} from "./refactorLinks";

describe("refactorWikilinks", () => {
  it("renames exact stem wikilink", () => {
    const input = "Here is [[My Note]] and more text.";
    expect(refactorWikilinks(input, "My Note", "Brand New Note")).toBe(
      "Here is [[Brand New Note]] and more text.",
    );
  });

  it("preserves headings and aliases in wikilinks", () => {
    const input = "Check [[Architecture#Layer 1|The Arch]] for details.";
    expect(refactorWikilinks(input, "Architecture", "System Architecture")).toBe(
      "Check [[System Architecture#Layer 1|The Arch]] for details.",
    );
  });

  it("handles embeds with size constraints", () => {
    const input = "![[Chart#Summary|350]]";
    expect(refactorWikilinks(input, "Chart", "DataChart")).toBe(
      "![[DataChart#Summary|350]]",
    );
  });

  it("handles nested directory targets in wikilinks", () => {
    const input = "[[guides/setup]] and [[guides/setup#mac]]";
    expect(refactorWikilinks(input, "setup", "quickstart")).toBe(
      "[[guides/quickstart]] and [[guides/quickstart#mac]]",
    );
  });

  it("does not match partial stems", () => {
    const input = "[[My Note]] and [[My Notes]] and [[Not My Note]]";
    expect(refactorWikilinks(input, "My Note", "New Note")).toBe(
      "[[New Note]] and [[My Notes]] and [[Not My Note]]",
    );
  });

  it("is case-insensitive for target matching", () => {
    const input = "[[my note]]";
    expect(refactorWikilinks(input, "My Note", "Our Note")).toBe("[[Our Note]]");
  });

  it("preserves whitespace around target", () => {
    const input = "[[  My Note  |Alias]]";
    expect(refactorWikilinks(input, "My Note", "New Note")).toBe(
      "[[  New Note  |Alias]]",
    );
  });
});

describe("refactorMarkdownFileLinks", () => {
  it("renames relative markdown links", () => {
    const input = "See [doc](./old-file.md) and [other](folder/old-file.md#sec).";
    expect(refactorMarkdownFileLinks(input, "old-file.md", "new-file.md")).toBe(
      "See [doc](./new-file.md) and [other](folder/new-file.md#sec).",
    );
  });

  it("encodes spaces in new filenames", () => {
    const input = "[doc](old.md)";
    expect(refactorMarkdownFileLinks(input, "old.md", "new note.md")).toBe(
      "[doc](new%20note.md)",
    );
  });
});

describe("refactorAllLinks", () => {
  it("renames both wikilinks and standard links from paths", () => {
    const input =
      "Check [[Guide#Intro|Start]] and [Doc](Guide.md) and unrelated [[Guidebook]].";
    const result = refactorAllLinks(
      input,
      "/vault/docs/Guide.md",
      "/vault/docs/Tutorial.md",
    );
    expect(result).toBe(
      "Check [[Tutorial#Intro|Start]] and [Doc](Tutorial.md) and unrelated [[Guidebook]].",
    );
  });
});
