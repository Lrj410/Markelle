import { describe, expect, it } from "vitest";
import {
  extractTags,
  parseFrontmatter,
  replaceFrontmatter,
  serializeFrontmatter,
} from "./frontmatter";

describe("frontmatter", () => {
  it("parses yaml-ish frontmatter", () => {
    const src = `---
title: Hello
tags: [a, b]
draft: true
---
# Body
`;
    const { data, body } = parseFrontmatter(src);
    expect(data.title).toBe("Hello");
    expect(data.tags).toEqual(["a", "b"]);
    expect(data.draft).toBe(true);
    expect(body.trim().startsWith("# Body")).toBe(true);
  });

  it("extracts hash tags from body", () => {
    expect(extractTags("hello #work and #项目/子")).toEqual(["work", "项目/子"]);
  });

  it("round-trips via replaceFrontmatter", () => {
    const src = `---
title: Hello
tags: [a, b]
---
# Body
`;
    const next = replaceFrontmatter(src, { title: "Hi", tags: ["a", "c"], draft: true });
    const { data, body } = parseFrontmatter(next);
    expect(data.title).toBe("Hi");
    expect(data.tags).toEqual(["a", "c"]);
    expect(data.draft).toBe(true);
    expect(body.trim()).toBe("# Body");
  });

  it("inserts frontmatter when missing", () => {
    const next = replaceFrontmatter("# Body\n", { title: "X" });
    expect(serializeFrontmatter({ title: "X" })).toBe("---\ntitle: X\n---");
    expect(parseFrontmatter(next).data.title).toBe("X");
    expect(parseFrontmatter(next).body.trim()).toBe("# Body");
  });

  it("only accepts an exact `---` line as the closing fence", () => {
    const src = "---\ntitle: Hello\n----------\ndraft: true\n---\n# Body\n";
    const { data, body } = parseFrontmatter(src);
    expect(data.title).toBe("Hello");
    expect(data.draft).toBe(true);
    expect(body.trim().startsWith("# Body")).toBe(true);
  });

  it("parses block-sequence tags and aliases", () => {
    const src = `---
title: 项目索引
date: 2026-09-27
tags:
  - moc
  - projects
aliases:
  - Projects MOC
---

# 项目索引

body
`;
    const { data, body } = parseFrontmatter(src);
    expect(data.title).toBe("项目索引");
    expect(data.tags).toEqual(["moc", "projects"]);
    expect(data.aliases).toEqual(["Projects MOC"]);
    expect(body).toContain("# 项目索引");
    expect(body).toContain("body");
  });
});
