import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";

export interface TextEdit {
  doc: string;
  from: number;
  to: number;
}

/** Pure helper: wrap `[from,to)` in `doc` with markers. */
export function wrapRange(
  doc: string,
  from: number,
  to: number,
  before: string,
  after: string = before,
): TextEdit {
  if (from === to) {
    const insert = before + after;
    return {
      doc: doc.slice(0, from) + insert + doc.slice(to),
      from: from + before.length,
      to: from + before.length,
    };
  }
  const selected = doc.slice(from, to);
  const insert = before + selected + after;
  return {
    doc: doc.slice(0, from) + insert + doc.slice(to),
    from: from + before.length,
    to: from + before.length + selected.length,
  };
}

export function linkRange(doc: string, from: number, to: number): TextEdit {
  const selected = doc.slice(from, to);
  const label = selected || "链接文字";
  const insert = `[${label}](url)`;
  const urlFrom = from + 1 + label.length + 2;
  return {
    doc: doc.slice(0, from) + insert + doc.slice(to),
    from: urlFrom,
    to: urlFrom + 3,
  };
}

/** Wrap each selection range with `before`/`after`; if empty, insert markers and place cursor between. */
export function wrapSelection(
  view: EditorView,
  before: string,
  after: string = before,
): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    if (range.empty) {
      const insert = before + after;
      const anchor = range.from + before.length;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(anchor),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.from, to: range.to, insert: before + text + after },
      range: EditorSelection.range(
        range.from + before.length,
        range.from + before.length + text.length,
      ),
    };
  });
  view.dispatch(changes);
  return true;
}

/** Insert `[label](url)` — uses selection as label when present. */
export function insertMarkdownLink(view: EditorView): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const label = selected || "链接文字";
    const insert = `[${label}](url)`;
    const urlFrom = range.from + 1 + label.length + 2;
    const urlTo = urlFrom + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlFrom, urlTo),
    };
  });
  view.dispatch(changes);
  return true;
}

/** Insert a minimal GFM table scaffold. */
export function insertMarkdownTable(view: EditorView): boolean {
  const snippet = `| 列1 | 列2 | 列3 |
| --- | --- | --- |
|  |  |  |
`;
  const { state } = view;
  const pos = state.selection.main.from;
  view.dispatch({
    changes: { from: pos, to: state.selection.main.to, insert: snippet },
    selection: EditorSelection.cursor(pos + snippet.length),
  });
  return true;
}

export const TABLE_SNIPPET = `| 列1 | 列2 | 列3 |
| --- | --- | --- |
|  |  |  |
`;

/** Insert a fenced block; cursor lands inside. */
export function insertFence(
  view: EditorView,
  open: string,
  close: string,
  inner = "\n",
): boolean {
  const { state } = view;
  const selected = state.sliceDoc(state.selection.main.from, state.selection.main.to);
  const body = selected || inner;
  const insert = `${open}${body}${close}`;
  view.dispatch({
    changes: {
      from: state.selection.main.from,
      to: state.selection.main.to,
      insert,
    },
    selection: EditorSelection.cursor(
      selected
        ? state.selection.main.from + open.length + selected.length
        : state.selection.main.from + open.length,
    ),
  });
  return true;
}

export function insertDisplayMath(view: EditorView): boolean {
  return insertFence(view, "$$\n", "\n$$", "");
}

export function insertMermaidFence(view: EditorView): boolean {
  return insertFence(view, "```mermaid\n", "\n```", "flowchart LR\n  A --> B");
}

export function insertCodeFence(view: EditorView): boolean {
  return insertFence(view, "```\n", "\n```", "");
}

/** Prefix the current line (or each selected line) with a markdown marker. */
export function prefixLines(view: EditorView, marker: string): boolean {
  const { state } = view;
  const range = state.selection.main;
  const fromLine = state.doc.lineAt(range.from);
  const toLine = state.doc.lineAt(range.to);
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = fromLine.number; n <= toLine.number; n++) {
    const line = state.doc.line(n);
    if (line.text.startsWith(marker)) continue;
    changes.push({ from: line.from, to: line.from, insert: marker });
  }
  if (!changes.length) {
    view.focus();
    return true;
  }
  let newFrom = range.from;
  let newTo = range.to;
  for (const ch of changes) {
    if (ch.from <= range.from) newFrom += marker.length;
    if (ch.from <= range.to) newTo += marker.length;
  }
  view.dispatch({
    changes,
    selection: EditorSelection.range(newFrom, newTo),
  });
  view.focus();
  return true;
}

export function insertHeading(view: EditorView, level: 1 | 2 | 3 = 2): boolean {
  const marks = "#".repeat(level) + " ";
  return prefixLines(view, marks);
}

export function insertBulletList(view: EditorView): boolean {
  return prefixLines(view, "- ");
}

export function insertQuote(view: EditorView): boolean {
  return prefixLines(view, "> ");
}

export function isTableLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith("|") && trimmed.endsWith("|");
}

function selectCell(view: EditorView, from: number, to: number) {
  const doc = view.state.doc.sliceString(from, to);
  let start = from;
  let end = to;
  while (start < end && doc.charCodeAt(start - from) === 32) start++;
  while (end > start && doc.charCodeAt(end - 1 - from) === 32) end--;
  view.dispatch({
    selection: EditorSelection.range(start, end),
    scrollIntoView: true,
  });
}

