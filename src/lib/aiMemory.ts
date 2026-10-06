/**
 * AI Context & Memory Dual-Engine System.
 * Bridges Built-in sliding-window engine and CogniStack Context & Memory Fusion Engine.
 */

import type { ReaderSettings } from "./types";
import { type ChatMessage, smartSliceMarkdown, ollamaGenerate } from "./ollama";
import { t } from "./i18n";
import {
  cogniStackPrepare,
  type CogniStackDialogueItem,
  type CogniStackPrepareResult,
  type SummaryBlock,
  buildCogniStackSummarizePrompt,
  parseStructuredCogniStackSummary,
  formatCogniStackTranscript,
} from "./cognistack";

/** Structured marker for a stored AI turn that must not be reused as context. */
export type HistoryTurnFlag = "aborted" | "errored";

export interface PrepareContextParams {
  settings: ReaderSettings;
  dialogueHistory: Array<{
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    turn?: HistoryTurnFlag | null;
  }>;
  currentPrompt: string;
  currentPromptId?: string;
  activeDocContent?: string;
  selectedText?: string;
  /** When false, do not re-attach doc/selection (caller already embedded source). Default true. */
  attachDocContext?: boolean;
  signal?: AbortSignal;
}

export interface PreparedContextResult {
  engineUsed: "builtin" | "cognistack";
  messages: ChatMessage[];
  shouldSummarize?: boolean;
  budgetNotice?: string;
  cogniStackResult?: CogniStackPrepareResult;
  warningNotice?: string;
  error?: string;
}

export interface CogniStackSessionState {
  summaryBlocks: SummaryBlock[];
  summarizedCount: number;
  summarizedThroughMessageId: string | null;
}

const COGNI_STATE_KEY = "markelle:cognistack:state";

let memoryStateFallback: CogniStackSessionState = {
  summaryBlocks: [],
  summarizedCount: 0,
  summarizedThroughMessageId: null,
};

export function getCogniStackSessionState(): CogniStackSessionState {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(COGNI_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CogniStackSessionState>;
        return {
          summaryBlocks: Array.isArray(parsed.summaryBlocks) ? parsed.summaryBlocks : [],
          summarizedCount: Number(parsed.summarizedCount) || 0,
          summarizedThroughMessageId: parsed.summarizedThroughMessageId || null,
        };
      }
    }
  } catch {
    // Ignore storage errors
  }
  return { ...memoryStateFallback, summaryBlocks: [...memoryStateFallback.summaryBlocks] };
}

export function saveCogniStackSessionState(state: CogniStackSessionState): void {
  memoryStateFallback = {
    summaryBlocks: [...state.summaryBlocks],
    summarizedCount: state.summarizedCount,
    summarizedThroughMessageId: state.summarizedThroughMessageId,
  };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(COGNI_STATE_KEY, JSON.stringify(state));
    }
  } catch {
    // Ignore storage errors
  }
}

