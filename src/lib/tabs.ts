import type { DocMode } from "./types";

export interface DocTab {
  id: string;
  path: string;
  name: string;
  content: string;
  savedContent: string;
  baseDir: string;
  size: number;
  /** True while background hydrate has not finished. */
  truncated: boolean;
  mode: DocMode;
  /** Detected encoding when opened; saves always write UTF-8. */
  encoding?: string;
  /** Disk mtime (ms) when last synced from/to disk. */
  diskMtimeMs?: number;
  /** Byte offset already read from disk (hydrate resume). */
  bytesRead?: number;
  /** 后端认定超 50MB 的大文件（`OpenedFile.large`）。 */
  large?: boolean;
  /** 0–1 hydrate progress for toolbar. */
  hydrateRatio?: number;
  /** Full text lives in Rust LargeFileStore — never bind GB strings to React. */
  backendBuffer?: boolean;
  /** Dirty flag for windowed large-file edits (content may be preview-only). */
  largeDirty?: boolean;
  lineCount?: number;
  /** Active session passphrase when this tab contains a decrypted note. */
  cryptoPassphrase?: string;
}

export function isDirty(tab: DocTab): boolean {
  // 只有全文放在 Rust LargeFileStore 时 content 才可能是预览片段，此时无法比较
  // content/savedContent，只能认显式的 largeDirty。large 但已完整载入的文件照常比较。
  if (tab.backendBuffer) {
    return Boolean(tab.largeDirty);
  }
  return tab.content !== tab.savedContent;
}

export function createTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `tab-${crypto.randomUUID()}`;
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isLargeTab(tab: DocTab): boolean {
  // 只依据后端语义判定，不再用与后端不一致的 size 启发式。
  return Boolean(tab.large || tab.backendBuffer || tab.truncated);
}
