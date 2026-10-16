import { describe, expect, it } from "vitest";
import {
  cogniStackCheckHealth,
  cogniStackPrepare,
  cogniStackFit,
  buildCogniStackSummarizePrompt,
  parseStructuredCogniStackSummary,
  formatCogniStackTranscript,
  canonicalColumnTitle,
  COGNISTACK_MEMORY_COLUMNS,
} from "./cognistack";

describe("cognistack client module", () => {
  it("fails gracefully with connection error on dead endpoint", async () => {
    const res = await cogniStackCheckHealth("http://127.0.0.1:59999");
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it("handles prepare error gracefully on dead endpoint", async () => {
    const res = await cogniStackPrepare({
      url: "http://127.0.0.1:59999",
      dialogue: [{ role: "user", content: "hello" }],
      profile: { name: "Test Assistant" },
      loreEntries: [{ id: "l1", content: "knowledge", keys: ["k1"] }],
      vectorHits: [{ name: "v1", content: "vector text" }],
    });
    expect(res.ok).toBe(false);
    expect(res.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(res.error).toContain("CogniStack 调用失败");
  });

  it("handles fit error gracefully on dead endpoint", async () => {
    const res = await cogniStackFit({
      url: "http://127.0.0.1:59999",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.ok).toBe(false);
    expect(res.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(res.error).toBeDefined();
  });

  it("formats dialogue transcript correctly", () => {
    const transcript = formatCogniStackTranscript([
      { role: "user", content: "显卡型号是多少？" },
      { role: "assistant", content: "是 RTX 5070。" },
    ]);
    expect(transcript).toContain("用户: 显卡型号是多少？");
    expect(transcript).toContain("助手: 是 RTX 5070。");
  });

  it("builds five-part structured summarize prompt matching CogniStack standard", () => {
    const prompt = buildCogniStackSummarizePrompt({
      priorJoined: "【硬事实】旧事实",
      transcript: "用户: 显卡换了吗？\n\n助手: 换成了RTX 5080。",
      maxCharsHint: 600,
    });

    for (const col of COGNISTACK_MEMORY_COLUMNS) {
      expect(prompt).toContain(col);
    }
    expect(prompt).toContain("已有长期记忆摘要");
    expect(prompt).toContain("本批新对话");
    expect(prompt).toContain("600 字以内");
  });

  it("resolves canonical column titles and CogniStack 1.4.0 aliases", () => {
    expect(canonicalColumnTitle("【硬事实】")).toBe("【硬事实】");
    expect(canonicalColumnTitle("【核心事实】")).toBe("【硬事实】");
    expect(canonicalColumnTitle("【长期事实】")).toBe("【硬事实】");
    expect(canonicalColumnTitle("【事件时间线】")).toBe("【时间线】");
    expect(canonicalColumnTitle("【人物关系】")).toBe("【关系与称呼】");
    expect(canonicalColumnTitle("【未决事项】")).toBe("【未决】");
    expect(canonicalColumnTitle("【最近情节】")).toBe("【近期情节】");
    expect(canonicalColumnTitle("【未知栏目】")).toBeNull();
  });

  it("normalizes markdown headers and brackets into canonical five-part layout", () => {
    const raw = [
      "### 硬事实: 显卡为 RTX 5090",
      "## 事件时间线",
      "2026年完成系统升级",
      "[人物关系]",
      "张三为系统管理员",
      "【未决事项】",
      "显卡供电线尚未插紧",
      "### 最近情节",
      "刚刚进行了基准测试",
    ].join("\n");

    const cleaned = parseStructuredCogniStackSummary(raw);
    expect(cleaned).toContain("【硬事实】\n显卡为 RTX 5090");
    expect(cleaned).toContain("【时间线】\n2026年完成系统升级");
    expect(cleaned).toContain("【关系与称呼】\n张三为系统管理员");
    expect(cleaned).toContain("【未决】\n显卡供电线尚未插紧");
    expect(cleaned).toContain("【近期情节】\n刚刚进行了基准测试");
  });

  it("parses structured summary and strips machine blocks if present", () => {
    const raw = [
      "【硬事实】专有名词与事实",
      "【时间线】事件",
      "【关系与称呼】无",
      "【未决】无",
      "【近期情节】剧情",
      "<<<STATE_PATCH>>>",
      '{"entries":[{"key":"地点","value":"杭州"}]}',
      "<<<END>>>",
    ].join("\n");

    const cleaned = parseStructuredCogniStackSummary(raw);
    expect(cleaned).toContain("【硬事实】");
    expect(cleaned).toContain("专有名词与事实");
    expect(cleaned).not.toContain("<<<STATE_PATCH>>>");
    expect(cleaned).not.toContain("<<<END>>>");
  });

  it("returns fallback five-part structure if raw string is empty", () => {
    const cleaned = parseStructuredCogniStackSummary("");
    for (const col of COGNISTACK_MEMORY_COLUMNS) {
      expect(cleaned).toContain(col);
    }
  });

  it("normalizes missing columns into the fixed five-part layout", () => {
    const cleaned = parseStructuredCogniStackSummary("【硬事实】显卡是 RTX 5080\n杂项说明");
    for (const col of COGNISTACK_MEMORY_COLUMNS) {
      expect(cleaned).toContain(col);
    }
    expect(cleaned).toContain("RTX 5080");
    expect(cleaned).toMatch(/【时间线】\s*\n无/);
  });

  it("rejects non-loopback CogniStack URLs by default", async () => {
    const res = await cogniStackCheckHealth("https://evil.example.com");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/本机|局域网|非法/);
  });

  it("accurately handles emergency-dialogue-window warning patterns", () => {
    const sampleWarnings = [
      "prompt-budget-unreachable:dialogue-exceeds-cap:9200>8192",
      "emergency-dialogue-window:dropped-26",
    ];
    let droppedCount = 0;
    for (const w of sampleWarnings) {
      const m = w.match(/emergency-dialogue-window:dropped-(\d+)/i);
      if (m) droppedCount += Number(m[1]) || 0;
    }
    expect(droppedCount).toBe(26);
  });
});
