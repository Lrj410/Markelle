import { DEFAULT_DOCK, type DockLayout } from "./dock";

export type LayoutPreset = "docs" | "book";
export type ColorScheme = "light" | "dark" | "system";
export type DocMode = "read" | "source" | "split";
export type ViewMode = DocMode | "graph";
export type GraphScope = "local" | "full";

export interface ReaderSettings {
  layout: LayoutPreset;
  scheme: ColorScheme;
  fontSize: number;
  lineWidth: number;
  /** @deprecated migrated into dock; still READ by storage.ts for legacy blobs. */
  tocOpen?: boolean;
  /** @deprecated migrated into dock; still READ by storage.ts for legacy blobs. */
  vaultSidebarOpen?: boolean;
  lastVaultPath: string | null;
  enabledPlugins: string[];
  /** Distraction-free immersive reading — persisted across sessions */
  immersive: boolean;
  /** Auto-save dirty buffers to disk after idle */
  autosave: boolean;
  /** Idle delay before autosave (ms) */
  autosaveDelayMs: number;
  dock: DockLayout;
  /** Per-plugin setting bags (plugin API v2). */
  pluginSettings: Record<string, Record<string, unknown>>;
  /** UI locale skeleton */
  locale: "zh" | "en";
  /** Show icon in the system notification area */
  trayEnabled: boolean;
  /** Closing the window hides to tray instead of quitting */
  closeToTray: boolean;
  /** Re-open last vault on launch */
  restoreLastVault: boolean;
  /** Re-open the most recent file on launch when no CLI/OS path is given */
  restoreLastFile: boolean;
  /** Soft-wrap lines in source editor */
  sourceWordWrap: boolean;
  /** Show line numbers in source editor */
  sourceLineNumbers: boolean;
  /** Show YAML / properties strip above the reader */
  showProperties: boolean;
  /** Confirm when quitting with unsaved changes */
  confirmQuitDirty: boolean;
  /**
   * When opening a file via OS association / second launch:
   * false (default) = reuse the running window; true = open a new window.
   */
  openFilesInNewWindow: boolean;
  /** Recent-files preview count before “show more” (2-col grid) */
  recentPreviewCount: number;
  /**
   * Vault roots the user explicitly opened via dialog (or prior trust).
   * Auto-restore only runs for paths in this list (SEC-03).
   */
  trustedVaultPaths: string[];
  /** Daily note folder relative to vault root (zh default `日记`, en often `Daily`). */
  dailyFolder: string;
  /**
   * Attachment folder relative to vault root. Imports land in
   * `{attachmentFolder}/yyyy/mm/…` (experimental in 0.0.2).
   */
  attachmentFolder: string;
  /** Keep knowledge graph open when navigating to a node. */
  graphKeepOpen: boolean;
  /** Local-graph hop depth (1–3). */
  graphLocalHops: 1 | 2 | 3;
  /** Soft-wrap / Vim keybindings in source editor (CodeMirror vim). */
  vimMode: boolean;
  /** Snapshot note content under .markelle/history on save. */
  historyEnabled: boolean;
  /** Max snapshots kept per note path. */
  historyMaxVersions: number;
  /** Allow remote http(s) images/media in reader (https always; http if true). */
  allowRemoteHttpMedia: boolean;
  /** Spellcheck in source editor. */
  spellcheck: boolean;
  /** Quick-capture target relative to vault (or "daily"). */
  captureTarget: "daily" | "inbox";
  /** Enable localhost-only Ollama assist. */
  ollamaEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  /** Optional API Key / Bearer token for local/LAN OpenAI-compatible endpoints */
  ollamaApiKey: string;
  /** Allow connecting to private LAN IP ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x, .local) */
  ollamaAllowLan: boolean;
  /** Context & memory engine mode: 'builtin' (default) or 'cognistack' */
  aiEngineMode: "builtin" | "cognistack";
  /** CogniStack gateway endpoint (e.g. http://127.0.0.1:7331) */
  cogniStackUrl: string;
  /** CogniStack API Key if gateway requires authentication */
  cogniStackApiKey: string;
  /** CogniStack context window limit (default: 8192) */
  cogniStackTokenLimit: number;
  /** CogniStack characters-per-token ratio hint (1=conservative, 2=balanced CJK, 3=dense code) */
  cogniStackCharsPerToken: number;
  /** System prompt persona for AI responses */
  aiSystemPrompt: string;
  /** Model temperature (0.0 to 1.0) */
  aiTemperature: number;
  /** Recently opened vault roots for quick switch (max ~8). */
  recentVaultPaths: string[];
  /** Activity rail shows icon labels when true (default). */
  activityBarExpanded: boolean;
}

export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  layout: "docs",
  scheme: "system",
  fontSize: 17,
  lineWidth: 72,
  lastVaultPath: null,
  enabledPlugins: ["focus-mode"],
  immersive: false,
  autosave: true,
  autosaveDelayMs: 2000,
  dock: structuredClone(DEFAULT_DOCK),
  pluginSettings: {},
  locale: "zh",
  trayEnabled: true,
  closeToTray: true,
  restoreLastVault: true,
  restoreLastFile: true,
  sourceWordWrap: true,
  sourceLineNumbers: true,
  showProperties: true,
  confirmQuitDirty: true,
  openFilesInNewWindow: false,
  recentPreviewCount: 10,
  trustedVaultPaths: [],
  dailyFolder: "日记",
  attachmentFolder: "attachments",
  graphKeepOpen: false,
  graphLocalHops: 1,
  vimMode: false,
  historyEnabled: true,
  historyMaxVersions: 20,
  allowRemoteHttpMedia: false,
  spellcheck: false,
  captureTarget: "daily",
  ollamaEnabled: false,
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "llama3.2",
  ollamaApiKey: "",
  ollamaAllowLan: false,
  aiEngineMode: "builtin",
  cogniStackUrl: "http://127.0.0.1:7331",
  cogniStackApiKey: "",
  cogniStackTokenLimit: 8192,
  cogniStackCharsPerToken: 2,
  aiSystemPrompt: "你是一位专业高效的个人知识库助手，请直接输出精炼、准确的 Markdown 格式结果，不带多余的客套寒暄。",
  aiTemperature: 0.7,
  recentVaultPaths: [],
  activityBarExpanded: true,
};

export {
  clampFontSize,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
} from "./fontSize";

export function clampAutosaveDelayMs(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.autosaveDelayMs;
  return Math.min(10000, Math.max(500, Math.round(n)));
}

export function clampRecentPreviewCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.recentPreviewCount;
  // Even counts fit the 2-column grid cleanly.
  const rounded = Math.round(n / 2) * 2;
  return Math.min(20, Math.max(4, rounded));
}
