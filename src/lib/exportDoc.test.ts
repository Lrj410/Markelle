import { describe, expect, it } from "vitest";
import { sanitizeExportHtml } from "./exportDoc";

describe("sanitizeExportHtml", () => {
  it("keeps ordinary markup untouched", () => {
    const html = "<p>hello <strong>world</strong></p>";
    expect(sanitizeExportHtml(html)).toBe(html);
  });

  it("removes script blocks and their contents", () => {
    const out = sanitizeExportHtml('<p>x</p><script>alert("xss")</script>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>x</p>");
  });

  it("removes style / iframe / object / embed", () => {
    const out = sanitizeExportHtml(
      '<style>body{color:red}</style><iframe src="x"></iframe><object></object><embed>',
    );
    const lower = out.toLowerCase();
    expect(lower).not.toContain("<style");
    expect(lower).not.toContain("<iframe");
    expect(lower).not.toContain("<object");
    expect(lower).not.toContain("<embed");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeExportHtml(
      '<img src="a.png" onerror="steal()"><p onclick=\'x()\'>t</p>',
    );
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onclick");
    expect(out).toContain('src="a.png"');
  });

  it("strips event handlers written flush against a closing quote or slash", () => {
    const out = sanitizeExportHtml(
      '<a href="x"onclick="go()">t</a><img/onerror="steal()"><p onmouseover=\'y()\'>z</p>',
    );
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onmouseover/i);
    expect(out).toContain('href="x"');
  });

  it("strips unquoted event handlers written without a preceding space", () => {
    const out = sanitizeExportHtml('<img/onerror=steal()><p onload=x()>t</p>');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onload/i);
  });

  it("strips back-to-back event handlers", () => {
    const out = sanitizeExportHtml('<a onclick="a()"onerror="b()"onload="c()">t</a>');
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onload/i);
    expect(out).toContain("<a ");
  });

  it("neutralises javascript: URLs", () => {
    const out = sanitizeExportHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="#"');
  });

  it("still rewrites internal href / src", () => {
    const out = sanitizeExportHtml(
      '<a href="markelle-file:C:/secret.md" data-path="C:/secret.md">n</a><img src="mklasset:C:/x.png">',
    );
    expect(out).not.toContain("secret.md");
    expect(out).not.toContain("mklasset:");
    expect(out).toContain('href="#"');
  });
});