export function handleTableTabNext(view: EditorView): boolean {
  const { state } = view;
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  if (!isTableLine(line.text)) return false;

  const text = line.text;
  const pipeIndices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && (i === 0 || text[i - 1] !== "\\")) {
      pipeIndices.push(i);
    }
  }
  if (pipeIndices.length < 2) return false;

  const colOffset = cursor - line.from;
  let currentPipeIndex = -1;
  for (let i = 0; i < pipeIndices.length - 1; i++) {
    if (colOffset >= pipeIndices[i]! && colOffset < pipeIndices[i + 1]!) {
      currentPipeIndex = i;
      break;
    }
  }

  if (currentPipeIndex === -1) {
    if (colOffset < pipeIndices[0]!) {
      const from = line.from + pipeIndices[0]! + 1;
      const to = line.from + pipeIndices[1]!;
      selectCell(view, from, to);
      return true;
    }
    currentPipeIndex = pipeIndices.length - 2;
  }

  // Not the last cell in this row -> jump to next cell in current row
  if (currentPipeIndex < pipeIndices.length - 2) {
    const nextPipe = currentPipeIndex + 1;
    const from = line.from + pipeIndices[nextPipe]! + 1;
    const to = line.from + pipeIndices[nextPipe + 1]!;
    selectCell(view, from, to);
    return true;
  }

  // At the last cell of this row -> jump to next line or add row
  if (line.number < state.doc.lines) {
    const nextLine = state.doc.line(line.number + 1);
    if (isTableLine(nextLine.text)) {
      const nextPipes: number[] = [];
      for (let i = 0; i < nextLine.text.length; i++) {
        if (nextLine.text[i] === "|" && (i === 0 || nextLine.text[i - 1] !== "\\")) {
          nextPipes.push(i);
        }
      }
      if (nextPipes.length >= 2) {
        const from = nextLine.from + nextPipes[0]! + 1;
        const to = nextLine.from + nextPipes[1]!;
        selectCell(view, from, to);
        return true;
      }
    }
  }

  // Next line is not a table line -> create a new row with the same number of columns!
  const numCols = pipeIndices.length - 1;
  const newRow = "\n" + Array(numCols).fill("|   ").join("") + "|";
  const insertPos = line.to;
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: newRow },
  });
  const newCellStart = insertPos + 1 + 2; // skip newline + '| '
  view.dispatch({
    selection: EditorSelection.cursor(newCellStart),
    scrollIntoView: true,
  });
  return true;
}

export function handleTableTabPrev(view: EditorView): boolean {
  const { state } = view;
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  if (!isTableLine(line.text)) return false;

  const text = line.text;
  const pipeIndices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && (i === 0 || text[i - 1] !== "\\")) {
      pipeIndices.push(i);
    }
  }
  if (pipeIndices.length < 2) return false;

  const colOffset = cursor - line.from;
  let currentPipeIndex = -1;
  for (let i = 0; i < pipeIndices.length - 1; i++) {
    if (colOffset >= pipeIndices[i]! && colOffset < pipeIndices[i + 1]!) {
      currentPipeIndex = i;
      break;
    }
  }

  if (currentPipeIndex > 0) {
    const prevPipe = currentPipeIndex - 1;
    const from = line.from + pipeIndices[prevPipe]! + 1;
    const to = line.from + pipeIndices[prevPipe + 1]!;
    selectCell(view, from, to);
    return true;
  }

  // At first cell of row -> jump to last cell of previous row if it is a table line
  if (line.number > 1) {
    const prevLine = state.doc.line(line.number - 1);
    if (isTableLine(prevLine.text)) {
      const prevPipes: number[] = [];
      for (let i = 0; i < prevLine.text.length; i++) {
        if (prevLine.text[i] === "|" && (i === 0 || prevLine.text[i - 1] !== "\\")) {
          prevPipes.push(i);
        }
      }
      if (prevPipes.length >= 2) {
        const lastIdx = prevPipes.length - 2;
        const from = prevLine.from + prevPipes[lastIdx]! + 1;
        const to = prevLine.from + prevPipes[lastIdx + 1]!;
        selectCell(view, from, to);
        return true;
      }
    }
  }

  return false;
}

/** Source-mode formatting + find panel keybindings. */
export function markdownEditingKeymap(): Extension {
  return keymap.of([
    { key: "Mod-b", run: (v) => wrapSelection(v, "**") },
    { key: "Mod-i", run: (v) => wrapSelection(v, "*") },
    { key: "Mod-Shift-k", run: (v) => insertMarkdownLink(v) },
    { key: "Mod-Shift-t", run: (v) => insertMarkdownTable(v) },
    { key: "Mod-Shift-m", run: (v) => insertDisplayMath(v) },
    { key: "Mod-Shift-d", run: (v) => insertMermaidFence(v) },
    { key: "Mod-Shift-c", run: (v) => insertCodeFence(v) },
    { key: "Mod-Shift-1", run: (v) => insertHeading(v, 1) },
    { key: "Mod-Shift-2", run: (v) => insertHeading(v, 2) },
    { key: "Mod-Shift-3", run: (v) => insertHeading(v, 3) },
    { key: "Mod-Shift-8", run: (v) => insertBulletList(v) },
    { key: "Mod-Shift-.", run: (v) => insertQuote(v) },
    { key: "Tab", run: handleTableTabNext },
    { key: "Shift-Tab", run: handleTableTabPrev },
    { key: "Mod-f", run: openSearchPanel },
    { key: "Mod-h", run: openSearchPanel },
  ]);
}
