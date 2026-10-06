import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { ReaderSettings } from "../lib/types";
import {
  continuePrompt,
  extractTagsPrompt,
  isAbortError,
  ollamaCheckConnection,
  ollamaGenerate,
  polishPrompt,
  proofreadPrompt,
  stripModelOutputFences,
  summarizePrompt,
  translatePrompt,
} from "../lib/ollama";
import {
  prepareConversationContext,
  runCogniStackBackgroundSummarize,
  getCogniStackSessionState,
  clearCogniStackSessionState,
} from "../lib/aiMemory";
import { cogniStackCheckHealth } from "../lib/cognistack";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";
import { renderMarkdown } from "../lib/markdown";

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** Raw prompt used for generation (for retry); display may differ for quick actions */
  prompt?: string;
  /** When true, document context was already embedded in prompt */
  embedSource?: boolean;
  /**
   * Structured marker for a turn that must not be reused as context.
   * Language-independent — see isUsableHistoryTurn in lib/aiMemory.
   */
  turn?: "aborted" | "errored";
}

/**
 * Upper bound on the chat list — used for BOTH the persisted slice and the
 * in-memory array, so the list (and its per-chunk markdown re-render) cannot
 * grow without limit over a long session.
 */
const MAX_CHAT_MESSAGES = 40;

interface Props {
  settings: ReaderSettings;
  activePath: string | null;
  activeContent: string;
  selectedText?: string;
  /** Live selection from editor — preferred over stale selectedText prop */
  getSelectedText?: () => string;
  onInsertText?: (text: string) => void;
  onReplaceContent?: (text: string) => void;
  onReplaceSelection?: (text: string) => void;
  onAppendText?: (text: string) => void;
  onCreateNote?: (title: string, content: string) => void;
  onOpenSettings?: () => void;
  onStatus?: (status: string) => void;
}

/* --------------------------------------------------------------------------
   Precision Modern Vector SVG Icons (No crude emojis)
   -------------------------------------------------------------------------- */

function IconSparkles({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" />
      <path d="M19 3v4" />
      <path d="M21 5h-4" />
    </svg>
  );
}

function IconSummarize({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="21" x2="3" y1="6" y2="6" />
      <line x1="15" x2="3" y1="12" y2="12" />
      <line x1="17" x2="3" y1="18" y2="18" />
    </svg>
  );
}

function IconPolish({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 4-2 4-4 2 4 2 2 4 2-4 4-2-4-2z" />
      <path d="M4 14l3-3 2 2-3 3z" />
      <path d="M2 22l6-6" />
    </svg>
  );
}

