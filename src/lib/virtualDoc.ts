import { ViewPlugin, type ViewUpdate, type EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { largeFileLines } from "./largeFile";

export const VIRTUAL_CHUNK_SIZE = 500;

/**
 * Pads the initial viewport string with empty newlines up to totalLines.
 * This establishes the full scroll height and line gutter in CodeMirror with near-zero memory.
 */
export function buildVirtualInitialText(initialText: string, totalLines: number): string {
  if (totalLines <= 1) return initialText;
  if (!initialText) return "\n".repeat(totalLines - 1);
  const count = (initialText.match(/\n/g) || []).length + 1;
  if (totalLines <= count) return initialText;
  return initialText + "\n" + "\n".repeat(totalLines - count - 1);
}

/**
 * CodeMirror extension that silently streams lines into the editor as the user scrolls.
 * Operates like Google Maps tile loading: lines in the viewport are fetched from native memmap
 * and seamlessly replace empty placeholders without jumping the scrollbar or altering line counts.
 */
export function createVirtualDocExtension(
  path: string,
  totalLines: number,
  onLinesLoaded?: (start: number, count: number) => void,
): Extension {
  const loadedChunks = new Set<number>();
  // Mark initial lines as loaded so we don't refetch chunk 0/1
  const initialChunks = Math.min(4, Math.ceil(totalLines / VIRTUAL_CHUNK_SIZE));
  for (let i = 0; i < initialChunks; i++) {
    loadedChunks.add(i);
  }

  const inFlight = new Set<number>();

  return ViewPlugin.fromClass(
    class {
      private destroyed = false;

      constructor(readonly view: EditorView) {
        this.checkViewport(view);
      }

      update(update: ViewUpdate) {
        if (update.viewportChanged || update.geometryChanged) {
          this.checkViewport(update.view);
        }
      }

      destroy() {
        this.destroyed = true;
      }

      private checkViewport(view: EditorView) {
        if (this.destroyed) return;
        try {
          const doc = view.state.doc;
          if (doc.lines < 2) return;

          const fromLine = doc.lineAt(view.viewport.from).number;
          const toLine = doc.lineAt(view.viewport.to).number;

          const fromChunk = Math.floor((fromLine - 1) / VIRTUAL_CHUNK_SIZE);
          const toChunk = Math.floor((toLine - 1) / VIRTUAL_CHUNK_SIZE);

          // Prefetch 1 chunk above and 2 chunks below
          const startChunk = Math.max(0, fromChunk - 1);
          const maxChunk = Math.floor((doc.lines - 1) / VIRTUAL_CHUNK_SIZE);
          const endChunk = Math.min(maxChunk, toChunk + 2);

          for (let c = startChunk; c <= endChunk; c++) {
            if (!loadedChunks.has(c) && !inFlight.has(c)) {
              this.fetchChunk(view, c);
            }
          }
        } catch {
          /* viewport can temporarily be out of sync during transitions */
        }
      }

      private fetchChunk(view: EditorView, chunkIdx: number) {
        inFlight.add(chunkIdx);
        const startLine = chunkIdx * VIRTUAL_CHUNK_SIZE + 1;
        const count = Math.min(VIRTUAL_CHUNK_SIZE, totalLines - startLine + 1);
        if (count <= 0) {
          inFlight.delete(chunkIdx);
          return;
        }

        largeFileLines(path, startLine, count)
          .then((res) => {
            inFlight.delete(chunkIdx);
            loadedChunks.add(chunkIdx);
            if (this.destroyed || !res.lines || res.lines.length === 0) return;

            const doc = view.state.doc;
            if (startLine > doc.lines) return;

            const actualCount = Math.min(res.lines.length, doc.lines - startLine + 1);
            const startObj = doc.line(startLine);
            const endObj = doc.line(startLine + actualCount - 1);

            const newText = res.lines.slice(0, actualCount).join("\n");
            // If text is already identical to current slice, skip dispatch
            if (startObj.from === endObj.to && newText === "") return;
            if (view.state.sliceDoc(startObj.from, endObj.to) === newText) return;

            view.dispatch({
              changes: {
                from: startObj.from,
                to: endObj.to,
                insert: newText,
              },
            });
            onLinesLoaded?.(startLine, actualCount);
          })
          .catch(() => {
            inFlight.delete(chunkIdx);
          });
      }
    },
  );
}
