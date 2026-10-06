/**
 * Local & LAN AI Engine Client (supports llama.cpp, LM Studio, Ollama, vLLM).
 * Provides true SSE/NDJSON streaming, multi-turn conversation, smart context slicing, and LAN support.
 */

import type { ReaderSettings } from "./types";
import { t } from "./i18n";

/**
 * Marker for errors raised after every endpoint attempt has been exhausted.
 * Callers rethrow these unchanged instead of wrapping them in the generic
 * "unreachable" message. Uses a class (not a message-substring check) so the
 * user-facing text can be localised without coupling to Chinese literals.
 */
class LocalAiAttemptsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAiAttemptsError";
  }
}

// Loopback addresses: IPv4 127.0.0.1, localhost, IPv6 [::1]
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|localhost6)$/i;

// Private LAN ranges: 192.168.x.x, 10.x.x.x, 172.16-31.x.x (literal IPs only — no *.local DNS)
const LAN_HOST =
  /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/i;

export function assertAllowedUrl(baseUrl: string, allowLan = false): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  let hostname = "";
  let protocol = "";
  try {
    const parsed = new URL(trimmed);
    hostname = parsed.hostname;
    protocol = parsed.protocol.toLowerCase();
  } catch {
    throw new Error(t("ailib.badUrl", { url: baseUrl }));
  }

  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(
      t("ailib.badProtocol", { protocol: protocol || t("ailib.unknownProtocol") }),
    );
  }

  // Strip brackets from IPv6 host if present
  const cleanHost = hostname.replace(/^\[|\]$/g, "");

  if (LOOPBACK_HOST.test(cleanHost) || LOOPBACK_HOST.test(hostname)) {
    return trimmed;
  }

  if (allowLan && (LAN_HOST.test(cleanHost) || LAN_HOST.test(hostname))) {
    return trimmed;
  }

  if (allowLan) {
    throw new Error(t("ailib.lanOnlyHosts"));
  }

  throw new Error(t("ailib.localOnly"));
}

/** Persist-safe URL check used by settings loader (never throws). */
export function tryNormalizeAllowedUrl(
  baseUrl: string,
  allowLan = false,
): string | null {
  try {
    return assertAllowedUrl(baseUrl, allowLan);
  } catch {
    return null;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaGenerateOptions {
  settings?: Partial<ReaderSettings>;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  allowLan?: boolean;
  prompt?: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  temperature?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  /** Soft timeout in ms (default 180s). 0 disables. Combined with caller signal. */
  timeoutMs?: number;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "AbortError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /aborted|AbortError/i.test(msg);
}

/**
 * Strip a single outer ``` / ```markdown fence that models often wrap around polished text.
 * Leaves content alone when multiple fences are present (real code samples).
 */
export function stripModelOutputFences(text: string): string {
  const trimmed = (text || "").trim();
  const match = trimmed.match(/^```(?:markdown|md|text)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (!match) return trimmed;
  const inner = match[1] ?? "";
  // If the unwrapped body still has fence pairs that look like a whole-doc wrap mistake, keep as-is
  if ((inner.match(/```/g) || []).length >= 2) return trimmed;
  return inner.trim();
}

/**
 * Smartly slices Markdown source while preserving fenced code blocks and paragraph boundaries.
 */
export function smartSliceMarkdown(source: string, maxChars = 8000): string {
  if (source.length <= maxChars) return source;

  // Find a suitable break point around maxChars (prefer newline or paragraph)
  let cutIndex = source.lastIndexOf("\n\n", maxChars);
  if (cutIndex < maxChars * 0.7) {
    cutIndex = source.lastIndexOf("\n", maxChars);
  }
  if (cutIndex < maxChars * 0.6) {
    cutIndex = maxChars;
  }

  let sliced = source.slice(0, cutIndex);

  // Check unclosed code fences (odd count of ```)
  const codeFenceMatches = sliced.match(/```/g);
  if (codeFenceMatches && codeFenceMatches.length % 2 !== 0) {
    sliced += "\n```\n[…文本过长已智能截断…]";
  } else {
    sliced += "\n\n[…文本过长已智能截断…]";
  }

  return sliced;
}

function mergeAbortSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort(external?.reason);
  if (external) {
    if (external.aborted) {
      ctrl.abort(external.reason);
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      const timeoutErr = new Error(
        t("ailib.timeout", { seconds: Math.round(timeoutMs / 1000) }),
      );
      timeoutErr.name = "AbortError";
      ctrl.abort(timeoutErr);
    }, timeoutMs);
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * Parses Server-Sent Events (SSE) or NDJSON streams into tokens in real-time.
 */
