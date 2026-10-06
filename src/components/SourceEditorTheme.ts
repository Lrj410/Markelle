import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/** Body / code — CJK fallbacks OK. */
export const MONO_STACK =
  '"JetBrains Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", "PingFang SC", monospace';

/**
 * Line-number gutter only — dedicated @font-face (MarkelleGutter) so digits
 * never fall through to YaHei / Source Serif (proportional → “大小不一”).
 */
export const GUTTER_FONT_STACK =
  '"MarkelleGutter", "Cascadia Mono", Consolas, "Courier New", monospace';

/** Fixed gutter type size — independent of editor fontSize / heading weight. */
export const GUTTER_FONT_SIZE_PX = 12;

/** Compact line-number column — 3 tabular digits + slim padding. */
export const GUTTER_LINE_MIN_WIDTH = "2.4ch";

/** Inline stamp — beats any stylesheet race / inheritance in WebView2. */
export function stampGutterFonts(view: EditorView) {
  const size = `${GUTTER_FONT_SIZE_PX}px`;
  const nodes = view.dom.querySelectorAll<HTMLElement>(
    ".cm-gutters, .cm-gutter, .cm-gutterElement",
  );
  nodes.forEach((el) => {
    el.style.setProperty("font-family", GUTTER_FONT_STACK, "important");
    el.style.setProperty("font-size", size, "important");
    el.style.setProperty("font-weight", "400", "important");
    el.style.setProperty("font-style", "normal", "important");
    el.style.setProperty("font-variant-numeric", "tabular-nums lining-nums", "important");
    el.style.setProperty("font-feature-settings", '"tnum" 1, "lnum" 1', "important");
  });
}

export const gutterFontStamp = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      stampGutterFonts(view);
    }
    update(u: ViewUpdate) {
      if (u.viewportChanged || u.geometryChanged || u.docChanged) {
        stampGutterFonts(u.view);
      }
    }
  },
);

/** Layout rules that prevent gutters stacking above the document (blank-gap bug). */
export const SOURCE_SCROLLER_LAYOUT = {
  display: "flex !important",
  flexDirection: "row !important",
  alignItems: "flex-start !important",
  flexWrap: "nowrap !important",
} as const;

/**
 * 墨纸语法色 — 暖墨纸面 + 朱砂强调，只用一个强调色和两个低饱和墨色（苔绿 / 赭石）。
 * 不用紫色与霓虹；标题保持统一字号，行号槽才不会跳动。
 */
export function buildSourceHighlightStyle(dark: boolean): HighlightStyle {
  if (dark) {
    return HighlightStyle.define([
      { tag: tags.heading1, color: "#f6f1e8", fontWeight: "700" },
      { tag: tags.heading2, color: "#f1e9dc", fontWeight: "650" },
      { tag: tags.heading3, color: "#e8dece", fontWeight: "600" },
      { tag: [tags.heading4, tags.heading5, tags.heading6], color: "#d9cdb9", fontWeight: "600" },
      { tag: tags.strong, color: "#f6f1e8", fontWeight: "700" },
      { tag: tags.emphasis, color: "#c9bba6", fontStyle: "italic" },
      { tag: tags.strikethrough, color: "#7a6d5b", textDecoration: "line-through" },
      { tag: [tags.link, tags.url], color: "var(--accent-text, #e88a6a)" },
      { tag: tags.monospace, color: "var(--warning, #d9a05b)", fontFamily: MONO_STACK },
      { tag: tags.quote, color: "#b5a793", fontStyle: "italic" },
      { tag: [tags.meta, tags.processingInstruction, tags.comment], color: "#8b7c68" },
      { tag: [tags.keyword, tags.operator, tags.atom], color: "#cfc3ad" },
      { tag: [tags.string, tags.special(tags.string)], color: "var(--success, #7fa86f)" },
      { tag: tags.labelName, color: "var(--warning, #d9a05b)" },
      { tag: tags.contentSeparator, color: "#4a4032" },
      { tag: tags.list, color: "#a4967f" },
      { tag: tags.invalid, color: "#e4756b" },
    ]);
  }
  return HighlightStyle.define([
    { tag: tags.heading1, color: "#201b15", fontWeight: "700" },
    { tag: tags.heading2, color: "#2a231b", fontWeight: "650" },
    { tag: tags.heading3, color: "#35291e", fontWeight: "600" },
    { tag: [tags.heading4, tags.heading5, tags.heading6], color: "#4a3f31", fontWeight: "600" },
    { tag: tags.strong, color: "#201b15", fontWeight: "700" },
    { tag: tags.emphasis, color: "#5a4f40", fontStyle: "italic" },
    { tag: tags.strikethrough, color: "#9a8b77", textDecoration: "line-through" },
    // Link accent bridges to the design-token accent (#ab3d24), fixing the
    // long-standing #a63d24 typo drift.
    { tag: [tags.link, tags.url], color: "var(--accent, #ab3d24)" },
    { tag: tags.monospace, color: "var(--warning, #855c17)", fontFamily: MONO_STACK },
    { tag: tags.quote, color: "#6b5f50", fontStyle: "italic" },
    { tag: [tags.meta, tags.processingInstruction, tags.comment], color: "#9a8b77" },
    { tag: [tags.keyword, tags.operator, tags.atom], color: "#4a3f31" },
    // String / number colours track the design-token semantic pair.
    { tag: [tags.string, tags.special(tags.string)], color: "var(--success, #477040)" },
    { tag: tags.labelName, color: "var(--warning, #855c17)" },
    { tag: tags.contentSeparator, color: "#cfc5b2" },
    { tag: tags.list, color: "#7c6f5c" },
    { tag: tags.invalid, color: "#9a2b22" },
  ]);
}

