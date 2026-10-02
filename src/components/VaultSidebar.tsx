import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { askConfirm } from "../lib/appConfirm";
import type { SearchHit, VaultInfo, VaultNode } from "../lib/vault";
import { searchVault } from "../lib/vault";
import {
  computeRowWindow,
  flattenVaultRows,
  VAULT_ROW_HEIGHT,
  VAULT_VIRTUALIZE_THRESHOLD,
  type VaultRow,
} from "../lib/vaultRows";
import { pathsEqual } from "../lib/openTab";
import { basename, joinPath, toPosixPath, trimTrailingSep } from "../lib/paths";
import { vaultCreateDir, vaultDelete, vaultRename } from "../lib/vaultOps";
import { formatAppError } from "../lib/errors";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

interface Props {
  vault: VaultInfo;
  activePath: string | null;
  busy?: boolean;
  onOpenFile: (path: string) => void;
  onCloseVault: () => void;
  onRefresh: () => void;
  onNewNote?: (dir?: string) => void;
  onStatus?: (msg: string) => void;
  onRenamePath?: (oldPath: string, newPath: string, isDir: boolean) => Promise<void> | void;
}

function relativeUnderRoot(root: string, absolute: string): string {
  const r = trimTrailingSep(toPosixPath(root));
  const a = trimTrailingSep(toPosixPath(absolute));
  if (a === r) return "";
  const prefix = `${r}/`;
  if (a.startsWith(prefix)) return a.slice(prefix.length);
  // Case-insensitive fallback (Windows)
  const rl = r.toLowerCase();
  const al = a.toLowerCase();
  if (al === rl) return "";
  if (al.startsWith(`${rl}/`)) return a.slice(r.length + 1);
  return "";
}

function parentDirOf(path: string): string {
  const p = trimTrailingSep(toPosixPath(path));
  const i = p.lastIndexOf("/");
  if (i <= 0) return p.includes(":") ? p.slice(0, 2) || p : "";
  return p.slice(0, i);
}

type CtxTarget = { path: string; name: string; kind: "dir" | "file" | "root" };

interface VaultRowProps {
  row: VaultRow;
  activePath: string | null;
  selectedPath: string | null;
  expanded: boolean;
  emptyLabel: string;
  onOpenFile: (path: string) => void;
  onSelect: (path: string, kind: "dir" | "file") => void;
  onToggle: (path: string, depth: number) => void;
  onContextMenu: (e: MouseEvent, target: CtxTarget) => void;
  onMovePath?: (srcPath: string, destDir: string) => void;
}

/*
  Memoised single-line renderer. The old recursive `TreeNode` is gone: the tree
  is flattened into rows by `flattenVaultRows`, and only the visible window is
  mounted. Every prop is primitive or referentially stable (see the
  `useCallback`s below), and the `row` object only changes identity when the tree
  or the expansion state changes — scrolling and editor/status traffic skip all
  of these instances. `depth` no longer holds React state, so toggling a folder
  re-renders at most the visible window instead of an entire subtree.
*/
const VaultRowView = memo(function VaultRowView({
  row,
  activePath,
  selectedPath,
  expanded,
  emptyLabel,
  onOpenFile,
  onSelect,
  onToggle,
  onContextMenu,
  onMovePath,
}: VaultRowProps) {
  const { node, depth } = row;

  if (row.empty) {
    return (
      <div
        className="vault-empty-folder"
        style={{
          height: VAULT_ROW_HEIGHT,
          boxSizing: "border-box",
          paddingLeft: 20 + depth * 12,
        }}
      >
        {emptyLabel}
      </div>
    );
  }

  const selected = selectedPath != null && pathsEqual(node.path, selectedPath);

  if (node.kind === "dir") {
    return (
      <button
        type="button"
        className={clsx("vault-row dir", { selected })}
        style={{
          height: VAULT_ROW_HEIGHT,
          boxSizing: "border-box",
          paddingLeft: 8 + depth * 12,
        }}
        onClick={() => {
          onToggle(node.path, depth);
          onSelect(node.path, "dir");
        }}
        onContextMenu={(e) =>
          onContextMenu(e, { path: node.path, name: node.name, kind: "dir" })
        }
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          const srcPath =
            e.dataTransfer.getData("application/x-markelle-path") ||
            e.dataTransfer.getData("text/plain");
          if (srcPath && onMovePath) {
            onMovePath(srcPath, node.path);
          }
        }}
      >
        <span className="vault-caret">{expanded ? "▾" : "▸"}</span>
        <span className="vault-label">{node.name}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={clsx("vault-row file", {
        active: activePath != null && pathsEqual(node.path, activePath),
        selected,
      })}
      style={{
        height: VAULT_ROW_HEIGHT,
        boxSizing: "border-box",
        paddingLeft: 8 + depth * 12,
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-markelle-path", node.path);
        e.dataTransfer.setData("text/plain", node.path);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => {
        onSelect(node.path, "file");
        onOpenFile(node.path);
      }}
      onContextMenu={(e) =>
        onContextMenu(e, { path: node.path, name: node.name, kind: "file" })
      }
      title={node.path}
    >
      <span className="vault-file-dot" aria-hidden />
      <span className="vault-label">{node.name}</span>
    </button>
  );
});

