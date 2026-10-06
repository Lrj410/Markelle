import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { askConfirm, askAlert } from "./lib/appConfirm";
import { askPrompt } from "./lib/appPrompt";
import { UnifiedHeader } from "./components/UnifiedHeader";
import { ActivityBar } from "./components/ActivityBar";
import { DockWorkspace } from "./components/DockWorkspace";
import { Welcome } from "./components/Welcome";
import { TocSidebar } from "./components/TocSidebar";
import { VaultSidebar } from "./components/VaultSidebar";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { TagsPanel } from "./components/TagsPanel";
import { QueryPanel } from "./components/QueryPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { CalendarPanel } from "./components/CalendarPanel";
import { AiAssistantPanel } from "./components/AiAssistantPanel";
import { CaptureDialog } from "./components/CaptureDialog";
import { SplitScrollPane } from "./components/SplitScrollPane";
import { CanvasBoard } from "./components/CanvasBoard";
import { historyClearNote, historySaveSnapshot } from "./lib/history";
import { buildExportHtml, downloadTextFile, embedLocalImagesInHtml, printHtmlDocument } from "./lib/exportDoc";
import { renderMarkdown } from "./lib/markdown";
import {
  continuePrompt,
  isAbortError,
  ollamaGenerate,
  polishPrompt,
  proofreadPrompt,
  stripModelOutputFences,
  summarizePrompt,
  translatePrompt,
} from "./lib/ollama";
import { toGatedAssetUrl } from "./lib/assets";
import { adjustHeadingLevel, moveHeadingTo } from "./lib/headingLevel";
import { decryptNote, encryptNote, isEncryptedNote } from "./lib/noteCrypto";
import { checkForUpdates } from "./lib/updateCheck";
import { listVaultTemplates } from "./lib/templatesList";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PropertiesStrip } from "./components/PropertiesStrip";
import { PluginPanel } from "./components/PluginPanel";
import { AboutDialog } from "./components/AboutDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { PromptDialog } from "./components/PromptDialog";
import { CommandPalette, type CommandItem } from "./components/CommandPalette";
import { setLocale, t } from "./lib/i18n";
import {
  appendMarkdownFile,
  formatBytes,
  LARGE_FILE_WARN_BYTES,
  MAX_LARGE_FILE_TABS,
  readMarkdownFile,
  registerAccess,
  statMarkdownFile,
  writeMarkdownFile,
  type OpenedFile,
} from "./lib/files";
import {
  formatHydrateStatus,
  hydrateLargeFile,
  largeFileClose,
  listenLargeFileProgress,
} from "./lib/largeFile";
import { formatAppError } from "./lib/errors";
import {
  clearRecent,
  flushStore,
  loadRecent,
  loadSettings,
  pushRecent,
  saveSettings,
} from "./lib/storage";
import {
  hasPendingOpen,
  setPendingOpenConsumer,
} from "./lib/pendingOpen";
import { ErrorBoundary } from "./components/ErrorBoundary";

const SourceWorkbench = lazy(() =>
  import("./components/SourceWorkbench").then((m) => ({ default: m.SourceWorkbench })),
);
const GraphView = lazy(() =>
  import("./components/GraphView").then((m) => ({ default: m.GraphView })),
);
/** Pulls katex + highlight.js — keep off the welcome/shell critical path. */
const MarkdownView = lazy(() =>
  import("./components/MarkdownView").then((m) => ({ default: m.MarkdownView })),
);
import type { TocItem } from "./lib/toc";
import { resolveHeadingId } from "./lib/toc";
import type { ColorScheme, LayoutPreset } from "./lib/types";
import type { GraphHops } from "./lib/graph";
import { isDirty, isLargeTab, type DocTab } from "./lib/tabs";
import { getWriteBlockReason } from "./lib/documentGuards";
import {
  findTabByPath,
  isPathUnder,
  isSameDirectory,
  normalizePath,
  pathsEqual,
  upsertOpenedTab,
  resolveActiveId,
} from "./lib/openTab";
// normalizePath also used for trusted-vault comparisons
import { openPathInNewWindow, readStartupFileParam } from "./lib/windows";
import { findBacklinks, type VaultInfo } from "./lib/vault";
import { flattenVaultFiles } from "./lib/vaultIndex";
import {
  applyEnabledPlugins,
  applyVaultStyle,
  listDiskPlugins,
  mergePlugins,
  runPluginCommand,
} from "./lib/plugins/host";
import { IMMERSIVE_TOGGLE_EVENT } from "./lib/plugins/builtin";
import type { PluginInfo } from "./lib/plugins/types";
import type { GraphScope, ReaderSettings, RecentEntry, ViewMode } from "./lib/types";
import { DEFAULT_SETTINGS } from "./lib/types";
import { isPanelVisible, panelLabel, togglePanel, type DockLayout, type PanelId } from "./lib/dock";
import { allocateUniquePath, basename, dirname, joinPath, toPosixPath } from "./lib/paths";
import { refactorAllLinks } from "./lib/refactorLinks";
import {
  isAttachmentDropCandidate,
  isImageFileName,
  markdownImageLink,
} from "./lib/attachments";
import { toggleTaskAt } from "./lib/taskToggle";
import { readAllowedBytes, vaultWriteBytes } from "./lib/vaultOps";
import {
  createDailyNote,
  DEFAULT_NOTE_TEMPLATE,
  dailyNoteSeed,
  formatDateYmd,
  formatTimeHm,
  renderTemplate,
} from "./lib/templates";
import { matchKeybinding } from "./lib/keybinding";
import { useBusy } from "./hooks/useBusy";
import { useCtrlWheelZoom } from "./hooks/useCtrlWheelZoom";
import { useResolvedDark } from "./hooks/useResolvedDark";
import { useWindowLifecycle } from "./hooks/useWindowLifecycle";
import { useVaultActions } from "./hooks/useVaultActions";
import { useAttachments } from "./hooks/useAttachments";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { clampFontSize } from "./lib/fontSize";
import "./styles/app.css";

