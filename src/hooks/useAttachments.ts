import { useCallback, type MutableRefObject } from "react";
import {
  buildAttachmentRelativePath,
  imageAltFromFile,
  isImageFile,
  isImageFileName,
  markdownImageLink,
  uniqueAttachmentName,
} from "../lib/attachments";
import { registerAccess } from "../lib/files";
import { prepareImageForImport } from "../lib/imagePrepare";
import { basename, toPosixPath, trimTrailingSep } from "../lib/paths";
import {
  importAdjacentFile,
  readAllowedBytes,
  vaultImportFile,
  vaultWriteBytes,
  writeAdjacentBytes,
} from "../lib/vaultOps";
import type { DocTab } from "../lib/tabs";
import type { VaultInfo } from "../lib/vault";
import type { ReaderSettings } from "../lib/types";
import { t } from "../lib/i18n";

/** Prefer vault-relative path from an absolute write result. */
function relativeFromAbs(root: string, abs: string, fallback: string): string {
  const r = trimTrailingSep(toPosixPath(root));
  const a = toPosixPath(abs);
  const prefix = `${r}/`;
  if (a.startsWith(prefix)) return a.slice(prefix.length);
  if (a.toLowerCase().startsWith(prefix.toLowerCase())) {
    return a.slice(r.length + 1);
  }
  return fallback;
}

/**
 * Copy external images into the vault (or next to the open note).
 *
 * Vault mode writes vault-root-relative links (`attachments/yyyy/mm/…`) so nested
 * notes resolve without `../` (media ACL rejects unsafe `..` escapes).
 * Single-file mode writes beside the note.
 */
export function useAttachments(opts: {
  vaultRef: MutableRefObject<VaultInfo | null>;
  tabsRef: MutableRefObject<DocTab[]>;
  activeIdRef: MutableRefObject<string | null>;
  settingsRef: MutableRefObject<ReaderSettings>;
  patchTab: (id: string, patch: Partial<DocTab>) => void;
  setStatus: (msg: string) => void;
}) {
  const { vaultRef, tabsRef, activeIdRef, settingsRef, setStatus } = opts;

  /** Write image bytes; returns markdown `![…](…)` links for the active note. */
  const importImageFiles = useCallback(
    async (files: File[]): Promise<string[]> => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!tab) {
        setStatus(t("attachments.openNoteFirst"));
        return [];
      }
      const images = files.filter(isImageFile);
      if (!images.length) return [];

      const v = vaultRef.current;
      const links: string[] = [];
      for (const file of images) {
        const prepared = await prepareImageForImport(file);
        const name = uniqueAttachmentName(prepared.fileName || file.name || "paste.png");
        const alt = imageAltFromFile(file);
        if (v) {
          const relative = buildAttachmentRelativePath(
            settingsRef.current.attachmentFolder,
            name,
          );
          const abs = await vaultWriteBytes(v.root, relative, prepared.bytes);
          await registerAccess([abs]);
          const linkPath = relativeFromAbs(v.root, abs, relative);
          links.push(markdownImageLink(linkPath, alt));
        } else {
          const abs = await writeAdjacentBytes(tab.baseDir, name, prepared.bytes);
          await registerAccess([abs]);
          links.push(markdownImageLink(basename(abs), alt));
        }
      }
      return links;
    },
    [vaultRef, tabsRef, activeIdRef, settingsRef, setStatus],
  );

  /** Drag-drop / dialog: copy an on-disk file into vault (or beside the note). */
  const importPathAsAttachment = useCallback(
    async (sourcePath: string): Promise<string | null> => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      const v = vaultRef.current;
      await registerAccess([sourcePath]);

      // Images: read → HEIC convert / resize → write (raw IPC).
      if (isImageFileName(sourcePath)) {
        const raw = await readAllowedBytes(sourcePath);
        const blob = new Blob([raw]);
        const prepared = await prepareImageForImport(blob, basename(sourcePath));
        const name = uniqueAttachmentName(prepared.fileName);
        if (v) {
          const relative = buildAttachmentRelativePath(
            settingsRef.current.attachmentFolder,
            name,
          );
          const abs = await vaultWriteBytes(v.root, relative, prepared.bytes);
          await registerAccess([abs]);
          return relativeFromAbs(v.root, abs, toPosixPath(relative));
        }
        if (!tab) {
          setStatus(t("attachments.openNoteFirstAttachment"));
          return null;
        }
        setStatus(t("attachments.noVaultBeside"));
        const abs = await writeAdjacentBytes(tab.baseDir, name, prepared.bytes);
        await registerAccess([abs]);
        return basename(abs);
      }

      const name = uniqueAttachmentName(basename(sourcePath));
      if (v) {
        const relative = buildAttachmentRelativePath(
          settingsRef.current.attachmentFolder,
          name,
        );
        const abs = await vaultImportFile(v.root, relative, sourcePath);
        await registerAccess([abs]);
        return relativeFromAbs(v.root, abs, toPosixPath(relative));
      }

      if (!tab) {
        setStatus(t("attachments.openNoteFirstAttachment"));
        return null;
      }
      setStatus(t("attachments.noVaultBeside"));
      const abs = await importAdjacentFile(tab.baseDir, sourcePath, name);
      await registerAccess([abs]);
      return basename(abs);
    },
    [vaultRef, tabsRef, activeIdRef, settingsRef, setStatus],
  );

  /**
   * Paste handler for the source editor — writes files and returns markdown
   * snippets for cursor insertion (does not append to end of doc).
   */
  const importClipboardFiles = useCallback(
    async (files: File[]): Promise<string[] | false> => {
      try {
        const links = await importImageFiles(files);
        if (!links.length) return false;
        setStatus(t("attachments.importedNImages", { n: links.length }));
        return links;
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [importImageFiles, setStatus],
  );

  return { importPathAsAttachment, importClipboardFiles, importImageFiles };
}
