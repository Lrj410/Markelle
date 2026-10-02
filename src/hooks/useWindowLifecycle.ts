import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { askConfirm } from "../lib/appConfirm";
import { isDirty, type DocTab } from "../lib/tabs";
import type { ReaderSettings } from "../lib/types";
import { formatAppError } from "../lib/errors";
import { t } from "../lib/i18n";

/**
 * Window close → tray / quit with dirty-buffer confirmation.
 * Extracted from App to keep lifecycle concerns testable in isolation later.
 */
export function useWindowLifecycle(options: {
  tabsRef: React.MutableRefObject<DocTab[]>;
  settingsRef: React.MutableRefObject<ReaderSettings>;
  flushSettings: () => Promise<void>;
  setStatus: (msg: string) => void;
  onOpenSettings: () => void;
}) {
  const { tabsRef, settingsRef, flushSettings, setStatus, onOpenSettings } = options;
  const confirmQuitIfDirty = useCallback(
    async (action: "quit" | "tray" = "quit"): Promise<boolean> => {
      const dirtyTabs = tabsRef.current.filter(isDirty);
      if (dirtyTabs.length === 0 || !settingsRef.current.confirmQuitDirty) return true;
      const names = dirtyTabs
        .slice(0, 3)
        .map((tab) => tab.name)
        .join("、");
      const more =
        dirtyTabs.length > 3
          ? t("lifecycle.moreCount", { count: dirtyTabs.length - 3 })
          : "";
      const msg =
        action === "tray"
          ? t("lifecycle.confirmDirtyTray", { names, more })
          : t("lifecycle.confirmDirtyQuit", { names, more });
      return askConfirm(msg, {
        title: "Markelle",
        kind: "warning",
      });
    },
    [tabsRef, settingsRef],
  );

  const quitApplication = useCallback(async () => {
    await flushSettings();
    const ok = await confirmQuitIfDirty();
    if (!ok) return;
    await flushSettings();
    try {
      await invoke("quit_app");
    } catch {
      await getCurrentWindow().destroy();
    }
  }, [flushSettings, confirmQuitIfDirty]);

  const quitRef = useRef(quitApplication);
  quitRef.current = quitApplication;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await flushSettings();
            const s = settingsRef.current;
            if (s.trayEnabled && s.closeToTray) {
              const ok = await confirmQuitIfDirty("tray");
              if (!ok) return;
              await getCurrentWindow().hide();
              const dirtyLeft = tabsRef.current.some(isDirty);
              setStatus(dirtyLeft ? t("status.trayDirty") : t("status.tray"));
              return;
            }
            await quitRef.current();
          } catch (err) {
            setStatus(formatAppError(err, t("app.closeWindowFailed")));
          }
        });
      } catch {
        /* web preview */
      }
    })();
    return () => unlisten?.();
  }, [flushSettings, confirmQuitIfDirty, settingsRef, tabsRef, setStatus]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ action?: string }>("markelle-tray", (event) => {
      const action = event.payload?.action;
      if (action === "settings") {
        onOpenSettings();
        return;
      }
      if (action === "quit") {
        void quitRef.current();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [onOpenSettings]);

  return { confirmQuitIfDirty, quitApplication };
}
