import { memo, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { autocompletion } from "@codemirror/autocomplete";
import { search, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { vim } from "@replit/codemirror-vim";
import {
  buildSourceEditorTheme,
  buildSourceHighlightStyle,
  gutterFontStamp,
  stampGutterFonts,
} from "./SourceEditorTheme";
import { wikiLinkCompletion } from "../lib/wikiComplete";
import { markdownEditingKeymap } from "../lib/mdFormat";
import { FONT_SIZE_EVENT } from "../lib/fontSize";
import type { VaultFile } from "../lib/vaultIndex";
import {
  insertMarkdownLink,
  wrapSelection,
} from "../lib/mdFormat";
import { filesFromDataTransfer, isImageFile } from "../lib/attachments";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { buildVirtualInitialText, createVirtualDocExtension } from "../lib/virtualDoc";
import { htmlToMarkdown } from "../lib/htmlToMd";
import { EditorContextMenu, type ContextMenuItem } from "./EditorContextMenu";
import "../styles/source-gutter.css";

export interface SourceCursorInfo {
  line: number;
  col: number;
  chars: number;
  lines: number;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  dark: boolean;
  fontSize: number;
  vaultFiles?: VaultFile[];
  wordWrap?: boolean;
  lineNumbers?: boolean;
  /** Enable CodeMirror Vim keybindings. */
  vimMode?: boolean;
  /** Native spellcheck on the contenteditable surface. */
  spellcheck?: boolean;
  /** When true, document is view-only (large-file hydrate). */
  readOnly?: boolean;
  /** 1-based line to scroll into view once (consumed by parent clearing). */
  scrollToLine?: number | null;
  onScrolledToLine?: () => void;
  /** Increment to open the find/replace panel. */
  findRequest?: number;
  /**
   * Optional paste handler (e.g. image → vault attachment).
   * Return markdown snippets to insert at the cursor, or false/empty to skip.
   */
  onPasteFiles?: (
    files: File[],
  ) =>
    | string[]
    | false
    | void
    | boolean
    | Promise<string[] | false | void | boolean>;
  /** Expose live EditorView for the workbench format chrome. */
  onViewReady?: (view: EditorView | null) => void;
  /** Cursor / doc meta for the status rail. */
  onCursorInfo?: (info: SourceCursorInfo) => void;
  /** Native virtual document configuration for ultra-large files */
  virtualDoc?: {
    path: string;
    totalLines: number;
  };
}


function emitCursor(view: EditorView, onCursorInfo?: (info: SourceCursorInfo) => void) {
  if (!onCursorInfo) return;
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  onCursorInfo({
    line: line.number,
    col: pos - line.from + 1,
    chars: view.state.doc.length,
    lines: view.state.doc.lines,
  });
}

function SourceEditorInner({
  value,
  onChange,
  dark,
  fontSize: _fontSize,
  vaultFiles = [],
  wordWrap = true,
  lineNumbers = true,
  vimMode = false,
  spellcheck = false,
  readOnly = false,
  scrollToLine = null,
  onScrolledToLine,
  findRequest = 0,
  onPasteFiles,
  onViewReady,
  onCursorInfo,
  virtualDoc,
}: Props) {
  void _fontSize; // size via --source-font-size (Ctrl+wheel / settings)
  const locale = useLocale();
  const paneRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const pasteRef = useRef(onPasteFiles);
  pasteRef.current = onPasteFiles;
  const cursorRef = useRef(onCursorInfo);
  cursorRef.current = onCursorInfo;
  const readyRef = useRef(onViewReady);
  readyRef.current = onViewReady;
  const scrolledGenRef = useRef(0);
  const [ctx, setCtx] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );

  const isLargeDoc = Boolean(virtualDoc) || value.length > 2_000_000;
  const isMegaDoc = Boolean(virtualDoc) || value.length > 20_000_000;
  const estimatedDigits = useMemo(() => {
    if (virtualDoc && virtualDoc.totalLines > 0) {
      return Math.max(3, String(virtualDoc.totalLines).length);
    }
    let lines = 1;
    for (let i = 0; i < Math.min(value.length, 50000); i++) {
      if (value.charCodeAt(i) === 10) lines++;
    }
    const total = Math.max(lines, Math.floor(value.length / 45));
    return Math.max(3, String(total).length);
  }, [value, virtualDoc]);

  const docValue = useMemo(() => {
    if (virtualDoc && virtualDoc.totalLines > 0) {
      return buildVirtualInitialText(value, virtualDoc.totalLines);
    }
    return value;
  }, [value, virtualDoc]);

  const extensions = useMemo(() => {
    void locale;
    const exts: Extension[] = [
      EditorState.phrases.of({
        Find: t("source.findPlaceholder"),
        Replace: t("source.replacePlaceholder"),
        next: t("source.findNext"),
        previous: t("source.findPrev"),
        all: t("source.findAll"),
        "match case": t("source.matchCase"),
        regexp: t("source.regexp"),
        "by word": t("source.byWord"),
        replace: t("source.replace"),
        "replace all": t("source.replaceAll"),
        close: t("source.close"),
      }),
      markdown(),
      syntaxHighlighting(buildSourceHighlightStyle(dark)),
      search({ top: true }),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      markdownEditingKeymap(),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          emitCursor(update.view, cursorRef.current);
        }
      }),
      EditorView.domEventHandlers({
        paste(event, view) {
          if (readOnly || !event.clipboardData) return false;
          const handler = pasteRef.current;
          const files = handler ? filesFromDataTransfer(event.clipboardData).filter(isImageFile) : [];
          if (!files.length) {
            const html = event.clipboardData.getData("text/html");
            const plain = event.clipboardData.getData("text/plain") || "";
            // Only convert if there is substantive HTML tags and plain text doesn't look like raw Markdown already
            if (html && /<(?:p|div|h[1-6]|table|ul|ol|li|blockquote|strong|b|em|i|a|pre|code)\b/i.test(html)) {
              const md = htmlToMarkdown(html);
              if (md && md.trim().length > 0 && md.trim() !== plain.trim()) {
                event.preventDefault();
                const sel = view.state.selection.main;
                view.dispatch({
                  changes: { from: sel.from, to: sel.to, insert: md },
                  selection: { anchor: sel.from + md.length },
                  scrollIntoView: true,
                });
                return true;
              }
            }
            return false;
          }

          const { from, to } = view.state.selection.main;
          const plainText = event.clipboardData.getData("text/plain") || "";

          const insertLinks = (links: string[]) => {
            if (!links.length) return;
            const text = links.join("\n");
            const sel = view.state.selection.main;
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: text },
              selection: { anchor: sel.from + text.length },
              scrollIntoView: true,
            });
          };

          const restoreTextOnFailure = () => {
            // Image import failed — if clipboard also had text, restore it so
            // preventDefault did not silently swallow the paste.
            if (!plainText) return;
            view.dispatch({
              changes: { from, to, insert: plainText },
              selection: { anchor: from + plainText.length },
              scrollIntoView: true,
            });
          };

          if (!handler) return false;
          const result = handler(files);
          if (result === true) {
            event.preventDefault();
            return true;
          }
          if (Array.isArray(result)) {
            if (!result.length) return false;
            event.preventDefault();
            insertLinks(result);
            return true;
          }
          if (result && typeof (result as Promise<unknown>).then === "function") {
            event.preventDefault();
            void (result as Promise<string[] | false | void | boolean>).then((r) => {
              if (Array.isArray(r) && r.length) insertLinks(r);
              else restoreTextOnFailure();
            });
            return true;
          }
          return false;
        },
      }),
      EditorView.contentAttributes.of({ spellcheck: spellcheck ? "true" : "false" }),
    ];
    if (vimMode && !readOnly) exts.unshift(vim());
    if (wordWrap && !isLargeDoc) exts.push(EditorView.lineWrapping);
    if (!isMegaDoc) {
      exts.push(highlightSelectionMatches());
      exts.push(
        autocompletion({
          override: vaultFiles.length ? [wikiLinkCompletion(vaultFiles)] : undefined,
          activateOnTyping: true,
        }),
      );
    }
    if (virtualDoc && virtualDoc.totalLines > 0) {
      exts.push(createVirtualDocExtension(virtualDoc.path, virtualDoc.totalLines));
    }
    exts.push(
      buildSourceEditorTheme(dark, estimatedDigits + 1),
      gutterFontStamp,
    );
    exts.push(keymap.of([{ key: "Mod-f", run: openSearchPanel }]));
    return exts;
  }, [vaultFiles, wordWrap, dark, readOnly, vimMode, spellcheck, locale, isLargeDoc, isMegaDoc, estimatedDigits, virtualDoc]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const ro = new ResizeObserver(() => {
      viewRef.current?.requestMeasure();
    });
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onFontZoom = () => {
      viewRef.current?.requestMeasure();
    };
    window.addEventListener(FONT_SIZE_EVENT, onFontZoom);
    return () => window.removeEventListener(FONT_SIZE_EVENT, onFontZoom);
  }, []);

  useEffect(() => {
    return () => {
      readyRef.current?.(null);
    };
  }, []);

  useEffect(() => {
    if (!scrollToLine || scrollToLine < 1) return;
    const view = viewRef.current;
    if (!view) return;
    const gen = ++scrolledGenRef.current;
    const line = Math.min(scrollToLine, view.state.doc.lines);
    const run = () => {
      if (gen !== scrolledGenRef.current || !viewRef.current) return;
      try {
        const pos = viewRef.current.state.doc.line(line).from;
        viewRef.current.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 28 }),
        });
        viewRef.current.focus();
      } catch {
        /* ignore */
      }
      onScrolledToLine?.();
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, [scrollToLine, value, onScrolledToLine]);

  useEffect(() => {
    if (!findRequest) return;
    const view = viewRef.current;
    if (!view) return;
    openSearchPanel(view);
    view.focus();
  }, [findRequest]);

  return (
    <div
      className="source-pane"
      ref={paneRef}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const view = viewRef.current;
        const hasSel = Boolean(view && !view.state.selection.main.empty);
        const items: ContextMenuItem[] = [
          {
            id: "cut",
            label: t("edit.cut"),
            disabled: readOnly || !hasSel,
            onSelect: () => {
              if (!view || readOnly) return;
              const { from, to } = view.state.selection.main;
              if (from === to) return;
              const text = view.state.sliceDoc(from, to);
              void navigator.clipboard.writeText(text).catch(() => undefined);
              view.dispatch({
                changes: { from, to, insert: "" },
                selection: { anchor: from },
              });
              view.focus();
            },
          },
          {
            id: "copy",
            label: t("edit.copy"),
            disabled: !hasSel,
            onSelect: () => {
              if (!view) return;
              const { from, to } = view.state.selection.main;
              if (from === to) return;
              const text = view.state.sliceDoc(from, to);
              void navigator.clipboard.writeText(text).catch(() => undefined);
              view.focus();
            },
          },
          {
            id: "paste",
            label: t("edit.paste"),
            disabled: readOnly,
            onSelect: () => {
              if (!view || readOnly) return;
              view.focus();
              void navigator.clipboard
                .readText()
                .then((text) => {
                  if (!text) return;
                  const { from, to } = view.state.selection.main;
                  view.dispatch({
                    changes: { from, to, insert: text },
                    selection: { anchor: from + text.length },
                  });
                })
                .catch(() => {
                  /* clipboard permission denied */
                });
            },
          },
          {
            id: "select-all",
            label: t("edit.selectAll"),
            onSelect: () => {
              if (!view) return;
              view.focus();
              view.dispatch({
                selection: { anchor: 0, head: view.state.doc.length },
              });
            },
          },
          { id: "sep-fmt", label: "", separator: true },
          {
            id: "bold",
            label: t("edit.bold"),
            disabled: readOnly,
            onSelect: () => {
              if (!view || readOnly) return;
              wrapSelection(view, "**");
              view.focus();
            },
          },
          {
            id: "italic",
            label: t("edit.italic"),
            disabled: readOnly,
            onSelect: () => {
              if (!view || readOnly) return;
              wrapSelection(view, "*");
              view.focus();
            },
          },
          {
            id: "link",
            label: t("edit.insertLink"),
            disabled: readOnly,
            onSelect: () => {
              if (!view || readOnly) return;
              insertMarkdownLink(view);
              view.focus();
            },
          },
          {
            id: "find",
            label: t("edit.find"),
            onSelect: () => {
              if (!view) return;
              openSearchPanel(view);
              view.focus();
            },
          },
          { id: "sep-ai", label: "", separator: true },
          ...(hasSel
            ? [
                {
                  id: "ai-polish-sel",
                  label: "✨ 润色所选文字 (AI Polish)",
                  onSelect: () => {
                    window.dispatchEvent(
                      new CustomEvent("markelle:ai-action", { detail: { action: "polish" } }),
                    );
                  },
                },
                {
                  id: "ai-translate-sel",
                  label: "✨ 翻译所选文字 (AI Translate)",
                  onSelect: () => {
                    window.dispatchEvent(
                      new CustomEvent("markelle:ai-action", { detail: { action: "translate" } }),
                    );
                  },
                },
                {
                  id: "ai-proofread-sel",
                  label: "✨ 纠错校对所选 (AI Proofread)",
                  onSelect: () => {
                    window.dispatchEvent(
                      new CustomEvent("markelle:ai-action", { detail: { action: "proofread" } }),
                    );
                  },
                },
              ]
            : []),
          {
            id: "ai-panel",
            label: "✨ 打开 AI 助手 (Alt+A)",
            onSelect: () => {
              window.dispatchEvent(new CustomEvent("markelle:open-ai"));
            },
          },
        ];
        setCtx({ x: event.clientX, y: event.clientY, items });
      }}
    >
      <CodeMirror
        className="source-cm"
        value={docValue}
        height="100%"
        width="100%"
        theme="none"
        extensions={extensions}
        onChange={onChange}
        onCreateEditor={(view) => {
          viewRef.current = view;
          readyRef.current?.(view);
          emitCursor(view, cursorRef.current);
          stampGutterFonts(view);
          queueMicrotask(() => {
            stampGutterFonts(view);
            view.requestMeasure();
          });
        }}
        basicSetup={{
          lineNumbers,
          // Fold chevrons next to empty viewport looked like a second
          // “broken” gutter under short notes — keep Ink Bench numbers-only.
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          searchKeymap: true,
          bracketMatching: true,
        }}
      />
      {ctx ? (
        <EditorContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.items}
          onClose={() => setCtx(null)}
        />
      ) : null}
    </div>
  );
}

export const SourceEditor = memo(SourceEditorInner);
