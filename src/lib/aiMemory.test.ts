import { describe, expect, it } from "vitest";
import {
  assembleBuiltinContext,
  prepareConversationContext,
  getCogniStackSessionState,
  saveCogniStackSessionState,
  clearCogniStackSessionState,
  isUsableHistoryTurn,
} from "./aiMemory";
import { DEFAULT_SETTINGS } from "./types";

describe("isUsableHistoryTurn structured marker", () => {
  it("rejects turns flagged aborted/errored regardless of text", () => {
    // Content looks perfectly normal — only the structured flag decides.
    expect(isUsableHistoryTurn("完整的一段回答", "assistant", "aborted")).toBe(false);
    expect(isUsableHistoryTurn("完整的一段回答", "assistant", "errored")).toBe(false);
    expect(isUsableHistoryTurn("完整的一段回答", "assistant", null)).toBe(true);
  });

  it("still drops legacy placeholder text when no flag is present (backward compat)", () => {
    expect(isUsableHistoryTurn("半截 [已中止生成]", "assistant")).toBe(false);
    expect(isUsableHistoryTurn("⚠️ 生成遇到错误：boom", "assistant")).toBe(false);
    expect(isUsableHistoryTurn("思考生成中…", "assistant")).toBe(false);
  });

  it("still rejects empty content", () => {
    expect(isUsableHistoryTurn("", "assistant")).toBe(false);
    expect(isUsableHistoryTurn("   ", "user")).toBe(false);
  });
});

describe("aiMemory Built-in sliding window engine", () => {
  it("assembles system prompt and dialogue history correctly", () => {
    const history = [
      { role: "user" as const, content: "你好，你是谁？" },
      { role: "assistant" as const, content: "我是 Markelle AI 助手。" },
    ];
    const msgs = assembleBuiltinContext(
      "你是一位笔记专家。",
      history,
      "帮我解释一下量子力学",
      "笔记正文内容",
    );

    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("你是一位笔记专家。");

    // History turns preserved
    expect(msgs[1].content).toBe("你好，你是谁？");
    expect(msgs[2].content).toBe("我是 Markelle AI 助手。");

    // Last turn includes doc context and user prompt
    const lastTurn = msgs[msgs.length - 1];
    expect(lastTurn.role).toBe("user");
    expect(lastTurn.content).toContain("【背景知识库笔记资料】");
    expect(lastTurn.content).toContain("笔记正文内容");
    expect(lastTurn.content).toContain("帮我解释一下量子力学");
  });

  it("skips empty and aborted/error assistant turns from history", () => {
    const history = [
      { role: "user" as const, content: "第一问" },
      { role: "assistant" as const, content: "" },
      { role: "user" as const, content: "第二问" },
      { role: "assistant" as const, content: "正常回复" },
      { role: "user" as const, content: "第三问" },
      { role: "assistant" as const, content: "半截 [已中止生成]" },
    ];
    const msgs = assembleBuiltinContext("sys", history, "新问题");
    const contents = msgs.map((m) => m.content);
    expect(contents).not.toContain("");
    expect(contents.some((c) => c.includes("[已中止生成]"))).toBe(false);
    expect(contents).toContain("正常回复");
    expect(contents[contents.length - 1]).toContain("新问题");
  });

  it("can omit doc attachment when caller already embedded source", () => {
    const msgs = assembleBuiltinContext(
      "sys",
      [],
      "请总结以下内容：\n\n# Doc",
      "整篇笔记不应该再附加",
      6,
      false,
    );
    const last = msgs[msgs.length - 1];
    expect(last.content).toContain("请总结以下内容");
    expect(last.content).not.toContain("【背景知识库笔记资料】");
    expect(last.content).not.toContain("整篇笔记不应该再附加");
  });
});

describe("aiMemory Dual-Engine Dispatcher", () => {
  it("dispatches to builtin engine by default", async () => {
    const res = await prepareConversationContext({
      settings: { ...DEFAULT_SETTINGS, aiEngineMode: "builtin" },
      dialogueHistory: [],
      currentPrompt: "写一首诗",
    });

    expect(res.engineUsed).toBe("builtin");
    expect(res.messages.length).toBeGreaterThanOrEqual(2);
    expect(res.messages[0].role).toBe("system");
    expect(res.messages[1].content).toContain("写一首诗");
  });

  it("handles CogniStack offline fallback gracefully", async () => {
    const res = await prepareConversationContext({
      settings: {
        ...DEFAULT_SETTINGS,
        aiEngineMode: "cognistack",
        cogniStackUrl: "http://127.0.0.1:9999", // dead port
      },
      dialogueHistory: [],
      currentPrompt: "测试离线降级",
    });

    // Should gracefully fallback to builtin engine without throwing
    expect(res.engineUsed).toBe("builtin");
    expect(res.error).toBeDefined();
    expect(res.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("respects attachDocContext=false for quick actions that embed source", async () => {
    const res = await prepareConversationContext({
      settings: { ...DEFAULT_SETTINGS, aiEngineMode: "builtin" },
      dialogueHistory: [],
      currentPrompt: "请总结以下 Markdown：\n\n正文",
      activeDocContent: "不该重复附加的全文",
      attachDocContext: false,
    });
    const last = res.messages[res.messages.length - 1];
    expect(last.content).not.toContain("【背景知识库笔记资料】");
    expect(last.content).not.toContain("不该重复附加的全文");
  });
});

describe("aiMemory CogniStack Session State Management", () => {
  it("initializes empty state when session is clean", () => {
    clearCogniStackSessionState();
    const state = getCogniStackSessionState();
    expect(state.summaryBlocks).toEqual([]);
    expect(state.summarizedCount).toBe(0);
    expect(state.summarizedThroughMessageId).toBeNull();
  });

  it("saves, loads and clears CogniStack session state accurately", () => {
    saveCogniStackSessionState({
      summaryBlocks: [
        {
          id: "b1",
          text: "【硬事实】重要内容\n【时间线】无\n【关系与称呼】无\n【未决】无\n【近期情节】无",
          throughMessageId: "m4",
          pairCount: 2,
          kind: "full",
        },
      ],
      summarizedCount: 2,
      summarizedThroughMessageId: "m4",
    });

    const loaded = getCogniStackSessionState();
    expect(loaded.summarizedCount).toBe(2);
    expect(loaded.summarizedThroughMessageId).toBe("m4");
    expect(loaded.summaryBlocks.length).toBe(1);
    expect(loaded.summaryBlocks[0].text).toContain("重要内容");

    clearCogniStackSessionState();
    const afterClear = getCogniStackSessionState();
    expect(afterClear.summaryBlocks).toEqual([]);
    expect(afterClear.summarizedCount).toBe(0);
    expect(afterClear.summarizedThroughMessageId).toBeNull();
  });
});

