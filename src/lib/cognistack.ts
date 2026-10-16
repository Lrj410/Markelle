/**
 * CogniStack Context & Memory Fusion Engine HTTP Client.
 * Connects to CogniStack gateway (default: http://127.0.0.1:7331).
 * Updated for CogniStack 1.4.0 (Full support for /v1/prepare, /v1/fit, /v1/health, lore, vector, budget & prefix stability).
 */

import { getVersion } from "@tauri-apps/api/app";
import { assertAllowedUrl } from "./ollama";
import { t } from "./i18n";

export interface SummaryBlock {
  id?: string;
  text: string;
  throughMessageId?: string;
  pairCount?: number;
  kind?: "full" | "episode";
  importance?: number;
  timestamp?: number;
}

export interface CogniStackDialogueItem {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface CogniStackProfile {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  system_prompt?: string;
}

export interface CogniStackLoreEntry {
  id?: string;
  name?: string;
  keys?: string[];
  secondaryKeys?: string[];
  content: string;
  enabled?: boolean;
  constant?: boolean;
  insertionOrder?: number;
}

export interface CogniStackVectorHit {
  name?: string;
  content: string;
  score?: number;
}

export interface CogniStackBudget {
  contextLimit?: number;
  completionReserve?: number;
  softTrimTokenCap?: number;
  softTrimEnabled?: boolean;
  hardFit?: number;
  safetyPad?: number;
  templateOverhead?: number;
  warnings?: string[];
}

export interface CogniStackPrefixStability {
  ratio?: number;
  unchangedTokens?: number;
  priorTokens?: number;
  currentTokens?: number;
}

export interface CogniStackPrepareOptions {
  url?: string;
  apiKey?: string;
  /** Reuse LAN allowlist from AI settings (default false = loopback only). */
  allowLan?: boolean;
  dialogue: CogniStackDialogueItem[];
  profile?: CogniStackProfile;
  loreEntries?: CogniStackLoreEntry[];
  vectorHits?: CogniStackVectorHit[];
  summaryBlocks?: SummaryBlock[];
  summarizedCount?: number;
  summarizedThroughMessageId?: string | null;
  pairBatchSize?: number;
  systemRules?: string;
  contextTokenLimit?: number;
  completionReserveTokens?: number;
  charsPerToken?: number;
  cacheScope?: string;
  signal?: AbortSignal;
}

export interface CogniStackPrepareResult {
  ok: boolean;
  engine?: string;
  version?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  promptTokens?: number;
  promptChars?: number;
  loreInjected?: Array<{ id: string; name?: string }>;
  prefixStability?: CogniStackPrefixStability;
  shouldSummarize: boolean;
  compressReason?: string;
  summary?: string;
  summaryBlocks?: SummaryBlock[];
  toSummarize?: CogniStackDialogueItem[];
  toSummarizePairCount?: number;
  nextSummarizedCount?: number;
  nextSummarizedThroughMessageId?: string | null;
  budget?: CogniStackBudget;
  warnings?: string[];
  emergencyDroppedCount?: number;
  error?: string;
}

export interface CogniStackFitOptions {
  url?: string;
  apiKey?: string;
  allowLan?: boolean;
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  contextTokenLimit?: number;
  completionReserveTokens?: number;
  cacheScope?: string;
  signal?: AbortSignal;
}

export interface CogniStackFitResult {
  ok: boolean;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  promptTokens?: number;
  hardFit?: number;
  trimmed?: boolean;
  model?: string;
  shouldSummarize?: boolean;
  error?: string;
}

export interface CogniStackHealthResult {
  ok: boolean;
  version?: string;
  engine?: string;
  zone?: string;
  uptimeMs?: number;
  prepareQueue?: number;
  rateLimit?: number;
  lore?: string;
  auth?: boolean;
  error?: string;
}

export const COGNISTACK_MEMORY_COLUMNS = [
  "【硬事实】",
  "【时间线】",
  "【关系与称呼】",
  "【未决】",
  "【近期情节】",
] as const;

export const MEMORY_COLUMN_ALIASES: Record<
  (typeof COGNISTACK_MEMORY_COLUMNS)[number],
  string[]
> = {
  "【硬事实】": ["【长期事实】", "【核心事实】", "【确定事实】", "【事实】", "【设定】"],
  "【时间线】": ["【事件时间线】", "【时间线记录】", "【大事记】", "【发生的事】"],
  "【关系与称呼】": ["【人物关系】", "【关系】", "【称呼】"],
  "【未决】": ["【未决事项】", "【待决】", "【悬而未决】", "【开放问题】"],
  "【近期情节】": ["【最近情节】", "【近期剧情】", "【最近剧情】", "【当前情节】"],
};

export function canonicalColumnTitle(
  title: string,
): (typeof COGNISTACK_MEMORY_COLUMNS)[number] | null {
  const tStr = (title ?? "").trim();
  if (!tStr) return null;
  if ((COGNISTACK_MEMORY_COLUMNS as readonly string[]).includes(tStr)) {
    return tStr as (typeof COGNISTACK_MEMORY_COLUMNS)[number];
  }
  for (const canonical of COGNISTACK_MEMORY_COLUMNS) {
    if (MEMORY_COLUMN_ALIASES[canonical].includes(tStr)) return canonical;
  }
  return null;
}

export function formatCogniStackTranscript(
  items: Array<{ role: string; content: string }>,
): string {
  return items
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.trim()}`)
    .join("\n\n");
}

export function buildCogniStackSummarizePrompt(params: {
  priorJoined: string;
  transcript: string;
  maxCharsHint?: number;
}): string {
  const prior = params.priorJoined.trim() || "（无）";
  const hint = params.maxCharsHint || 800;
  return [
    "将对话压缩为简洁中文长期记忆文档。必须使用以下固定栏目标题（缺栏目写「无」，不可改标题文案）：",
    "【硬事实】专有名词、知识点、约定、不可推翻设定",
    "【时间线】有序事件节点",
    "【关系与称呼】",
    "【未决】待办、冲突、悬念与待解决问题",
    "【近期情节】可牺牲的叙事与问答缓冲",
    "",
    "已有长期记忆摘要（将被整份替换融合）：",
    prior,
    "",
    "本批新对话：",
    params.transcript,
    "",
    "硬性要求：保留旧摘要与本批对话中的关键事实、知识要点与未决事项。整份替换旧记忆，不要另起碎段，不要用 --- 分隔，不要输出 markdown 标题。",
    "特别要求：【硬事实】只记录提炼出的客观实体信息、设定与核心知识结论，严禁把临时的提问行为（例如‘用户问了测试’、‘用户让总结’、‘输入了1’）作为硬事实记录。",
    `篇幅：控制在约 ${hint} 字以内；超长则合并去重，优先压缩【近期情节】，不得丢失【硬事实】与【未决】。`,
    "栏目质量：每个栏目要么写实质内容，要么单独一行写「无」。",
    "只输出栏目正文，不要解释。",
  ].join("\n");
}

function emptyFivePartSummary(): string {
  return COGNISTACK_MEMORY_COLUMNS.map((col) => `${col}\n无`).join("\n\n");
}

function matchHeaderLine(
  rawLine: string,
): { col: (typeof COGNISTACK_MEMORY_COLUMNS)[number]; rest: string } | null {
  const line = rawLine.trim();
  if (!line) return null;
  const noHash = line.replace(/^#{1,6}\s*/, "").trim();

  for (const col of COGNISTACK_MEMORY_COLUMNS) {
    const candidates = [col, ...MEMORY_COLUMN_ALIASES[col]];
    for (const cand of candidates) {
      const bare = cand.replace(/[[\]【】［］()（）]/g, "");
      const patterns = [
        cand,
        `[${bare}]`,
        `［${bare}］`,
        `(${bare})`,
        `（${bare}）`,
        bare,
      ];
      for (const p of patterns) {
        if (noHash.startsWith(p)) {
          const rest = noHash.slice(p.length).replace(/^[:：\-—\s]+/, "").trim();
          if (p === bare && !line.startsWith("#") && rest.length > 0) {
            continue;
          }
          return { col, rest };
        }
      }
    }
  }
  return null;
}

/**
 * Normalize LLM memory text into the fixed five-column CogniStack layout.
 * Supports CogniStack 1.4.0 column aliases, markdown headers, and bracket variations.
 */
export function normalizeCogniStackSummaryColumns(body: string): string {
  const text = (body || "").trim();
  if (!text) return emptyFivePartSummary();

  const sections: Record<string, string[]> = {};
  for (const col of COGNISTACK_MEMORY_COLUMNS) sections[col] = [];

  let current: (typeof COGNISTACK_MEMORY_COLUMNS)[number] | null = null;
  const preamble: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const hit = matchHeaderLine(line);
    if (hit) {
      current = hit.col;
      if (hit.rest) sections[hit.col].push(hit.rest);
      continue;
    }
    if (current) {
      if (line.trim()) sections[current].push(line.trim());
    } else if (line.trim()) {
      preamble.push(line.trim());
    }
  }

  // Fold orphan preamble into 硬事实 when the model skipped headings
  if (preamble.length > 0 && sections["【硬事实】"].length === 0) {
    sections["【硬事实】"] = preamble;
  } else if (preamble.length > 0) {
    sections["【硬事实】"] = [...preamble, ...sections["【硬事实】"]];
  }

  return COGNISTACK_MEMORY_COLUMNS.map((col) => {
    const lines = sections[col];
    const bodyText = lines.length > 0 ? lines.join("\n") : "无";
    return `${col}\n${bodyText}`;
  }).join("\n\n");
}

export function parseStructuredCogniStackSummary(raw: string): string {
  let body = (raw || "").trim();
  // Strip machine block <<<STATE_PATCH>>>...<<<END>>> if emitted
  body = body.replace(/<<<STATE_PATCH>>>[\s\S]*?<<<END>>>/gi, "").trim();
  const openIdx = body.search(/<<<STATE_PATCH>>>/i);
  if (openIdx >= 0) {
    body = body.slice(0, openIdx).trim();
  }
  return normalizeCogniStackSummaryColumns(body);
}

function resolveCogniBase(url: string, allowLan: boolean): string {
  return assertAllowedUrl(url.trim() || "http://127.0.0.1:7331", allowLan);
}

export async function cogniStackCheckHealth(
  url = "http://127.0.0.1:7331",
  apiKey = "",
  allowLan = false,
): Promise<CogniStackHealthResult> {
  try {
    const base = resolveCogniBase(url, allowLan);
    const headers: Record<string, string> = {};
    if (apiKey.trim()) {
      headers["Authorization"] = `Bearer ${apiKey.trim()}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);

    try {
      const res = await fetch(`${base}/v1/health`, {
        method: "GET",
        headers,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        if (res.status === 404) {
          const v1Res = await fetch(`${base}/v1`, {
            method: "GET",
            headers,
            signal: ctrl.signal,
          });
          if (v1Res.ok) {
            const v1Data = (await v1Res.json()) as {
              name?: string;
              version?: string;
              zone?: string;
              lore?: string;
            };
            return {
              ok: true,
              version: v1Data.version || "1.4.0",
              engine: v1Data.name || "CogniStack",
              zone: v1Data.zone,
              lore: v1Data.lore,
            };
          }
        }
        return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const data = (await res.json()) as {
        ok?: boolean;
        version?: string;
        engine?: string;
        zone?: string;
        uptimeMs?: number;
        prepareQueue?: number;
        rateLimit?: number;
        lore?: string;
        auth?: boolean;
      };
      return {
        ok: Boolean(data.ok ?? true),
        version: data.version || "1.4.0",
        engine: data.engine || "cognistack-engine",
        zone: data.zone,
        uptimeMs: data.uptimeMs,
        prepareQueue: data.prepareQueue,
        rateLimit: data.rateLimit,
        lore: data.lore,
        auth: data.auth,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    let friendly = msg;
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
      friendly = t("ailib.gatewayUnreachable");
    }
    return { ok: false, error: friendly };
  }
}

export async function cogniStackPrepare(
  opts: CogniStackPrepareOptions,
): Promise<CogniStackPrepareResult> {
  let base: string;
  try {
    base = resolveCogniBase(opts.url || "http://127.0.0.1:7331", opts.allowLan ?? false);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      messages: opts.dialogue,
      shouldSummarize: false,
      error: msg,
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.apiKey?.trim()) {
    headers["Authorization"] = `Bearer ${opts.apiKey.trim()}`;
  }

  let hostVersion = "";
  try {
    hostVersion = await getVersion();
  } catch {
    /* non-Tauri / web preview */
  }

  const body: Record<string, unknown> = {
    host: {
      id: "markelle",
      name: "Markelle",
      kind: "client",
      version: hostVersion,
    },
    profile: opts.profile || {
      name: "Markelle AI",
      description: "本地优先 Markdown 知识库助手",
    },
    dialogue: opts.dialogue,
    summaryBlocks: opts.summaryBlocks,
    summarizedCount: opts.summarizedCount,
    summarizedThroughMessageId: opts.summarizedThroughMessageId || undefined,
    pairBatchSize: opts.pairBatchSize ?? 2,
    systemRules:
      opts.systemRules ||
      "你是一位专业高效的个人知识库助手，请直接输出精炼、准确的 Markdown 格式结果。",
    contextTokenLimit: opts.contextTokenLimit || 8192,
    completionReserveTokens: opts.completionReserveTokens || 1024,
    charsPerToken: opts.charsPerToken,
  };

  if (opts.loreEntries && opts.loreEntries.length > 0) {
    body.loreEntries = opts.loreEntries;
  }
  if (opts.vectorHits && opts.vectorHits.length > 0) {
    body.vectorHits = opts.vectorHits;
  }
  if (opts.cacheScope) {
    body.cacheScope = opts.cacheScope;
  }

  try {
    const res = await fetch(`${base}/v1/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        messages: opts.dialogue,
        shouldSummarize: false,
        error: t("ailib.gatewayResponseError", {
          status: res.status,
          detail: errText || res.statusText,
        }),
      };
    }

    const data = (await res.json()) as {
      engine?: string;
      version?: string;
      messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      promptTokens?: number;
      promptChars?: number;
      loreInjected?: Array<{ id: string; name?: string }>;
      prefixStability?: CogniStackPrefixStability;
      summary?: string;
      summaryBlocks?: SummaryBlock[];
      memory?: {
        shouldSummarize?: boolean;
        compressReason?: string;
      };
      toSummarize?: CogniStackDialogueItem[];
      toSummarizePairCount?: number;
      nextSummarizedCount?: number;
      nextSummarizedThroughMessageId?: string;
      budget?: CogniStackBudget;
      warnings?: string[];
      diagnostics?: Record<string, unknown>;
    };

    let emergencyDroppedCount = 0;
    const diagStages = data.diagnostics?.stages as { emergencyDropped?: number } | undefined;
    if (typeof diagStages?.emergencyDropped === "number" && diagStages.emergencyDropped > 0) {
      emergencyDroppedCount = diagStages.emergencyDropped;
    } else if (Array.isArray(data.warnings)) {
      for (const w of data.warnings) {
        const m = w.match(/emergency-dialogue-window:dropped-(\d+)/i);
        if (m) {
          emergencyDroppedCount += Number(m[1]) || 0;
        }
      }
    }

    return {
      ok: true,
      engine: data.engine,
      version: data.version,
      messages: data.messages && data.messages.length > 0 ? data.messages : opts.dialogue,
      promptTokens: data.promptTokens,
      promptChars: data.promptChars,
      loreInjected: data.loreInjected,
      prefixStability: data.prefixStability,
      shouldSummarize: Boolean(data.memory?.shouldSummarize),
      compressReason: data.memory?.compressReason,
      summary: data.summary,
      summaryBlocks: data.summaryBlocks,
      toSummarize: data.toSummarize,
      toSummarizePairCount: data.toSummarizePairCount,
      nextSummarizedCount: data.nextSummarizedCount,
      nextSummarizedThroughMessageId: data.nextSummarizedThroughMessageId,
      budget: data.budget,
      warnings: data.warnings,
      emergencyDroppedCount: emergencyDroppedCount > 0 ? emergencyDroppedCount : undefined,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      messages: opts.dialogue,
      shouldSummarize: false,
      error: t("ailib.gatewayCallFailed", { error: msg }),
    };
  }
}

export async function cogniStackFit(
  opts: CogniStackFitOptions,
): Promise<CogniStackFitResult> {
  let base: string;
  try {
    base = resolveCogniBase(opts.url || "http://127.0.0.1:7331", opts.allowLan ?? false);
  } catch (err: unknown) {
    return { ok: false, messages: opts.messages, error: String(err) };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey?.trim()) {
    headers["Authorization"] = `Bearer ${opts.apiKey.trim()}`;
  }

  try {
    const res = await fetch(`${base}/v1/fit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: opts.messages,
        model: opts.model || "gpt-4o",
        contextTokenLimit: opts.contextTokenLimit,
        completionReserveTokens: opts.completionReserveTokens,
        cacheScope: opts.cacheScope,
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        messages: opts.messages,
        error: `HTTP ${res.status}: ${errText || res.statusText}`,
      };
    }

    const data = (await res.json()) as {
      messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      promptTokens?: number;
      hardFit?: number;
      trimmed?: boolean;
      model?: string;
      shouldSummarize?: boolean;
    };
    return {
      ok: true,
      messages: data.messages || opts.messages,
      promptTokens: data.promptTokens,
      hardFit: data.hardFit,
      trimmed: data.trimmed,
      model: data.model,
      shouldSummarize: data.shouldSummarize,
    };
  } catch (err: unknown) {
    return { ok: false, messages: opts.messages, error: String(err) };
  }
}
