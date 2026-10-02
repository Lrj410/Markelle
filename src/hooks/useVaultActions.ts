import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openVault, type VaultInfo } from "../lib/vault";
import { revokeVaultAccess } from "../lib/files";
import { formatAppError } from "../lib/errors";
import { findPanelSide, togglePanel } from "../lib/dock";
import { normalizePath } from "../lib/openTab";
import { t } from "../lib/i18n";
import type { ReaderSettings } from "../lib/types";

type SetSettings = Dispatch<SetStateAction<ReaderSettings>>;

/**
 * Vault open / close / pick — extracted from App for clearer ownership.
 */
export function useVaultActions(options: {
  beginBusy: () => void;
  endBusy: () => void;
  setStatus: (msg: string) => void;
  setVault: (v: VaultInfo | null) => void;
  setSettings: SetSettings;
  setGraphOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  vaultRootRef: MutableRefObject<string | null | undefined>;
}) {
  const {
    beginBusy,
    endBusy,
    setStatus,
    setVault,
    setSettings,
    setGraphOpen,
    vaultRootRef,
  } = options;

  // Bumped on every load/close so stale scans cannot overwrite newer state.
  const generationRef = useRef(0);

  const loadVault = useCallback(
    async (root: string, opts?: { trust?: boolean }) => {
      const generation = ++generationRef.current;
      beginBusy();
      try {
        setStatus(t("status.vaultScanning"));
        const info = await openVault(root);
        if (generation !== generationRef.current) return;
        setVault(info);
        const trustedKey = normalizePath(info.root);
        setSettings((s) => {
          const trusted = s.trustedVaultPaths.some((p) => normalizePath(p) === trustedKey)
            ? s.trustedVaultPaths
            : opts?.trust
              ? [...s.trustedVaultPaths, info.root].slice(-20)
              : s.trustedVaultPaths;
          const recentVaultPaths = [
            info.root,
            ...s.recentVaultPaths.filter((p) => normalizePath(p) !== trustedKey),
          ].slice(0, 8);
          return {
            ...s,
            lastVaultPath: info.root,
            trustedVaultPaths: trusted,
            recentVaultPaths,
            dock: (() => {
              const side = findPanelSide(s.dock, "vault");
              if (side) return s.dock;
              return togglePanel(s.dock, "vault");
            })(),
          };
        });
        setStatus(
          info.truncated
            ? `${t("status.vaultOpened")} · ${info.fileCount} ${t("status.files")}（${t("status.vaultTruncated")}）`
            : `${t("status.vaultOpened")} · ${info.fileCount} ${t("status.files")}`,
        );
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus(formatAppError(err, t("vault.openFailed")));
      } finally {
        if (generation === generationRef.current) endBusy();
      }
    },
    [beginBusy, endBusy, setStatus, setVault, setSettings],
  );

  const pickVault = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    if (typeof selected === "string") {
      await loadVault(selected, { trust: true });
    }
  }, [loadVault]);

  const closeVault = useCallback(() => {
    generationRef.current += 1; // cancel any in-flight scan
    const root = vaultRootRef.current ?? null;
    setVault(null);
    setGraphOpen(false);
    setSettings((s) => ({ ...s, lastVaultPath: null }));
    setStatus(t("status.vaultClosed"));
    if (root) {
      void revokeVaultAccess(root).catch(() => undefined);
    }
  }, [vaultRootRef, setVault, setGraphOpen, setSettings, setStatus]);

  return { loadVault, pickVault, closeVault };
}
