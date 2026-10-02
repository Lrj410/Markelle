import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import {
  historyList,
  historyRead,
  type HistoryEntry,
} from "../lib/history";
import { computeLineDiff, type DiffLine } from "../lib/diff";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

interface Props {
  vaultRoot: string | null;
  notePath: string | null;
  currentContent?: string;
  onRestore: (content: string) => Promise<void>;
  onStatus?: (msg: string) => void;
}

interface DiffModalState {
  id: string;
  savedAt: number;
  snapContent: string;
  diff: DiffLine[];
}

export function HistoryPanel({
  vaultRoot,
  notePath,
  currentContent = "",
  onRestore,
  onStatus,
}: Props) {
  useLocale();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [diffModal, setDiffModal] = useState<DiffModalState | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useModalFocusTrap({
    active: Boolean(diffModal),
    containerRef: modalRef,
    onEscape: () => setDiffModal(null),
  });

  const refresh = useCallback(async () => {
    if (!vaultRoot || !notePath) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      setEntries(await historyList(vaultRoot, notePath));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [vaultRoot, notePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!vaultRoot || !notePath) {
    return (
      <aside className="backlinks-panel dock-fill" aria-label={t("panel.history")}>
        <p className="backlinks-empty">{t("history.needNote")}</p>
      </aside>
    );
  }

  return (
    <aside className="backlinks-panel dock-fill" aria-label={t("panel.history")}>
      <div className="backlinks-head" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>{t("panel.history")}</span>
        <button type="button" className="btn ghost" onClick={() => void refresh()} disabled={loading}>
          {t("history.refresh")}
        </button>
      </div>
      {loading && <p className="backlinks-empty quiet">…</p>}
      {!loading && entries.length === 0 && (
        <p className="backlinks-empty">{t("history.empty")}</p>
      )}
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="backlink-item"
          onClick={() => {
            void (async () => {
              try {
                const snap = await historyRead(vaultRoot, notePath, entry.id);
                const diff = computeLineDiff(currentContent, snap);
                setDiffModal({
                  id: entry.id,
                  savedAt: entry.savedAt,
                  snapContent: snap,
                  diff,
                });
              } catch (e) {
                onStatus?.(String(e));
              }
            })();
          }}
        >
          <span className="backlink-name">
            {new Date(entry.savedAt).toLocaleString()}
          </span>
          <span className="backlink-preview">
            {Math.round(entry.bytes / 1024)} KB · {entry.id}
          </span>
        </button>
      ))}

      {diffModal && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          style={{ zIndex: 1200 }}
        >
          <button
            type="button"
            className="modal-backdrop"
            onClick={() => setDiffModal(null)}
            aria-label={t("common.cancel")}
          />
          <div
            className="modal-panel"
            ref={modalRef}
            style={{
              width: "90%",
              maxWidth: "820px",
              height: "80vh",
              display: "flex",
              flexDirection: "column",
              padding: "1.25rem",
              gap: "1rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: "1.1rem" }}>
                  {t("history.previewDiff")}
                </h2>
                <div style={{ fontSize: "0.85rem", opacity: 0.7, marginTop: 4 }}>
                  {new Date(diffModal.savedAt).toLocaleString()} · {diffModal.id}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                }}
              >
                <span style={{ color: "var(--success)" }}>
                  {t("history.diffAdded")}:{" "}
                  {diffModal.diff.filter((d) => d.type === "add").length}
                </span>
                <span style={{ color: "var(--danger)" }}>
                  {t("history.diffRemoved")}:{" "}
                  {diffModal.diff.filter((d) => d.type === "del").length}
                </span>
              </div>
            </div>

            <div
              style={{
                flex: 1,
                overflowY: "auto",
                fontFamily: 'Consolas, "JetBrains Mono", monospace',
                fontSize: "0.85rem",
                lineHeight: "1.5",
                border: "1px solid var(--border-subtle)",
                borderRadius: 6,
                background: "var(--bg-subtle)",
                padding: "0.5rem 0",
              }}
            >
              {diffModal.diff.map((line, idx) => {
                const bg =
                  line.type === "add"
                    ? "var(--success-subtle)"
                    : line.type === "del"
                    ? "var(--danger-subtle)"
                    : "transparent";
                const prefix =
                  line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
                const color =
                  line.type === "add"
                    ? "var(--success)"
                    : line.type === "del"
                    ? "var(--danger)"
                    : "inherit";
                return (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      background: bg,
                      padding: "1px 0.75rem",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    <span
                      style={{
                        width: "2.5rem",
                        userSelect: "none",
                        opacity: 0.4,
                        flexShrink: 0,
                        fontSize: "0.8rem",
                      }}
                    >
                      {line.type === "del" ? line.oldNum : line.newNum || ""}
                    </span>
                    <span
                      style={{
                        width: "1.5rem",
                        color,
                        userSelect: "none",
                        flexShrink: 0,
                      }}
                    >
                      {prefix}
                    </span>
                    <span style={{ flex: 1 }}>{line.text || " "}</span>
                  </div>
                );
              })}
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.75rem",
              }}
            >
              <button
                type="button"
                className="btn ghost"
                onClick={() => setDiffModal(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  void (async () => {
                    const content = diffModal.snapContent;
                    setDiffModal(null);
                    await onRestore(content);
                    onStatus?.(t("history.restored"));
                  })();
                }}
              >
                {t("history.restoreConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
