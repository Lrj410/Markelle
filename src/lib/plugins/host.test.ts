import { describe, expect, it } from "vitest";
import { isSafeBodyClass, scopeReaderCss } from "./host";

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

  // Escape-based bypass fixtures: literal regexes must not be fooled by CSS escapes.
  it("blocks hex-escaped url (u\\72l)", () => {
    const out = scopeReaderCss('.x { background: u\\72l("https://evil.test/x.png"); }');
    expect(out).toContain("/* url blocked */");
    expect(out).not.toContain("evil.test");
    expect(out).not.toContain("u\\72l");
  });

  it("blocks spaced hex-escaped url (\\75 rl)", () => {
    const out = scopeReaderCss(".x { background: \\75 rl(foo.png); }");
    expect(out).toContain("/* url blocked */");
    expect(out).not.toContain("foo.png");
  });

  it("blocks char-escaped @import (@im\\port)", () => {
    const out = scopeReaderCss('@im\\port url("evil.css"); .ok { color: blue; }');
    expect(out).toContain("@import blocked");
    expect(out).not.toContain("evil.css");
  });

  it("blocks escaped expression() and image-set()", () => {
    const expr = scopeReaderCss(".x { width: expression\\28 hidden\\29; }");
    expect(expr).toContain("/* expression blocked */");
    expect(expr).not.toContain("expression(");
    const img = scopeReaderCss('.x { background: image\\2d set("a.png" 1x); }');
    expect(img).toContain("/* image-set blocked */");
    expect(img).not.toContain("a.png");
  });

  it("still wraps legitimate escaped CSS in @scope", () => {
    const out = scopeReaderCss(".a\\:b { color: red; }");
    expect(out).toContain("@scope (.main-pane)");
  });
});

describe("isSafeBodyClass", () => {
  it("accepts plain class tokens", () => {
    expect(isSafeBodyClass("plugin-sepia-reading")).toBe(true);
    expect(isSafeBodyClass("a_b-c1")).toBe(true);
  });

  it("rejects whitespace, quotes and markup-ish tokens", () => {
    expect(isSafeBodyClass("")).toBe(false);
    expect(isSafeBodyClass("a b")).toBe(false);
    expect(isSafeBodyClass('x" onload="alert(1)')).toBe(false);
    expect(isSafeBodyClass("a.b")).toBe(false);
  });
});
