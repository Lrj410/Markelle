import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import clsx from "clsx";
import type { ColorScheme, LayoutPreset, ViewMode } from "../lib/types";
import { isDirty, type DocTab } from "../lib/tabs";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { Select } from "./Select";

interface Props {
  // Tabs & Title state
  tabs: DocTab[];
  activeId: string | null;
  activeTitle: string;
  dirty: boolean;
  busy?: boolean;
  vaultName?: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenInNewWindow: (id: string) => void;
  onReorderTabs?: (from: number, to: number) => void;
  onNewNote?: () => void;
  onOpenCommandPalette?: () => void;

  // View mode & toolbar controls
  hasFile: boolean;
  mode: ViewMode;
  layout: LayoutPreset;
  scheme: ColorScheme;
  fontSize: number;
  lineWidth: number;
  truncated: boolean;
  hydrateRatio?: number;
  immersive: boolean;
  autosave: boolean;
  rightDockOpen?: boolean;
  aiOpen?: boolean;
  onMode: (mode: ViewMode) => void;
  onLayout: (layout: LayoutPreset) => void;
  onScheme: (scheme: ColorScheme) => void;
  onFontSize: (size: number) => void;
  onLineWidth: (width: number) => void;
  onSave: () => void;
  onToggleImmersive: () => void;
  onToggleAutosave: () => void;
  onToggleRightDock?: () => void;
  onToggleAi?: () => void;
}