function App() {
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const { busy, beginBusy, endBusy } = useBusy();
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [vaultRestored, setVaultRestored] = useState(false);
  const sessionFileRestoredRef = useRef(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphScope, setGraphScope] = useState<GraphScope>("local");
  /** Bumps GraphView reload after save / vault refresh. */
  const [graphEpoch, setGraphEpoch] = useState(0);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  /** Canvas JSON loaded from disk when the board is opened (undefined = new board). */
  const [canvasInitialJson, setCanvasInitialJson] = useState<string | undefined>(undefined);
  /** True while a disk open is in flight — prevents Welcome flash between awaits. */
  const [openingFile, setOpeningFile] = useState(false);
  const openingFileRef = useRef(false);
  /** 1-based source line jump from CmdK search (consumed by SourceEditor). */
  const [scrollLine, setScrollLine] = useState<number | null>(null);
  /** Bump to open CodeMirror find/replace panel. */
  const [findRequest, setFindRequest] = useState(0);
  const [ollamaGenerating, setOllamaGenerating] = useState(false);
  const ollamaAbortRef = useRef<AbortController | null>(null);

  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const tocRef = useRef(toc);
  const vaultRef = useRef(vault);
  const settingsRef = useRef(settings);
  const readyRef = useRef(ready);
  const recentRef = useRef(recent);
  // Mirror the latest state into refs for the stable callbacks (openPath,
  // keydown, hydrate, …) that must read a same-commit value. Written in a
  // layout effect rather than during render so an interrupted/concurrent render
  // can never publish a stale or discarded snapshot; layout effects flush
  // synchronously before paint and before any event handler can run, so
  // same-tick readers still see the committed value.
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
    tocRef.current = toc;
    vaultRef.current = vault;
    settingsRef.current = settings;
    readyRef.current = ready;
    recentRef.current = recent;
  });
  const openGenRef = useRef(0);
  /** Live source editor for drag-drop insert-at-cursor. */
  const editorViewRef = useRef<import("@codemirror/view").EditorView | null>(null);
  /** Per-tab hydrate generation — bump to cancel in-flight chunk loops. */
  const hydrateGenRef = useRef<Map<string, number>>(new Map());
  /** Per-tab progress unlisten, so a closed tab cannot leak its listener. */
  const hydrateUnlistenRef = useRef<Map<string, () => void>>(new Map());
  const pendingHeadingRef = useRef<string | null>(null);
  const pendingLineRef = useRef<number | null>(null);
  const tocOwnerRef = useRef<string | null>(null);
  const saveChainRef = useRef(Promise.resolve());
  const diskPromptRef = useRef(false);
  const snoozedDiskRef = useRef<{ path: string; mtimeMs: number } | null>(null);
  /** Always-current keydown handler; the window listener is registered once (no per-keystroke churn). */
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});

  const vaultFiles = useMemo(
    () => (vault ? flattenVaultFiles(vault.root, vault.tree) : []),
    [vault],
  );

  const dailyExistingDates = useMemo(() => {
    const folder = settings.dailyFolder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const set = new Set<string>();
    for (const file of vaultFiles) {
      const rel = file.relative.replace(/\\/g, "/");
      const prefix = folder ? `${folder}/` : "";
      if (prefix && !rel.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const name = prefix ? rel.slice(prefix.length) : rel;
      const m = /^(\d{4}-\d{2}-\d{2})\.(md|markdown|mdown|mkd)$/i.exec(name);
      if (m) set.add(m[1]!);
    }
    return set;
  }, [vaultFiles, settings.dailyFolder]);

  const dark = useResolvedDark(settings.scheme);
  const active = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? null,
    [tabs, activeId],
  );
  const dirty = active ? isDirty(active) : false;

  const patchTab = useCallback((id: string, patch: Partial<DocTab>) => {
    setTabs((prev) => {
      const next = prev.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
      // Keep tabsRef in sync inside the updater so same-tick readers (multi-drop,
      // AI apply, rapid open/save) never see a stale snapshot.
      tabsRef.current = next;
      return next;
    });
  }, []);

  const patchActive = useCallback(
    (patch: Partial<DocTab>) => {
      if (!activeId) return;
      patchTab(activeId, patch);
    },
    [activeId, patchTab],
  );

  const runEditorAiAction = useCallback(
    async (opts: {
      buildPrompt: (source: string) => string;
      apply: "append-heading" | "replace-or-append" | "continue";
      headingKey?:
        | "app.aiSummaryHeading"
        | "app.aiPolishHeading"
        | "app.aiProofreadHeading"
        | "app.aiTranslateHeading";
      selectionInsertMode?: "replace-with-newline";
      selectionDone?: string;
    }) => {
      const note = tabsRef.current.find((tab) => tab.id === activeIdRef.current) ?? null;
      const cfg = settingsRef.current;
      if (!note || !cfg.ollamaEnabled) return;
      const tabId = note.id;

      const controller = new AbortController();
      ollamaAbortRef.current = controller;
      setOllamaGenerating(true);
      setStatus(t("app.ollamaGenerating"));

      try {
        const view = editorViewRef.current;
        const hasSel = Boolean(view && !view.state.selection.main.empty);
        const targetText = hasSel
          ? view!.state.sliceDoc(view!.state.selection.main.from, view!.state.selection.main.to)
          : note.content;

        const raw = await ollamaGenerate({
          settings: cfg,
          prompt: opts.buildPrompt(targetText),
          signal: controller.signal,
        });
        const out = stripModelOutputFences(raw);

        // Re-read the live tab after await — never apply against a stale snapshot.
        const latest = tabsRef.current.find((tab) => tab.id === tabId);
        if (!latest) return;

        if (opts.apply === "continue") {
          if (hasSel && view && !view.state.readOnly) {
            const { to } = view.state.selection.main;
            view.dispatch({
              changes: { from: to, insert: `\n\n${out}` },
              scrollIntoView: true,
            });
            setStatus(opts.selectionDone || t("app.aiInserted"));
          } else {
            patchTab(tabId, { content: `${latest.content.trimEnd()}\n\n${out}\n` });
            setStatus(t("app.aiInserted"));
          }
          return;
        }

        if (hasSel && view && !view.state.readOnly) {
          const { from, to } = view.state.selection.main;
          const insert =
            opts.selectionInsertMode === "replace-with-newline" ? `${out}\n` : out;
          view.dispatch({
            changes: { from, to, insert },
            selection:
              opts.selectionInsertMode === "replace-with-newline"
                ? undefined
                : { anchor: from, head: from + insert.length },
            scrollIntoView: true,
          });
          setStatus(opts.selectionDone || t("app.aiInserted"));
          return;
        }

        if (opts.apply === "append-heading" || opts.apply === "replace-or-append") {
          const heading = opts.headingKey ? t(opts.headingKey) : "";
          const next = heading
            ? `${latest.content.trimEnd()}\n\n## ${heading}\n\n${out}\n`
            : `${latest.content.trimEnd()}\n\n${out}\n`;
          patchTab(tabId, { content: next });
          setStatus(t("app.aiInserted"));
        }
      } catch (e: unknown) {
        if (controller.signal.aborted || isAbortError(e)) {
          setStatus(t("app.ollamaAborted"));
        } else {
          setStatus(formatAppError(e));
        }
      } finally {
        ollamaAbortRef.current = null;
        setOllamaGenerating(false);
      }
    },
    [patchTab],
  );


  const handleTaskToggle = useCallback(
    (index: number) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!tab) return;
      const next = toggleTaskAt(tab.content, index);
      if (next == null) return;
      patchTab(tab.id, { content: next });
    },
    [patchTab],
  );

  const handleFontSize = useCallback((fontSize: number) => {
    setSettings((s) => {
      const next = clampFontSize(fontSize);
      return s.fontSize === next ? s : { ...s, fontSize: next };
    });
  }, []);

  useCtrlWheelZoom(settings.fontSize, handleFontSize);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("markelle-scheme", settings.scheme);
    } catch (err) {
      /* quota / private mode — non-fatal, but log so a real storage failure is visible */
      console.warn("markelle: failed to persist scheme preference", err);
    }
  }, [dark, settings.scheme]);

  useEffect(() => {
    setReady(true);
    void (async () => {
      try {
        const [s, r] = await Promise.all([loadSettings(), loadRecent()]);
        setSettings(s);
        setRecent(r);
      } catch (err) {
        setStatus(formatAppError(err, t("app.loadSettingsFailed")));
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!ready || !hydrated) return;
    const timer = window.setTimeout(() => {
      // Surface a persistence failure (disk full / store timeout) instead of
      // swallowing it — saveSettings now rejects when store.save() stalls.
      void saveSettings(settings).catch((err) => {
        setStatus(formatAppError(err, t("app.saveSettingsFailed")));
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [settings, ready, hydrated]);

  useEffect(() => {
    document.documentElement.classList.toggle("immersive", settings.immersive);
  }, [settings.immersive]);

  /** Remember maximized state so exiting immersion restores it (not a tiny window). */
  const preImmersiveMaximizedRef = useRef(false);

  // True fullscreen hides the Windows taskbar — maximized alone leaves it as a black strip.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const win = getCurrentWindow();
        if (settings.immersive) {
          preImmersiveMaximizedRef.current = await win.isMaximized();
          if (cancelled) return;
          await win.setFocus();
          if (cancelled) return;
          await win.setFullscreen(true);
          if (cancelled) return;
          // Some Windows builds need a second pass after focus/layout.
          if (!(await win.isFullscreen())) {
            if (cancelled) return;
            await win.maximize();
            if (cancelled) return;
            await win.setFullscreen(true);
          }
        } else {
          const fs = await win.isFullscreen();
          if (cancelled) return;
          if (fs) {
            await win.setFullscreen(false);
            if (cancelled) return;
            if (preImmersiveMaximizedRef.current) {
              await win.maximize();
            }
          }
        }
      } catch (err) {
        /* web preview / permission — fullscreen control is best-effort */
        console.warn("markelle: immersive window control failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.immersive]);

  const wasDirtyRef = useRef(false);
  useEffect(() => {
    if (dirty && !wasDirtyRef.current) {
      setStatus(t("status.unsaved"));
    }
    wasDirtyRef.current = dirty;
  }, [dirty]);

  const toggleImmersive = useCallback((force?: boolean) => {
    const next = force ?? !settingsRef.current.immersive;
    if (next === settingsRef.current.immersive) return;
    setSettings((s) => ({ ...s, immersive: next }));
    setStatus(next ? t("app.immersiveEntered") : t("app.immersiveExited"));
  }, []);

  useEffect(() => {
    const onToggle = () => toggleImmersive();
    window.addEventListener(IMMERSIVE_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(IMMERSIVE_TOGGLE_EVENT, onToggle);
  }, [toggleImmersive]);

  const flushSettings = useCallback(async () => {
    if (!readyRef.current) return;
    try {
      await saveSettings(settingsRef.current);
      await flushStore();
    } catch (err) {
      /* best-effort: the in-memory settings are still authoritative this session */
      console.warn("markelle: failed to flush settings to disk", err);
    }
  }, []);

  const refreshPlugins = useCallback(async (vaultRoot: string | null) => {
    try {
      const disk = await listDiskPlugins(vaultRoot);
      setPlugins(mergePlugins(disk));
    } catch (err) {
      // Surface the failure instead of silently pretending only built-ins exist.
      console.warn("markelle: failed to load disk plugins", err);
      setPlugins(mergePlugins([]));
      setStatus(t("app.pluginsLoadFailed"));
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refreshPlugins(vault?.root ?? null);
  }, [ready, vault?.root, refreshPlugins]);

  useEffect(() => {
    setLocale(settings.locale);
  }, [settings.locale]);

  // Sync system tray visibility and locale with settings.
  useEffect(() => {
    if (!ready) return;
    void invoke("set_tray_visible", {
      visible: settings.trayEnabled,
      locale: settings.locale,
    }).catch(() => {
      /* web preview / older builds */
    });
    if (!settings.trayEnabled) {
      void getCurrentWindow()
        .show()
        .then(() => getCurrentWindow().setFocus())
        .catch(() => {
          /* ignore */
        });
    }
  }, [ready, settings.trayEnabled, settings.locale]);

  useEffect(() => {
    if (!ready) return;
    void applyEnabledPlugins(
      plugins,
      settings.enabledPlugins,
      setStatus,
      settings.pluginSettings,
      (pluginSettings) => setSettings((s) => ({ ...s, pluginSettings })),
    ).catch((err) => setStatus(formatAppError(err)));
  }, [ready, plugins, settings.enabledPlugins, settings.pluginSettings]);

  useEffect(() => {
    if (!ready) return;
    void applyVaultStyle(vault?.root ?? null);
  }, [ready, vault?.root]);

  const patchDock = useCallback((dock: DockLayout) => {
    setSettings((s) => ({ ...s, dock }));
  }, []);

  const onTogglePanel = useCallback((id: PanelId) => {
    setSettings((s) => ({ ...s, dock: togglePanel(s.dock, id) }));
  }, []);

  useEffect(() => {
    const onOpenAi = () => {
      onTogglePanel("ai");
    };
    // Editor / reader context menus dispatch "markelle:ai-action" with the
    // requested action in the event detail. Open the panel, then run the same
    // AI pipeline the command palette uses.
    const onAiAction = (event: Event) => {
      if (!isPanelVisible(settings.dock, "ai")) {
        onTogglePanel("ai");
      }
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      switch (action) {
        case "summarize":
          void runEditorAiAction({
            buildPrompt: summarizePrompt,
            apply: "append-heading",
            headingKey: "app.aiSummaryHeading",
            selectionInsertMode: "replace-with-newline",
          });
          break;
        case "polish":
          void runEditorAiAction({
            buildPrompt: polishPrompt,
            apply: "replace-or-append",
            headingKey: "app.aiPolishHeading",
            selectionDone: t("app.aiSelectionPolished"),
          });
          break;
        case "continue":
          void runEditorAiAction({
            buildPrompt: continuePrompt,
            apply: "continue",
            selectionDone: t("app.aiSelectionContinued"),
          });
          break;
        case "proofread":
          void runEditorAiAction({
            buildPrompt: proofreadPrompt,
            apply: "replace-or-append",
            headingKey: "app.aiProofreadHeading",
            selectionDone: t("app.aiSelectionProofread"),
          });
          break;
        case "translate":
          void runEditorAiAction({
            buildPrompt: translatePrompt,
            apply: "replace-or-append",
            headingKey: "app.aiTranslateHeading",
            selectionDone: t("app.aiSelectionTranslated"),
          });
          break;
        default:
          break;
      }
    };
    window.addEventListener("markelle:open-ai", onOpenAi);
    window.addEventListener("markelle:ai-action", onAiAction);
    return () => {
      window.removeEventListener("markelle:open-ai", onOpenAi);
      window.removeEventListener("markelle:ai-action", onAiAction);
    };
  }, [onTogglePanel, settings.dock, runEditorAiAction]);

  const onToggleRightDock = useCallback((preferredPanel?: PanelId) => {
    setSettings((s) => {
      const right = s.dock.right;
      const allAux: PanelId[] = ["ai", "history", "query", "tags", "backlinks", "toc", "calendar"];
      if (right.active && (!preferredPanel || right.active === preferredPanel)) {
        return { ...s, dock: { ...s.dock, right: { ...right, active: null } } };
      }
      const target = preferredPanel || right.active || right.panels[0] || "ai";
      const panels = right.panels.length > 0 ? right.panels : allAux;
      return { ...s, dock: { ...s.dock, right: { ...right, panels, active: target } } };
    });
  }, []);

  const vaultRootRef = useRef<string | null | undefined>(null);
  // Same latest-value mirror as the block above; read by closeVault (post-commit).
  useLayoutEffect(() => {
    vaultRootRef.current = vault?.root ?? null;
  });

  const { loadVault, pickVault, closeVault } = useVaultActions({
    beginBusy,
    endBusy,
    setStatus,
    setVault,
    setSettings,
    setGraphOpen,
    vaultRootRef,
  });

  const { importPathAsAttachment, importClipboardFiles } =
    useAttachments({
      vaultRef,
      tabsRef,
      activeIdRef,
      settingsRef,
      patchTab,
      setStatus,
    });

  /** Read-mode paste: import then append markdown to the active note. */
  const handleReadPasteImages = useCallback(
    async (files: File[]) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!tab || tab.truncated) return false;
      const links = await importClipboardFiles(files);
      if (!Array.isArray(links) || !links.length) return false;
      const cur = tabsRef.current.find((t) => t.id === tab.id);
      if (!cur) return false;
      const block = links.join("\n");
      const content =
        cur.content.endsWith("\n") || cur.content.length === 0
          ? `${cur.content}${block}\n`
          : `${cur.content}\n${block}\n`;
      patchTab(tab.id, { content });
      return links;
    },
    [importClipboardFiles, patchTab],
  );

  /** Toolbar / dialog: pick images from disk; returns markdown links for cursor insert. */
  const handleInsertImageDialog = useCallback(async (): Promise<string[] | null> => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!tab || tab.truncated) {
      setStatus(t("app.needEditableNote"));
      return null;
    }
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "gif",
              "webp",
              "bmp",
              "avif",
              "ico",
              "heic",
              "heif",
            ],
          },
        ],
      });
      const paths = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : [];
      if (!paths.length) return null;
      const links: string[] = [];
      for (const path of paths) {
        const rel = await importPathAsAttachment(path);
        if (!rel) continue;
        links.push(markdownImageLink(rel, basename(path)));
      }
      if (!links.length) return null;
      setStatus(t("largeFile.imagesInserted", { n: links.length }));
      return links;
    } catch (err) {
      setStatus(formatAppError(err, t("app.insertImageFailed")));
      return null;
    }
  }, [importPathAsAttachment]);

  useEffect(() => {
    if (!hydrated || vaultRestored) return;
    setVaultRestored(true);
    if (settings.restoreLastVault && settings.lastVaultPath) {
      const key = normalizePath(settings.lastVaultPath);
      const trusted = settings.trustedVaultPaths.some((p) => normalizePath(p) === key);
      if (trusted) {
        void loadVault(settings.lastVaultPath);
      } else {
        setStatus(t("status.vaultNeedTrust"));
      }
    }
  }, [
    hydrated,
    vaultRestored,
    settings.restoreLastVault,
    settings.lastVaultPath,
    settings.trustedVaultPaths,
    loadVault,
  ]);

  const startHydrate = useCallback((tabId: string, opened: OpenedFile) => {
    if (!opened.truncated) return;
    const gen = (hydrateGenRef.current.get(tabId) ?? 0) + 1;
    hydrateGenRef.current.set(tabId, gen);
    const pathKey = opened.path.replace(/\\/g, "/").toLowerCase();

    // Mark as backend-buffered immediately — never grow `content` during hydrate.
    // Seed already lives in Rust from read_markdown_file → viewing is ready now.
    setTabs((prev) => {
      const next = prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              backendBuffer: true,
              large: true,
              truncated: true,
              hydrateRatio: Math.max(0.01, (opened.bytesRead ?? 0) / Math.max(1, opened.size)),
              largeDirty: false,
            }
          : t,
      );
      tabsRef.current = next;
      return next;
    });

    let unlisten: (() => void) | undefined;
    let lastUiMs = 0;
    let lastPct = -1;
    let lastLineCount = -1;
    let sawReady = false;
    void listenLargeFileProgress((p) => {
      if (hydrateGenRef.current.get(tabId) !== gen) return;
      if (p.path.replace(/\\/g, "/").toLowerCase() !== pathKey) return;
      const pct = p.size > 0 ? Math.floor((p.bytesRead / p.size) * 100) : 0;
      const now = Date.now();
      const readyEdge = Boolean(p.ready) && !sawReady;
      if (p.ready) sawReady = true;
      const meaningful =
        p.done ||
        readyEdge ||
        Boolean(p.error) ||
        pct !== lastPct ||
        (p.lineCount || 0) !== lastLineCount;
      // Cap App re-renders while indexing — only push UI on % / line-count edges.
      if (!meaningful && now - lastUiMs < 400) return;
      lastUiMs = now;
      lastPct = pct;
      lastLineCount = p.lineCount || 0;
      // Non-urgent: keep scroll/input responsive during hydrate (Vercel rerender-transitions).
      startTransition(() => {
        setTabs((prev) => {
          const next = prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  // Keep first-paint preview content — do NOT assign full file text.
                  bytesRead: p.bytesRead,
                  hydrateRatio: p.size > 0 ? p.bytesRead / p.size : 1,
                  truncated: !p.done,
                  backendBuffer: true,
                  lineCount: p.lineCount || t.lineCount,
                  ...(p.done && !p.error
                    ? { truncated: false, hydrateRatio: 1, largeDirty: false }
                    : {}),
                }
              : t,
          );
          tabsRef.current = next;
          return next;
        });
        if (activeIdRef.current === tabId) {
          setStatus(formatHydrateStatus(p));
        }
      });
      if (p.done) {
        unlisten?.();
        hydrateUnlistenRef.current.delete(tabId);
        if (p.error) setStatus(formatAppError(p.error, t("app.largeFileLoadFailed")));
      }
    }).then((fn) => {
      unlisten = fn;
      // A close may have raced us here — then it is already cancelled.
      if (hydrateGenRef.current.get(tabId) === gen) {
        hydrateUnlistenRef.current.set(tabId, fn);
      } else {
        fn();
      }
    });

    void hydrateLargeFile(opened.path).catch((err) => {
      unlisten?.();
      hydrateUnlistenRef.current.delete(tabId);
      if (hydrateGenRef.current.get(tabId) !== gen) return;
      setStatus(formatAppError(err, t("app.largeFileLoadFailed")));
      setTabs((prev) => {
        const next = prev.map((t) =>
          t.id === tabId ? { ...t, truncated: true, hydrateRatio: t.hydrateRatio ?? 0 } : t,
        );
        tabsRef.current = next;
        return next;
      });
    });
  }, []);

  const openPath = useCallback(async (
    path: string,
    forceFull = false,
    heading?: string,
    options?: { authorize?: boolean; line?: number },
  ) => {
    const headingTrim = heading?.trim() ? heading.trim() : null;
    const authorize = options?.authorize === true;
    const jumpLine =
      typeof options?.line === "number" && options.line > 0 ? Math.floor(options.line) : null;

    // Instant tab focus — no disk read, no busy chrome, no TOC wipe.
    if (!forceFull) {
      const existing = findTabByPath(tabsRef.current, path);
      if (existing) {
        setActiveId(existing.id);
        if (!settingsRef.current.graphKeepOpen) setGraphOpen(false);
        pendingHeadingRef.current = headingTrim;
        pendingLineRef.current = jumpLine;
        if (jumpLine) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === existing.id ? { ...t, mode: "source" as const } : t,
            ),
          );
        }
        if (
          headingTrim &&
          existing.id === activeIdRef.current &&
          tocOwnerRef.current === existing.id &&
          tocRef.current.length > 0
        ) {
          const id = resolveHeadingId(headingTrim, tocRef.current);
          pendingHeadingRef.current = null;
          window.requestAnimationFrame(() => {
            document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        }
        if (existing.truncated) {
          startHydrate(existing.id, {
            path: existing.path,
            name: existing.name,
            content: existing.content,
            size: existing.size,
            truncated: true,
            encoding: existing.encoding ?? "utf-8",
            mtimeMs: existing.diskMtimeMs ?? 0,
            bytesRead: existing.bytesRead ?? existing.content.length,
            large: Boolean(existing.large),
          });
          setStatus(t("app.loadingSize", { size: formatBytes(existing.size) }));
        } else {
          setStatus(
            existing.large
              ? t("app.openedLarge", { size: formatBytes(existing.size) })
              : existing.name,
          );
        }
        return;
      }
    }

    // Wiki / relative links: only navigate within vault or same folder as an open note.
    if (!authorize) {
      const vaultRoot = vaultRef.current?.root;
      const underVault = vaultRoot ? isPathUnder(path, vaultRoot) : false;
      const underOpenFolder = tabsRef.current.some(
        (t) => isSameDirectory(path, t.path) || isPathUnder(path, t.baseDir),
      );
      if (!underVault && !underOpenFolder) {
        setStatus(t("app.outsideVault"));
        return;
      }
    }

    const gen = ++openGenRef.current;
    // Whichever tab the user was on when this open started. Reading from disk can
    // take a while; if they switch tabs meanwhile, the tab still opens but must
    // not yank focus back (§ openPath completion below).
    const activeAtOpen = activeIdRef.current;
    // Hide Welcome immediately so async I/O never flashes the empty state.
    openingFileRef.current = true;
    setOpeningFile(true);
    if (!settingsRef.current.graphKeepOpen) setGraphOpen(false);
    const statusTimer: number | null = window.setTimeout(() => {
      if (gen === openGenRef.current) setStatus(t("app.openingFile"));
    }, 140);
    try {
      if (authorize) {
        await registerAccess([path]);
      }

      const st = await statMarkdownFile(path);
      if (gen !== openGenRef.current) return;

      const ABSOLUTE_MAX_BYTES = 10 * 1024 * 1024 * 1024;
      if (st.size > ABSOLUTE_MAX_BYTES) {
        await askAlert(
          t("app.largeDocOverHardCap", { size: formatBytes(st.size) }),
          { title: "Markelle", kind: "error" },
        );
        setStatus(t("app.largeDocOverHardCapStatus", { size: formatBytes(st.size) }));
        return;
      }

      if (st.size > LARGE_FILE_WARN_BYTES) {
        const ok = await askConfirm(
          t("app.confirmLargeOpen", { size: formatBytes(st.size) }),
          { title: "Markelle", kind: "warning" },
        );
        if (!ok) {
          setStatus(t("app.cancelledOpenLarge"));
          return;
        }
      }

      const alreadyOpen = findTabByPath(tabsRef.current, path);
      if (!alreadyOpen && st.isLarge) {
        const largeTabs = tabsRef.current.filter(isLargeTab);
        if (largeTabs.length >= MAX_LARGE_FILE_TABS) {
          const victim = largeTabs[0]!;
          const ok = await askConfirm(
            t("app.confirmLargeLimit", { max: MAX_LARGE_FILE_TABS, name: victim.name }),
            { title: "Markelle", kind: "warning" },
          );
          if (!ok) {
            setStatus(t("app.cancelledLargeFull"));
            return;
          }
          if (isDirty(victim)) {
            const discard = await askConfirm(
              t("app.confirmDiscardClose", { name: victim.name }),
              { title: "Markelle", kind: "warning" },
            );
            if (!discard) {
              setStatus(t("app.cancelledOpen"));
              return;
            }
          }
          hydrateGenRef.current.set(
            victim.id,
            (hydrateGenRef.current.get(victim.id) ?? 0) + 1,
          );
          hydrateUnlistenRef.current.get(victim.id)?.();
          hydrateUnlistenRef.current.delete(victim.id);
          if (victim.backendBuffer || victim.large) {
            void largeFileClose(victim.path).catch(() => {});
          }
          const pruned = tabsRef.current.filter((t) => t.id !== victim.id);
          tabsRef.current = pruned;
          setTabs(pruned);
        }
      }

      // Direct full loading of all files into the virtualized editor.
      const opened = await readMarkdownFile(path, true);
      if (gen !== openGenRef.current) return;
      const dir = dirname(opened.path);

      if (forceFull) {
        const existing = findTabByPath(tabsRef.current, opened.path);
        if (existing && isDirty(existing)) {
          const ok = await askConfirm(t("app.confirmReloadDiscard"), {
            title: "Markelle",
            kind: "warning",
          });
          if (!ok) {
            setStatus(t("app.cancelledReload"));
            return;
          }
        }
      }

      const { tabs: nextTabs, focusId } = upsertOpenedTab(
        tabsRef.current,
        opened,
        dir,
        forceFull,
      );
      let tabsOut = nextTabs;
      if (jumpLine) {
        tabsOut = nextTabs.map((t) =>
          t.id === focusId ? { ...t, mode: "source" as const } : t,
        );
      }
      tabsRef.current = tabsOut;
      setTabs(tabsOut);
      // Focus the tab only if the user is still where they were when the read
      // began — otherwise they have navigated away deliberately, so the file
      // opens in the background instead of pulling focus off their tab.
      if (activeIdRef.current === activeAtOpen) {
        pendingHeadingRef.current = headingTrim;
        pendingLineRef.current = jumpLine;
        setActiveId(focusId);
      }
      openingFileRef.current = false;
      setOpeningFile(false);
      setStatus(
        opened.truncated
          ? t("app.instantOpen", { size: formatBytes(opened.size) })
          : opened.encoding && opened.encoding !== "utf-8"
            ? `${formatBytes(opened.size)} · ${opened.encoding}`
            : `${formatBytes(opened.size)}`,
      );

      if (opened.truncated) {
        startHydrate(focusId, opened);
      }

      void pushRecent({ path: opened.path, name: opened.name })
        .then((nextRecent) => {
          if (gen === openGenRef.current) setRecent(nextRecent);
        })
        .catch(() => {
          /* ignore */
        });
    } catch (err) {
      if (gen !== openGenRef.current) return;
      setStatus(formatAppError(err, t("app.openFileFailed")));
    } finally {
      if (statusTimer != null) window.clearTimeout(statusTimer);
      if (gen === openGenRef.current) {
        openingFileRef.current = false;
        setOpeningFile(false);
      }
    }
  }, [startHydrate]);

  const handleWikiOpen = useCallback(
    (path: string, heading?: string) => {
      void openPath(path, false, heading);
    },
    [openPath],
  );

  // Consume pending line jump. Read mode switches to source so the editor can land.
  useEffect(() => {
    const line = pendingLineRef.current;
    if (!line || !active) return;
    if (active.mode === "read") {
      patchTab(active.id, { mode: "source" });
      return;
    }
    setScrollLine(line);
    pendingLineRef.current = null;
  }, [active, patchTab]);

  // Safety net: never leave tabs open with a stale/empty activeId (welcome stuck).
  useEffect(() => {
    const resolved = resolveActiveId(tabs, activeId);
    if (resolved !== activeId) setActiveId(resolved);
  }, [tabs, activeId]);

  // Jump to heading after TOC is ready for the focused tab.
  useEffect(() => {
    const heading = pendingHeadingRef.current;
    if (!heading || toc.length === 0) return;
    if (tocOwnerRef.current !== activeId) return;
    pendingHeadingRef.current = null;
    const id = resolveHeadingId(heading, toc);
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [toc, activeId]);

  const { quitApplication } = useWindowLifecycle({
    tabsRef,
    settingsRef,
    flushSettings,
    setStatus,
    onOpenSettings: () => setSettingsOpen(true),
  });

  useEffect(() => {
    setPendingOpenConsumer((item) => {
      if (item.kind === "file") {
        // Only the main window may spawn new windows. A freshly created `doc-*`
        // window still receives the same open-file request from the single-instance
        // forwarder, so without this guard it would open yet another window for the
        // same file (see the matching guard on the startup-argument path below).
        if (settingsRef.current.openFilesInNewWindow && getCurrentWindow().label === "main") {
          void openPathInNewWindow(item.path).catch((err) =>
            setStatus(formatAppError(err)),
          );
        } else {
          void openPath(item.path, false, undefined, { authorize: true });
        }
      } else {
        void loadVault(item.path, { trust: true });
      }
    });
    return () => setPendingOpenConsumer(null);
  }, [openPath, loadVault]);

  useEffect(() => {
    if (!hydrated || sessionFileRestoredRef.current) return;
    sessionFileRestoredRef.current = true;

    const startup = readStartupFileParam();
    if (startup) {
      // Only the main window may spawn the new window; a `doc-*` window already
      // carries the same `?file=` param and must open it locally (otherwise the
      // open-files-in-new-window setting would recurse into endless windows).
      if (settingsRef.current.openFilesInNewWindow && getCurrentWindow().label === "main") {
        void openPathInNewWindow(startup).catch((err) => setStatus(formatAppError(err)));
      } else {
        void openPath(startup, false, undefined, { authorize: true });
      }
      return;
    }

    const timer = window.setTimeout(() => {
      if (tabsRef.current.length > 0 || hasPendingOpen() || openingFileRef.current) return;
      if (!settingsRef.current.restoreLastFile) return;
      const last = recentRef.current[0];
      if (!last?.path) return;
      void openPath(last.path, false, undefined, { authorize: true });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [hydrated, openPath]);

  const pickOpen = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const path of paths) {
      await openPath(path, false, undefined, { authorize: true });
    }
  }, [openPath]);

  const saveFile = useCallback(async () => {
    if (!active) return;
    const block = getWriteBlockReason(active);
    if (block === "truncated") {
      setStatus(t("app.waitHydrateSave"));
      return;
    }
    // A backend-buffered tab keeps only a preview in `content`; the real text
    // lives in Rust. Writing `content` here would truncate the note on disk.
    if (block === "backendBuffer") {
      setStatus(t("app.largeReadOnlySave"));
      return;
    }
    const tabId = active.id;
    const path = active.path;
    const enc = (active.encoding ?? "utf-8").toLowerCase();
    if (enc !== "utf-8" && enc !== "utf8") {
      const ok = await askConfirm(
        t("app.confirmReencode", { enc: active.encoding ?? "" }),
        { title: "Markelle", kind: "warning" },
      );
      if (!ok) return;
    }

    const run = async () => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.path !== path || tab.truncated || tab.backendBuffer) return;
      const knownMtime = tab.diskMtimeMs ?? 0;
      try {
        if (knownMtime > 0) {
          try {
            const st = await statMarkdownFile(path);
            if (st.mtimeMs > knownMtime + 2) {
              const ok = await askConfirm(
                t("app.confirmDiskOverwrite"),
                { title: "Markelle", kind: "warning" },
              );
              if (!ok) {
                setStatus(t("app.cancelledSaveDiskChanged"));
                return;
              }
            }
          } catch {
            /* missing file — proceed to write */
          }
        }
        const latest = tabsRef.current.find((t) => t.id === tabId);
        if (!latest || latest.path !== path || latest.truncated || latest.backendBuffer)
          return;

        let toSave = latest.content;
        if (latest.cryptoPassphrase) {
          if (isEncryptedNote(latest.content)) {
            // Already ciphertext in the buffer — never wrap again.
            toSave = latest.content;
          } else {
            toSave = await encryptNote(latest.content, latest.cryptoPassphrase);
          }
        }
        const st = await writeMarkdownFile(path, toSave);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId && t.path === path
              ? {
                  ...t,
                  savedContent: latest.content,
                  truncated: false,
                  encoding: "utf-8",
                  size: st.size,
                  diskMtimeMs: st.mtimeMs,
                }
              : t,
          ),
        );
        snoozedDiskRef.current = null;
        setStatus(t("app.saved"));
        if (graphOpen) setGraphEpoch((n) => n + 1);
        const v = vaultRef.current;
        const s = settingsRef.current;
        if (v && s.historyEnabled && !(latest.backendBuffer || latest.large)) {
          if (latest.cryptoPassphrase || isEncryptedNote(toSave)) {
            /* encrypted notes never snapshot — plaintext history purged on encrypt */
          } else {
            void historySaveSnapshot(
              v.root,
              path,
              latest.content,
              s.historyMaxVersions,
            ).catch(() => {
              /* history is best-effort */
            });
          }
        }
      } catch (err) {
        setStatus(formatAppError(err));
      }
    };

    const queued = saveChainRef.current.then(run, run);
    saveChainRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }, [active, graphOpen]);

  const saveAs = useCallback(async () => {
    if (!active) return;
    const block = getWriteBlockReason(active);
    if (block === "truncated") {
      setStatus(t("app.waitHydrateSaveAs"));
      return;
    }
    // Preview-only buffers must not be written as complete files.
    if (block === "backendBuffer") {
      setStatus(t("app.largeReadOnlySave"));
      return;
    }
    const target = await saveDialog({
      filters: [{ name: "Markdown", extensions: ["md"] }],
      defaultPath: active.name,
    });
    if (!target) return;
    try {
      await registerAccess([target]);
      // Conflict check before any write — avoid overwriting then cancelling.
      const existingOther = tabsRef.current.find(
        (t) =>
          t.path.replace(/\\/g, "/").toLowerCase() ===
            target.replace(/\\/g, "/").toLowerCase() && t.id !== active.id,
      );
      if (existingOther) {
        if (isDirty(existingOther)) {
          const ok = await askConfirm(
            t("app.confirmSaveAsClose", { name: existingOther.name }),
            { title: "Markelle", kind: "warning" },
          );
          if (!ok) {
            setStatus(t("app.cancelledSaveAs"));
            return;
          }
        }
        const next = tabsRef.current.filter((t) => t.id !== existingOther.id);
        tabsRef.current = next;
        setTabs(next);
      }
      // Write the latest in-memory content (edits made while the dialog was open are kept).
      const latest = tabsRef.current.find((t) => t.id === active.id);
      let toWrite = latest?.content ?? active.content;
      const pass = latest?.cryptoPassphrase ?? active.cryptoPassphrase;
      if (pass && !isEncryptedNote(toWrite)) {
        toWrite = await encryptNote(toWrite, pass);
      }
      await writeMarkdownFile(target, toWrite);
      const opened = await readMarkdownFile(target, true);
      const dir = dirname(opened.path);
      // Keep an unlocked editing session if the source tab had a passphrase.
      const keepPass = pass && isEncryptedNote(toWrite) ? pass : undefined;
      const editorContent =
        keepPass && isEncryptedNote(opened.content)
          ? latest?.content ?? active.content
          : opened.content;
      patchActive({
        path: opened.path,
        name: opened.name,
        content: editorContent,
        savedContent: editorContent,
        cryptoPassphrase: keepPass,
        baseDir: dir,
        size: opened.size,
        truncated: false,
        encoding: opened.encoding,
        diskMtimeMs: opened.mtimeMs,
      });
      const nextRecent = await pushRecent({ path: opened.path, name: opened.name });
      setRecent(nextRecent);
      snoozedDiskRef.current = null;
      setStatus(t("app.savedAs"));
    } catch (err) {
      setStatus(formatAppError(err));
    }
  }, [active, patchActive]);

  const confirmCloseTab = useCallback(async (tab: DocTab) => {
    if (!isDirty(tab)) return true;
    return askConfirm(t("app.confirmCloseDirty", { name: tab.name }), {
      title: "Markelle",
      kind: "warning",
    });
  }, []);

  const closeTab = useCallback(
    async (id: string) => {
      const tab = tabsRef.current.find((item) => item.id === id);
      if (!tab) return;
      if (!(await confirmCloseTab(tab))) return;

      hydrateGenRef.current.set(id, (hydrateGenRef.current.get(id) ?? 0) + 1);
      // Bumping the generation makes the progress callback bail out, so the
      // listener would never be released — unhook it here instead.
      hydrateUnlistenRef.current.get(id)?.();
      hydrateUnlistenRef.current.delete(id);
      if (tab.backendBuffer || tab.large) {
        void largeFileClose(tab.path).catch(() => {
          /* ignore */
        });
      }
      const prev = tabsRef.current;
      const index = prev.findIndex((item) => item.id === id);
      const next = prev.filter((item) => item.id !== id);
      tabsRef.current = next;
      setTabs(next);
      if (activeId === id) {
        const neighbor = next[index] ?? next[index - 1] ?? null;
        setActiveId(neighbor?.id ?? null);
        if (!neighbor) {
          setToc([]);
          tocOwnerRef.current = null;
        }
      }
    },
    [activeId, confirmCloseTab],
  );

  const openActiveInNewWindow = useCallback(async () => {
    if (!active) return;
    if (isDirty(active)) {
      const ok = await askConfirm(t("app.confirmNewWindowDirty"), {
        title: "Markelle",
        kind: "warning",
      });
      if (!ok) return;
    } else {
      const ok = await askConfirm(t("app.confirmNewWindowFork"), {
        title: "Markelle",
        kind: "warning",
      });
      if (!ok) return;
    }
    try {
      await openPathInNewWindow(active.path);
      setStatus(t("app.openedNewWindow"));
    } catch (err) {
      setStatus(formatAppError(err));
    }
  }, [active]);

  const openTabInNewWindow = useCallback(
    async (id: string) => {
      const tab = tabs.find((item) => item.id === id);
      if (!tab) return;
      if (isDirty(tab)) {
        const ok = await askConfirm(t("app.confirmNewWindowDirtyTab"), {
          title: "Markelle",
          kind: "warning",
        });
        if (!ok) return;
      } else {
        const ok = await askConfirm(t("app.confirmNewWindowFork"), {
          title: "Markelle",
          kind: "warning",
        });
        if (!ok) return;
      }
      try {
        await openPathInNewWindow(tab.path);
      } catch (err) {
        setStatus(formatAppError(err));
      }
    },
    [tabs],
  );

  const createNewNote = useCallback(async (dir?: string) => {
    if (!vault) {
      setStatus(t("vault.needOpen"));
      return;
    }
    const baseDir = dir?.trim() ? dir : vault.root;
    const existing = new Set(
      flattenVaultFiles(vault.root, vault.tree).map((f) => normalizePath(f.path)),
    );
    let path: string;
    try {
      path = allocateUniquePath(baseDir, t("app.untitledName"), existing);
    } catch {
      setStatus(t("app.allocFailed"));
      return;
    }
    const name = basename(path);
    const seed = `# ${name.replace(/\.md$/i, "")}\n\n`;
    try {
      await registerAccess([path]);
      await writeMarkdownFile(path, seed);
      await loadVault(vault.root);
      await openPath(path, true, undefined, { authorize: true });
      setStatus(t("app.noteCreated", { name }));
    } catch (err) {
      setStatus(formatAppError(err));
    }
  }, [vault, loadVault, openPath]);

  const openOrCreateDailyNote = useCallback(async () => {
    if (!vault) {
      setStatus(t("vault.needOpen"));
      return;
    }
    const { path, content, dateKey } = createDailyNote(vault.root, new Date(), settings.dailyFolder);
    try {
      try {
        await statMarkdownFile(path);
      } catch {
        await writeMarkdownFile(path, content);
        await loadVault(vault.root);
        setStatus(t("app.dailyCreated", { name: dateKey }));
      }
      await openPath(path, true, undefined, { authorize: true });
    } catch (err) {
      setStatus(formatAppError(err));
    }
  }, [vault, loadVault, openPath, settings.dailyFolder]);

  const createFromTemplate = useCallback(async () => {
    if (!vault) {
      setStatus(t("vault.needOpen"));
      return;
    }
    let template = DEFAULT_NOTE_TEMPLATE;
    let templateLabel = t("app.builtinTemplate");
    try {
      const listed = await listVaultTemplates(vault.root);
      if (listed.length === 1) {
        const file = await readMarkdownFile(listed[0]!, true);
        template = file.content;
        templateLabel = basename(listed[0]!);
      } else if (listed.length > 1) {
        const lines = listed.map((p, i) => `${i + 1}. ${basename(p)}`).join("\n");
        const raw = await askPrompt({
          title: "Markelle",
          message: `${t("app.templatePromptMessage")}\n${lines}`,
          initialValue: "1",
          placeholder: t("app.templatePromptPlaceholder"),
        });
        if (raw == null) return;
        const idx = Number.parseInt(raw, 10) - 1;
        if (!Number.isFinite(idx) || idx < 0 || idx >= listed.length) {
          setStatus(t("app.templateIndexInvalid"));
          return;
        }
        const pick = listed[idx]!;
        const file = await readMarkdownFile(pick, true);
        template = file.content;
        templateLabel = basename(pick);
      } else {
        const fallback = joinPath(vault.root, ".markelle", "templates", "默认.md");
        try {
          const file = await readMarkdownFile(fallback);
          template = file.content;
          templateLabel = t("app.defaultTemplateName");
        } catch {
          // built-in DEFAULT_NOTE_TEMPLATE
        }
      }
    } catch (err) {
      setStatus(formatAppError(err, t("app.readTemplateFailed")));
      return;
    }
    const existing = new Set(
      flattenVaultFiles(vault.root, vault.tree).map((f) => normalizePath(f.path)),
    );
    let path: string;
    try {
      path = allocateUniquePath(vault.root, t("app.untitledName"), existing);
    } catch {
      setStatus(t("app.allocFailed"));
      return;
    }
    const title = basename(path).replace(/\.md$/i, "");
    const now = new Date();
    const body = renderTemplate(template, {
      title,
      date: formatDateYmd(now),
      time: formatTimeHm(now),
    });
    try {
      await writeMarkdownFile(path, body);
      await loadVault(vault.root);
      await openPath(path, true, undefined, { authorize: true });
      setStatus(t("app.templateCreated", { name: templateLabel, file: basename(path) }));
    } catch (err) {
      setStatus(formatAppError(err));
    }
  }, [vault, loadVault, openPath]);

  const reorderTabs = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(to, 0, moved);
      tabsRef.current = next;
      return next;
    });
  }, []);

  // Register once; dispatch to the latest handler via ref. This keeps Ctrl+W/S/… responsive
  // and avoids removing/re-adding a window listener on every keystroke.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (cmdOpen || aboutOpen || pluginsOpen || settingsOpen || captureOpen || canvasOpen) {
        // Overlays own their shortcuts; don't steal Ctrl+W etc.
        return;
      }
      const meta = event.ctrlKey || event.metaKey;

      if (meta && event.key.toLowerCase() === "k" && !event.shiftKey) {
        event.preventDefault();
        setCmdOpen((v) => !v);
        return;
      }

      if (meta && event.key === ",") {
        event.preventDefault();
        setPluginsOpen((v) => !v);
        return;
      }
      // Built-in shortcuts first — plugins must not steal Ctrl+S / O / W / …
      if (meta && event.key.toLowerCase() === "n" && event.shiftKey) {
        event.preventDefault();
        setCaptureOpen(true);
        return;
      }
      if (meta && event.key.toLowerCase() === "o" && event.shiftKey) {
        event.preventDefault();
        void pickVault();
        return;
      }
      if (meta && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void pickOpen();
        return;
      }
      if (meta && event.key.toLowerCase() === "b" && event.shiftKey) {
        event.preventDefault();
        onTogglePanel("vault");
        return;
      }
      // Ctrl+B reserved for source bold (CodeMirror); do not steal here.
      if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) void saveAs();
        else void saveFile();
        return;
      }
      if (meta && event.key.toLowerCase() === "e" && event.shiftKey) {
        event.preventDefault();
        onToggleRightDock();
        return;
      }
      if (event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        onTogglePanel("ai");
        return;
      }
      if (meta && event.key.toLowerCase() === "e") {
        event.preventDefault();
        if (graphOpen) {
          setGraphOpen(false);
          return;
        }
        if (active) {
          const next =
            active.mode === "read" ? "source" : active.mode === "source" ? "split" : "read";
          patchActive({ mode: next });
        }
        return;
      }
      if (meta && event.key.toLowerCase() === "g" && vault) {
        event.preventDefault();
        setGraphOpen((v) => !v);
        return;
      }
      if (meta && event.key.toLowerCase() === "w") {
        event.preventDefault();
        if (activeId) void closeTab(activeId);
        return;
      }
      if (meta && event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        void createNewNote();
        return;
      }
      // Ctrl+Shift+N is 快速捕获 (handled above) — there is no new-window chord.

      // Immersive reading — F11 / Esc (exit only)
      if (event.key === "F11") {
        event.preventDefault();
        toggleImmersive();
        return;
      }
      if (event.key === "Escape" && settings.immersive) {
        event.preventDefault();
        toggleImmersive(false);
        return;
      }

      // Plugin keybindings (after reserved chords)
      const reservedPluginSteal = new Set([
        "s",
        "o",
        "w",
        "k",
        "e",
        "g",
        "n",
        ",",
      ]);
      for (const plugin of plugins) {
        if (!settings.enabledPlugins.includes(plugin.id)) continue;
        for (const cmd of plugin.contributes.commands) {
          if (!cmd.keybinding) continue;
          if (matchKeybinding(cmd.keybinding, event)) {
            const key = event.key.toLowerCase();
            if (meta && reservedPluginSteal.has(key)) {
              continue;
            }
            event.preventDefault();
            runPluginCommand(
              plugins,
              cmd.id,
              settings.enabledPlugins,
              setStatus,
              settings.pluginSettings,
              (pluginSettings) => setSettings((s) => ({ ...s, pluginSettings })),
            );
            return;
          }
        }
      }
      if (meta && event.key === "Tab") {
        if (tabs.length < 2) return;
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.id === activeId);
        const nextIndex = event.shiftKey
          ? (index - 1 + tabs.length) % tabs.length
          : (index + 1) % tabs.length;
        setActiveId(tabs[nextIndex]?.id ?? null);
      }
    };
    keyHandlerRef.current = onKey;
  }, [
    pickOpen,
    pickVault,
    saveAs,
    saveFile,
    active,
    activeId,
    patchActive,
    closeTab,
    openActiveInNewWindow,
    createNewNote,
    tabs,
    plugins,
    settings.enabledPlugins,
    settings.immersive,
    toggleImmersive,
    graphOpen,
    vault,
    onTogglePanel,
    onToggleRightDock,
    cmdOpen,
    aboutOpen,
    pluginsOpen,
    settingsOpen,
    captureOpen,
    canvasOpen,
    settings.pluginSettings,
  ]);

  useEffect(() => {
    let cancelled = false;
    let unlistenDrop: (() => void) | undefined;

    void (async () => {
      try {
        const un = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (event.payload.type !== "drop") return;
          const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
          for (const path of event.payload.paths) {
            if (/\.(md|markdown|mdown|mkd)$/i.test(path)) {
              await openPath(path, false, undefined, { authorize: true });
              continue;
            }
            if (tab && isAttachmentDropCandidate(path)) {
              try {
                const rel = await importPathAsAttachment(path);
                if (!rel) continue;
                const snippet = isImageFileName(path)
                  ? markdownImageLink(rel, basename(path))
                  : `[${basename(path)}](${rel})`;
                const cur = tabsRef.current.find((t) => t.id === tab.id);
                if (!cur) continue;

                const view = editorViewRef.current;
                const canInsertAtCursor =
                  !cur.truncated &&
                  (cur.mode === "source" || cur.mode === "split") &&
                  view &&
                  !view.state.readOnly;

                if (canInsertAtCursor && view) {
                  const { from, to } = view.state.selection.main;
                  const insert =
                    from > 0 &&
                    view.state.doc.sliceString(Math.max(0, from - 1), from) !== "\n" &&
                    !snippet.startsWith("\n")
                      ? `\n${snippet}`
                      : snippet;
                  view.dispatch({
                    changes: { from, to, insert },
                    selection: { anchor: from + insert.length },
                    scrollIntoView: true,
                  });
                  view.focus();
                } else {
                  const content =
                    cur.content.endsWith("\n") || cur.content.length === 0
                      ? `${cur.content}${snippet}\n`
                      : `${cur.content}\n${snippet}\n`;
                  patchTab(tab.id, { content });
                }
                setStatus(t("app.attachmentImported", { name: basename(path) }));
              } catch (err) {
                setStatus(formatAppError(err, t("app.importAttachmentFailed")));
              }
            }
          }
        });
        if (cancelled) un();
        else unlistenDrop = un;
      } catch {
        /* web preview */
      }
    })();

    return () => {
      cancelled = true;
      unlistenDrop?.();
    };
  }, [openPath, importPathAsAttachment, patchTab]);

  // Detect external disk changes on tab switch / focus (single prompt gate).
  const promptDiskChange = useCallback(
    async (tabId: string) => {
      if (diskPromptRef.current) return;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.truncated) return;
      const path = tab.path;
      const known = tab.diskMtimeMs ?? 0;
      if (known <= 0) return;

      let st: Awaited<ReturnType<typeof statMarkdownFile>>;
      try {
        st = await statMarkdownFile(path);
      } catch {
        // File deleted or moved on disk
        if (snoozedDiskRef.current?.path === path && snoozedDiskRef.current.mtimeMs === -1) {
          return;
        }
        diskPromptRef.current = true;
        try {
          const current = tabsRef.current.find((t) => t.id === tabId);
          if (!current || current.path !== path) return;
          const ok = await askConfirm(
            t("app.confirmFileDeletedOnDisk", { name: current.name }),
            {
              title: "Markelle",
              kind: "warning",
              okLabel: t("app.keepAndSaveAs"),
              cancelLabel: t("app.closeDeletedTab"),
            },
          );
          if (ok) {
            snoozedDiskRef.current = { path, mtimeMs: -1 };
            setStatus(t("app.fileDeletedKeptInMemory"));
          } else {
            void closeTab(tabId);
          }
        } finally {
          diskPromptRef.current = false;
        }
        return;
      }
      if (st.mtimeMs <= known + 2) return;
      const snoozed = snoozedDiskRef.current;
      if (snoozed && snoozed.path === path && snoozed.mtimeMs === st.mtimeMs) return;

      diskPromptRef.current = true;
      try {
        const current = tabsRef.current.find((t) => t.id === tabId);
        if (!current || current.path !== path) return;
        const dirtyNow = isDirty(current);
        if (dirtyNow) {
          const ok = await askConfirm(
            t("app.confirmDiskChangedDirty"),
            { title: "Markelle", kind: "warning" },
          );
          const after = tabsRef.current.find((t) => t.id === tabId);
          if (!after || after.path !== path) return;
          if (ok) {
            void openPath(path, true, undefined, { authorize: true });
          } else {
            snoozedDiskRef.current = { path, mtimeMs: st.mtimeMs };
            setStatus(t("app.diskChangedNotReloaded"));
          }
        } else {
          const ok = await askConfirm(t("app.confirmDiskChangedReload"), {
            title: "Markelle",
            kind: "info",
          });
          const after = tabsRef.current.find((t) => t.id === tabId);
          if (!after || after.path !== path) return;
          if (ok) {
            if (isDirty(after)) {
              const force = await askConfirm(
                t("app.confirmDiskOverwriteDuringPrompt"),
                { title: "Markelle", kind: "warning" },
              );
              if (!force) {
                snoozedDiskRef.current = { path, mtimeMs: st.mtimeMs };
                setStatus(t("app.diskChangedNotReloaded"));
                return;
              }
            }
            void openPath(path, true, undefined, { authorize: true });
          } else {
            snoozedDiskRef.current = { path, mtimeMs: st.mtimeMs };
          }
        }
      } finally {
        diskPromptRef.current = false;
      }
    },
    [openPath, closeTab],
  );

  useEffect(() => {
    if (!active || active.truncated) return;
    void promptDiskChange(active.id);
    // Member deps only: re-stat the file when the tab, path or mtime changes, but
    // not on every content keystroke (which would hit the disk per character).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.path, active?.diskMtimeMs, promptDiskChange]);

  useEffect(() => {
    const check = () => {
      const id = activeIdRef.current;
      if (id) void promptDiskChange(id);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [promptDiskChange]);

  // Backend vault FS watcher — refresh tree (and check open tab) after external edits.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;

    void listen<{ root: string }>("vault-fs-changed", (event) => {
      const current = vaultRef.current?.root;
      if (!current) return;
      if (normalizePath(event.payload.root) !== normalizePath(current)) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = vaultRef.current?.root;
        if (!root || normalizePath(root) !== normalizePath(current)) return;
        void loadVault(root).then(() => {
          setGraphEpoch((n) => n + 1);
        });
        const id = activeIdRef.current;
        if (!id) return;
        const tab = tabsRef.current.find((t) => t.id === id);
        if (tab && isPathUnder(tab.path, root)) {
          void promptDiskChange(id);
        }
      }, 500);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [loadVault, promptDiskChange]);

  // Autosave dirty buffers after idle.
  useEffect(() => {
    const snoozedForActive =
      Boolean(active) &&
      snoozedDiskRef.current?.path === active!.path;
    if (
      !settings.autosave ||
      !active ||
      !isDirty(active) ||
      active.truncated ||
      diskPromptRef.current ||
      snoozedForActive
    ) return;
    const timer = window.setTimeout(() => {
      if (diskPromptRef.current) return;
      if (snoozedDiskRef.current?.path === active.path) return;
      void saveFile();
    }, settings.autosaveDelayMs);
    return () => window.clearTimeout(timer);
    // Member deps only: `active` is a fresh object on every UI patch, so depending
    // on it directly would restart the autosave countdown for unrelated changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.autosave,
    settings.autosaveDelayMs,
    active?.id,
    active?.content,
    active?.savedContent,
    active?.truncated,
    saveFile,
  ]);

  const onToc = useCallback((items: TocItem[]) => {
    tocOwnerRef.current = activeIdRef.current;
    setToc((prev) => {
      if (
        prev.length === items.length &&
        prev.every(
          (item, i) =>
            item.id === items[i]?.id &&
            item.level === items[i]?.level &&
            item.text === items[i]?.text,
        )
      ) {
        return prev;
      }
      return items;
    });
  }, []);

  const setMode = useCallback(
    (mode: ViewMode) => {
      if (mode === "graph") {
        setGraphOpen(true);
        if (!active) setGraphScope("full");
        return;
      }
      setGraphOpen(false);
      if (active && (active.large || active.backendBuffer) && mode !== "source") {
        setStatus(
          active.truncated
            ? t("app.largeFilePagedPending")
            : t("app.largeFilePaged"),
        );
      }
      patchActive({ mode });
    },
    [active, patchActive],
  );

  useEffect(() => {
    // Outline is read-mode only; clear when leaving read so sidebar doesn't lie.
    if (graphOpen || active?.mode === "source") {
      setToc([]);
      tocOwnerRef.current = null;
    }
  }, [graphOpen, active?.mode]);
  const setBusyStable = useCallback((v: boolean) => {
    if (v) beginBusy();
    else endBusy();
  }, [beginBusy, endBusy]);
  const setStatusStable = useCallback((msg: string) => setStatus(msg), []);

  const displayMode: ViewMode = graphOpen ? "graph" : (active?.mode ?? "read");
  // Split mode re-renders the preview on every keystroke otherwise; debounce it.
  // Read mode has no input, so it passes through with no delay. Switching tabs
  // (active.id changes) resets immediately to avoid a stale preview flash.
  const previewSource = useDebouncedValue(active?.content ?? "", 200, active?.id);
  // Stable identity: SourceEditor keys its CodeMirror extension set on this
  // object, so a fresh `{...}` literal per render forced a full reconfigure
  // (and reset the virtual-doc chunk cache). Depend on the primitives instead
  // of `active`, whose identity changes on every content edit.
  const sourceVirtualDoc = useMemo(() => {
    const backendBuffer = active?.backendBuffer;
    const path = active?.path;
    if (!backendBuffer || !path) return undefined;
    return { path, totalLines: active?.lineCount || 2000 };
  }, [active?.backendBuffer, active?.path, active?.lineCount]);
  const effectiveGraphScope: GraphScope =
    graphScope === "local" && !active ? "full" : graphScope;

  /** Read the saved canvas from disk before showing the board, so it round-trips. */
  const openCanvas = useCallback(async () => {
    const v = vaultRef.current;
    let json: string | undefined;
    if (v) {
      const abs = joinPath(v.root, ".markelle", "canvas", "default.json");
      try {
        const bytes = await readAllowedBytes(abs);
        json = new TextDecoder().decode(bytes);
      } catch {
        json = undefined; // no saved canvas yet
      }
    }
    setCanvasInitialJson(json);
    setCanvasOpen(true);
  }, []);

  const commands: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [
      {
        id: "open-file",
        label: t("welcome.openFile"),
        hint: "Ctrl+O",
        group: t("cmdGroup.file"),
        run: () => void pickOpen(),
      },
      {
        id: "open-vault",
        label: t("welcome.openVault"),
        hint: "Ctrl+Shift+O",
        group: t("cmdGroup.file"),
        run: () => void pickVault(),
      },
      {
        id: "new-note",
        label: t("vault.ctxNewNote"),
        hint: "Ctrl+N",
        group: t("cmdGroup.file"),
        disabled: !vault,
        run: () => void createNewNote(),
      },
      {
        id: "daily-note",
        label: t("settings.captureTargetDaily"),
        group: t("cmdGroup.file"),
        disabled: !vault,
        run: () => void openOrCreateDailyNote(),
      },
      {
        id: "new-from-template",
        label: t("cmdItem.fromTemplate"),
        group: t("cmdGroup.file"),
        disabled: !vault,
        run: () => void createFromTemplate(),
      },
      {
        id: "save",
        label: t("toolbar.save"),
        hint: "Ctrl+S",
        group: t("cmdGroup.file"),
        disabled: !active || !dirty || Boolean(active?.truncated),
        run: () => void saveFile(),
      },
      {
        id: "save-as",
        label: t("cmdItem.saveAs"),
        hint: "Ctrl+Shift+S",
        group: t("cmdGroup.file"),
        disabled: !active || Boolean(active?.truncated),
        run: () => void saveAs(),
      },
      {
        id: "find-replace",
        label: t("cmdItem.findReplace"),
        hint: "Ctrl+F",
        group: t("cmdGroup.edit"),
        disabled: !active,
        run: () => {
          setGraphOpen(false);
          if (active?.mode === "read") patchActive({ mode: "source" });
          window.setTimeout(() => setFindRequest((n) => n + 1), 40);
        },
      },
      {
        id: "insert-math",
        label: t("cmdItem.insertMath"),
        hint: "Ctrl+Shift+M",
        group: t("cmdGroup.edit"),
        disabled: !active,
        run: () => {
          if (!active) return;
          if (active.mode === "read") patchActive({ mode: "source" });
          const snip = "$$\n\n$$\n";
          const c = active.content;
          patchActive({
            content: c.endsWith("\n") || !c ? `${c}${snip}` : `${c}\n${snip}`,
          });
          setStatus(t("app.formulaInserted"));
        },
      },
      {
        id: "insert-mermaid",
        label: t("cmdItem.insertMermaid"),
        hint: "Ctrl+Shift+D",
        group: t("cmdGroup.edit"),
        disabled: !active,
        run: () => {
          if (!active) return;
          if (active.mode === "read") patchActive({ mode: "source" });
          const snip = "```mermaid\nflowchart LR\n  A --> B\n```\n";
          const c = active.content;
          patchActive({
            content: c.endsWith("\n") || !c ? `${c}${snip}` : `${c}\n${snip}`,
          });
          setStatus(t("app.mermaidInserted"));
        },
      },
      {
        id: "mode-read",
        label: t("cmdItem.modeRead"),
        hint: "Ctrl+E",
        group: t("cmdGroup.view"),
        disabled: !active,
        run: () => {
          setGraphOpen(false);
          if (active) patchActive({ mode: "read" });
        },
      },
      {
        id: "mode-source",
        label: t("cmdItem.modeSource"),
        hint: "Ctrl+E",
        group: t("cmdGroup.view"),
        disabled: !active,
        run: () => {
          setGraphOpen(false);
          if (active) patchActive({ mode: "source" });
        },
      },
      {
        id: "mode-split",
        label: t("cmdItem.modeSplit"),
        hint: "Ctrl+E",
        group: t("cmdGroup.view"),
        disabled: !active,
        run: () => {
          setGraphOpen(false);
          if (active) patchActive({ mode: "split" });
        },
      },
      {
        id: "toggle-autosave",
        label: settings.autosave ? t("toolbar.autosaveOff") : t("toolbar.autosaveOn"),
        group: t("cmdGroup.file"),
        run: () => setSettings((s) => ({ ...s, autosave: !s.autosave })),
      },
      {
        id: "graph",
        label: graphOpen ? t("cmdItem.graphClose") : t("cmdItem.graphOpen"),
        hint: "Ctrl+G",
        group: t("cmdGroup.view"),
        disabled: !vault,
        run: () => setGraphOpen((v) => !v),
      },
      {
        id: "immersive",
        label: settings.immersive ? t("toolbar.exitImmersive") : t("toolbar.enterImmersive"),
        hint: "F11",
        group: t("cmdGroup.view"),
        run: () => toggleImmersive(),
      },
      {
        id: "quit",
        label: t("cmdItem.quit"),
        hint: t("app.quitHint"),
        group: t("cmdGroup.file"),
        run: () => void quitApplication(),
      },
      {
        id: "panel-vault",
        label: t("cmdItem.panelVault"),
        hint: "Ctrl+Shift+B",
        group: t("cmdGroup.panels"),
        run: () => onTogglePanel("vault"),
      },
      {
        id: "panel-right-dock",
        label: settings.dock.right.active ? t("panel.hideRightDock") : t("panel.showRightDock"),
        hint: "Ctrl+Shift+E",
        group: t("cmdGroup.panels"),
        run: () => onToggleRightDock(),
      },
      {
        id: "panel-toc",
        label: t("cmdItem.panelToc"),
        group: t("cmdGroup.panels"),
        run: () => onTogglePanel("toc"),
      },
      {
        id: "panel-backlinks",
        label: t("cmdItem.panelBacklinks"),
        group: t("cmdGroup.panels"),
        run: () => onTogglePanel("backlinks"),
      },
      {
        id: "panel-tags",
        label: t("cmdItem.panelTags"),
        group: t("cmdGroup.panels"),
        run: () => onTogglePanel("tags"),
      },
      {
        id: "panel-query",
        label: t("cmdItem.panelQuery"),
        group: t("cmdGroup.panels"),
        run: () => onTogglePanel("query"),
      },
      {
        id: "panel-history",
        label: t("cmdItem.panelHistory"),
        group: t("cmdGroup.panels"),
        run: () => onTogglePanel("history"),
      },
      {
        id: "panel-calendar",
        label: t("cmdItem.panelCalendar"),
        group: t("cmdGroup.panels"),
        run: () => onTogglePanel("calendar"),
      },
      {
        id: "panel-ai",
        label: t("panel.ai"),
        hint: "Alt+A",
        group: t("cmdGroup.panels"),
        run: () => onTogglePanel("ai"),
      },
      {
        id: "note-encrypt",
        label: t("cmdItem.encrypt"),
        group: t("cmdGroup.security"),
        disabled:
          !active ||
          Boolean(active.large) ||
          isEncryptedNote(active.content) ||
          Boolean(active.cryptoPassphrase),
        run: () => {
          if (!active || active.large) return;
          const tabId = active.id;
          const path = active.path;
          void (async () => {
            const pass = await askPrompt({
              masked: true,
              title: "Markelle",
              message: t("app.encryptPromptMessage"),
              placeholder: t("app.passwordPlaceholder"),
            });
            if (pass == null) return;
            if (pass.trim().length < 8) {
              setStatus(t("app.encryptPassTooShort"));
              return;
            }
            const pass2 = await askPrompt({
              masked: true,
              title: "Markelle",
              message: t("app.encryptConfirmMessage"),
              placeholder: t("app.passwordPlaceholder"),
            });
            if (pass2 == null) return;
            if (pass2 !== pass) {
              setStatus(t("app.encryptPassMismatch"));
              return;
            }

            const run = async () => {
              const tab = tabsRef.current.find((item) => item.id === tabId);
              if (!tab || tab.path !== path) return;
              if (isEncryptedNote(tab.content)) {
                setStatus(t("app.alreadyEncrypted"));
                return;
              }
              // Disk gets ciphertext; editor keeps plaintext + passphrase so Save
              // re-encrypts once (same model as unlock-after-decrypt).
              const enc = await encryptNote(tab.content, pass);
              const st = await writeMarkdownFile(path, enc);
              patchTab(tabId, {
                content: tab.content,
                savedContent: tab.content,
                cryptoPassphrase: pass,
                diskMtimeMs: st.mtimeMs,
                size: st.size,
                encoding: "utf-8",
              });
              snoozedDiskRef.current = null;
              const v = vaultRef.current;
              if (v) {
                try {
                  const n = await historyClearNote(v.root, path);
                  setStatus(
                    n > 0
                      ? t("app.encryptedClearedHistory", { n })
                      : t("app.encrypted"),
                  );
                } catch {
                  setStatus(t("app.encryptedClearFailed"));
                }
              } else {
                setStatus(t("app.encrypted"));
              }
            };

            const queued = saveChainRef.current.then(run, run);
            saveChainRef.current = queued.then(
              () => undefined,
              () => undefined,
            );
            try {
              await queued;
            } catch (err) {
              setStatus(formatAppError(err));
            }
          })();
        },
      },
      {
        id: "note-decrypt",
        label: t("cmdItem.decrypt"),
        group: t("cmdGroup.security"),
        disabled: !active || !isEncryptedNote(active?.content ?? ""),
        run: () => {
          if (!active || !isEncryptedNote(active.content)) return;
          void (async () => {
            const pass = await askPrompt({
              masked: true,
              title: "Markelle",
              message: t("app.decryptPromptMessage"),
              placeholder: t("app.passwordPlaceholder"),
            });
            if (pass == null) return;
            void decryptNote(active.content, pass)
              .then((pt) => {
                patchActive({ content: pt, savedContent: pt, cryptoPassphrase: pass });
                setStatus(t("app.decrypted"));
              })
              .catch(() => setStatus(t("app.decryptFailed")));
          })();
        },
      },
      {
        id: "note-lock",
        label: t("cmdItem.lockNote"),
        group: t("cmdGroup.security"),
        run: () => {
          const pass = active?.cryptoPassphrase;
          if (!active || !pass) return;
          void (async () => {
            try {
              // If the buffer is already ciphertext (legacy bad state), just clear the key.
              const enc = isEncryptedNote(active.content)
                ? active.content
                : await encryptNote(active.content, pass);
              const st = await writeMarkdownFile(active.path, enc);
              patchActive({
                content: enc,
                savedContent: enc,
                cryptoPassphrase: undefined,
                diskMtimeMs: st.mtimeMs,
                size: st.size,
              });
              snoozedDiskRef.current = null;
              setStatus(t("app.locked"));
            } catch (err) {
              setStatus(formatAppError(err));
            }
          })();
        },
      },
      {
        id: "check-updates",
        label: t("cmdItem.checkUpdates"),
        group: t("cmdGroup.app"),
        run: () => {
          void (async () => {
            try {
              setStatus(t("app.checkingUpdates"));
              const cur = await getVersion();
              const info = await checkForUpdates(cur);
              if (info.newer) {
                const ok = await askConfirm(
                  t("app.updateAvailableConfirm", {
                    latest: info.latest,
                    current: info.current,
                  }),
                  { title: "Markelle", kind: "info" },
                );
                if (ok) void openUrl(info.url);
                setStatus(t("app.updateAvailable", { latest: info.latest }));
              } else {
                setStatus(t("app.upToDate", { current: info.current }));
              }
            } catch (e) {
              setStatus(formatAppError(e, t("app.updateCheckFailed")));
            }
          })();
        },
      },
      {
        id: "capture",
        label: t("capture.title"),
        hint: "Ctrl+Shift+N",
        group: t("cmdGroup.notes"),
        run: () => setCaptureOpen(true),
      },
      {
        id: "export-html",
        label: t("cmdItem.exportHtml"),
        group: t("cmdGroup.file"),
        disabled: !active || Boolean(active.large),
        run: () => {
          if (!active || active.large) return;
          void (async () => {
            try {
              const { html } = renderMarkdown(active.content, {
                baseDir: dirname(active.path),
                vaultRoot: vaultRef.current?.root ?? null,
                vaultFiles,
                toAssetUrl: toGatedAssetUrl,
              });
              const body = await embedLocalImagesInHtml(html);
              const doc = buildExportHtml({
                title: active.name,
                bodyHtml: body,
                dark,
              });
              downloadTextFile(
                active.name.replace(/\.(md|markdown|mdown|mkd)$/i, "") + ".html",
                doc,
              );
              setStatus(t("app.exportedHtml"));
            } catch (err) {
              setStatus(formatAppError(err));
            }
          })();
        },
      },
      {
        id: "export-print",
        label: t("cmdItem.exportPrint"),
        group: t("cmdGroup.file"),
        disabled: !active || Boolean(active.large),
        run: () => {
          if (!active || active.large) return;
          void (async () => {
            try {
              const { html } = renderMarkdown(active.content, {
                baseDir: dirname(active.path),
                vaultRoot: vaultRef.current?.root ?? null,
                vaultFiles,
                toAssetUrl: toGatedAssetUrl,
              });
              const body = await embedLocalImagesInHtml(html);
              printHtmlDocument(
                buildExportHtml({ title: active.name, bodyHtml: body, dark: false }),
              );
            } catch (err) {
              setStatus(formatAppError(err));
            }
          })();
        },
      },
      {
        id: "ai-summarize",
        label: t("cmdItem.aiSummarize"),
        group: t("cmdGroup.integrations"),
        disabled: !settings.ollamaEnabled || !active || Boolean(active.large) || ollamaGenerating,
        run: () => {
          void runEditorAiAction({
            buildPrompt: summarizePrompt,
            apply: "append-heading",
            headingKey: "app.aiSummaryHeading",
            selectionInsertMode: "replace-with-newline",
          });
        },
      },
      {
        id: "ai-polish",
        label: t("cmdItem.aiPolish"),
        group: t("cmdGroup.integrations"),
        disabled: !settings.ollamaEnabled || !active || Boolean(active.large) || ollamaGenerating,
        run: () => {
          void runEditorAiAction({
            buildPrompt: polishPrompt,
            apply: "replace-or-append",
            headingKey: "app.aiPolishHeading",
            selectionDone: t("app.aiSelectionPolished"),
          });
        },
      },
      {
        id: "ai-continue",
        label: t("cmdItem.aiContinue"),
        group: t("cmdGroup.integrations"),
        disabled: !settings.ollamaEnabled || !active || Boolean(active.large) || ollamaGenerating,
        run: () => {
          void runEditorAiAction({
            buildPrompt: continuePrompt,
            apply: "continue",
            selectionDone: t("app.aiSelectionContinued"),
          });
        },
      },
      {
        id: "ai-proofread",
        label: t("cmdItem.aiProofread"),
        group: t("cmdGroup.integrations"),
        disabled: !settings.ollamaEnabled || !active || Boolean(active.large) || ollamaGenerating,
        run: () => {
          void runEditorAiAction({
            buildPrompt: proofreadPrompt,
            apply: "replace-or-append",
            headingKey: "app.aiProofreadHeading",
            selectionDone: t("app.aiSelectionProofread"),
          });
        },
      },
      {
        id: "ai-translate",
        label: t("cmdItem.aiTranslate"),
        group: t("cmdGroup.integrations"),
        disabled: !settings.ollamaEnabled || !active || Boolean(active.large) || ollamaGenerating,
        run: () => {
          void runEditorAiAction({
            buildPrompt: translatePrompt,
            apply: "replace-or-append",
            headingKey: "app.aiTranslateHeading",
            selectionDone: t("app.aiSelectionTranslated"),
          });
        },
      },
      {
        id: "ai-stop",
        label: t("cmdItem.aiStop"),
        group: t("cmdGroup.integrations"),
        disabled: !ollamaGenerating,
        run: () => {
          if (ollamaAbortRef.current) {
            ollamaAbortRef.current.abort();
            ollamaAbortRef.current = null;
            setOllamaGenerating(false);
            setStatus(t("app.ollamaAborted"));
          }
        },
      },
      {
        id: "canvas",
        label: t("cmdItem.canvas"),
        group: t("cmdGroup.notes"),
        disabled: !vault,
        run: () => void openCanvas(),
      },
      {
        id: "panel-plugins",
        label: t("plugins.title"),
        hint: "Ctrl+,",
        group: t("cmdGroup.app"),
        run: () => setPluginsOpen(true),
      },
      {
        id: "settings",
        label: t("settings.title"),
        group: t("cmdGroup.app"),
        run: () => setSettingsOpen(true),
      },
      {
        id: "about",
        label: t("cmdItem.about"),
        group: t("cmdGroup.app"),
        run: () => setAboutOpen(true),
      },
    ];

    for (const file of vaultFiles.slice(0, 40)) {
      items.push({
        id: `vault:${file.path}`,
        label: file.name,
        hint: file.relative,
        group: t("cmdGroup.vaultNotes"),
        run: () => void openPath(file.path),
      });
    }

    for (const entry of recent.slice(0, 12)) {
      items.push({
        id: `recent:${entry.path}`,
        label: entry.name,
        hint: entry.path,
        group: t("cmdGroup.recent"),
        run: () => void openPath(entry.path, false, undefined, { authorize: true }),
      });
    }

    return items;
    // `t()` resolves against the module-level locale, not a prop or state value, so
    // the rule cannot see that the labels must be rebuilt when the UI language
    // changes. `settings.locale` below is a deliberate, required dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    dirty,
    graphOpen,
    vault,
    vaultFiles,
    recent,
    pickOpen,
    pickVault,
    saveFile,
    saveAs,
    createNewNote,
    openOrCreateDailyNote,
    createFromTemplate,
    openCanvas,
    patchActive,
    onTogglePanel,
    onToggleRightDock,
    openPath,
    settings.dock.right.active,
    settings.immersive,
    settings.autosave,
    settings.ollamaEnabled,
    settings.locale,
    dark,
    toggleImmersive,
    quitApplication,
    runEditorAiAction,
    ollamaGenerating,
  ]);

  /*
    Stable identities for the dock panels.
    ──────────────────────────────────────
    VaultSidebar is memoised and renders a recursive file tree. Before this,
    every one of these arrived as a fresh arrow function on each App render, so
    the whole tree re-rendered on every keystroke, status message and busy
    toggle — even though nothing about the vault had changed. Keeping them
    referentially stable is what makes `memo` actually bite.
    Deps are the real ones; `openPath` is already a `useCallback([])` in this
    component, so it is safe to depend on.
  */
  const openVaultFile = useCallback(
    (path: string, line?: number) => {
      void openPath(path, false, undefined, line && line > 0 ? { line } : undefined);
    },
    [openPath],
  );
  const refreshVault = useCallback(() => {
    if (!vault) return;
    void loadVault(vault.root).then(() => {
      if (graphOpen) setGraphEpoch((n) => n + 1);
    });
  }, [vault, loadVault, graphOpen]);
  const createNoteIn = useCallback(
    (dir?: string) => {
      void createNewNote(dir);
    },
    [createNewNote],
  );

  const handleVaultRename = useCallback(
    async (oldPath: string, newPath: string, isDir: boolean) => {
      // 1. Update open tabs
      setTabs((prev) => {
        let changed = false;
        const next = prev.map((tab) => {
          if (!isDir && pathsEqual(tab.path, oldPath)) {
            changed = true;
            const newName = basename(newPath);
            return {
              ...tab,
              path: newPath,
              name: newName,
              baseDir: dirname(newPath),
            };
          }
          if (isDir) {
            const normOld = toPosixPath(oldPath);
            const normTab = toPosixPath(tab.path);
            if (normTab.startsWith(normOld + "/")) {
              changed = true;
              const rel = normTab.slice(normOld.length);
              const resolvedNew = toPosixPath(newPath) + rel;
              return {
                ...tab,
                path: resolvedNew,
                name: basename(resolvedNew),
                baseDir: dirname(resolvedNew),
              };
            }
          }
          return tab;
        });
        if (changed) {
          tabsRef.current = next;
          return next;
        }
        return prev;
      });

      // 2. Update recent files
      setRecent((prev) => {
        let changed = false;
        const next = prev.map((entry) => {
          if (!isDir && pathsEqual(entry.path, oldPath)) {
            changed = true;
            return { ...entry, path: newPath, name: basename(newPath) };
          }
          if (isDir) {
            const normOld = toPosixPath(oldPath);
            const normPath = toPosixPath(entry.path);
            if (normPath.startsWith(normOld + "/")) {
              changed = true;
              const resolvedNew = toPosixPath(newPath) + normPath.slice(normOld.length);
              return { ...entry, path: resolvedNew, name: basename(resolvedNew) };
            }
          }
          return entry;
        });
        return changed ? next : prev;
      });

      // 3. Cascading link updates if a markdown note was renamed
      const isMd =
        !isDir &&
        (oldPath.toLowerCase().endsWith(".md") ||
          oldPath.toLowerCase().endsWith(".markdown"));
      if (!isMd || !vault) return;

      const oldStem = basename(oldPath).replace(/\.(md|markdown)$/i, "");
      const newStem = basename(newPath).replace(/\.(md|markdown)$/i, "");
      if (oldStem === newStem) return;

      try {
        const backlinks = await findBacklinks(vault.root, oldPath).catch(() => []);
        if (backlinks.length === 0) return;

        const shouldRefactor = await askConfirm(
          t("vault.confirmRefactorLinks", {
            count: backlinks.length,
            oldStem,
            newStem,
          }),
          { title: "Markelle", kind: "info" },
        );
        if (!shouldRefactor) return;

        let totalUpdated = 0;
        let skippedLarge = 0;
        const filePaths = Array.from(new Set(backlinks.map((b) => b.path)));

        for (const filePath of filePaths) {
          const openTab = tabsRef.current.find((t) => pathsEqual(t.path, filePath));
          // Never rewrite from a truncated / backend-buffer preview — that would
          // truncate the note on disk to the preview slice.
          if (openTab && getWriteBlockReason(openTab)) {
            try {
              const file = await readMarkdownFile(filePath, true);
              // Never write a truncated / preview read back to disk.
              if (file.truncated || (file.large && file.truncated)) {
                skippedLarge++;
                continue;
              }
              const updated = refactorAllLinks(file.content, oldPath, newPath);
              if (updated !== file.content) {
                const st = await writeMarkdownFile(filePath, updated);
                // Disk now differs from the buffer/large tab's snapshot. Refresh
                // its fingerprint so the next save is not blocked as stale.
                patchTab(openTab.id, { diskMtimeMs: st.mtimeMs, size: st.size });
                totalUpdated++;
              }
            } catch {
              /* ignore individual file io error */
            }
            continue;
          }
          if (openTab) {
            const updated = refactorAllLinks(openTab.content, oldPath, newPath);
            if (updated !== openTab.content) {
              try {
                const st = await writeMarkdownFile(filePath, updated);
                patchTab(openTab.id, {
                  content: updated,
                  savedContent: updated,
                  diskMtimeMs: st.mtimeMs,
                  size: st.size,
                });
                totalUpdated++;
              } catch {
                // Fall back to dirty in-memory update if disk write fails.
                patchTab(openTab.id, { content: updated });
                totalUpdated++;
              }
            }
          } else {
            try {
              const file = await readMarkdownFile(filePath, true);
              // Never write a truncated / preview read back to disk.
              if (file.truncated || (file.large && file.truncated)) {
                skippedLarge++;
                continue;
              }
              const updated = refactorAllLinks(file.content, oldPath, newPath);
              if (updated !== file.content) {
                await writeMarkdownFile(filePath, updated);
                totalUpdated++;
              }
            } catch {
              /* ignore individual file io error */
            }
          }
        }

        if (totalUpdated > 0) {
          setStatus(
            skippedLarge > 0
              ? t("vault.refactoredLinksLargeOpen", {
                  count: totalUpdated,
                  skipped: skippedLarge,
                })
              : t("vault.refactoredLinks", { count: totalUpdated }),
          );
        }
      } catch (err) {
        setStatus(formatAppError(err));
      }
    },
    [vault, patchTab],
  );

  const handleCloseTab = useCallback((id: string) => void closeTab(id), [closeTab]);
  const handleOpenInNewWindow = useCallback((id: string) => void openTabInNewWindow(id), [openTabInNewWindow]);
  const handleNewNote = useCallback(() => void createNewNote(), [createNewNote]);
  const handleOpenCommandPalette = useCallback(() => setCmdOpen(true), []);
  const handleLayout = useCallback((layout: LayoutPreset) => setSettings((s) => ({ ...s, layout })), []);
  const handleScheme = useCallback((scheme: ColorScheme) => setSettings((s) => ({ ...s, scheme })), []);
  const handleLineWidth = useCallback((lineWidth: number) => setSettings((s) => ({ ...s, lineWidth })), []);
  const handleSave = useCallback(() => void saveFile(), [saveFile]);
  const handleToggleAutosave = useCallback(() => setSettings((s) => ({ ...s, autosave: !s.autosave })), []);
  const handleToggleRightDock = useCallback(() => onToggleRightDock(), [onToggleRightDock]);

  /*
    Stable identities for the AI dock panel.
    ──────────────────────────────────────
    AiAssistantPanel is memoised; before this, every App render handed it a
    fresh set of inline arrow callbacks, so it re-rendered (and re-parsed all of
    its markdown messages) on any unrelated App state change. These match the
    previous inline behaviour exactly.
  */
  const aiGetSelectedText = useCallback(() => {
    const view = editorViewRef.current;
    if (view && !view.state.selection.main.empty) {
      return view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      );
    }
    return (typeof window !== "undefined" && window.getSelection()?.toString()) || "";
  }, []);

  const aiOnInsertText = useCallback(
    (text: string) => {
      const view = editorViewRef.current;
      if (view) {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
        });
        view.focus();
      } else if (active) {
        patchActive({ content: active.content + "\n\n" + text });
      }
    },
    [active, patchActive],
  );

  const aiOnAppendText = useCallback(
    (text: string) => {
      if (!active) {
        setStatus(t("ai.noActiveNote"));
        return;
      }
      const view = editorViewRef.current;
      if (view) {
        const end = view.state.doc.length;
        const prefix =
          end > 0 && view.state.doc.sliceString(end - 1, end) !== "\n" ? "\n\n" : "\n";
        view.dispatch({
          changes: { from: end, insert: `${prefix}${text}` },
          selection: { anchor: end + prefix.length + text.length },
          scrollIntoView: true,
        });
        view.focus();
      } else {
        patchActive({ content: `${active.content.trimEnd()}\n\n${text}` });
      }
      setStatus(t("ai.appended"));
    },
    [active, patchActive],
  );

  const aiOnReplaceContent = useCallback(
    (text: string) => {
      if (!active) {
        setStatus(t("ai.noActiveNote"));
        return;
      }
      const view = editorViewRef.current;
      if (view) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
          scrollIntoView: true,
        });
        view.focus();
      } else {
        patchActive({ content: text });
      }
    },
    [active, patchActive],
  );

  const aiOnReplaceSelection = useCallback(
    (text: string) => {
      const view = editorViewRef.current;
      if (view && !view.state.selection.main.empty) {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
        });
        view.focus();
      } else if (active) {
        patchActive({ content: text });
      }
    },
    [active, patchActive],
  );

  const aiOnOpenSettings = useCallback(() => setSettingsOpen(true), []);

  const aiOnCreateNote = useCallback(
    (title: string, content: string) => {
      void (async () => {
        try {
          const targetFolder = vault?.root || (active?.path ? dirname(active.path) : "");
          if (!targetFolder) {
            setStatus(t("ai.cannotCreateNote"));
            return;
          }
          const existing = new Set(
            vault
              ? flattenVaultFiles(vault.root, vault.tree).map((f) => normalizePath(f.path))
              : [],
          );
          const unique = allocateUniquePath(targetFolder, `${title}.md`, existing);
          await writeMarkdownFile(unique, content);
          if (vault) await loadVault(vault.root);
          await openPath(unique, false, undefined, { authorize: true });
          setStatus(t("ai.created"));
        } catch (e) {
          setStatus(formatAppError(e));
        }
      })();
    },
    [vault, active, loadVault, openPath],
  );

  /*
    Stable identities for GraphView (also memoised). Inline arrows here forced a
    full graph re-render (and forced the force-simulation effect to be
    reconsidered) on every App render.
  */
  const graphOnLocalHopsChange = useCallback((hops: GraphHops) => {
    setSettings((s) => ({ ...s, graphLocalHops: hops }));
  }, []);
  const graphOnKeepOpenChange = useCallback((keep: boolean) => {
    setSettings((s) => ({ ...s, graphKeepOpen: keep }));
  }, []);
  const graphOnOpenFile = useCallback(
    (path: string) => {
      if (!settingsRef.current.graphKeepOpen) setGraphOpen(false);
      void openPath(path);
    },
    [openPath],
  );

  /*
    First commit must look EXACTLY like the inline splash in index.html.
    `createRoot()` calls `clearContainer()` on its first commit, so returning
    anything else here would throw away the boot screen that is already on
    screen (and it is the frame the window was revealed on). The old
    `<div className="boot">Markelle</div>` flashed a bare text node in its place.
    Keys/classes below are intentionally duplicated from index.html — the markup
    has to survive the hand-off byte-for-byte in layout terms.
  */
  // The `!ready` boot-screen early return now lives just below, AFTER all hooks
  // (see the note there) — rules of hooks forbids a conditional return before
  // the dock-panel callbacks.
  const renderDockPanelContent = useCallback(
    (id: PanelId) => {
      switch (id) {
      case "vault":
        if (!vault) {
          return (
            <div className="dock-empty">
              <p>{t("app.noVault")}</p>
              <button type="button" className="btn primary" onClick={() => void pickVault()}>
                {t("welcome.openVault")}
              </button>
            </div>
          );
        }
        return (
          <VaultSidebar
            vault={vault}
            activePath={active?.path ?? null}
            busy={busy}
            onOpenFile={openVaultFile}
            onCloseVault={closeVault}
            onRefresh={refreshVault}
            onNewNote={createNoteIn}
            onStatus={setStatus}
            onRenamePath={handleVaultRename}
          />
        );
      case "toc":
        return (
          <TocSidebar
            items={toc}
            open
            onClose={() => onTogglePanel("toc")}
            onJump={(hid) => {
              document.getElementById(hid)?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
            onAdjustLevel={
              active && !active.large
                ? (id, delta) => {
                    const next = adjustHeadingLevel(active.content, id, delta);
                    if (next !== active.content) patchActive({ content: next });
                  }
                : undefined
            }
            onReorder={
              active && !active.large
                ? (id, toIndex) => {
                    const next = moveHeadingTo(active.content, id, toIndex);
                    if (next !== active.content) patchActive({ content: next });
                  }
                : undefined
            }
          />
        );
      case "backlinks":
        return (
          <BacklinksPanel
            vaultRoot={vault?.root ?? null}
            notePath={active?.path ?? null}
            onOpenFile={(path, line) =>
              void openPath(path, false, undefined, line && line > 0 ? { line } : undefined)
            }
          />
        );
      case "tags":
        return (
          <TagsPanel
            vaultRoot={vault?.root ?? null}
            onOpenFile={(path) => void openPath(path)}
          />
        );
      case "query":
        return (
          <QueryPanel
            vaultRoot={vault?.root ?? null}
            onOpenFile={(path, line) =>
              void openPath(path, false, undefined, line && line > 0 ? { line } : undefined)
            }
          />
        );
      case "history":
        return (
          <HistoryPanel
            vaultRoot={vault?.root ?? null}
            notePath={active?.path ?? null}
            currentContent={active?.content ?? ""}
            onStatus={setStatus}
            onRestore={async (content) => {
              if (!activeId) return;
              patchTab(activeId, { content });
              setStatus(t("history.restored"));
            }}
          />
        );
      case "calendar":
        return (
          <CalendarPanel
            vaultRoot={vault?.root ?? null}
            dailyFolder={settings.dailyFolder}
            existingDates={dailyExistingDates}
            onOpenDate={(path, ymd) => {
              void (async () => {
                try {
                  await registerAccess([path]);
                  try {
                    await statMarkdownFile(path);
                    await openPath(path, false, undefined, { authorize: true });
                  } catch {
                    const seed = dailyNoteSeed(new Date(`${ymd}T12:00:00`));
                    await writeMarkdownFile(path, seed);
                    await loadVault(vault!.root);
                    await openPath(path, false, undefined, { authorize: true });
                  }
                } catch (err) {
                  setStatus(formatAppError(err));
                }
              })();
            }}
          />
        );
      case "ai":
        return (
          <AiAssistantPanel
            settings={settings}
            activePath={active?.path ?? null}
            activeContent={active?.content ?? ""}
            getSelectedText={aiGetSelectedText}
            onInsertText={aiOnInsertText}
            onAppendText={aiOnAppendText}
            onReplaceContent={aiOnReplaceContent}
            onReplaceSelection={aiOnReplaceSelection}
            onCreateNote={aiOnCreateNote}
            onOpenSettings={aiOnOpenSettings}
            onStatus={setStatus}
          />
        );
      default:
        return null;
    }
    },
    [
      vault,
      active,
      activeId,
      busy,
      openVaultFile,
      closeVault,
      refreshVault,
      createNoteIn,
      setStatus,
      handleVaultRename,
      toc,
      onTogglePanel,
      patchActive,
      patchTab,
      openPath,
      loadVault,
      pickVault,
      settings,
      dailyExistingDates,
      aiGetSelectedText,
      aiOnInsertText,
      aiOnAppendText,
      aiOnReplaceContent,
      aiOnReplaceSelection,
      aiOnCreateNote,
      aiOnOpenSettings,
    ],
  );

  // Per-panel boundary: a crash in one dock panel must not replace the whole UI.
  // `key={id}` remounts the boundary when the active panel changes, clearing any
  // sticky error state from the previous panel.
  const renderDockPanel = useCallback(
    (id: PanelId) => (
      <ErrorBoundary key={id} fallbackLabel={panelLabel(id)}>
        {renderDockPanelContent(id)}
      </ErrorBoundary>
    ),
    [renderDockPanelContent],
  );

  /*
    First commit must look EXACTLY like the inline splash in index.html.
    `createRoot()` calls `clearContainer()` on its first commit, so returning
    anything else here would throw away the boot screen that is already on
    screen (and it is the frame the window was revealed on). The old
    `<div className="boot">Markelle</div>` flashed a bare text node in its place.
    Keys/classes below are intentionally duplicated from index.html — the markup
    has to survive the hand-off byte-for-byte in layout terms.
  */
  if (!ready) {
    return (
      <div className="boot-inline" aria-busy="true">
        <div className="boot-mark" aria-hidden="true">
          M
        </div>
        <div>Markelle</div>
        <div className="boot-bar" aria-hidden="true">
          <i />
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <UnifiedHeader
        tabs={tabs}
        activeId={activeId}
        activeTitle={active?.name ?? ""}
        dirty={dirty}
        busy={busy}
        vaultName={vault?.name}
        onSelectTab={setActiveId}
        onCloseTab={handleCloseTab}
        onOpenInNewWindow={handleOpenInNewWindow}
        onReorderTabs={reorderTabs}
        onNewNote={handleNewNote}
        onOpenCommandPalette={handleOpenCommandPalette}
        hasFile={Boolean(active)}
        mode={displayMode}
        layout={settings.layout}
        scheme={settings.scheme}
        fontSize={settings.fontSize}
        lineWidth={settings.lineWidth}
        truncated={Boolean(active?.truncated)}
        hydrateRatio={active?.hydrateRatio ?? 0}
        immersive={settings.immersive}
        autosave={settings.autosave}
        rightDockOpen={Boolean(settings.dock.right.active)}
        aiOpen={isPanelVisible(settings.dock, "ai")}
        onMode={setMode}
        onLayout={handleLayout}
        onScheme={handleScheme}
        onFontSize={handleFontSize}
        onLineWidth={handleLineWidth}
        onSave={handleSave}
        onToggleImmersive={toggleImmersive}
        onToggleAutosave={handleToggleAutosave}
        onToggleRightDock={handleToggleRightDock}
        onToggleAi={() => onTogglePanel("ai")}
      />

      {settings.immersive && (
        <button
          type="button"
          className="immersive-exit"
          onClick={() => toggleImmersive(false)}
        >
          {t("app.exitImmersive")}
          <kbd>Esc</kbd>
        </button>
      )}
      {settings.immersive && dirty && (
        <div className="immersive-dirty" role="status">
          <span>{t("tabs.unsaved")}</span>
          <button
            type="button"
            className="btn primary"
            onClick={() => void saveFile()}
            disabled={Boolean(active?.truncated)}
            title="Ctrl+S"
          >
            {t("toolbar.save")}
            <kbd>Ctrl+S</kbd>
          </button>
        </div>
      )}

      <div
        className={
          settings.activityBarExpanded ? "app-body activity-expanded" : "app-body"
        }
      >
        <ActivityBar
          dock={settings.dock}
          graphOpen={graphOpen}
          vaultOpen={Boolean(vault)}
          pluginsOpen={pluginsOpen}
          scheme={settings.scheme}
          dark={dark}
          expanded={settings.activityBarExpanded}
          onToggleExpanded={() =>
            setSettings((s) => ({
              ...s,
              activityBarExpanded: !s.activityBarExpanded,
            }))
          }
          onTogglePanel={onTogglePanel}
          onGraph={() => {
            if (!vault) return;
            setGraphOpen((v) => !v);
          }}
          onPlugins={() => setPluginsOpen(true)}
          onAbout={() => setAboutOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          settingsOpen={settingsOpen}
          onToggleTheme={() =>
            setSettings((s) => ({
              ...s,
              scheme: dark ? "light" : "dark",
            }))
          }
        />

        <div className="app-main" aria-busy={busy || undefined}>
          <DockWorkspace
            layout={settings.dock}
            onChange={patchDock}
            renderPanel={renderDockPanel}
          >
            <main
              className="main-pane"
              data-mode={graphOpen ? "graph" : (active?.mode ?? "idle")}
            >
              {graphOpen && vault ? (
                <ErrorBoundary fallbackLabel={t("panel.graph")}>
                  <Suspense fallback={<div className="open-pending" aria-busy="true" />}>
                    <GraphView
                      vaultRoot={vault.root}
                      focusPath={active?.path ?? null}
                      mode={effectiveGraphScope}
                      dark={dark}
                      epoch={graphEpoch}
                      localHops={settings.graphLocalHops}
                      keepOpenOnNavigate={settings.graphKeepOpen}
                      onLocalHopsChange={graphOnLocalHopsChange}
                      onKeepOpenChange={graphOnKeepOpenChange}
                      onOpenFile={graphOnOpenFile}
                      onBusy={setBusyStable}
                      onStatus={setStatusStable}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : !active && openingFile ? (
                <div className="open-pending" aria-busy="true" aria-live="polite">
                  <div className="open-pending-card">
                    <span className="open-pending-spinner" aria-hidden />
                    <p>{t("app.openingFile")}</p>
                  </div>
                </div>
              ) : !active ? (
                <Welcome
                  recent={recent}
                  recentVaults={
                    settings.recentVaultPaths.length > 0
                      ? settings.recentVaultPaths
                      : [...settings.trustedVaultPaths].reverse()
                  }
                  previewCount={settings.recentPreviewCount}
                  onOpen={() => void pickOpen()}
                  onOpenVault={() => void pickVault()}
                  onOpenPath={(path) =>
                    void openPath(path, false, undefined, { authorize: true })
                  }
                  onOpenVaultPath={(path) => void loadVault(path, { trust: true })}
                  onClearRecent={() => {
                    void clearRecent().then(() => setRecent([]));
                    setSettings((s) => ({ ...s, recentVaultPaths: [] }));
                  }}
                  onNewNote={() => void createNewNote()}
                  onOpenCmdk={() => setCmdOpen(true)}
                />
              ) : (
                <ErrorBoundary
                  fallbackLabel={t("app.renderFailed")}
                  onReset={() => {
                    if (active) void openPath(active.path, true, undefined, { authorize: true });
                  }}
                >
                  {active.mode === "read" ? (
                    <Suspense
                      fallback={
                        <div className="reader-scroll open-pending" aria-busy="true">
                          <div className="open-pending-card">
                            <span className="open-pending-spinner" aria-hidden />
                            <p>{t("app.loadingReader")}</p>
                          </div>
                        </div>
                      }
                    >
                      {settings.showProperties ? (
                        <PropertiesStrip
                          docKey={active.id}
                          source={active.content}
                          onSourceChange={(content) => patchActive({ content })}
                        />
                      ) : null}
                      <MarkdownView
                        docKey={`${active.id}:${active.path}`}
                        source={displayMode === "split" ? previewSource : (active?.content ?? "")}
                        baseDir={active.baseDir}
                        vaultRoot={vault?.root ?? null}
                        attachmentFolder={settings.attachmentFolder}
                        layout={settings.layout}
                        lineWidth={settings.lineWidth}
                        dark={dark}
                        vaultFiles={vaultFiles}
                        allowRemoteHttpMedia={settings.allowRemoteHttpMedia}
                        vaultEpoch={vault ? `${vault.root}:${vault.fileCount}` : "none"}
                        largeDoc={
                          (active.backendBuffer || active.large) && active.path
                            ? {
                                path: active.path,
                                totalLines: active.lineCount || 2000,
                                totalSize: active.size,
                                isHydrating: active.truncated,
                              }
                            : undefined
                        }
                        onSwitchToSource={() => patchActive({ mode: "source" })}
                        onToc={onToc}
                        onWikiOpen={handleWikiOpen}
                        onTaskToggle={handleTaskToggle}
                        onPasteImages={handleReadPasteImages}
                      />
                    </Suspense>
                  ) : active.mode === "source" ? (
                    <Suspense
                      fallback={
                        <div className="source-workbench open-pending" aria-busy="true">
                          <div className="open-pending-card">
                            <span className="open-pending-spinner" aria-hidden />
                            <p>{t("app.loadingEditor")}</p>
                          </div>
                        </div>
                      }
                    >
                      <SourceWorkbench
                        key={active.id}
                        value={active.content}
                        onChange={(content) => patchActive({ content })}
                        dark={dark}
                        vaultFiles={vaultFiles}
                        wordWrap={active.large || active.backendBuffer ? false : settings.sourceWordWrap}
                        lineNumbers={settings.sourceLineNumbers}
                        vimMode={settings.vimMode}
                        spellcheck={settings.spellcheck}
                        readOnly={Boolean(active.truncated || active.backendBuffer)}
                        scrollToLine={scrollLine}
                        onScrolledToLine={() => setScrollLine(null)}
                        findRequest={findRequest}
                        virtualDoc={sourceVirtualDoc}
                        onPasteFiles={
                          active.truncated || active.backendBuffer || active.large
                            ? undefined
                            : (files) => importClipboardFiles(files)
                        }
                        onInsertImage={
                          active.truncated || active.backendBuffer || active.large
                            ? undefined
                            : () => handleInsertImageDialog()
                        }
                        onViewReady={(v) => {
                          editorViewRef.current = v;
                        }}
                        onStatus={setStatusStable}
                        header={
                          settings.showProperties ? (
                            <PropertiesStrip
                              docKey={active.id}
                              source={active.content}
                              onSourceChange={(content) => patchActive({ content })}
                            />
                          ) : null
                        }
                      />
                    </Suspense>
                  ) : (
                    <SplitScrollPane
                      source={
                        <Suspense
                          fallback={<div className="source-workbench" aria-busy="true" />}
                        >
                          <SourceWorkbench
                            key={`split-${active.id}`}
                            compact
                            value={active.content}
                            onChange={(content) => patchActive({ content })}
                            dark={dark}
                            vaultFiles={vaultFiles}
                            wordWrap={active.large || active.backendBuffer ? false : settings.sourceWordWrap}
                            lineNumbers={settings.sourceLineNumbers}
                            vimMode={settings.vimMode}
                            spellcheck={settings.spellcheck}
                            readOnly={Boolean(active.truncated || active.backendBuffer)}
                            scrollToLine={scrollLine}
                            onScrolledToLine={() => setScrollLine(null)}
                            findRequest={findRequest}
                            virtualDoc={sourceVirtualDoc}
                            onPasteFiles={
                              active.truncated || active.backendBuffer || active.large
                                ? undefined
                                : (files) => importClipboardFiles(files)
                            }
                            onInsertImage={
                              active.truncated || active.backendBuffer || active.large
                                ? undefined
                                : () => handleInsertImageDialog()
                            }
                            onViewReady={(v) => {
                              editorViewRef.current = v;
                            }}
                            onStatus={setStatusStable}
                          />
                        </Suspense>
                      }
                      preview={
                        <Suspense fallback={<div className="reader-scroll" aria-busy="true" />}>
                          {settings.showProperties ? (
                            <PropertiesStrip
                              docKey={active.id}
                              source={active.content}
                              onSourceChange={
                                active.truncated
                                  ? undefined
                                  : (content) => patchActive({ content })
                              }
                            />
                          ) : null}
                          <MarkdownView
                            docKey={`${active.id}:${active.path}`}
                            source={displayMode === "split" ? previewSource : (active?.content ?? "")}
                            baseDir={active.baseDir}
                            vaultRoot={vault?.root ?? null}
                            attachmentFolder={settings.attachmentFolder}
                            layout={settings.layout}
                            lineWidth={settings.lineWidth}
                            dark={dark}
                            vaultFiles={vaultFiles}
                            allowRemoteHttpMedia={settings.allowRemoteHttpMedia}
                            vaultEpoch={vault ? `${vault.root}:${vault.fileCount}` : "none"}
                            largeDoc={
                              (active.backendBuffer || active.large) && active.path
                                ? {
                                    path: active.path,
                                    totalLines: active.lineCount || 2000,
                                    totalSize: active.size,
                                    isHydrating: active.truncated,
                                  }
                                : undefined
                            }
                            onToc={onToc}
                            onWikiOpen={handleWikiOpen}
                            onTaskToggle={
                              active.truncated || active.large
                                ? undefined
                                : handleTaskToggle
                            }
                            onPasteImages={
                              active.truncated || active.large
                                ? undefined
                                : handleReadPasteImages
                            }
                          />
                        </Suspense>
                      }
                    />
                  )}
                </ErrorBoundary>
              )}
            </main>
          </DockWorkspace>

          <footer className="statusbar" aria-live="polite">
            <span className="statusbar-left">
              {busy && <span className="busy-dot" aria-hidden />}
              {active ? active.path : t("app.ready")}
            </span>
            <span className="statusbar-right">{status}</span>
          </footer>
        </div>
      </div>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <CaptureDialog
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
        onSave={async (text) => {
          const v = vaultRef.current;
          if (!v) {
            setStatus(t("vault.needOpen"));
            throw new Error(t("vault.needOpen"));
          }
          const s = settingsRef.current;
          const stamp = `${formatDateYmd(new Date())} ${formatTimeHm(new Date())}`;
          const block = `\n\n## ${stamp}\n\n${text.trim()}\n`;
          if (s.captureTarget === "inbox") {
            const inboxPath = joinPath(v.root, "Inbox.md");
            await registerAccess([inboxPath]);
            // Seed the heading only when the file is brand new: append_markdown_file
            // creates a missing file, so without this a fresh `Inbox.md` would start
            // with a blank line instead of its title. If it already exists we only
            // append — never read-modify-write, which would risk truncating a huge note.
            try {
              await statMarkdownFile(inboxPath);
            } catch {
              await writeMarkdownFile(inboxPath, "# Inbox\n");
            }
            await appendMarkdownFile(inboxPath, block);
            await openPath(inboxPath, false, undefined, { authorize: true });
          } else {
            const daily = createDailyNote(v.root, new Date(), s.dailyFolder);
            await registerAccess([daily.path]);
            // Seed the daily-note title only on first creation (same reasoning).
            try {
              await statMarkdownFile(daily.path);
            } catch {
              await writeMarkdownFile(daily.path, daily.content);
            }
            await appendMarkdownFile(daily.path, block);
            await openPath(daily.path, false, undefined, { authorize: true });
          }
          setStatus(t("capture.saved"));
        }}
      />
      <CanvasBoard
        open={canvasOpen}
        initialJson={canvasInitialJson}
        onClose={() => setCanvasOpen(false)}
        onSave={async (json) => {
          const v = vaultRef.current;
          if (!v) throw new Error(t("vault.needOpen"));
          const relative = ".markelle/canvas/default.json";
          const bytes = new TextEncoder().encode(json);
          await vaultWriteBytes(v.root, relative, bytes);
          setStatus(t("canvas.saved"));
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
      />
      <PluginPanel
        open={pluginsOpen}
        plugins={plugins}
        enabledIds={settings.enabledPlugins}
        onClose={() => setPluginsOpen(false)}
        onToggle={(pluginId, enabled) => {
          setSettings((s) => {
            const set = new Set(s.enabledPlugins);
            if (enabled) set.add(pluginId);
            else set.delete(pluginId);
            return { ...s, enabledPlugins: [...set] };
          });
        }}
        onRunCommand={(commandId) => {
          runPluginCommand(
            plugins,
            commandId,
            settings.enabledPlugins,
            setStatus,
            settings.pluginSettings,
            (pluginSettings) => setSettings((s) => ({ ...s, pluginSettings })),
          );
        }}
        pluginSettings={settings.pluginSettings}
        onPluginSetting={(pluginId, key, value) => {
          setSettings((s) => ({
            ...s,
            pluginSettings: {
              ...s.pluginSettings,
              [pluginId]: { ...(s.pluginSettings[pluginId] ?? {}), [key]: value },
            },
          }));
        }}
      />
      <CommandPalette
        open={cmdOpen}
        commands={commands}
        onClose={() => setCmdOpen(false)}
        vaultRoot={vault?.root ?? null}
        onOpenSearchHit={(path, line) =>
          void openPath(path, false, undefined, { line: line > 0 ? line : undefined })
        }
      />
      <ConfirmDialog />
      <PromptDialog />
    </div>
  );
}

export default App;