async function consumeSseStream(
  response: Response,
  onToken: (token: string) => void,
  extractToken: (dataStr: string) => string | null,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(t("ailib.noStream"));
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed === "data: [DONE]" || trimmed === "[DONE]") {
          return fullText;
        }

        const dataStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        const token = extractToken(dataStr);
        if (token) {
          fullText += token;
          onToken(token);
        }
      }
    }

    if (buffer.trim()) {
      const raw = buffer.trim();
      if (raw !== "data: [DONE]" && raw !== "[DONE]") {
        const dataStr = raw.startsWith("data:") ? raw.slice(5).trim() : raw;
        const token = extractToken(dataStr);
        if (token) {
          fullText += token;
          onToken(token);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

function shortErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 180);
  return String(err).slice(0, 180);
}

/**
 * Universal Generate Function supporting true SSE streaming, multi-turn messages, and custom headers.
 */
export async function ollamaGenerate(
  arg1: string | OllamaGenerateOptions,
  arg2?: string,
  arg3?: string,
  arg4?: AbortSignal,
): Promise<string> {
  let baseUrl: string;
  let model: string;
  let apiKey = "";
  let allowLan = false;
  let prompt = "";
  let messages: ChatMessage[] = [];
  let systemPrompt: string | undefined;
  let temperature = 0.7;
  let signal: AbortSignal | undefined;
  let onChunk: ((chunk: string) => void) | undefined;
  let timeoutMs = 180_000;

  if (typeof arg1 === "object" && arg1 !== null) {
    baseUrl = arg1.baseUrl || arg1.settings?.ollamaBaseUrl || "http://127.0.0.1:11434";
    model = arg1.model || arg1.settings?.ollamaModel || "llama3.2";
    apiKey = arg1.apiKey || arg1.settings?.ollamaApiKey || "";
    allowLan = arg1.allowLan ?? arg1.settings?.ollamaAllowLan ?? false;
    prompt = arg1.prompt || "";
    messages = arg1.messages ? [...arg1.messages] : [];
    systemPrompt = arg1.systemPrompt || arg1.settings?.aiSystemPrompt;
    temperature = arg1.temperature ?? arg1.settings?.aiTemperature ?? 0.7;
    signal = arg1.signal;
    onChunk = arg1.onChunk;
    timeoutMs = arg1.timeoutMs ?? 180_000;
  } else {
    baseUrl = arg1;
    model = arg2 || "default";
    prompt = arg3 || "";
    signal = arg4;
  }

  const base = assertAllowedUrl(baseUrl, allowLan);
  const cleanModel = model.trim() || "default";
  const { signal: mergedSignal, cleanup } = mergeAbortSignals(signal, timeoutMs);

  try {
    // Build standard chat messages
    if (messages.length === 0 && prompt) {
      messages = [{ role: "user", content: prompt }];
    }
    if (systemPrompt?.trim() && !messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: systemPrompt.trim() });
    }

    if (messages.length === 0) {
      throw new Error(t("ailib.emptyPrompt"));
    }

    const defaultHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey.trim()) {
      defaultHeaders["Authorization"] = `Bearer ${apiKey.trim()}`;
    }

    const isV1 = base.endsWith("/v1");
    const openAiEndpoint = isV1 ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const errors: string[] = [];

    // 1. Try OpenAI-compatible chat completions with SSE Streaming (/v1/chat/completions)
    try {
      const res = await fetch(openAiEndpoint, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({
          model: cleanModel,
          messages,
          temperature,
          stream: true,
        }),
        signal: mergedSignal,
      });

      if (res.ok) {
        const fullText = await consumeSseStream(
          res,
          (token) => onChunk?.(token),
          (jsonStr) => {
            try {
              const data = JSON.parse(jsonStr) as {
                choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
              };
              return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? null;
            } catch {
              return null;
            }
          },
        );
        if (fullText.trim()) return fullText.trim();
        errors.push(t("ailib.diagOpenAiEmpty"));
      } else {
        const errorText = await res.text().catch(() => "");
        errors.push(
          t("ailib.diagOpenAiHttp", { status: res.status }) +
            (errorText ? `: ${errorText.slice(0, 120)}` : ""),
        );
      }
    } catch (err: unknown) {
      if (mergedSignal.aborted || isAbortError(err)) throw err;
      errors.push(t("ailib.diagOpenAiErr", { error: shortErr(err) }));
    }

    // Fallback prompt text for non-chat endpoints
    const flatPrompt =
      messages.length > 0
        ? messages
            .map((m) =>
              `${m.role === "user" ? "User" : m.role === "system" ? "System" : "Assistant"}: ${m.content}`,
            )
            .join("\n\n")
        : prompt;

    // 2. Try llama.cpp native completion (/completion)
    try {
      const llamaEndpoint = isV1 ? `${base.replace(/\/v1$/, "")}/completion` : `${base}/completion`;
      const res = await fetch(llamaEndpoint, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({
          prompt: flatPrompt,
          n_predict: 2048,
          temperature,
          stream: true,
        }),
        signal: mergedSignal,
      });

      if (res.ok) {
        const fullText = await consumeSseStream(
          res,
          (token) => onChunk?.(token),
          (jsonStr) => {
            try {
              const data = JSON.parse(jsonStr) as { content?: string };
              return data.content ?? null;
            } catch {
              return null;
            }
          },
        );
        if (fullText.trim()) return fullText.trim();
        errors.push(t("ailib.diagLlamaEmpty"));
      } else {
        errors.push(t("ailib.diagLlamaHttp", { status: res.status }));
      }
    } catch (err: unknown) {
      if (mergedSignal.aborted || isAbortError(err)) throw err;
      errors.push(t("ailib.diagLlamaErr", { error: shortErr(err) }));
    }

    // 3. Try Ollama native chat (/api/chat) — preserves multi-turn roles
    try {
      const chatEndpoint = isV1 ? `${base.replace(/\/v1$/, "")}/api/chat` : `${base}/api/chat`;
      const res = await fetch(chatEndpoint, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({
          model: cleanModel,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          options: { temperature },
        }),
        signal: mergedSignal,
      });

      if (res.ok) {
        const fullText = await consumeSseStream(
          res,
          (token) => onChunk?.(token),
          (jsonStr) => {
            try {
              const data = JSON.parse(jsonStr) as {
                message?: { content?: string };
                response?: string;
              };
              return data.message?.content ?? data.response ?? null;
            } catch {
              return null;
            }
          },
        );
        if (fullText.trim()) return fullText.trim();
        errors.push(t("ailib.diagOllamaChatEmpty"));
      } else {
        errors.push(t("ailib.diagOllamaChatHttp", { status: res.status }));
      }
    } catch (err: unknown) {
      if (mergedSignal.aborted || isAbortError(err)) throw err;
      errors.push(t("ailib.diagOllamaChatErr", { error: shortErr(err) }));
    }

    // 4. Try Ollama native generate (/api/generate)
    const ollamaEndpoint = isV1 ? `${base.replace(/\/v1$/, "")}/api/generate` : `${base}/api/generate`;
    try {
      const res = await fetch(ollamaEndpoint, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({
          model: cleanModel,
          prompt: flatPrompt,
          stream: true,
          options: { temperature },
        }),
        signal: mergedSignal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        errors.push(
          t("ailib.diagOllamaGenHttp", { status: res.status }) +
            (errorText ? `: ${errorText.slice(0, 120)}` : ""),
        );
        throw new LocalAiAttemptsError(
          `${t("ailib.attemptsFailed")}\n- ${errors.join("\n- ")}`,
        );
      }

      const fullText = await consumeSseStream(
        res,
        (token) => onChunk?.(token),
        (jsonStr) => {
          try {
            const data = JSON.parse(jsonStr) as { response?: string };
            return data.response ?? null;
          } catch {
            return null;
          }
        },
      );

      if (fullText.trim()) return fullText.trim();
      errors.push(t("ailib.diagOllamaGenEmpty"));
      throw new LocalAiAttemptsError(
        `${t("ailib.emptyResult")}\n- ${errors.join("\n- ")}`,
      );
    } catch (err: unknown) {
      if (mergedSignal.aborted || isAbortError(err)) throw err;
      if (err instanceof LocalAiAttemptsError) throw err;
      errors.push(t("ailib.diagOllamaGenErr", { error: shortErr(err) }));
      throw new Error(
        `${t("ailib.unreachable")}\n- ${errors.join("\n- ")}`,
      );
    }
  } finally {
    cleanup();
  }
}

