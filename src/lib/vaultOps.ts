import { invoke } from "@tauri-apps/api/core";

/** Create a directory under the vault root (`relative` may not contain `..`). */
export async function vaultCreateDir(root: string, relative: string): Promise<void> {
  await invoke("vault_create_dir", { root, relative });
}

/** Rename or move a file/directory within the vault. */
export async function vaultRename(
  root: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  await invoke("vault_rename", { root, fromPath, toPath });
}

/** Move a file or folder to the system trash / recycle bin (not the vault root). */
export async function vaultDelete(root: string, path: string): Promise<void> {
  await invoke("vault_delete", { root, path });
}

function asUint8(data: number[] | Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

/**
 * Write raw bytes into the vault at a relative path.
 * Uses Tauri raw IPC (Uint8Array body) — no JSON number[] / Array.from.
 */
export async function vaultWriteBytes(
  root: string,
  relative: string,
  data: number[] | Uint8Array | ArrayBuffer,
): Promise<string> {
  const bytes = asUint8(data);
  return invoke<string>("vault_write_bytes_raw", bytes, {
    headers: {
      "X-Mkl-Root": encodeURIComponent(root),
      "X-Mkl-Relative": encodeURIComponent(relative),
    },
  });
}

/**
 * Write a bare filename into an ACL-allowed directory (open-file same folder).
 * Raw IPC — no Array.from.
 */
export async function writeAdjacentBytes(
  dir: string,
  fileName: string,
  data: number[] | Uint8Array | ArrayBuffer,
): Promise<string> {
  const bytes = asUint8(data);
  return invoke<string>("write_adjacent_bytes_raw", bytes, {
    headers: {
      "X-Mkl-Dir": encodeURIComponent(dir),
      "X-Mkl-Name": encodeURIComponent(fileName),
    },
  });
}

/** Read an ACL-allowed file as binary (raw response). */
export async function readAllowedBytes(path: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("read_allowed_bytes", { path });
  return buf instanceof ArrayBuffer ? new Uint8Array(buf) : asUint8(buf as unknown as Uint8Array);
}

/** Copy an authorized source file into the vault. Returns absolute dest path. */
export async function vaultImportFile(
  root: string,
  relative: string,
  sourcePath: string,
): Promise<string> {
  return invoke<string>("vault_import_file", {
    root,
    relative,
    sourcePath,
  });
}

/** Copy an authorized source file beside an open note (no vault). */
export async function importAdjacentFile(
  dir: string,
  sourcePath: string,
  fileName: string,
): Promise<string> {
  return invoke<string>("import_adjacent_file", {
    dir,
    sourcePath,
    fileName,
  });
}