/** Exported for regression tests — must keep gutters beside content. */
export function buildSourceEditorTheme(dark: boolean, gutterCh = 2.4): Extension {
  // 墨纸版面：暖炭纸面，不用冷灰也不用纯黑 IDE 底。
  // Body size comes from --source-font-size so Ctrl+wheel never rebuilds the theme.
  //
  // Colours bridge to design-tokens.css via `var(--token, fallback)`. CodeMirror
  // emits these strings verbatim into its injected stylesheet, so the root
  // custom properties resolve at paint time and the editor tracks the live
  // palette automatically (the file already relies on this for --paper-elevated
  // / --line). This is preferred over getComputedStyle() here: that would read
  // the *previous* theme on first paint (the `data-theme` attribute is applied
  // in an effect, after render) and returns "" under the node test env. The
  // fallbacks keep the editor correct if a token is ever missing and encode the
  // light/dark selection.
  const ink = `var(--text-primary, ${dark ? "#f2ebdf" : "#201b15"})`;
  const inkSoft = `var(--text-secondary, ${dark ? "#b5a793" : "#6b5f50"})`;
  const paper = `var(--page, ${dark ? "#1e1a14" : "#fdfbf5"})`;
  const gutterBg = `var(--bg-subtle, ${dark ? "#1a1611" : "#f0ebdf"})`;
  const line = `var(--line, ${dark ? "#322a1f" : "#ded5c4"})`;
  const inset = `var(--surface-inset, ${dark ? "#262018" : "#f0ebdf"})`;
  const active = dark ? "rgba(243, 235, 221, 0.05)" : "rgba(38, 31, 23, 0.035)";
  const selection = dark ? "rgba(224, 112, 79, 0.28)" : "rgba(180, 69, 43, 0.16)";
  const match = dark ? "rgba(217, 160, 91, 0.24)" : "rgba(150, 104, 29, 0.16)";
  const gutterFg = dark ? "#7c6f5c" : "#a2947f";
  const caret = ink;
  const accent = `var(--accent-text, ${dark ? "#e88a6a" : "#9c3a22"})`;

  return EditorView.theme(
    {
      "&": {
        height: "100%",
        width: "100%",
        fontSize: "var(--source-font-size, 17px)",
        color: ink,
        backgroundColor: paper,
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-scroller": {
        ...SOURCE_SCROLLER_LAYOUT,
        fontFamily: MONO_STACK,
        lineHeight: "1.72",
        overflow: "auto !important",
        color: ink,
        backgroundColor: paper,
        fontVariantLigatures: "contextual",
        fontFeatureSettings: '"liga" 1, "calt" 1, "ss01" 1',
      },
      ".cm-gutters": {
        flexShrink: "0 !important",
        display: "flex !important",
        flexDirection: "row !important",
        flexWrap: "nowrap !important",
        alignItems: "flex-start !important",
        backgroundColor: gutterBg,
        color: gutterFg,
        border: "none",
        borderRight: `1px solid ${line}`,
        padding: "0",
        minWidth: "max-content",
        width: "auto",
        fontFamily: GUTTER_FONT_STACK,
        fontSize: `${GUTTER_FONT_SIZE_PX}px`,
        fontWeight: "400",
        fontStyle: "normal",
        fontVariantNumeric: "tabular-nums lining-nums",
        fontFeatureSettings: '"tnum" 1, "lnum" 1, "liga" 0, "calt" 0',
        letterSpacing: "0",
      },
      ".cm-gutterElement": {
        padding: "0",
        minHeight: "0",
        overflow: "hidden",
        boxSizing: "border-box",
        fontFamily: GUTTER_FONT_STACK,
        fontSize: `${GUTTER_FONT_SIZE_PX}px`,
        fontWeight: "400",
        fontStyle: "normal",
        fontVariantNumeric: "tabular-nums lining-nums",
        fontFeatureSettings: '"tnum" 1, "lnum" 1, "liga" 0, "calt" 0',
        letterSpacing: "0",
        opacity: "0.88",
      },
      ".cm-lineNumbers": {
        minWidth: "max-content",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        fontFamily: GUTTER_FONT_STACK,
        fontSize: `${GUTTER_FONT_SIZE_PX}px`,
        fontWeight: "400",
        minWidth: `${Math.max(2.4, gutterCh)}ch`,
        padding: "0 6px",
        textAlign: "center",
        boxSizing: "border-box",
      },
      ".cm-content": {
        flex: "1 0 auto",
        maxWidth: "none",
        padding: "28px 36px 72px 22px",
        caretColor: caret,
        color: ink,
        backgroundColor: "transparent",
      },
      ".cm-line": {
        color: ink,
        padding: "0 4px",
        borderRadius: "3px",
      },
      ".cm-activeLine": {
        backgroundColor: active,
      },
      ".cm-activeLineGutter": {
        backgroundColor: dark ? "rgba(243, 235, 221, 0.06)" : "rgba(38, 31, 23, 0.045)",
        color: inkSoft,
        // Same weight as idle — weight shifts read as “大小不一”.
        fontWeight: "400",
        opacity: "1",
      },
      "&.cm-focused .cm-cursor": {
        borderLeftColor: caret,
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: selection,
      },
      ".cm-selectionMatch": {
        backgroundColor: match,
        borderRadius: "2px",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: dark ? "rgba(217, 160, 91, 0.2)" : "rgba(150, 104, 29, 0.14)",
        outline: "none",
        borderRadius: "2px",
      },
      ".cm-panels": {
        backgroundColor: "var(--paper-elevated, " + inset + ")",
        color: ink,
        borderBottom: `1px solid var(--line, ${line})`,
        boxShadow: dark
          ? "0 4px 16px rgba(0, 0, 0, 0.35)"
          : "0 2px 8px rgba(58, 44, 30, 0.07)",
        zIndex: "40",
      },
      ".cm-panel.cm-search": {
        position: "relative",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: "8px",
        rowGap: "8px",
        padding: "10px 44px 10px 14px",
        fontFamily: "var(--font-ui, sans-serif)",
        fontSize: "12.5px",
        lineHeight: "1.4",
        boxSizing: "border-box",
        width: "100%",
        backgroundColor: "var(--paper-elevated, " + inset + ")",
      },
      ".cm-panel.cm-search br": {
        display: "block",
        flexBasis: "100%",
        width: "100%",
        height: "0",
        margin: "0",
        border: "none",
      },
      ".cm-panel.cm-search input[type=text], .cm-panel.cm-search input:not([type])": {
        fontSize: "13px",
        fontFamily: "var(--font-ui, sans-serif)",
        border: `1px solid var(--line, ${line})`,
        borderRadius: "var(--radius-sm, 6px)",
        backgroundColor: "var(--paper, " + paper + ")",
        color: ink,
        padding: "0 10px",
        outline: "none",
        boxSizing: "border-box",
        width: "250px",
        minWidth: "180px",
        height: "30px",
        lineHeight: "30px",
        margin: "0",
        transition: "border-color 0.15s ease, box-shadow 0.15s ease",
      },
      ".cm-panel.cm-search input[type=text]::placeholder, .cm-panel.cm-search input:not([type])::placeholder": {
        color: inkSoft,
        opacity: "0.65",
      },
      ".cm-panel.cm-search input:focus": {
        borderColor: accent,
        boxShadow: `0 0 0 2px ${dark ? "rgba(224,112,79,0.3)" : "rgba(180,69,43,0.24)"}`,
      },
      ".cm-panel.cm-search input[type=checkbox]": {
        width: "14px",
        height: "14px",
        margin: "0",
        cursor: "pointer",
        accentColor: accent,
      },
      ".cm-panel.cm-search button": {
        fontSize: "12px",
        fontWeight: "500",
        fontFamily: "var(--font-ui, sans-serif)",
        border: `1px solid var(--line, ${line})`,
        borderRadius: "var(--radius-sm, 6px)",
        backgroundColor: "var(--paper, " + paper + ")",
        color: ink,
        padding: "0 11px",
        height: "30px",
        cursor: "pointer",
        margin: "0",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        whiteSpace: "nowrap",
        userSelect: "none",
        transition: "all 0.15s ease",
      },
      ".cm-panel.cm-search button:hover": {
        color: ink,
        backgroundColor: dark ? "rgba(243, 235, 221, 0.08)" : "rgba(38, 31, 23, 0.05)",
        borderColor: accent,
      },
      ".cm-panel.cm-search button:active": {
        transform: "translateY(0.5px)",
      },
      ".cm-panel.cm-search button[name=prev]": {
        order: "1",
      },
      ".cm-panel.cm-search button[name=next]": {
        order: "2",
      },
      ".cm-panel.cm-search button[name=select]": {
        order: "3",
      },
      ".cm-panel.cm-search button[name=close]": {
        position: "absolute",
        top: "10px",
        right: "12px",
        width: "28px",
        height: "28px",
        margin: "0",
        padding: "0",
        border: "none",
        backgroundColor: "transparent",
        color: inkSoft,
        fontSize: "18px",
        lineHeight: "1",
        borderRadius: "var(--radius-sm, 6px)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 0.15s ease",
      },
      ".cm-panel.cm-search button[name=close]:hover": {
        backgroundColor: dark ? "rgba(243, 235, 221, 0.1)" : "rgba(38, 31, 23, 0.08)",
        color: ink,
      },
      ".cm-panel.cm-search label": {
        fontSize: "12px",
        color: inkSoft,
        whiteSpace: "nowrap",
        margin: "0",
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        cursor: "pointer",
        userSelect: "none",
        padding: "4px 8px",
        borderRadius: "var(--radius-sm, 6px)",
        border: "1px solid transparent",
        order: "4",
        transition: "all 0.15s ease",
      },
      ".cm-panel.cm-search label:hover": {
        color: ink,
        backgroundColor: dark ? "rgba(243, 235, 221, 0.05)" : "rgba(38, 31, 23, 0.04)",
      },
      ".cm-tooltip": {
        backgroundColor: inset,
        color: ink,
        border: `1px solid ${line}`,
        borderRadius: "9px",
        boxShadow: dark
          ? "0 14px 36px rgba(0, 0, 0, 0.5)"
          : "0 14px 32px rgba(58, 44, 30, 0.14)",
        fontFamily: "var(--font-ui, sans-serif)",
        fontSize: "13px",
        overflow: "hidden",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: dark ? "rgba(224, 112, 79, 0.22)" : "rgba(180, 69, 43, 0.12)",
        color: ink,
      },
      ".cm-completionIcon": {
        opacity: 0.5,
      },
    },
    { dark },
  );
}
