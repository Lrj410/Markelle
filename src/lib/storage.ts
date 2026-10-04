import { LazyStore } from "@tauri-apps/plugin-store";
import { DEFAULT_DOCK, normalizeDock } from "./dock";
import { pathsEqual } from "./openTab";
import {
  clampAutosaveDelayMs,
  clampFontSize,
  clampRecentPreviewCount,
  DEFAULT_SETTINGS,
  type ReaderSettings,
  type RecentEntry,
} from "./types";
import { tryNormalizeAllowedUrl } from "./ollama";

const store = new LazyStore("markelle.json");
/** API keys live in a separate store file so general settings export/debug is safer. */
const secretsStore = new LazyStore("markelle.secrets.json");

const SETTINGS_KEY = "settings";
const RECENT_KEY = "recent";
const SECRETS_KEY = "secrets";
const MAX_RECENT = 20;

type SecretsBlob = {
  ollamaApiKey?: string;
  cogniStackApiKey?: string;
};

async function loadSecretsBlob(): Promise<SecretsBlob> {
  try {
    return (await secretsStore.get<SecretsBlob>(SECRETS_KEY)) ?? {};
  } catch {
    return {};
  }
}

async function saveSecretsBlob(blob: SecretsBlob): Promise<void> {
  await secretsStore.set(SECRETS_KEY, {
    ollamaApiKey: blob.ollamaApiKey ?? "",
    cogniStackApiKey: blob.cogniStackApiKey ?? "",
  });
  await secretsStore.save();
}

let recentCache: RecentEntry[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();
/** Callers awaiting the next (shared) persist — settled together, never dropped. */
let persistWaiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];

function runPersist(): void {
  const waiters = persistWaiters;
  persistWaiters = [];
  persistChain = persistChain
    .then(() => store.save())
    .then(() => {
      for (const w of waiters) w.resolve();
    })
    .catch((err) => {
      for (const w of waiters) w.reject(err);
    });
}

function schedulePersist(immediate = false): Promise<void> {
  return new Promise((resolve, reject) => {
    persistWaiters.push({ resolve, reject });
    if (immediate) {
      if (persistTimer != null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      runPersist();
      return;
    }
    // A debounce timer is already pending: just join its batch.
    if (persistTimer != null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      runPersist();
    }, 120);
  });
}

export async function flushStore(): Promise<void> {
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const waiters = persistWaiters;
  persistWaiters = [];
  try {
    await persistChain;
    await store.save();
    for (const w of waiters) w.resolve();
  } catch (err) {
    for (const w of waiters) w.reject(err);
  }
}

type StoredSettings = Partial<ReaderSettings> & {
  showDesktopOrb?: boolean;
  showQuickOrb?: boolean;
  tocOpen?: boolean;
  vaultSidebarOpen?: boolean;
  dockRightClearedV3?: boolean;
};

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

