import { invoke } from "@tauri-apps/api/core";

/** One snapshot entry under `.markelle/history/<noteKey>/`. */
export interface HistoryEntry {
  id: string;
  savedAt: number;
  bytes: number;
}

/** Save a UTF-8 snapshot; prunes oldest beyond `maxVersions` (default 20, clamp 1–100). */
export async function historySaveSnapshot(
  vaultRoot: string,
  notePath: string,
  content: string,
  maxVersions?: number,
): Promise<HistoryEntry> {
  return invoke<HistoryEntry>("history_save_snapshot", {
    vaultRoot,
    notePath,
    content,
    maxVersions: maxVersions ?? null,
  });
}

/** List snapshots for a note (newest first). */
export async function historyList(
  vaultRoot: string,
  notePath: string,
): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("history_list", { vaultRoot, notePath });
}

/** Read snapshot content by id (does not write the note). */
export async function historyRead(
  vaultRoot: string,
  notePath: string,
  id: string,
): Promise<string> {
  return invoke<string>("history_read", { vaultRoot, notePath, id });
}

/** Delete all local history snapshots for a note (call after encrypt). */
export async function historyClearNote(
  vaultRoot: string,
  notePath: string,
): Promise<number> {
  return invoke<number>("history_clear_note", { vaultRoot, notePath });
}