function IconContinue({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function IconProofread({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function IconTranslate({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  );
}

function IconTags({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z" />
      <path d="M7 7h.01" />
    </svg>
  );
}

function IconCopy({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function IconInsert({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

function IconReplaceDoc({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 21h5v-5" />
    </svg>
  );
}

function IconNewNote({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function IconTrash({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function IconSettings({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconCheck({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/* --------------------------------------------------------------------------
   Memoized markdown body
   --------------------------------------------------------------------------
   Streaming appends a chunk to ONE message, but the list re-renders in full on
   every chunk. Rendering markdown-it + highlight.js for every historical
   message on each chunk is O(n²) over the session. Memoising on `content` means
   only the message that actually changed re-parses.
   -------------------------------------------------------------------------- */
const MemoizedMarkdown = memo(function MemoizedMarkdown({ content }: { content: string }) {
  return (
    <div
      className="ai-markdown-rendered markdown-body"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content).html }}
    />
  );
});

/* --------------------------------------------------------------------------
   AiAssistantPanel Component
   -------------------------------------------------------------------------- */

function AiAssistantPanelInner({
  settings,
  activePath,
  activeContent,
  selectedText = "",
  getSelectedText,
  onInsertText,
  onReplaceContent,
  onReplaceSelection,
  onAppendText,
  onCreateNote,
  onOpenSettings,
  onStatus,
}: Props) {
  useLocale();
  const STORAGE_KEY = "markelle:ai-chat-messages";
  const [messages, setMessages] = useState<AiChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return (JSON.parse(saved) as AiChatMessage[]).slice(-MAX_CHAT_MESSAGES);
    } catch {
      // Ignore
    }
    return [];
  });
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [includeDoc, setIncludeDoc] = useState(true);
  const [liveSelectionLen, setLiveSelectionLen] = useState(0);

  // Micro-feedback states for action buttons
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [insertedId, setInsertedId] = useState<string | null>(null);
  const [replacedWholeId, setReplacedWholeId] = useState<string | null>(null);
  const [replacedSelId, setReplacedSelId] = useState<string | null>(null);
  const [createdNoteId, setCreatedNoteId] = useState<string | null>(null);
  const [savedAllNote, setSavedAllNote] = useState(false);

  const [serverStatus, setServerStatus] = useState<{
    tested: boolean;
    ok: boolean;
    provider?: string;
  }>({ tested: false, ok: false });

  const [cogniStatus, setCogniStatus] = useState<{
    tested: boolean;
    ok: boolean;
  }>({ tested: false, ok: false });

  const [cogniMemoryCount, setCogniMemoryCount] = useState<number>(
    () => getCogniStackSessionState().summaryBlocks.length,
  );
  const [showMemoryModal, setShowMemoryModal] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const feedbackTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const memoryModalRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Focus trap + Escape dismissal for the memory inspector dialog.
  useModalFocusTrap({
    active: showMemoryModal,
    containerRef: memoryModalRef,
    onEscape: () => setShowMemoryModal(false),
    initialFocusSelector: ".ai-memory-modal-footer .btn.primary",
  });

  /** Schedule a micro-feedback reset, tracking the handle so unmount can clear it. */
  const scheduleFeedbackReset = useCallback((reset: () => void, ms: number) => {
    const id = setTimeout(() => {
      feedbackTimersRef.current.delete(id);
      reset();
    }, ms);
    feedbackTimersRef.current.add(id);
  }, []);

  const resolveSelection = useCallback(() => {
    const live = getSelectedText?.()?.trim() || "";
    if (live) return live;
    return selectedText.trim();
  }, [getSelectedText, selectedText]);

  // Auto-scroll on new messages or during generation
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, generating]);

  // Persist messages to localStorage
  useEffect(() => {
    try {
      if (messages.length === 0) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_CHAT_MESSAGES)));
      }
    } catch {
      // Ignore storage errors
    }
  }, [messages]);

  // Track the live editor selection so the context bar stays accurate.
  // A `selectionchange` listener replaces the old 600 ms poll: it fires exactly
  // when the selection moves (editor or read-mode) with no idle wakeups.
  useEffect(() => {
    const tick = () => {
      const len = resolveSelection().length;
      setLiveSelectionLen((prev) => (prev === len ? prev : len));
    };
    tick();
    document.addEventListener("selectionchange", tick);
    window.addEventListener("focus", tick);
    return () => {
      document.removeEventListener("selectionchange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [resolveSelection]);

  // Escape stops generation
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        setGenerating(false);
        onStatus?.(t("ai.stop"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStatus]);

  // Dock renders only the active panel, so switching panels unmounts this
  // component mid-stream. Abort the in-flight fetch (stops the stream and the
  // wasted tokens) and drop every pending feedback timer so nothing schedules
  // state writes after unmount.
  useEffect(() => {
    const timers = feedbackTimersRef.current;
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    };
  }, []);

  // Initial connection check if enabled
  useEffect(() => {
    let active = true;
    if (settings.ollamaEnabled && settings.ollamaBaseUrl) {
      void ollamaCheckConnection(
        settings.ollamaBaseUrl,
        settings.ollamaApiKey,
        settings.ollamaAllowLan,
      ).then((res) => {
        if (active) {
          setServerStatus({ tested: true, ok: res.ok, provider: res.provider });
        }
      });
    }
    if (settings.aiEngineMode === "cognistack" && settings.cogniStackUrl) {
      void cogniStackCheckHealth(
        settings.cogniStackUrl,
        settings.cogniStackApiKey,
        settings.ollamaAllowLan,
      ).then((res) => {
        if (active) {
          setCogniStatus({ tested: true, ok: res.ok });
        }
      });
    }
    return () => {
      active = false;
    };
  }, [
    settings.ollamaEnabled,
    settings.ollamaBaseUrl,
    settings.ollamaApiKey,
    settings.ollamaAllowLan,
    settings.aiEngineMode,
    settings.cogniStackUrl,
    settings.cogniStackApiKey,
  ]);

  const activeDocName = activePath ? activePath.replace(/\\/g, "/").split("/").pop() : null;

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setGenerating(false);
  }, []);

  const getEffectiveContext = useCallback(() => {
    const sel = resolveSelection();
    if (sel) return sel.slice(0, 12_000);
    if (includeDoc && activeContent.trim()) {
      return activeContent.slice(0, 12_000);
    }
    return "";
  }, [resolveSelection, includeDoc, activeContent]);

  const cleanOutput = useCallback((text: string) => stripModelOutputFences(text), []);

  const runPrompt = useCallback(
    async (
      userPrompt: string,
      displayLabel?: string,
      opts?: { embedSource?: boolean; historyOverride?: AiChatMessage[] },
    ) => {
      if (!settings.ollamaEnabled) {
        onStatus?.(t("ai.unconfiguredHelp"));
        onOpenSettings?.();
        return;
      }
      if (generating) return;

      const embedSource = Boolean(opts?.embedSource);
      const historyBase = opts?.historyOverride ?? messagesRef.current;
      const userMsgId = `u-${Date.now()}`;
      const assistantMsgId = `a-${Date.now() + 1}`;
      const userDisplay = displayLabel || userPrompt;
      const sel = resolveSelection();

      const nextMessages: AiChatMessage[] = [
        ...historyBase,
        {
          id: userMsgId,
          role: "user",
          content: userDisplay,
          timestamp: Date.now(),
          prompt: userPrompt,
          embedSource,
        },
      ];

      const assistantMessage: AiChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages([...nextMessages, assistantMessage].slice(-MAX_CHAT_MESSAGES));

      setGenerating(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const prep = await prepareConversationContext({
          settings,
          dialogueHistory: historyBase.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            turn: m.turn,
          })),
          currentPrompt: userPrompt,
          currentPromptId: userMsgId,
          activeDocContent: !embedSource && includeDoc ? activeContent : undefined,
          selectedText: !embedSource && sel ? sel : undefined,
          attachDocContext: !embedSource,
          signal: controller.signal,
        });

        if (prep.warningNotice) onStatus?.(prep.warningNotice);
        if (prep.error) onStatus?.(prep.error);

        let full = "";
        await ollamaGenerate({
          settings,
          messages: prep.messages,
          signal: controller.signal,
          onChunk: (chunk: string) => {
            full += chunk;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsgId ? { ...m, content: full } : m)),
            );
          },
        });

        const cleaned = cleanOutput(full);
        if (cleaned !== full) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? { ...m, content: cleaned } : m)),
          );
        }
        setServerStatus((prev) => ({ ...prev, ok: true }));

        if (
          prep.engineUsed === "cognistack" &&
          prep.cogniStackResult?.shouldSummarize &&
          prep.cogniStackResult.toSummarize &&
          prep.cogniStackResult.toSummarize.length > 0
        ) {
          void runCogniStackBackgroundSummarize({
            settings,
            toSummarize: prep.cogniStackResult.toSummarize,
            nextSummarizedThroughMessageId:
              prep.cogniStackResult.nextSummarizedThroughMessageId || null,
            nextSummarizedCount: prep.cogniStackResult.nextSummarizedCount || 0,
            toSummarizePairCount: prep.cogniStackResult.toSummarizePairCount,
            onStatus: (msg) => {
              onStatus?.(msg);
              setCogniMemoryCount(getCogniStackSessionState().summaryBlocks.length);
            },
          });
        }
      } catch (err: unknown) {
        if (controller.signal.aborted || isAbortError(err)) {
          setMessages((prev) =>
            prev
              .map((m) => {
                if (m.id !== assistantMsgId) return m;
                const body = m.content.trim();
                if (!body) return null;
                return { ...m, content: `${body} ${t("ai.abortedSuffix")}`, turn: "aborted" };
              })
              .filter((m): m is AiChatMessage => m != null),
          );
        } else {
          const errMsg = err instanceof Error ? err.message : String(err);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: `${m.content ? `${m.content}\n\n` : ""}⚠️ ${t("ai.error", { error: errMsg })}`,
                    turn: "errored",
                  }
                : m,
            ),
          );
          setServerStatus((prev) => ({ ...prev, ok: false }));
        }
      } finally {
        setGenerating(false);
        abortControllerRef.current = null;
      }
    },
    [
      settings,
      generating,
      includeDoc,
      activeContent,
      resolveSelection,
      cleanOutput,
      onStatus,
      onOpenSettings,
    ],
  );

  const handleQuickAction = useCallback(
    (action: "summarize" | "polish" | "continue" | "proofread" | "translate" | "tags") => {
      const target = getEffectiveContext();
      if (!target.trim()) {
        onStatus?.(t("ai.noContext"));
        return;
      }
      const opts = { embedSource: true as const };
      const n = target.length;
      switch (action) {
        case "summarize":
          void runPrompt(summarizePrompt(target), t("ai.quickSummarize", { n }), opts);
          break;
        case "polish":
          void runPrompt(polishPrompt(target), t("ai.quickPolish", { n }), opts);
          break;
        case "continue":
          void runPrompt(continuePrompt(target), t("ai.quickContinue", { n }), opts);
          break;
        case "proofread":
          void runPrompt(proofreadPrompt(target), t("ai.quickProofread", { n }), opts);
          break;
        case "translate":
          void runPrompt(translatePrompt(target), t("ai.quickTranslate", { n }), opts);
          break;
        case "tags":
          void runPrompt(extractTagsPrompt(target), t("ai.quickTags", { n }), opts);
          break;
      }
    },
    [getEffectiveContext, runPrompt, onStatus],
  );

  const handleRetry = useCallback(
    (assistantId: string) => {
      if (generating) return;
      const list = messagesRef.current;
      const idx = list.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      let userIdx = idx - 1;
      while (userIdx >= 0 && list[userIdx]?.role !== "user") userIdx--;
      const userMsg = userIdx >= 0 ? list[userIdx] : null;
      if (!userMsg) return;
      const prompt = userMsg.prompt || userMsg.content;
      const historyOverride = list.slice(0, userIdx);
      void runPrompt(prompt, userMsg.content, {
        embedSource: userMsg.embedSource,
        historyOverride,
      });
    },
    [generating, runPrompt],
  );

  const handleSendMessage = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || generating) return;

    setInput("");
    void runPrompt(trimmed, trimmed, { embedSource: false });
  }, [input, generating, runPrompt]);

  const handleClearChat = useCallback(() => {
    setMessages([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
    clearCogniStackSessionState();
    setCogniMemoryCount(0);
    onStatus?.(t("ai.clearedMemory"));
  }, [STORAGE_KEY, onStatus]);

  const handleSaveWholeChat = useCallback(() => {
    if (!onCreateNote || messages.length === 0) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toTimeString().slice(0, 5).replace(":", "");
    const title = `AI-${dateStr}-${timeStr}`;
    let mdContent = `# ${title}\n\n- ${new Date().toLocaleString()}\n- ${settings.aiEngineMode === "cognistack" ? "CogniStack" : "Markelle"}\n- ${settings.ollamaModel || t("ai.modelDefault")}\n\n---\n\n`;

    for (const msg of messages) {
      if (msg.role === "user") {
        mdContent += `### User\n\n${msg.content}\n\n`;
      } else if (msg.role === "assistant") {
        mdContent += `### Assistant\n\n${msg.content}\n\n---\n\n`;
      }
    }

    onCreateNote(title, mdContent);
    setSavedAllNote(true);
    onStatus?.(t("ai.chatSaved"));
    scheduleFeedbackReset(() => setSavedAllNote(false), 2000);
  }, [onCreateNote, messages, settings.aiEngineMode, settings.ollamaModel, onStatus, scheduleFeedbackReset]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleCopy = (id: string, text: string) => {
    void navigator.clipboard.writeText(cleanOutput(text));
    setCopiedId(id);
    onStatus?.(t("ai.copied"));
    scheduleFeedbackReset(() => setCopiedId(null), 1800);
  };

  const handleInsert = (id: string, text: string) => {
    if (!onInsertText) return;
    onInsertText(cleanOutput(text));
    setInsertedId(id);
    onStatus?.(t("ai.inserted"));
    scheduleFeedbackReset(() => setInsertedId(null), 1800);
  };

  const handleAppend = (id: string, text: string) => {
    if (!onAppendText) return;
    onAppendText(cleanOutput(text));
    setInsertedId(id);
    onStatus?.(t("ai.appended"));
    scheduleFeedbackReset(() => setInsertedId(null), 1800);
  };

  const handleReplaceWhole = (id: string, text: string) => {
    if (!onReplaceContent) return;
    onReplaceContent(cleanOutput(text));
    setReplacedWholeId(id);
    onStatus?.(t("ai.replacedWhole"));
    scheduleFeedbackReset(() => setReplacedWholeId(null), 1800);
  };

  const handleReplaceSelection = (id: string, text: string) => {
    if (!onReplaceSelection) return;
    onReplaceSelection(cleanOutput(text));
    setReplacedSelId(id);
    onStatus?.(t("ai.replacedSelection"));
    scheduleFeedbackReset(() => setReplacedSelId(null), 1800);
  };

  const handleCreateNote = (id: string, text: string) => {
    if (!onCreateNote) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const stem = activeDocName ? activeDocName.replace(/\.md$/i, "") : "AI";
    const title = `${stem}-AI-${dateStr}`;
    onCreateNote(title, cleanOutput(text));
    setCreatedNoteId(id);
    onStatus?.(t("ai.created"));
    scheduleFeedbackReset(() => setCreatedNoteId(null), 1800);
  };

  const hasLiveSelection = liveSelectionLen > 0;

  return (
    <div className="ai-panel">
      {/* Top Header / Server Status */}
      <div className="ai-panel-header">
        <div className="ai-panel-status">
          {settings.ollamaEnabled ? (
            <>
              <span
                className={clsx(
                  "ai-status-pill",
                  serverStatus.ok ? "is-online" : "is-offline",
                )}
                title={
                  serverStatus.ok
                    ? t("ai.serverOk", {
                        provider: serverStatus.provider || t("ai.localProvider"),
                        model: settings.ollamaModel || t("ai.modelDefault"),
                      })
                    : t("ai.serverDown")
                }
              >
                <span className="ai-status-dot" />
                <span className="ai-status-name">
                  {serverStatus.provider || t("ai.localProvider")}
                </span>
                <span className="ai-status-model">
                  {settings.ollamaModel ? `(${settings.ollamaModel})` : ""}
                </span>
              </span>
              <span
                className={clsx(
                  "ai-status-pill",
                  settings.aiEngineMode === "cognistack"
                    ? cogniStatus.ok
                      ? "is-online"
                      : "is-offline"
                    : "is-online",
                )}
                style={{ marginLeft: 6, fontSize: "11px", opacity: 0.9 }}
                title={
                  settings.aiEngineMode === "cognistack"
                    ? cogniStatus.ok
                      ? t("ai.cogniOnline", { url: settings.cogniStackUrl })
                      : t("ai.cogniOffline", { url: settings.cogniStackUrl })
                    : t("ai.builtinMemory")
                }
              >
                <span className="ai-status-dot" />
                <span>
                  {settings.aiEngineMode === "cognistack"
                    ? "CogniStack"
                    : t("ai.memoryShort")}
                </span>
              </span>
              {settings.aiEngineMode === "cognistack" && (
                <button
                  type="button"
                  className={clsx("ai-status-pill", cogniMemoryCount > 0 ? "is-online" : "")}
                  onClick={() => setShowMemoryModal(true)}
                  style={{
                    marginLeft: 4,
                    fontSize: "10.5px",
                    cursor: "pointer",
                    background:
                      cogniMemoryCount > 0
                        ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                        : "rgba(120, 120, 120, 0.08)",
                    color: cogniMemoryCount > 0 ? "var(--accent-text)" : "var(--ink-soft)",
                    borderColor:
                      cogniMemoryCount > 0
                        ? "color-mix(in srgb, var(--accent) 35%, transparent)"
                        : "var(--line)",
                  }}
                  title={t("ai.cogniOpenTitle")}
                >
                  <span>{t("ai.memoryBlocks", { n: cogniMemoryCount })}</span>
                </button>
              )}
            </>
          ) : (
            <span className="ai-status-pill is-disabled">
              <span className="ai-status-dot" />
              <span>{t("ai.disabled")}</span>
            </span>
          )}
        </div>
        <div className="ai-panel-header-actions">
          {messages.length > 0 && onCreateNote && (
            <button
              type="button"
              className="ai-icon-btn"
              onClick={handleSaveWholeChat}
              title={savedAllNote ? t("ai.savedNote") : t("ai.saveChat")}
              aria-label={t("ai.saveChatAria")}
              style={{ color: savedAllNote ? "var(--accent-text)" : undefined }}
            >
              {savedAllNote ? <IconCheck size={14} /> : <IconNewNote size={14} />}
            </button>
          )}
          {messages.length > 0 && (
            <button
              type="button"
              className="ai-icon-btn"
              onClick={handleClearChat}
              title={t("ai.clearChat")}
              aria-label={t("ai.clearChat")}
            >
              <IconTrash size={14} />
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              className="ai-icon-btn"
              onClick={onOpenSettings}
              title={t("ai.settingsTitle")}
              aria-label={t("ai.settingsAria")}
            >
              <IconSettings size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Unconfigured Alert Banner */}
      {!settings.ollamaEnabled && (
        <div className="ai-unconfigured-banner">
          <p className="ai-banner-title">{t("ai.unconfigured")}</p>
          <p className="ai-banner-desc">{t("ai.unconfiguredHelp")}</p>
          {onOpenSettings && (
            <button
              type="button"
              className="btn primary small"
              onClick={onOpenSettings}
            >
              {t("ai.openSettings")}
            </button>
          )}
        </div>
      )}

      {/* Context info pill */}
      {settings.ollamaEnabled && (
        <div className="ai-context-bar">
          <label className="ai-context-toggle" title={t("ai.includeDocTitle")}>
            <input
              type="checkbox"
              checked={includeDoc}
              onChange={(e) => setIncludeDoc(e.target.checked)}
            />
            <span>
              {hasLiveSelection
                ? t("ai.citeSelection", { n: liveSelectionLen })
                : activeDocName
                ? t("ai.linkDoc", { name: activeDocName })
                : t("ai.includeDoc")}
            </span>
          </label>
        </div>
      )}

      {/* Quick Action Prompt Chips (with precision vector SVG icons) */}
      {settings.ollamaEnabled && (
        <div className="ai-quick-actions">
          <button
            type="button"
            className="ai-chip-btn"
            disabled={generating}
            onClick={() => handleQuickAction("summarize")}
            title={t("ai.quickSummarize", { n: "" })}
          >
            <IconSummarize />
            <span>{t("ai.actionSummarize")}</span>
          </button>
          <button
            type="button"
            className="ai-chip-btn"
            disabled={generating}
            onClick={() => handleQuickAction("polish")}
            title={t("ai.actionPolish")}
          >
            <IconPolish />
            <span>{t("ai.actionPolish")}</span>
          </button>
          <button
            type="button"
            className="ai-chip-btn"
            disabled={generating}
            onClick={() => handleQuickAction("continue")}
            title={t("ai.actionContinue")}
          >
            <IconContinue />
            <span>{t("ai.actionContinue")}</span>
          </button>
          <button
            type="button"
            className="ai-chip-btn"
            disabled={generating}
            onClick={() => handleQuickAction("proofread")}
            title={t("ai.actionProofread")}
          >
            <IconProofread />
            <span>{t("ai.actionProofread")}</span>
          </button>
          <button
            type="button"
            className="ai-chip-btn"
            disabled={generating}
            onClick={() => handleQuickAction("translate")}
            title={t("ai.actionTranslate")}
          >
            <IconTranslate />
            <span>{t("ai.actionTranslate")}</span>
          </button>
          <button
            type="button"
            className="ai-chip-btn"
            disabled={generating}
            onClick={() => handleQuickAction("tags")}
            title={t("ai.actionTags")}
          >
            <IconTags />
            <span>{t("ai.actionTags")}</span>
          </button>
        </div>
      )}

      {/* Chat Messages Stream */}
      <div className="ai-chat-body" ref={chatScrollRef}>
        {messages.length === 0 ? (
          <div className="ai-chat-placeholder">
            <div className="ai-placeholder-sparkle">
              <IconSparkles size={28} />
            </div>
            <h4>{t("ai.heroTitle")}</h4>
            <p>{t("ai.heroBody")}</p>
            <p className="ai-placeholder-hint">{t("ai.heroHint")}</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={clsx(
                "ai-chat-message",
                msg.role === "user" ? "is-user" : "is-assistant",
              )}
            >
              <div className="ai-message-header">
                <span className="ai-message-role">
                  {msg.role === "user"
                    ? t("ai.you")
                    : serverStatus.provider || t("ai.assistantName")}
                </span>
              </div>
              <div className="ai-message-content">
                {msg.role === "assistant" ? (
                  <MemoizedMarkdown
                    content={msg.content || (generating ? t("ai.thinking") : "")}
                  />
                ) : (
                  <div className="ai-text-user">{msg.content}</div>
                )}
              </div>

              {/* Action buttons on Assistant reply */}
              {msg.role === "assistant" && msg.content && (
                <div className="ai-message-actions">
                  {onReplaceContent && (
                    <button
                      type="button"
                      className="ai-msg-action-btn is-action-replace"
                      onClick={() => handleReplaceWhole(msg.id, msg.content)}
                      title={t("ai.replaceDoc")}
                    >
                      {replacedWholeId === msg.id ? (
                        <>
                          <IconCheck />
                          <span>{t("ai.replacedDoc")}</span>
                        </>
                      ) : (
                        <>
                          <IconReplaceDoc />
                          <span>{t("ai.replaceDocBtn")}</span>
                        </>
                      )}
                    </button>
                  )}

                  {onReplaceSelection && hasLiveSelection && (
                    <button
                      type="button"
                      className="ai-msg-action-btn"
                      onClick={() => handleReplaceSelection(msg.id, msg.content)}
                      title={t("ai.replaceSel")}
                    >
                      {replacedSelId === msg.id ? (
                        <>
                          <IconCheck />
                          <span>{t("ai.replacedSel")}</span>
                        </>
                      ) : (
                        <>
                          <IconReplaceDoc />
                          <span>{t("ai.replaceSelBtn")}</span>
                        </>
                      )}
                    </button>
                  )}

                  {onInsertText && (
                    <button
                      type="button"
                      className="ai-msg-action-btn"
                      onClick={() => handleInsert(msg.id, msg.content)}
                      title={t("ai.insertCursor")}
                    >
                      {insertedId === msg.id ? (
                        <>
                          <IconCheck />
                          <span>{t("ai.inserted")}</span>
                        </>
                      ) : (
                        <>
                          <IconInsert />
                          <span>{t("ai.insertCursorBtn")}</span>
                        </>
                      )}
                    </button>
                  )}

                  {onAppendText && (
                    <button
                      type="button"
                      className="ai-msg-action-btn"
                      onClick={() => handleAppend(msg.id, msg.content)}
                      title={t("ai.appendEnd")}
                    >
                      <IconContinue />
                      <span>{t("ai.appendEndBtn")}</span>
                    </button>
                  )}

                  {onCreateNote && (
                    <button
                      type="button"
                      className="ai-msg-action-btn"
                      onClick={() => handleCreateNote(msg.id, msg.content)}
                      title={t("ai.saveAsNote")}
                    >
                      {createdNoteId === msg.id ? (
                        <>
                          <IconCheck />
                          <span>{t("ai.savedAsNote")}</span>
                        </>
                      ) : (
                        <>
                          <IconNewNote />
                          <span>{t("ai.saveAsNoteBtn")}</span>
                        </>
                      )}
                    </button>
                  )}

                  <button
                    type="button"
                    className="ai-msg-action-btn"
                    onClick={() => handleRetry(msg.id)}
                    disabled={generating}
                    title={t("ai.retry")}
                  >
                    <IconSparkles size={12} />
                    <span>{t("ai.retryBtn")}</span>
                  </button>

                  <button
                    type="button"
                    className="ai-msg-action-btn"
                    onClick={() => handleCopy(msg.id, msg.content)}
                    title={t("ai.copy")}
                  >
                    {copiedId === msg.id ? (
                      <>
                        <IconCheck />
                        <span>{t("ai.copied")}</span>
                      </>
                    ) : (
                      <>
                        <IconCopy />
                        <span>{t("ai.copy")}</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Input area */}
      <div className="ai-input-box">
        <textarea
          ref={textareaRef}
          className="ai-input-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("ai.inputPlaceholder")}
          rows={2}
          disabled={!settings.ollamaEnabled || generating}
        />
        <div className="ai-input-footer">
          {generating ? (
            <button
              type="button"
              className="btn secondary small ai-stop-btn"
              onClick={handleStop}
            >
              ■ {t("ai.stop")}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary small ai-send-btn"
              disabled={!input.trim() || !settings.ollamaEnabled}
              onClick={handleSendMessage}
            >
              {t("ai.send")} ↵
            </button>
          )}
        </div>
      </div>

      {/* CogniStack Memory Inspector Modal */}
      {showMemoryModal && (
        <div className="ai-memory-modal-overlay" onClick={() => setShowMemoryModal(false)}>
          <div
            ref={memoryModalRef}
            className="ai-memory-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-memory-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ai-memory-modal-head">
              <div className="ai-memory-modal-title" id="ai-memory-modal-title">
                {t("ai.memoryModalTitle")}
              </div>
              <button
                type="button"
                className="ai-icon-btn"
                onClick={() => setShowMemoryModal(false)}
                title={t("ai.close")}
                aria-label={t("ai.close")}
              >
                ✕
              </button>
            </div>

            <div className="ai-memory-modal-stats">
              <div className="ai-memory-stat-card">
                <span className="ai-memory-stat-label">{t("ai.memoryStatBlocks")}</span>
                <span className="ai-memory-stat-value">{cogniMemoryCount}</span>
              </div>
              <div className="ai-memory-stat-card">
                <span className="ai-memory-stat-label">{t("ai.memoryStatRounds")}</span>
                <span className="ai-memory-stat-value">
                  {getCogniStackSessionState().summarizedCount}
                </span>
              </div>
              <div className="ai-memory-stat-card">
                <span className="ai-memory-stat-label">{t("ai.memoryStatWaterline")}</span>
                <span className="ai-memory-stat-value ai-memory-stat-mono">
                  {getCogniStackSessionState().summarizedThroughMessageId ||
                    t("ai.memoryWaterlineInit")}
                </span>
              </div>
            </div>

            <div className="ai-memory-modal-body">
              <div className="ai-memory-blocks-head">
                <span>{t("ai.memoryBlocksHeading")}</span>
              </div>
              {getCogniStackSessionState().summaryBlocks.length === 0 ? (
                <div className="ai-memory-empty">
                  <p>{t("ai.memoryEmpty")}</p>
                  <p className="ai-memory-empty-tip">{t("ai.memoryEmptyHint")}</p>
                </div>
              ) : (
                <div className="ai-memory-blocks-list">
                  {getCogniStackSessionState().summaryBlocks.map((blk, idx) => (
                    <div key={blk.id || idx} className="ai-memory-block-card">
                      <div className="ai-memory-block-meta">
                        <span>
                          {t("ai.memoryBlockLabel", { n: idx + 1 })}
                          {blk.kind ? ` (${blk.kind})` : ""}
                        </span>
                        <span>
                          {t("ai.memoryThrough", {
                            id: blk.throughMessageId || t("ai.memoryLatest"),
                          })}
                        </span>
                      </div>
                      <pre className="ai-memory-block-text">{blk.text}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="ai-memory-modal-footer">
              <button
                type="button"
                className="btn secondary small"
                onClick={() => {
                  clearCogniStackSessionState();
                  setCogniMemoryCount(0);
                  onStatus?.(t("ai.memoryResetDone"));
                }}
              >
                {t("ai.memoryReset")}
              </button>
              <button
                type="button"
                className="btn primary small"
                onClick={() => setShowMemoryModal(false)}
              >
                {t("ai.memoryDone")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const AiAssistantPanel = memo(AiAssistantPanelInner);
