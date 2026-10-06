import { invoke } from "@tauri-apps/api/core";

/** Soft confirm before open. */
export const LARGE_FILE_WARN_BYTES = 512 * 1024 * 1024;
/** Max simultaneous large-file tabs. */
export const MAX_LARGE_FILE_TABS = 2;
/** Preview page size for large-file read mode (characters). */
export const PREVIEW_PAGE_CHARS = 200_000;

export interface OpenedFile {
  path: string;
  name: string;
  content: string;
  size: number;
  truncated: boolean;
  encoding: string;
  mtimeMs: number;
  bytesRead: number;
  large: boolean;
}

export interface FileStat {
  path: string;
  name: string;
  size: number;
  isLarge: boolean;
  mtimeMs: number;
}

/** Intentional authorization only — dialog / drop / CLI / save-as / recent. */
export async function registerAccess(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await invoke("register_access", { paths });
}

export async function revokeVaultAccess(root: string): Promise<void> {
  await invoke("revoke_vault_access", { root });
}

export async function readMarkdownFile(
  path: string,
  forceFull = false,
): Promise<OpenedFile> {
  return invoke<OpenedFile>("read_markdown_file", { path, forceFull });
}

export async function writeMarkdownFile(
  path: string,
  content: string,
): Promise<FileStat> {
  return invoke<FileStat>("write_markdown_file", { path, content });
}

/** Append-only write; never reads or rewrites existing content. Returns the new size. */
export async function appendMarkdownFile(
  path: string,
  content: string,
): Promise<number> {
  return invoke<number>("append_markdown_file", { path, content });
}

export async function statMarkdownFile(path: string): Promise<FileStat> {
  return invoke<FileStat>("stat_markdown_file", { path });
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

