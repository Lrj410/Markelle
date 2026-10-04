import { describe, expect, it } from "vitest";
import { scopeReaderCss } from "./host";

describe("scopeReaderCss", () => {
  it("wraps balanced CSS in @scope", () => {
    const out = scopeReaderCss(".foo { color: red; }");
    expect(out).toContain("@scope (.main-pane)");
    expect(out).toContain(".foo { color: red; }");
  });

  it("rejects brace breakout", () => {
    expect(scopeReaderCss("} .titlebar { color: red; }")).toBe(
      "/* CSS rejected: unbalanced braces */",
    );
  });

  it("rejects unclosed blocks", () => {
    expect(scopeReaderCss(".foo { color: red;")).toBe(
      "/* CSS rejected: unbalanced braces */",
    );
  });

  it("allows braces inside strings", () => {
    const out = scopeReaderCss('.foo { content: "}"; }');
    expect(out).toContain("@scope");
    expect(out).toContain('content: "}"');
  });

  it("strips @import", () => {
    const out = scopeReaderCss('@import url("evil.css"); .ok { color: blue; }');
    expect(out).toContain("@import blocked");
    expect(out).not.toMatch(/@import\s+url/i);
  });

  it("blocks remote url() in CSS", () => {
    const out = scopeReaderCss('.x { background: url("https://evil.test/x.png"); }');
    expect(out).toContain("/* url blocked */");
    expect(out).not.toContain("https://evil.test");
    expect(out).toContain("@scope");
  });

  it("blocks relative url() as well as remote", () => {
    const out = scopeReaderCss(".x { background: url(foo.png); }");
    expect(out).toContain("/* url blocked */");
    expect(out).not.toContain("foo.png");
  });
});