function UnifiedHeaderInner({
  tabs,
  activeId,
  activeTitle,
  dirty,
  busy,
  vaultName,
  onSelectTab,
  onCloseTab,
  onOpenInNewWindow,
  onReorderTabs,
  onNewNote,
  onOpenCommandPalette,
  hasFile,
  mode,
  layout,
  scheme,
  fontSize,
  lineWidth,
  truncated,
  hydrateRatio = 0,
  immersive,
  autosave,
  rightDockOpen = false,
  aiOpen = false,
  onMode,
  onLayout,
  onScheme,
  onFontSize,
  onLineWidth,
  onSave,
  onToggleImmersive,
  onToggleAutosave,
  onToggleRightDock,
  onToggleAi,
}: Props) {
  useLocale();
  const [maximized, setMaximized] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [stripEdges, setStripEdges] = useState({ start: false, end: false, width: 0 });
  const moreRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);

  const refreshMaximized = useCallback(async () => {
    try {
      setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      /* web preview */
    }
  }, []);

  useEffect(() => {
    void refreshMaximized();
    let un: (() => void) | undefined;
    void (async () => {
      try {
        un = await getCurrentWindow().onResized(() => {
          void refreshMaximized();
        });
      } catch {
        /* ignore */
      }
    })();
    return () => un?.();
  }, [refreshMaximized]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as Node;
      if (moreRef.current?.contains(el)) return;
      if (el instanceof Element && el.closest(".ui-select-menu")) return;
      setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey as unknown as EventListener);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey as unknown as EventListener);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!listOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as Node;
      if (listRef.current?.contains(el)) return;
      setListOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setListOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey as unknown as EventListener);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey as unknown as EventListener);
    };
  }, [listOpen]);

  // Which ends of the strip are scrolled out of view — drives the edge arrows.
  const syncStripEdges = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const start = strip.scrollLeft > 1;
    const end = max > 1 && strip.scrollLeft < max - 1;
    const width = strip.clientWidth;
    setStripEdges((prev) =>
      prev.start === start && prev.end === end && prev.width === width
        ? prev
        : { start, end, width },
    );
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    syncStripEdges();
    strip.addEventListener("scroll", syncStripEdges, { passive: true });
    const observer = new ResizeObserver(syncStripEdges);
    observer.observe(strip);
    return () => {
      strip.removeEventListener("scroll", syncStripEdges);
      observer.disconnect();
    };
  }, [syncStripEdges, tabs.length]);

  // Plain wheel scrolls the strip sideways; Ctrl/⌘+wheel stays font zoom.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || !event.deltaY) return;
      const max = strip.scrollWidth - strip.clientWidth;
      if (max <= 0) return;
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
      const next = Math.max(0, Math.min(max, strip.scrollLeft + event.deltaY * unit));
      if (next === strip.scrollLeft) return;
      event.preventDefault();
      strip.scrollLeft = next;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [tabs.length]);

  const scrollStrip = useCallback((direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    const step = Math.max(140, Math.round(strip.clientWidth * 0.72));
    strip.scrollBy({ left: direction * step, behavior: "smooth" });
  }, []);

  // The strip scrolls once the tabs no longer fit, so keep the active one visible.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeId) return;
    const tab = strip.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeId)}"]`,
    );
    if (!tab) return;
    const stripRect = strip.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    if (tabRect.left < stripRect.left) {
      strip.scrollBy({ left: tabRect.left - stripRect.left - 8, behavior: "smooth" });
    } else if (tabRect.right > stripRect.right) {
      strip.scrollBy({ left: tabRect.right - stripRect.right + 8, behavior: "smooth" });
    }
  }, [activeId, tabs.length]);

  const minimize = () => void getCurrentWindow().minimize().catch(() => undefined);
  const toggleMax = () =>
    void getCurrentWindow()
      .toggleMaximize()
      .then(refreshMaximized)
      .catch(() => undefined);
  const close = () => {
    void getCurrentWindow()
      .close()
      .catch((err) => {
        console.error("window.close failed", err);
      });
  };

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number) => {
      if (tabs.length === 0) return;
      let next = index;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next = (index + 1) % tabs.length;
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        next = (index - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        event.preventDefault();
        next = 0;
      } else if (event.key === "End") {
        event.preventDefault();
        next = tabs.length - 1;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelectTab(tabs[index]!.id);
        return;
      } else {
        return;
      }
      const el = document.querySelector<HTMLElement>(
        `[data-tab-id="${tabs[next]!.id}"]`,
      );
      el?.focus();
    },
    [tabs, onSelectTab],
  );

  const onDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>, index: number) => {
      if (!onReorderTabs) return;
      dragFrom.current = index;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    },
    [onReorderTabs],
  );

  const onDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (!onReorderTabs || dragFrom.current == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    [onReorderTabs],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>, toIndex: number) => {
      if (!onReorderTabs) return;
      e.preventDefault();
      const from = dragFrom.current;
      dragFrom.current = null;
      if (from == null || from === toIndex) return;
      onReorderTabs(from, toIndex);
    },
    [onReorderTabs],
  );

  const pct = Math.max(0, Math.min(99, Math.floor(hydrateRatio * 100)));
  // Narrower than this the two arrows would sit on top of each other; the
  // "all tabs" menu stays as the escape hatch.
  const arrowsFit = stripEdges.width >= 96;

  return (
    <header className="unified-header">
      {/* --- Left: Logo & Vault Branding --- */}
      <div className="unified-header-left">
        <div className="unified-brand">
          <img
            className="unified-logo"
            src="/markelle.svg"
            alt="Markelle"
            width={16}
            height={16}
          />
          <span className="unified-brand-name">Markelle</span>
        </div>

        {vaultName && (
          <span className="unified-vault-pill" title={vaultName}>
            <span className="vault-pill-icon" aria-hidden>
              📁
            </span>
            <span className="vault-pill-text">{vaultName}</span>
          </span>
        )}

        {onNewNote && (
          <button
            type="button"
            className="unified-icon-btn"
            onClick={onNewNote}
            title={t("vault.ctxNewNote")}
            aria-label={t("vault.ctxNewNote")}
           
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z" />
            </svg>
          </button>
        )}
      </div>

      {/* --- Center: Modern Integrated TabBar / Breadcrumb --- */}
      <div className="unified-header-center">
        {tabs.length > 0 ? (
          <>
          <div ref={stripRef} className="unified-tab-strip">
            {arrowsFit && stripEdges.start && (
              <button
                type="button"
                className="unified-tab-scroll start"
                onClick={() => scrollStrip(-1)}
                title={t("tabs.scrollLeft")}
                aria-label={t("tabs.scrollLeft")}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                  <path
                    d="M10 3.2 5.2 8l4.8 4.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
            {/* role="tablist" wraps ONLY the tabs; the scroll arrows are
                siblings inside the scroll container so the tablist has no
                non-tab children. Inline flex reproduces the strip's layout. */}
            <div
              role="tablist"
              aria-label={t("tabs.label")}
              style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}
            >
            {tabs.map((tab, idx) => {
              const active = tab.id === activeId;
              const tabDirty = isDirty(tab);
              return (
                <div
                  key={tab.id}
                  data-tab-id={tab.id}
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  className={clsx("unified-tab", { active, dirty: tabDirty })}
                  onClick={() => onSelectTab(tab.id)}
                  onKeyDown={(e) => onTabKeyDown(e, idx)}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    onCloseTab(tab.id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onOpenInNewWindow(tab.id);
                  }}
                  draggable={Boolean(onReorderTabs)}
                  onDragStart={(e) => onDragStart(e, idx)}
                  onDragOver={onDragOver}
                  onDrop={(e) => onDrop(e, idx)}
                  title={`${tab.name}${tab.path ? ` (${tab.path})` : ""}`}
                 
                >
                  <span className="unified-tab-dot" aria-hidden />
                  <span className="unified-tab-name">{tab.name}</span>
                  {tabDirty && (
                    <span
                      className="unified-tab-dirty-indicator"
                      title={t("tabs.unsaved")}
                    />
                  )}
                  <button
                    type="button"
                    className="unified-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    title={t("tabs.close")}
                    aria-label={`${t("tabs.close")} ${tab.name}`}
                   
                  >
                    ×
                  </button>
                </div>
              );
            })}
            </div>
            {arrowsFit && stripEdges.end && (
              <button
                type="button"
                className="unified-tab-scroll end"
                onClick={() => scrollStrip(1)}
                title={t("tabs.scrollRight")}
                aria-label={t("tabs.scrollRight")}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                  <path
                    d="M6 3.2 10.8 8 6 12.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>

          {/* Every open document, so a tab scrolled out of view is still one click away. */}
          <div className="unified-tab-list-wrap" ref={listRef}>
            <button
              type="button"
              className={clsx("unified-tab-list-btn", { active: listOpen })}
              onClick={() => setListOpen((v) => !v)}
              title={`${t("tabs.all")} (${tabs.length})`}
              aria-label={`${t("tabs.all")} (${tabs.length})`}
              aria-haspopup="menu"
              aria-expanded={listOpen}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M3.2 6 8 10.8 12.8 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {listOpen && (
              <div className="unified-dropdown-popover tab-list-popover" role="menu">
                <div className="tab-list-head">
                  <span>{t("tabs.all")}</span>
                  <span className="tab-list-count">{tabs.length}</span>
                </div>
                <div className="tab-list-scroll">
                  {tabs.map((tab) => {
                    const active = tab.id === activeId;
                    const tabDirty = isDirty(tab);
                    return (
                      <div
                        key={tab.id}
                        className={clsx("tab-list-item", { active })}
                        role="none"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="tab-list-jump"
                          onClick={() => {
                            onSelectTab(tab.id);
                            setListOpen(false);
                          }}
                          title={`${tab.name}${tab.path ? ` (${tab.path})` : ""}`}
                        >
                          <span className="tab-list-dot" aria-hidden />
                          <span className="tab-list-name">{tab.name}</span>
                          {tabDirty && (
                            <span className="tab-list-dirty">{t("tabs.unsaved")}</span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="tab-list-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseTab(tab.id);
                          }}
                          title={t("tabs.close")}
                          aria-label={`${t("tabs.close")} ${tab.name}`}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          </>
        ) : (
          <div className="unified-title-hint">
            {busy && <span className="busy-dot" aria-hidden />}
            <span>{activeTitle || t("title.noFile")}</span>
          </div>
        )}
      </div>

      {/* Window Drag Spacer (dedicated clickable area to drag/maximize window) */}
      <div
        className="unified-drag-spacer"
        data-tauri-drag-region
        onDoubleClick={toggleMax}
        title={t("header.dragHint")}
      />

      {/* --- Right: Quick Actions, Toolbars & Window Controls --- */}
      <div className="unified-header-right">
        {/* Command Palette Pill */}
        {onOpenCommandPalette && (
          <button
            type="button"
            className="unified-cmd-pill"
            onClick={onOpenCommandPalette}
            title="Ctrl+K / ⌘K"
            aria-label={t("cmd.label")}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
            </svg>
            <span className="cmd-pill-label">{t("cmd.label")}</span>
            <kbd className="cmd-pill-kbd">Ctrl+K</kbd>
          </button>
        )}

        {hasFile && (
          <div className="unified-actions">
            {/* View Mode Segmented Pill */}
            <div className="unified-seg" role="group" aria-label={t("view.mode")}>
              <button
                type="button"
                className={clsx("seg-btn", { active: mode === "read" })}
                onClick={() => onMode("read")}
                title={t("view.read")}
               
              >
                {t("view.read")}
              </button>
              <button
                type="button"
                className={clsx("seg-btn", { active: mode === "source" })}
                onClick={() => onMode("source")}
                title={t("view.source")}
               
              >
                {t("view.source")}
              </button>
              <button
                type="button"
                className={clsx("seg-btn", { active: mode === "split" })}
                onClick={() => onMode("split")}
                title={t("view.splitTitle")}
               
              >
                {t("view.split")}
              </button>
            </div>

            {/* Layout Preset Switcher: docs vs book (directly visible!) */}
            <div className="unified-seg" role="group" aria-label={t("view.layout")}>
              <button
                type="button"
                className={clsx("seg-btn", { active: layout === "docs" })}
                onClick={() => onLayout("docs")}
                title={t("settings.layoutDocs")}
               
              >
                {t("settings.layoutDocs")}
              </button>
              <button
                type="button"
                className={clsx("seg-btn", { active: layout === "book" })}
                onClick={() => onLayout("book")}
                title={t("settings.layoutBook")}
               
              >
                {t("settings.layoutBook")}
              </button>
            </div>

            {/* Right Aux Dock Toggle Button */}
            {onToggleRightDock && (
              <button
                type="button"
                className={clsx("unified-text-btn", { active: rightDockOpen })}
                onClick={onToggleRightDock}
                title={
                  rightDockOpen
                    ? t("panel.hideRightDock")
                    : t("panel.showRightDock")
                }
                aria-pressed={rightDockOpen}
               
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M14 2.5A1.5 1.5 0 0 0 12.5 1h-9A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-11ZM12.5 2.5v11h-2v-11h2ZM9 2.5v11H3.5a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5H9Z" />
                </svg>
                <span>{t("panel.auxDock")}</span>
              </button>
            )}

            {/* Local AI Assistant Button */}
            {onToggleAi && (
              <button
                type="button"
                className={clsx("unified-text-btn", "unified-ai-btn", { active: aiOpen })}
                onClick={onToggleAi}
                title={t("ai.toolbarTitle")}
                aria-pressed={aiOpen}
              >
                <svg width="13" height="13" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path
                    d="M9 2.2l1.4 3 3 1.4-3 1.4L9 11 7.6 8 4.6 6.6l3-1.4L9 2.2Z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M13.5 11.2l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4ZM4.5 11.8l.5 1.1 1.1.5-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.5.5-1.1Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>AI</span>
              </button>
            )}

            {/* Zen / Immersive Button */}
            <button
              type="button"
              className={clsx("unified-text-btn", { active: immersive })}
              onClick={onToggleImmersive}
              title={`${t("toolbar.immersiveTitle")} (F11)`}
              aria-pressed={immersive}
             
            >
              <span>{t("toolbar.immersive")}</span>
            </button>

            {/* Save Button (shows explicit state when dirty) */}
            <button
              type="button"
              className={clsx("unified-save-btn", { "is-dirty": dirty })}
              onClick={onSave}
              disabled={truncated || !dirty}
              title={
                truncated
                  ? t("toolbar.saveWait")
                  : dirty
                  ? `${t("toolbar.saveDirty")} (Ctrl+S)`
                  : `${t("toolbar.save")} (Ctrl+S)`
              }
             
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2.75 1.5a1.25 1.25 0 0 0-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V5.121a1.25 1.25 0 0 0-.366-.884l-2.871-2.871A1.25 1.25 0 0 0 10.879 1.5H2.75ZM2.5 13.25V2.75c0-.138.112-.25.25-.25h1.5v3.25a.75.75 0 0 0 .75.75h6a.75.75 0 0 0 .75-.75V2.5h.379c.066 0 .13.026.177.073l2.871 2.871c.047.047.073.111.073.177v7.629a.25.25 0 0 1-.25.25H2.75a.25.25 0 0 1-.25-.25Zm3-8V2.5h4v2.75H5.5Z" />
              </svg>
              <span>{dirty ? t("toolbar.saveDirty") : t("toolbar.save")}</span>
            </button>

            {/* Large file hydrating progress */}
            {truncated && (
              <span
                className="unified-badge-loading"
                title={t("toolbar.hydratingTitle")}
               
              >
                {t("toolbar.hydrating", { pct })}
              </span>
            )}

            {/* More Settings Dropdown */}
            <div className="unified-more-wrap" ref={moreRef}>
              <button
                type="button"
                className={clsx("unified-icon-btn", { active: moreOpen })}
                onClick={() => setMoreOpen((v) => !v)}
                title={t("toolbar.more")}
                aria-label={t("toolbar.more")}
                aria-expanded={moreOpen}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM14.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                </svg>
              </button>

              {moreOpen && (
                <div className="unified-dropdown-popover" role="menu">
                  <div className="popover-row">
                    <span>{t("settings.layout")}</span>
                    <Select<LayoutPreset>
                      value={layout}
                      onChange={onLayout}
                      aria-label={t("settings.layout")}
                      options={[
                        { value: "docs", label: t("settings.layoutDocs") },
                        { value: "book", label: t("settings.layoutBook") },
                      ]}
                    />
                  </div>

                  <div className="popover-row">
                    <span>{t("settings.scheme")}</span>
                    <Select<ColorScheme>
                      value={scheme}
                      onChange={onScheme}
                      aria-label={t("settings.scheme")}
                      options={[
                        { value: "system", label: t("settings.schemeSystem") },
                        { value: "light", label: t("settings.schemeLight") },
                        { value: "dark", label: t("settings.schemeDark") },
                      ]}
                    />
                  </div>

                  <div className="popover-row">
                    <span>{t("toolbar.fontSize")}</span>
                    <div className="popover-btn-group">
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => onFontSize(Math.max(12, fontSize - 1))}
                      >
                        -
                      </button>
                      <span className="popover-val">{fontSize}px</span>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => onFontSize(Math.min(36, fontSize + 1))}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="popover-row">
                    <span>{t("toolbar.lineWidth")}</span>
                    <div className="popover-btn-group">
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => onLineWidth(Math.max(48, lineWidth - 4))}
                      >
                        -
                      </button>
                      <span className="popover-val">{lineWidth}ch</span>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => onLineWidth(Math.min(120, lineWidth + 4))}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="popover-divider" />

                  <div className="popover-actions">
                    <button
                      type="button"
                      className="popover-action-btn"
                      onClick={() => {
                        onToggleAutosave();
                        setMoreOpen(false);
                      }}
                    >
                      <span>{t("settings.autosave")}</span>
                      <span className="popover-tag">{autosave ? "ON" : "OFF"}</span>
                    </button>
                    <button
                      type="button"
                      className={clsx("popover-action-btn", { active: immersive })}
                      onClick={() => {
                        onToggleImmersive();
                        setMoreOpen(false);
                      }}
                    >
                      <span>{t("toolbar.immersive")}</span>
                      <kbd>{immersive ? "Esc" : "F11"}</kbd>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Windows Standard Window Controls */}
        <div className="unified-win-controls">
          <button
            type="button"
            className="win-btn"
            onClick={minimize}
            aria-label={t("title.minimize")}
            title={t("title.minimize")}
           
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn"
            onClick={toggleMax}
            aria-label={maximized ? t("title.restore") : t("title.maximize")}
            title={maximized ? t("title.restore") : t("title.maximize")}
           
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path
                  d="M2.5 3.5h5v5h-5zM3.5 2.5h5v5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect
                  x="1.5"
                  y="1.5"
                  width="7"
                  height="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="win-btn win-btn-close"
            onClick={close}
            aria-label={t("common.close")}
            title={t("common.close")}
           
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}

export const UnifiedHeader = memo(UnifiedHeaderInner);
