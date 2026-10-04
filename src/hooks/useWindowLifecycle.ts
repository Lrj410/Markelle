import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { askConfirm } from "../lib/appConfirm";
import { isDirty, type DocTab } from "../lib/tabs";
import type { ReaderSettings } from "../lib/types";
import { formatAppError } from "../lib/errors";
import { t } from "../lib/i18n";

type QuitProbePayload = { requestId: string };
type QuitReplyPayload = {
  requestId: string;
  label: string;
  names: string[];
};

/**
 * Window close → tray / quit with dirty-buffer confirmation.
 * Tray quit is coordinated by the `main` window so sibling `doc-*` dirty
 * buffers are included before `app.exit(0)`.
 */
export function useWindowLifecycle(options: {
  tabsRef: React.MutableRefObject<DocTab[]>;
  settingsRef: React.MutableRefObject<ReaderSettings>;
  flushSettings: () => Promise<void>;
  setStatus: (msg: string) => void;
  onOpenSettings: () => void;
}) {
  const { tabsRef, settingsRef, flushSettings, setStatus, onOpenSettings } = options;

  const collectDirtyNames = useCallback(async (): Promise<string[]> => {
    const names = new Set(tabsRef.current.filter(isDirty).map((tab) => tab.name));
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await new Promise<void>((resolve) => {
      let settled = false;
      let unlisten: (() => void) | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        unlisten?.();
        resolve();
      };
      const timer = window.setTimeout(finish, 220);
      void listen<QuitReplyPayload>("markelle-quit-reply", (event) => {
        if (event.payload?.requestId !== requestId) return;
        for (const name of event.payload.names ?? []) {
          if (name) names.add(name);
        }
      }).then(async (fn) => {
        unlisten = () => {
          window.clearTimeout(timer);
          fn();
        };
        try {
          await emit("markelle-quit-probe", { requestId } satisfies QuitProbePayload);
        } catch {
          finish();
        }
      });
    });

    return [...names];
  }, [tabsRef]);

  const confirmQuitIfDirty = useCallback(
    async (action: "quit" | "tray" = "quit"): Promise<boolean> => {
      if (!settingsRef.current.confirmQuitDirty) return true;
      const dirtyNames =
        action === "quit" ? await collectDirtyNames() : tabsRef.current.filter(isDirty).map((t) => t.name);
      if (dirtyNames.length === 0) return true;
      const names = dirtyNames.slice(0, 3).join("、");
      const more =
        dirtyNames.length > 3
          ? t("lifecycle.moreCount", { count: dirtyNames.length - 3 })
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
    [tabsRef, settingsRef, collectDirtyNames],
  );

  const quitApplication = useCallback(async () => {
    await flushSettings();
    const ok = await confirmQuitIfDirty("quit");
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

  // Reply to cross-window quit probes with this window's dirty tab names.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<QuitProbePayload>("markelle-quit-probe", (event) => {
      const requestId = event.payload?.requestId;
      if (!requestId) return;
      const names = tabsRef.current.filter(isDirty).map((tab) => tab.name);
      void emit("markelle-quit-reply", {
        requestId,
        label: getCurrentWindow().label,
        names,
      } satisfies QuitReplyPayload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tabsRef]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const fn = await getCurrentWindow().onCloseRequested(async (event) => {
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
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        /* web preview */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [flushSettings, confirmQuitIfDirty, settingsRef, tabsRef, setStatus]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<{ action?: string }>("markelle-tray", (event) => {
      const action = event.payload?.action;
      if (action === "settings") {
        // Settings belong on the main chrome window.
        if (getCurrentWindow().label === "main") onOpenSettings();
        return;
      }
      if (action === "quit") {
        // Only main coordinates app-wide quit (avoids N confirm dialogs).
        if (getCurrentWindow().label !== "main") return;
        void quitRef.current();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onOpenSettings]);

  return { confirmQuitIfDirty, quitApplication };
}
