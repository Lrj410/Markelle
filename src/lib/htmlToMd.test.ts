import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./htmlToMd";

describe("htmlToMarkdown", () => {
  it("converts basic headings and paragraphs", () => {
    const html = "<h1>Title</h1><p>Hello <strong>world</strong>!</p>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Title");
    expect(md).toContain("Hello **world**!");
  });

  it("converts lists and links", () => {
    const html = `
      <ul>
        <li>First <a href="https://example.com">link</a></li>
        <li>Second item</li>
      </ul>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain("- First [link](https://example.com)");
    expect(md).toContain("- Second item");
  });

  it("converts preformatted code blocks", () => {
    const html = '<pre><code class="language-rust">fn main() {\n    println!("hi");\n}</code></pre>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("```rust");
    expect(md).toContain('println!("hi");');
    expect(md).toContain("```");
  });

  it("converts HTML tables", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </table>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain("| A | B |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1 | 2 |");
  });

  it("preserves generics and JSX in code blocks and inline code", () => {
    const html = '<pre><code class="language-typescript">const items: Array&lt;string&gt; = [];\nfunction App(): JSX.Element { return &lt;div&gt;Hello&lt;/div&gt;; }</code></pre><p>Use <code>Map&lt;string, number&gt;</code> here.</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("```typescript");
    expect(md).toContain("const items: Array<string> = [];");
    expect(md).toContain("return <div>Hello</div>;");
    expect(md).toContain("`Map<string, number>`");
  });

  it("preserves code blocks inside blockquotes", () => {
    const html = '<blockquote><p>Quote:</p><pre><code>const a: List&lt;T&gt; = [];</code></pre></blockquote>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("> const a: List<T> = [];");
  });
});