export async function loadSettings(): Promise<ReaderSettings> {
  const saved = (await store.get<StoredSettings>(SETTINGS_KEY)) ?? undefined;
  const secrets = await loadSecretsBlob();

  // Migrate keys that previously lived in the main settings blob.
  const migratedOllamaKey =
    (typeof secrets.ollamaApiKey === "string" && secrets.ollamaApiKey) ||
    (typeof saved?.ollamaApiKey === "string" ? saved.ollamaApiKey : "") ||
    DEFAULT_SETTINGS.ollamaApiKey;
  const migratedCogniKey =
    (typeof secrets.cogniStackApiKey === "string" && secrets.cogniStackApiKey) ||
    (typeof saved?.cogniStackApiKey === "string" ? saved.cogniStackApiKey : "") ||
    DEFAULT_SETTINGS.cogniStackApiKey;

  const merged: ReaderSettings = {
    ...DEFAULT_SETTINGS,
    ...(saved ?? {}),
    dock: normalizeDock(saved?.dock ?? DEFAULT_DOCK),
    pluginSettings: saved?.pluginSettings ?? DEFAULT_SETTINGS.pluginSettings,
    locale: saved?.locale === "en" ? "en" : "zh",
    trayEnabled: asBool(saved?.trayEnabled, DEFAULT_SETTINGS.trayEnabled),
    closeToTray: asBool(saved?.closeToTray, DEFAULT_SETTINGS.closeToTray),
    restoreLastVault: asBool(saved?.restoreLastVault, DEFAULT_SETTINGS.restoreLastVault),
    restoreLastFile: asBool(saved?.restoreLastFile, DEFAULT_SETTINGS.restoreLastFile),
    sourceWordWrap: asBool(saved?.sourceWordWrap, DEFAULT_SETTINGS.sourceWordWrap),
    sourceLineNumbers: asBool(saved?.sourceLineNumbers, DEFAULT_SETTINGS.sourceLineNumbers),
    showProperties: asBool(saved?.showProperties, DEFAULT_SETTINGS.showProperties),
    confirmQuitDirty: asBool(saved?.confirmQuitDirty, DEFAULT_SETTINGS.confirmQuitDirty),
    openFilesInNewWindow: asBool(
      saved?.openFilesInNewWindow,
      DEFAULT_SETTINGS.openFilesInNewWindow,
    ),
    autosave: asBool(saved?.autosave, DEFAULT_SETTINGS.autosave),
    autosaveDelayMs: clampAutosaveDelayMs(
      typeof saved?.autosaveDelayMs === "number"
        ? saved.autosaveDelayMs
        : DEFAULT_SETTINGS.autosaveDelayMs,
    ),
    recentPreviewCount: clampRecentPreviewCount(
      typeof saved?.recentPreviewCount === "number"
        ? saved.recentPreviewCount
        : DEFAULT_SETTINGS.recentPreviewCount,
    ),
    trustedVaultPaths: Array.isArray(saved?.trustedVaultPaths)
      ? saved!.trustedVaultPaths.filter((p): p is string => typeof p === "string").slice(0, 40)
      : saved?.lastVaultPath
        ? [saved.lastVaultPath]
        : DEFAULT_SETTINGS.trustedVaultPaths,
    dailyFolder:
      typeof saved?.dailyFolder === "string" && saved.dailyFolder.trim()
        ? saved.dailyFolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
        : DEFAULT_SETTINGS.dailyFolder,
    attachmentFolder:
      typeof saved?.attachmentFolder === "string" && saved.attachmentFolder.trim()
        ? saved.attachmentFolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
        : DEFAULT_SETTINGS.attachmentFolder,
    graphKeepOpen: asBool(saved?.graphKeepOpen, DEFAULT_SETTINGS.graphKeepOpen),
    graphLocalHops:
      saved?.graphLocalHops === 3 ? 3 : saved?.graphLocalHops === 2 ? 2 : 1,
    vimMode: asBool(saved?.vimMode, DEFAULT_SETTINGS.vimMode),
    historyEnabled: asBool(saved?.historyEnabled, DEFAULT_SETTINGS.historyEnabled),
    historyMaxVersions:
      typeof saved?.historyMaxVersions === "number"
        ? Math.min(100, Math.max(1, Math.round(saved.historyMaxVersions)))
        : DEFAULT_SETTINGS.historyMaxVersions,
    allowRemoteHttpMedia: asBool(
      saved?.allowRemoteHttpMedia,
      DEFAULT_SETTINGS.allowRemoteHttpMedia,
    ),
    spellcheck: asBool(saved?.spellcheck, DEFAULT_SETTINGS.spellcheck),
    captureTarget: saved?.captureTarget === "inbox" ? "inbox" : "daily",
    ollamaEnabled: asBool(saved?.ollamaEnabled, DEFAULT_SETTINGS.ollamaEnabled),
    ollamaAllowLan: asBool(saved?.ollamaAllowLan, DEFAULT_SETTINGS.ollamaAllowLan),
    ollamaApiKey: migratedOllamaKey,
    ollamaBaseUrl: (() => {
      const allowLan = asBool(saved?.ollamaAllowLan, DEFAULT_SETTINGS.ollamaAllowLan);
      if (typeof saved?.ollamaBaseUrl !== "string" || !saved.ollamaBaseUrl.trim()) {
        return DEFAULT_SETTINGS.ollamaBaseUrl;
      }
      return (
        tryNormalizeAllowedUrl(saved.ollamaBaseUrl, allowLan) || DEFAULT_SETTINGS.ollamaBaseUrl
      );
    })(),
    ollamaModel:
      typeof saved?.ollamaModel === "string" && saved.ollamaModel.trim()
        ? saved.ollamaModel.trim()
        : DEFAULT_SETTINGS.ollamaModel,
    aiEngineMode: saved?.aiEngineMode === "cognistack" ? "cognistack" : "builtin",
    cogniStackUrl: (() => {
      const allowLan = asBool(saved?.ollamaAllowLan, DEFAULT_SETTINGS.ollamaAllowLan);
      if (typeof saved?.cogniStackUrl !== "string" || !saved.cogniStackUrl.trim()) {
        return DEFAULT_SETTINGS.cogniStackUrl;
      }
      return (
        tryNormalizeAllowedUrl(saved.cogniStackUrl, allowLan) || DEFAULT_SETTINGS.cogniStackUrl
      );
    })(),
    cogniStackApiKey: migratedCogniKey,
    cogniStackTokenLimit:
      typeof saved?.cogniStackTokenLimit === "number" &&
      [4096, 8192, 16384, 32768, 65536].includes(saved.cogniStackTokenLimit)
        ? saved.cogniStackTokenLimit
        : DEFAULT_SETTINGS.cogniStackTokenLimit,
    cogniStackCharsPerToken:
      saved?.cogniStackCharsPerToken === 1 ||
      saved?.cogniStackCharsPerToken === 2 ||
      saved?.cogniStackCharsPerToken === 3
        ? saved.cogniStackCharsPerToken
        : DEFAULT_SETTINGS.cogniStackCharsPerToken,
    aiSystemPrompt:
      typeof saved?.aiSystemPrompt === "string" && saved.aiSystemPrompt.trim()
        ? saved.aiSystemPrompt.trim()
        : DEFAULT_SETTINGS.aiSystemPrompt,
    aiTemperature:
      typeof saved?.aiTemperature === "number" &&
      Number.isFinite(saved.aiTemperature)
        ? Math.min(1, Math.max(0, Math.round(saved.aiTemperature * 20) / 20))
        : DEFAULT_SETTINGS.aiTemperature,
    recentVaultPaths: Array.isArray(saved?.recentVaultPaths)
      ? saved!
          .recentVaultPaths!.filter((p): p is string => typeof p === "string")
          .slice(0, 8)
      : DEFAULT_SETTINGS.recentVaultPaths,
    activityBarExpanded: asBool(
      saved?.activityBarExpanded,
      DEFAULT_SETTINGS.activityBarExpanded,
    ),
    fontSize:
      typeof saved?.fontSize === "number"
        ? clampFontSize(saved.fontSize)
        : DEFAULT_SETTINGS.fontSize,
    lineWidth:
      typeof saved?.lineWidth === "number"
        ? Math.min(96, Math.max(56, Math.round(saved.lineWidth)))
        : DEFAULT_SETTINGS.lineWidth,
  };

  delete (merged as StoredSettings).showDesktopOrb;
  delete (merged as StoredSettings).showQuickOrb;
  delete (merged as StoredSettings).dockRightClearedV3;

  // One-shot migration: move plaintext keys out of markelle.json when present.
  const hadInlineSecrets =
    (typeof saved?.ollamaApiKey === "string" && saved.ollamaApiKey.length > 0) ||
    (typeof saved?.cogniStackApiKey === "string" && saved.cogniStackApiKey.length > 0);
  if (hadInlineSecrets) {
    try {
      await saveSecretsBlob({
        ollamaApiKey: migratedOllamaKey,
        cogniStackApiKey: migratedCogniKey,
      });
      const scrubbed = { ...saved, ollamaApiKey: "", cogniStackApiKey: "" };
      await store.set(SETTINGS_KEY, scrubbed);
      await schedulePersist(true);
    } catch {
      /* best-effort migration */
    }
  }

  if (saved && !saved.dock) {
    let dock = merged.dock;
    if (saved.vaultSidebarOpen === false) {
      dock = {
        ...dock,
        left: {
          ...dock.left,
          panels: dock.left.panels.filter((p) => p !== "vault"),
          active:
            dock.left.active === "vault"
              ? (dock.left.panels.find((p) => p !== "vault") ?? null)
              : dock.left.active,
        },
      };
    }
    if (saved.tocOpen === false) {
      dock = {
        ...dock,
        right: {
          ...dock.right,
          panels: dock.right.panels.filter((p) => p !== "toc"),
          active:
            dock.right.active === "toc"
              ? (dock.right.panels.find((p) => p !== "toc") ?? null)
              : dock.right.active,
        },
      };
    }
    merged.dock = normalizeDock(dock);
  }

  if (saved && !saved.dockRightClearedV3) {
    const right = merged.dock.right;
    const onlyAux = right.panels.every((p) => p === "toc" || p === "backlinks");
    if (onlyAux && right.panels.length > 0) {
      merged.dock = normalizeDock({
        ...merged.dock,
        right: { panels: [], active: null, size: Math.min(right.size || 200, 220) },
      });
    }
  }

  return merged;
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  const payload: StoredSettings = {
    ...settings,
    autosaveDelayMs: clampAutosaveDelayMs(settings.autosaveDelayMs),
    recentPreviewCount: clampRecentPreviewCount(settings.recentPreviewCount),
    dockRightClearedV3: true,
    // Never persist secrets in the main settings blob.
    ollamaApiKey: "",
    cogniStackApiKey: "",
  };
  delete payload.showDesktopOrb;
  delete payload.showQuickOrb;

  await saveSecretsBlob({
    ollamaApiKey: settings.ollamaApiKey,
    cogniStackApiKey: settings.cogniStackApiKey,
  });
  await store.set(SETTINGS_KEY, payload);
  await schedulePersist();
}

export async function loadRecent(): Promise<RecentEntry[]> {
  if (recentCache) return recentCache;
  const list = (await store.get<RecentEntry[]>(RECENT_KEY)) ?? [];
  recentCache = list;
  return list;
}

export async function pushRecent(entry: Omit<RecentEntry, "openedAt">): Promise<RecentEntry[]> {
  const list = recentCache ?? (await loadRecent());
  const next = [
    { ...entry, openedAt: Date.now() },
    ...list.filter((item) => !pathsEqual(item.path, entry.path)),
  ].slice(0, MAX_RECENT);
  recentCache = next;
  await store.set(RECENT_KEY, next);
  void schedulePersist();
  return next;
}

export async function clearRecent(): Promise<void> {
  recentCache = [];
  await store.set(RECENT_KEY, []);
  await schedulePersist(true);
}