function VaultSidebarInner({
  vault,
  activePath,
  busy = false,
  onOpenFile,
  onCloseVault,
  onRefresh,
  onNewNote,
  onStatus,
  onRenamePath,
}: Props) {
  useLocale();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<"dir" | "file">("file");
  const [ctx, setCtx] = useState<{ x: number; y: number; target: CtxTarget } | null>(
    null,
  );
  const [prompt, setPrompt] = useState<
    | { mode: "new-folder"; baseDir: string }
    | { mode: "rename"; target: CtxTarget }
    | null
  >(null);
  const [promptValue, setPromptValue] = useState("");
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);

  // Virtualised tree state. Expansion lives here (per path) instead of inside a
  // recursive node, so the whole tree can be flattened and windowed. A missing
  // entry falls back to the legacy default: dirs shallower than depth 2 open.
  const [expandedOverrides, setExpandedOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);

  const closePrompt = useCallback(() => setPrompt(null), []);

  useModalFocusTrap({
    active: Boolean(prompt),
    containerRef: promptRef,
    onEscape: closePrompt,
    initialFocusSelector: "input",
  });

  const debouncedQuery = useMemo(() => query.trim(), [query]);

  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setHits([]);
      setSearchError("");
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await searchVault(vault.root, debouncedQuery);
          if (!cancelled) {
            setHits(result);
            setSearchError("");
          }
        } catch (err) {
          if (!cancelled) {
            setHits([]);
            setSearchError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [debouncedQuery, vault.root]);

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  // Move keyboard focus onto the first menu item when the context menu opens.
  useEffect(() => {
    if (!ctx) return;
    const first = ctxMenuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus();
  }, [ctx]);

  const onCtxMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      ctxMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([disabled])',
      ) ?? [],
    );
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(current + 1) % buttons.length]!.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(current - 1 + buttons.length) % buttons.length]!.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]!.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]!.focus();
    }
  };

  const showSearch = debouncedQuery.length >= 2;

  // --- Flat rows + windowed rendering --------------------------------------
  // `depth < 2` preserves the legacy "first two levels start open" default.
  const isExpanded = useCallback(
    (node: VaultNode, depth: number) => {
      const override = expandedOverrides.get(node.path);
      return override ?? depth < 2;
    },
    [expandedOverrides],
  );

  const toggleRow = useCallback((path: string, depth: number) => {
    setExpandedOverrides((prev) => {
      const current = prev.get(path) ?? depth < 2;
      const next = new Map(prev);
      next.set(path, !current);
      return next;
    });
  }, []);

  const treeRows = useMemo(
    () => flattenVaultRows(vault.tree, { expanded: isExpanded }),
    [vault.tree, isExpanded],
  );

  // Small vaults render in one pass; only genuinely large ones pay for windowing.
  const virtualizeTree = !showSearch && treeRows.length > VAULT_VIRTUALIZE_THRESHOLD;

  const rowWindow = useMemo(
    () =>
      virtualizeTree
        ? computeRowWindow(treeRows.length, VAULT_ROW_HEIGHT, scrollTop, viewportHeight)
        : { start: 0, end: treeRows.length, padTop: 0, padBottom: 0 },
    [virtualizeTree, treeRows.length, scrollTop, viewportHeight],
  );

  const visibleRows = virtualizeTree
    ? treeRows.slice(rowWindow.start, rowWindow.end)
    : treeRows;

  const emptyFolderLabel = t("vault.emptyFolder");

  // Coalesce scroll events into one state update per frame; the live value is
  // kept in a ref so we never read layout during render.
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop(scrollTopRef.current);
    });
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    },
    [],
  );

  // Collapsing shrinks the content, so the browser clamps `scrollTop`; resync so
  // the window can never render blank after a structural change.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, [treeRows.length]);

  const report = useCallback(
    (msg: string) => {
      onStatus?.(msg);
    },
    [onStatus],
  );

  const baseDirForNewFolder = (): string => {
    if (selectedPath && selectedKind === "dir") return selectedPath;
    if (selectedPath && selectedKind === "file") return parentDirOf(selectedPath) || vault.root;
    return vault.root;
  };

  const openNewFolderPrompt = (baseDir?: string) => {
    setCtx(null);
    setPrompt({ mode: "new-folder", baseDir: baseDir ?? baseDirForNewFolder() });
    setPromptValue(t("vault.defaultFolderName"));
  };

  const openRenamePrompt = (target: CtxTarget) => {
    if (target.kind === "root") return;
    setCtx(null);
    setPrompt({ mode: "rename", target });
    setPromptValue(target.name);
  };

  const submitPrompt = async () => {
    if (!prompt) return;
    const name = promptValue.trim();
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
      report(t("vault.invalidName"));
      return;
    }
    try {
      if (prompt.mode === "new-folder") {
        const abs = joinPath(prompt.baseDir, name);
        const relative = relativeUnderRoot(vault.root, abs);
        if (!relative) {
          report(t("vault.badFolderPath"));
          return;
        }
        await vaultCreateDir(vault.root, relative);
        report(t("vault.folderCreated", { name }));
        setPrompt(null);
        // Expand parent mentally by selecting it; refresh tree so empty dirs appear.
        setSelectedPath(abs);
        setSelectedKind("dir");
        onRefresh();
      } else {
        const parent = parentDirOf(prompt.target.path);
        const toPath = joinPath(parent, name);
        if (pathsEqual(toPath, prompt.target.path)) {
          setPrompt(null);
          return;
        }
        await vaultRename(vault.root, prompt.target.path, toPath);
        report(t("vault.renamed", { name }));
        setPrompt(null);
        await onRenamePath?.(prompt.target.path, toPath, prompt.target.kind === "dir");
        onRefresh();
      }
    } catch (err) {
      report(formatAppError(err));
    }
  };

  const handleMovePath = useCallback(
    async (srcPath: string, destDir: string) => {
      const fileName = basename(srcPath);
      const toPath = joinPath(destDir, fileName);
      if (pathsEqual(srcPath, toPath) || pathsEqual(parentDirOf(srcPath), destDir)) {
        return;
      }
      try {
        await vaultRename(vault.root, srcPath, toPath);
        report(t("vault.renamed", { name: fileName }));
        await onRenamePath?.(srcPath, toPath, false);
        onRefresh();
      } catch (err) {
        report(formatAppError(err));
      }
    },
    [vault, onRenamePath, onRefresh, report],
  );

  const doDelete = async (target: CtxTarget) => {
    setCtx(null);
    if (target.kind === "root") return;
    const label =
      target.kind === "dir"
        ? t("vault.folderLabel", { name: target.name })
        : t("vault.fileLabel", { name: target.name });
    const ok = await askConfirm(t("vault.deleteConfirm", { label }), {
      title: "Markelle",
      kind: "warning",
      okLabel: t("vault.moveToTrash"),
    });
    if (!ok) return;
    try {
      await vaultDelete(vault.root, target.path);
      if (selectedPath && pathsEqual(selectedPath, target.path)) {
        setSelectedPath(null);
      }
      report(t("vault.movedToTrash", { name: target.name }));
      onRefresh();
    } catch (err) {
      report(formatAppError(err));
    }
  };

  // Stable: only touches state setters and `window`. This identity is what lets
  // the memoised VaultRowView instances skip re-rendering.
  const onContextMenu = useCallback((e: MouseEvent, target: CtxTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(target.kind === "root" ? null : target.path);
    if (target.kind === "dir" || target.kind === "file") {
      setSelectedKind(target.kind);
    }
    const menuW = 168;
    const menuH = 160;
    const x = Math.min(Math.max(8, e.clientX), window.innerWidth - menuW - 8);
    const y = Math.min(Math.max(8, e.clientY), window.innerHeight - menuH - 8);
    setCtx({ x, y, target });
  }, []);

  const selectNode = useCallback((path: string, kind: "dir" | "file") => {
    setSelectedPath(path);
    setSelectedKind(kind);
  }, []);

  const dirForNewNote = (target: CtxTarget): string => {
    if (target.kind === "dir") return target.path;
    if (target.kind === "file") return parentDirOf(target.path) || vault.root;
    return vault.root;
  };

  return (
    <aside className="vault-sidebar" aria-label={t("vault.aria")}>
      <div className="vault-head">
        <div className="vault-title-wrap">
          <div className="vault-kicker">{t("vault.kicker")}</div>
          <div className="vault-title" title={vault.root}>
            {vault.name}
          </div>
          <div className="vault-meta">
            {t("vault.mdCount", { count: vault.fileCount })}
            {vault.truncated ? t("vault.truncatedHint") : ""}
          </div>
        </div>
        <div className="vault-actions">
          {onNewNote && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => onNewNote(baseDirForNewFolder())}
              title={t("vault.newNoteTitle")}
            >
              {t("vault.newNote")}
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            onClick={() => openNewFolderPrompt()}
            title={t("vault.newFolderTitle")}
          >
            {t("vault.folder")}
          </button>
          <button type="button" className="btn ghost" onClick={onRefresh} title={t("vault.refresh")}>
            {t("vault.refresh")}
          </button>
          <button type="button" className="btn ghost" onClick={onCloseVault} title={t("vault.closeTitle")}>
            {t("vault.close")}
          </button>
        </div>
      </div>

      <div className="vault-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("vault.searchPlaceholder")}
          aria-label={t("vault.searchAria")}
        />
      </div>

      <div
        ref={bodyRef}
        className="vault-body"
        onScroll={virtualizeTree ? onBodyScroll : undefined}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".vault-row, .vault-hit")) return;
          onContextMenu(e, { path: vault.root, name: vault.name, kind: "root" });
        }}
      >
        {busy && (
          <div className="vault-busy" aria-live="polite">
            <span className="busy-dot" aria-hidden />
            {t("vault.scanningBusy")}
          </div>
        )}
        {showSearch ? (
          <div className="vault-search-results">
            {searching && <p className="vault-empty">{t("vault.searching")}</p>}
            {!searching && searchError && <p className="vault-empty">{searchError}</p>}
            {!searching && !searchError && hits.length === 0 && (
              <p className="vault-empty">{t("vault.noMatch")}</p>
            )}
            {!searching &&
              hits.map((hit) => (
                <button
                  key={`${hit.path}:${hit.line}:${hit.preview}`}
                  type="button"
                  className={clsx("vault-hit", {
                    active: activePath != null && pathsEqual(hit.path, activePath),
                  })}
                  onClick={() => onOpenFile(hit.path)}
                  onContextMenu={(e) =>
                    onContextMenu(e, {
                      path: hit.path,
                      name: hit.name,
                      kind: "file",
                    })
                  }
                >
                  <span className="vault-hit-name">
                    {hit.name}
                    {hit.line > 0 ? `:${hit.line}` : ""}
                  </span>
                  <span className="vault-hit-preview">{hit.preview}</span>
                </button>
              ))}
          </div>
        ) : (
          <div
            className="vault-tree"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              const srcPath =
                e.dataTransfer.getData("application/x-markelle-path") ||
                e.dataTransfer.getData("text/plain");
              if (srcPath) {
                void handleMovePath(srcPath, vault.root);
              }
            }}
          >
            {treeRows.length === 0 ? (
              <p className="vault-empty">{t("vault.noFiles")}</p>
            ) : (
              <>
                {rowWindow.padTop > 0 && (
                  <div aria-hidden style={{ height: rowWindow.padTop }} />
                )}
                {visibleRows.map((row) => (
                  <VaultRowView
                    key={row.key}
                    row={row}
                    activePath={activePath}
                    selectedPath={selectedPath}
                    expanded={
                      !row.empty &&
                      row.node.kind === "dir" &&
                      isExpanded(row.node, row.depth)
                    }
                    emptyLabel={emptyFolderLabel}
                    onOpenFile={onOpenFile}
                    onSelect={selectNode}
                    onToggle={toggleRow}
                    onContextMenu={onContextMenu}
                    onMovePath={handleMovePath}
                  />
                ))}
                {rowWindow.padBottom > 0 && (
                  <div aria-hidden style={{ height: rowWindow.padBottom }} />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {ctx &&
        createPortal(
          <div
            ref={ctxMenuRef}
            className="vault-ctx"
            style={{ left: ctx.x, top: ctx.y }}
            role="menu"
            onKeyDown={onCtxMenuKeyDown}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {onNewNote && (
              <button
                type="button"
                className="vault-ctx-item"
                role="menuitem"
                onClick={() => {
                  const dir = dirForNewNote(ctx.target);
                  setCtx(null);
                  onNewNote(dir);
                }}
              >
                {t("vault.ctxNewNote")}
              </button>
            )}
            <button
              type="button"
              className="vault-ctx-item"
              role="menuitem"
              onClick={() =>
                openNewFolderPrompt(
                  ctx.target.kind === "dir"
                    ? ctx.target.path
                    : ctx.target.kind === "root"
                      ? vault.root
                      : parentDirOf(ctx.target.path) || vault.root,
                )
              }
            >
              {t("vault.ctxNewFolder")}
            </button>
            {ctx.target.kind !== "root" && (
              <button
                type="button"
                className="vault-ctx-item"
                role="menuitem"
                onClick={() => openRenamePrompt(ctx.target)}
              >
                {t("vault.ctxRename")}
              </button>
            )}
            {ctx.target.kind !== "root" && (
              <button
                type="button"
                className="vault-ctx-item danger"
                role="menuitem"
                onClick={() => void doDelete(ctx.target)}
              >
                {t("vault.ctxDelete")}
              </button>
            )}
          </div>,
          document.body,
        )}

      {prompt && (
        <div
          ref={promptRef}
          className="vault-prompt"
          role="dialog"
          aria-modal="true"
          aria-label={
            prompt.mode === "new-folder" ? t("vault.promptNewFolder") : t("vault.promptRename")
          }
        >
          <label className="vault-prompt-label">
            {prompt.mode === "new-folder" ? t("vault.folderName") : t("vault.newName")}
          </label>
          <input
            autoFocus
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void submitPrompt();
              }
            }}
          />
          <div className="vault-prompt-actions">
            <button type="button" className="btn ghost" onClick={() => setPrompt(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" onClick={() => void submitPrompt()}>
              {t("common.confirm")}
            </button>
          </div>
          {prompt.mode === "rename" && (
            <p className="vault-prompt-hint">{basename(prompt.target.path)}</p>
          )}
        </div>
      )}
    </aside>
  );
}

/*
  Memoised so the sidebar is skipped entirely while the vault is unchanged.
  All props are stable across editor/status traffic as long as the callbacks in
  App.tsx stay `useCallback`-wrapped (`openVaultFile`, `refreshVault`,
  `createNoteIn`) and `closeVault` keeps coming from `useVaultActions`.
*/
export const VaultSidebar = memo(VaultSidebarInner);
