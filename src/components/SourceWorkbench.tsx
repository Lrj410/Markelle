import { type ReactNode, useCallback, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import {
  insertBulletList,
  insertCodeFence,
  insertDisplayMath,
  insertHeading,
  insertMarkdownLink,
  insertMarkdownTable,
  insertQuote,
  wrapSelection,
} from "../lib/mdFormat";
import {
  SourceEditor,
  type SourceCursorInfo,
} from "./SourceEditor";
import type { VaultFile } from "../lib/vaultIndex";

interface Props {
  value: string;
  onChange: (value: string) => void;
  dark: boolean;
  vaultFiles?: VaultFile[];
  wordWrap?: boolean;
  lineNumbers?: boolean;
  vimMode?: boolean;
  spellcheck?: boolean;
  readOnly?: boolean;
  scrollToLine?: number | null;
  onScrolledToLine?: () => void;
  findRequest?: number;
  onPasteFiles?: (
    files: File[],
  ) =>
    | string[]
    | false
    | void
    | boolean
    | Promise<string[] | false | void | boolean>;
  /** Pick image files; returns markdown snippets for cursor insertion. */
  onInsertImage?: () => Promise<string[] | null | void> | string[] | null | void;
  /** Surface image-insertion / paste failures to the shell status bar. */
  onStatus?: (msg: string) => void;
  /** Expose live CodeMirror view (for App-level drop-at-cursor). */
  onViewReady?: (view: EditorView | null) => void;
  /** Compact chrome for split panes. */
  compact?: boolean;
  /** Slot above the format rail (e.g. PropertiesStrip). */
  header?: ReactNode;
  /** Native virtual document configuration for ultra-large files */
  virtualDoc?: {
    path: string;
    totalLines: number;
  };
}

type FormatAction = (view: EditorView) => boolean;

function formatChars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function SourceWorkbench({
  value,
  onChange,
  dark,
  vaultFiles,
  wordWrap,
  lineNumbers,
  vimMode,
  spellcheck,
  readOnly = false,
  scrollToLine,
  onScrolledToLine,
  findRequest,
  onPasteFiles,
  onInsertImage,
  onStatus,
  onViewReady,
  compact = false,
  header,
  virtualDoc,
}: Props) {
  useLocale();
  const [view, setView] = useState<EditorView | null>(null);
  const [cursor, setCursor] = useState<SourceCursorInfo>({
    line: 1,
    col: 1,
    chars: 0,
    lines: 1,
  });

  const handleViewReady = useCallback(
    (v: EditorView | null) => {
      setView(v);
      onViewReady?.(v);
    },
    [onViewReady],
  );

  const run = useCallback(
    (action: FormatAction) => {
      if (!view || readOnly) return;
      action(view);
      view.focus();
    },
    [view, readOnly],
  );

  return (
    <div className={`source-workbench${compact ? " is-compact" : ""}`}>
      {header ? <div className="source-workbench-header">{header}</div> : null}

      <div className="source-chrome" role="toolbar" aria-label={t("source.chrome")}>
        <div className="source-chrome-left">
          <span className="source-chrome-kicker">
            {readOnly ? t("source.readOnly") : t("source.label")}
          </span>
          <div
            className="source-format"
            role="group"
            aria-label={t("source.formatGroup")}
            aria-disabled={readOnly || undefined}
          >
            <button
              type="button"
              className="source-format-btn"
              title={t("source.boldTitle")}
              onClick={() => run((v) => wrapSelection(v, "**"))}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              className="source-format-btn"
              title={t("source.italicTitle")}
              onClick={() => run((v) => wrapSelection(v, "*"))}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              className="source-format-btn"
              title={t("source.inlineCode")}
              onClick={() => run((v) => wrapSelection(v, "`"))}
            >
              {"<>"}
            </button>
            <span className="source-format-sep" aria-hidden />
            <button
              type="button"
              className="source-format-btn"
              title={t("source.h2Title")}
              onClick={() => run((v) => insertHeading(v, 2))}
            >
              H2
            </button>
            <button
              type="button"
              className="source-format-btn"
              title={t("source.bulletList")}
              onClick={() => run((v) => insertBulletList(v))}
            >
              •
            </button>
            <button
              type="button"
              className="source-format-btn"
              title={t("source.quote")}
              onClick={() => run((v) => insertQuote(v))}
            >
              {t("source.quoteLabel")}
            </button>
            <span className="source-format-sep" aria-hidden />
            <button
              type="button"
              className="source-format-btn"
              title={t("source.linkTitle")}
              onClick={() => run((v) => insertMarkdownLink(v))}
            >
              {t("source.linkLabel")}
            </button>
            <button
              type="button"
              className="source-format-btn"
              title={t("source.insertImage")}
              disabled={readOnly || !onInsertImage}
              onClick={() => {
                if (readOnly || !onInsertImage) return;
                void Promise.resolve(onInsertImage())
                  .then((links) => {
                    if (!Array.isArray(links) || !links.length || !view) return;
                    const text = links.join("\n");
                    const { from, to } = view.state.selection.main;
                    view.dispatch({
                      changes: { from, to, insert: text },
                      selection: { anchor: from + text.length },
                      scrollIntoView: true,
                    });
                    view.focus();
                  })
                  .catch((err: unknown) => {
                    onStatus?.(
                      `${t("source.insertImage")}: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                  });
              }}
            >
              {t("source.imageLabel")}
            </button>
            <button
              type="button"
              className="source-format-btn"
              title={t("source.table")}
              onClick={() => run((v) => insertMarkdownTable(v))}
            >
              {t("source.tableLabel")}
            </button>
            <button
              type="button"
              className="source-format-btn"
              title={t("source.codeBlock")}
              onClick={() => run((v) => insertCodeFence(v))}
            >
              {t("source.codeLabel")}
            </button>
            <button
              type="button"
              className="source-format-btn"
              title={t("source.mathTitle")}
              onClick={() => run((v) => insertDisplayMath(v))}
            >
              ∑
            </button>
          </div>
        </div>

        <div className="source-chrome-right">
          <button
            type="button"
            className="source-format-btn source-find-btn"
            title={t("source.findTitle")}
            onClick={() => run((v) => openSearchPanel(v))}
          >
            {t("source.findLabel")}
          </button>
          <div className="source-meta" aria-live="polite">
            <span className="source-meta-pos">
              {cursor.line}:{cursor.col}
            </span>
            <span className="source-meta-dot" aria-hidden>
              ·
            </span>
            <span className="source-meta-stat">
              {t("source.lineCount", { n: virtualDoc ? virtualDoc.totalLines : cursor.lines })} ·{" "}
              {t("source.charCount", { n: formatChars(cursor.chars) })}
            </span>
          </div>
        </div>
      </div>

      <SourceEditor
        value={value}
        onChange={onChange}
        dark={dark}
        vaultFiles={vaultFiles}
        wordWrap={wordWrap}
        lineNumbers={lineNumbers}
        vimMode={vimMode}
        spellcheck={spellcheck}
        readOnly={readOnly}
        scrollToLine={scrollToLine}
        onScrolledToLine={onScrolledToLine}
        findRequest={findRequest}
        onPasteFiles={onPasteFiles}
        onViewReady={handleViewReady}
        onCursorInfo={setCursor}
        virtualDoc={virtualDoc}
      />
    </div>
  );
}