export function summarizePrompt(source: string, maxChars = 8000): string {
  const body = smartSliceMarkdown(source, maxChars);
  return `请用简洁中文总结以下 Markdown 笔记要点（条目列表，不超过 8 条）：\n\n${body}`;
}

export function polishPrompt(source: string, maxChars = 8000): string {
  const body = smartSliceMarkdown(source, maxChars);
  return `请在保持原意和 Markdown 格式的前提下，对以下内容进行语言润色，修正语病，使表达更加专业、凝练、通顺。仅输出润色后的正文，不要包裹额外代码围栏，不要解释：\n\n${body}`;
}

export function continuePrompt(source: string, maxChars = 8000): string {
  const body = smartSliceMarkdown(source, maxChars);
  return `请根据以下 Markdown 笔记的上下文逻辑与行文风格，顺畅自然地向下续写补充内容（约 2-3 个段落），保持格式一致。仅输出续写的内容，不要重复原文：\n\n${body}`;
}

export function proofreadPrompt(source: string, maxChars = 8000): string {
  const body = smartSliceMarkdown(source, maxChars);
  return `请对以下 Markdown 文本进行严谨的错别字、标点符号及语病校对。先用条目列出修改说明，再输出「修正后全文」标题下的完整修正文本：\n\n${body}`;
}