export function clearCogniStackSessionState(): void {
  memoryStateFallback = {
    summaryBlocks: [],
    summarizedCount: 0,
    summarizedThroughMessageId: null,
  };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(COGNI_STATE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

let isSummarizing = false;

/** Drop empty / aborted / error-placeholder turns so they do not poison context. */
export function isUsableHistoryTurn(
  content: string,
  role: string,
  flag?: HistoryTurnFlag | null,
): boolean {
  // Structured marker (set by the UI when a turn aborts or errors) wins and is
  // language-independent — it survives locale changes and placeholder edits.
  if (flag === "aborted" || flag === "errored") return false;
  const text = (content || "").trim();
  if (!text) return false;
  if (role === "assistant") {
    // Backward compatibility: turns persisted before the `turn` flag existed
    // carry only the placeholder text, so fall back to matching it. Locale-
    // dependent by nature; every newly written turn sets the flag above.
    if (/\[已中止生成\]/.test(text)) return false;
    if (/⚠️\s*生成遇到错误/.test(text)) return false;
    if (/^思考生成中/.test(text)) return false;
  }
  return true;
}

/**
 * Executes host-owned background summarization when CogniStack signals shouldSummarize.
 * Synthesizes long-term memory blocks using the local LLM and advances the watermark.
 */
export async function runCogniStackBackgroundSummarize(params: {
  settings: ReaderSettings;
  toSummarize: CogniStackDialogueItem[];
  nextSummarizedThroughMessageId: string | null;
  nextSummarizedCount: number;
  toSummarizePairCount?: number;
  onStatus?: (msg: string) => void;
}): Promise<boolean> {
  const {
    settings,
    toSummarize,
    nextSummarizedThroughMessageId,
    nextSummarizedCount,
    toSummarizePairCount,
    onStatus,
  } = params;
  if (!toSummarize || toSummarize.length === 0) return false;
  if (isSummarizing) return false;

  isSummarizing = true;
  try {
    const currentState = getCogniStackSessionState();
    const priorJoined = currentState.summaryBlocks.map((b) => b.text).join("\n\n");
    const transcript = formatCogniStackTranscript(toSummarize);
    const userPrompt = buildCogniStackSummarizePrompt({
      priorJoined,
      transcript,
      maxCharsHint: 800,
    });

    onStatus?.(t("ailib.summarizing"));

    const llmOut = await ollamaGenerate({
      settings,
      systemPrompt:
        "将对话压缩为简洁中文长期记忆文档。必须严格遵守五段式固定栏目标题，不可输出解释。",
      prompt: userPrompt,
      temperature: 0.2,
      timeoutMs: 120_000,
    });

    const parsedText = parseStructuredCogniStackSummary(llmOut);
    const throughId =
      nextSummarizedThroughMessageId ||
      toSummarize[toSummarize.length - 1]?.id ||
      `m-${Date.now()}`;

    const newBlock: SummaryBlock = {
      id: `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: parsedText,
      throughMessageId: throughId,
      pairCount: toSummarizePairCount || Math.ceil(toSummarize.length / 2),
      kind: "full",
      importance: 80,
      timestamp: Date.now(),
    };

    // CogniStack contract: fused memory replaces prior summary as one living block
    saveCogniStackSessionState({
      summaryBlocks: [newBlock],
      summarizedCount: nextSummarizedCount,
      summarizedThroughMessageId: throughId,
    });

    onStatus?.(t("ailib.memoryUpdated", { watermark: throughId }));
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("CogniStack background summarize skipped:", msg);
    onStatus?.(t("ailib.memorySkipped", { error: msg.slice(0, 120) }));
    return false;
  } finally {
    isSummarizing = false;
  }
}

/**
 * Built-in context assembly with smart sliding window and Markdown integrity protection.
 */
export function assembleBuiltinContext(
  systemPrompt: string,
  history: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    turn?: HistoryTurnFlag | null;
  }>,
  currentPrompt: string,
  docContext?: string,
  maxHistoryTurns = 8,
  attachDoc = true,
  historyCharBudget = 12_000,
): ChatMessage[] {
  const result: ChatMessage[] = [];

  const cleanSystem =
    systemPrompt.trim() ||
    "你是一位专业高效的个人知识库助手，请直接输出精炼、准确的 Markdown 格式结果。";
  result.push({ role: "system", content: cleanSystem });

  const usable = history.filter(
    (m) => m.role !== "system" && isUsableHistoryTurn(m.content, m.role, m.turn),
  );
  const recent = usable.slice(-maxHistoryTurns);

  // Soft char budget: drop oldest history turns first
  let budget = historyCharBudget;
  const kept: typeof recent = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i]!;
    const slice = smartSliceMarkdown(item.content, Math.min(3000, budget));
    if (slice.length > budget && kept.length > 0) break;
    kept.unshift({ ...item, content: slice });
    budget -= slice.length;
    if (budget <= 0) break;
  }

  for (const item of kept) {
    result.push({
      role: item.role,
      content: item.content,
    });
  }

  let combinedUserText = currentPrompt.trim();
  if (attachDoc && docContext && docContext.trim()) {
    const safeDoc = smartSliceMarkdown(docContext.trim(), 6000);
    combinedUserText = `【背景知识库笔记资料】：\n\`\`\`markdown\n${safeDoc}\n\`\`\`\n\n【用户指令与问题】：\n${combinedUserText}`;
  }

  result.push({
    role: "user",
    content: combinedUserText,
  });

  return result;
}

/**
 * Unified Context Dispatcher: Dispatches to CogniStack if selected, or Built-in engine.
 */
export async function prepareConversationContext(
  params: PrepareContextParams,
): Promise<PreparedContextResult> {
  const {
    settings,
    dialogueHistory,
    currentPrompt,
    activeDocContent,
    selectedText,
    signal,
  } = params;
  const attachDoc = params.attachDocContext !== false;

  const docContext = attachDoc
    ? selectedText?.trim() || activeDocContent?.trim() || ""
    : "";

  if (settings.aiEngineMode === "cognistack") {
    let msgCounter = 1;
    const rawDialogue: CogniStackDialogueItem[] = [
      ...dialogueHistory
        .filter((m) => m.role !== "system" && isUsableHistoryTurn(m.content, m.role, m.turn))
        .map((m) => ({
          id: m.id || `m${msgCounter++}`,
          role: m.role,
          content: m.content,
        })),
      {
        id: params.currentPromptId || `m${msgCounter++}`,
        role: "user" as const,
        content:
          attachDoc && docContext
            ? `【背景知识库笔记资料】：\n\`\`\`markdown\n${smartSliceMarkdown(docContext, 6000)}\n\`\`\`\n\n【用户指令】：\n${currentPrompt}`
            : currentPrompt,
      },
    ];

    try {
      const memoryState = getCogniStackSessionState();
      const cogniRes = await cogniStackPrepare({
        url: settings.cogniStackUrl,
        apiKey: settings.cogniStackApiKey,
        allowLan: settings.ollamaAllowLan,
        dialogue: rawDialogue,
        summaryBlocks: memoryState.summaryBlocks,
        summarizedCount: memoryState.summarizedCount,
        summarizedThroughMessageId: memoryState.summarizedThroughMessageId,
        pairBatchSize: 2,
        systemRules: settings.aiSystemPrompt,
        contextTokenLimit: settings.cogniStackTokenLimit || 8192,
        completionReserveTokens: 1024,
        charsPerToken: settings.cogniStackCharsPerToken || 2,
        signal,
      });

      if (cogniRes.ok && cogniRes.messages.length > 0) {
        const warningNotice =
          cogniRes.emergencyDroppedCount && cogniRes.emergencyDroppedCount > 0
            ? t("ailib.emergencyDropped", { count: cogniRes.emergencyDroppedCount })
            : undefined;

        return {
          engineUsed: "cognistack",
          messages: cogniRes.messages,
          shouldSummarize: cogniRes.shouldSummarize,
          cogniStackResult: cogniRes,
          warningNotice,
          budgetNotice: cogniRes.budget ? t("ailib.budgetReady") : undefined,
        };
      }

      const fallbackMsgs = assembleBuiltinContext(
        settings.aiSystemPrompt,
        dialogueHistory,
        currentPrompt,
        docContext,
        8,
        attachDoc,
      );
      return {
        engineUsed: "builtin",
        messages: fallbackMsgs,
        error: t("ailib.fallbackError", {
          error: cogniRes.error || t("ailib.noResponse"),
        }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackMsgs = assembleBuiltinContext(
        settings.aiSystemPrompt,
        dialogueHistory,
        currentPrompt,
        docContext,
        8,
        attachDoc,
      );
      return {
        engineUsed: "builtin",
        messages: fallbackMsgs,
        error: t("ailib.gatewayError", { error: msg }),
      };
    }
  }

  const builtinMsgs = assembleBuiltinContext(
    settings.aiSystemPrompt,
    dialogueHistory,
    currentPrompt,
    docContext,
    8,
    attachDoc,
  );

  return {
    engineUsed: "builtin",
    messages: builtinMsgs,
  };
}
