import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { formatBytes } from "./files";

export interface LargeFileProgress {
  path: string;
  bytesRead: number;
  size: number;
  done: boolean;
  /** Rust store seeded — windowed reads are safe. */
  ready?: boolean;
  lineCount: number;
  error?: string | null;
}

export interface LargeFileLines {
  startLine: number;
  totalLines: number;
  lines: string[];
  partial?: boolean;
}

export async function hydrateLargeFile(path: string): Promise<void> {
  await invoke("hydrate_large_file", { path });
}

export async function largeFileLines(
  path: string,
  startLine: number,
  count: number,
): Promise<LargeFileLines> {
  return invoke<LargeFileLines>("large_file_lines", { path, startLine, count });
}

export async function largeFileClose(path: string): Promise<void> {
  await invoke("large_file_close", { path });
}

export function listenLargeFileProgress(
  handler: (p: LargeFileProgress) => void,
): Promise<UnlistenFn> {
  return listen<LargeFileProgress>("large-file-progress", (ev) => {
    handler(ev.payload);
  });
}

export function formatHydrateStatus(p: LargeFileProgress): string {
  if (p.error) return p.error;
  if (p.done) return `已完整加载 · ${formatBytes(p.size)} · ${p.lineCount} 行`;
  const pct = p.size > 0 ? Math.floor((p.bytesRead / p.size) * 100) : 0;
  const ready = p.ready ? "可浏览 · " : "";
  return `${ready}索引 ${pct}% · ${formatBytes(p.bytesRead)} / ${formatBytes(p.size)} · ${p.lineCount} 行`;
}