export function translatePrompt(source: string, maxChars = 8000): string {
  const body = smartSliceMarkdown(source, maxChars);
  return `请准确地翻译以下 Markdown 文本：若原文主要是中文，请翻译为地道流利的英文；若原文主要是英文或其他语言，请翻译为通顺规范的中文。仅输出翻译结果，保留原有 Markdown 结构：\n\n${body}`;
}

export function extractTagsPrompt(source: string, maxChars = 8000): string {
  const body = smartSliceMarkdown(source, maxChars);
  return `请分析以下 Markdown 笔记内容，提炼出最核心的 3-6 个知识概念标签与双向链接建议（格式如 #标签 或 [[概念笔记名]]），并附带简要关联说明：\n\n${body}`;
}

export async function ollamaCheckConnection(
  baseUrl: string,
  apiKey = "",
  allowLan = false,
): Promise<{
  ok: boolean;
  models: string[];
  provider?: string;
  error?: string;
}> {
  try {
    const base = assertAllowedUrl(baseUrl, allowLan);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);

    const headers: Record<string, string> = {};
    if (apiKey.trim()) {
      headers["Authorization"] = `Bearer ${apiKey.trim()}`;
    }

    const isV1 = base.endsWith("/v1");

    try {
      // 1. Check OpenAI-compatible /v1/models (llama.cpp, LM Studio, Ollama, vLLM)
      try {
        const modelsEndpoint = isV1 ? `${base}/models` : `${base}/v1/models`;
        const res = await fetch(modelsEndpoint, {
          method: "GET",
          headers,
          signal: ctrl.signal,
        });
        if (res.ok) {
          clearTimeout(timer);
          const data = (await res.json()) as { data?: Array<{ id?: string }> };
          const models = (data.data ?? []).map((m) => m.id || "").filter(Boolean);
          const provider = base.includes("8080")
            ? "llama.cpp"
            : base.includes("1234")
              ? "LM Studio"
              : base.includes("11434")
                ? "Ollama"
                : t("ailib.providerLocalLan");
          return { ok: true, models, provider };
        }
      } catch {
        // Continue
      }

      // 2. Check Ollama /api/tags
      try {
        const tagsEndpoint = isV1 ? `${base.replace(/\/v1$/, "")}/api/tags` : `${base}/api/tags`;
        const res = await fetch(tagsEndpoint, {
          method: "GET",
          headers,
          signal: ctrl.signal,
        });
        if (res.ok) {
          clearTimeout(timer);
          const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
          const models = (data.models ?? []).map((m) => m.name || m.model || "").filter(Boolean);
          return { ok: true, models, provider: "Ollama" };
        }
      } catch {
        // Continue
      }

      // 3. Check llama.cpp health endpoint
      try {
        const healthEndpoint = isV1 ? `${base.replace(/\/v1$/, "")}/health` : `${base}/health`;
        const res = await fetch(healthEndpoint, {
          method: "GET",
          headers,
          signal: ctrl.signal,
        });
        if (res.ok) {
          clearTimeout(timer);
          return { ok: true, models: [], provider: "llama.cpp" };
        }
      } catch {
        // Fall through
      }

      clearTimeout(timer);
      return { ok: false, models: [], error: t("ailib.noService") };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, models: [], error: msg };
  }
}
