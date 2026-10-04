import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assertAllowedUrl,
  smartSliceMarkdown,
  summarizePrompt,
  polishPrompt,
  continuePrompt,
  proofreadPrompt,
  translatePrompt,
  extractTagsPrompt,
  stripModelOutputFences,
  isAbortError,
  ollamaGenerate,
} from "./ollama";

describe("ollama URL whitelist and LAN policies", () => {
  it("allows standard localhost and 127.0.0.1", () => {
    expect(assertAllowedUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(assertAllowedUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(assertAllowedUrl("http://[::1]:11434")).toBe("http://[::1]:11434");
  });

  it("blocks non-loopback URLs when allowLan is false", () => {
    expect(() => assertAllowedUrl("http://192.168.1.100:11434", false)).toThrow(
      "本地 AI 仅允许连接本机",
    );
    expect(() => assertAllowedUrl("https://api.openai.com", false)).toThrow();
  });

  it("permits private LAN IP ranges when allowLan is true", () => {
    expect(assertAllowedUrl("http://192.168.1.50:11434", true)).toBe("http://192.168.1.50:11434");
    expect(assertAllowedUrl("http://10.0.0.12:8080", true)).toBe("http://10.0.0.12:8080");
    expect(assertAllowedUrl("http://172.20.0.5:1234", true)).toBe("http://172.20.0.5:1234");
  });

  it("rejects *.local hostnames even when allowLan is true (DNS may resolve off-LAN)", () => {
    expect(() => assertAllowedUrl("http://nas-ai.local:11434", true)).toThrow();
    expect(() => assertAllowedUrl("http://evil.local:11434", true)).toThrow();
  });

  it("rejects public internet IPs even when allowLan is true", () => {
    expect(() => assertAllowedUrl("http://8.8.8.8:11434", true)).toThrow();
    expect(() => assertAllowedUrl("https://api.deepseek.com", true)).toThrow();
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrow();
    expect(() => assertAllowedUrl("ftp://127.0.0.1/x")).toThrow();
  });
});

describe("smartSliceMarkdown integrity protection", () => {
  it("returns unchanged text within limit", () => {
    const text = "这是一篇短笔记\n\n包含两个段落。";
    expect(smartSliceMarkdown(text, 1000)).toBe(text);
  });

  it("automatically closes unclosed code fences when truncated", () => {
    const markdown = "```typescript\nfunction hello() {\n  console.log('world');\n}\n// very long content follows...";
    const truncated = smartSliceMarkdown(markdown, 30);
    expect(truncated).toContain("```");
    const count = (truncated.match(/```/g) || []).length;
    expect(count % 2).toBe(0);
  });

  it("prefers paragraph boundaries over hard cuts", () => {
    const para =
      "第一段内容写得比较长一些以便触发截断。\n\n第二段更长一些的内容在这里继续延伸很多字。\n\n第三段。";
    const sliced = smartSliceMarkdown(para, 40);
    expect(sliced).toContain("[…文本过长已智能截断…]");
    expect(sliced.indexOf("第一段")).toBeGreaterThanOrEqual(0);
    expect(sliced.length).toBeLessThan(para.length + 40);
  });
});

describe("Prompt generation functions", () => {
  it("generates appropriate prompts with content", () => {
    const sample = "# Title\nContent";
    expect(summarizePrompt(sample)).toContain("总结");
    expect(polishPrompt(sample)).toContain("润色");
    expect(continuePrompt(sample)).toContain("续写");
    expect(proofreadPrompt(sample)).toContain("校对");
    expect(translatePrompt(sample)).toContain("翻译");
    expect(extractTagsPrompt(sample)).toContain("双向链接");
  });
});

describe("stripModelOutputFences", () => {
  it("unwraps a single outer markdown fence", () => {
    expect(stripModelOutputFences("```markdown\n# Hello\nworld\n```")).toBe("# Hello\nworld");
    expect(stripModelOutputFences("```\nplain\n```")).toBe("plain");
  });

  it("leaves normal markdown untouched", () => {
    expect(stripModelOutputFences("# Title\n\n- a\n- b")).toBe("# Title\n\n- a\n- b");
  });

  it("does not strip when multiple fences exist inside content", () => {
    const src = "Intro\n\n```js\ncode()\n```\n\nOutro";
    expect(stripModelOutputFences(src)).toBe(src);
  });
});

describe("isAbortError", () => {
  it("detects AbortError and DOMException abort", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("network"))).toBe(false);
  });
});

describe("ollamaGenerate endpoint cascade", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prefers OpenAI-compatible streaming chat completions", async () => {
    const fetchMock = vi.fn(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await ollamaGenerate({
      baseUrl: "http://127.0.0.1:11434",
      model: "test",
      prompt: "hi",
    });
    expect(out).toBe("你好");
    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = fetchMock.mock.calls.at(0)?.at(0);
    expect(String(calledUrl)).toContain("/v1/chat/completions");
  });

  it("falls through to Ollama /api/chat when OpenAI path fails", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/v1/chat/completions") || u.includes("/completion")) {
        return new Response("nope", { status: 404 });
      }
      if (u.includes("/api/chat")) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('{"message":{"content":"来自chat"}}\n'),
            );
            controller.enqueue(encoder.encode('{"done":true}\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response("miss", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await ollamaGenerate({
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "问" },
      ],
    });
    expect(out).toBe("来自chat");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/chat"))).toBe(true);
  });
});
