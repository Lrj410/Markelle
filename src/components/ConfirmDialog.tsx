import { useEffect, useId, useRef, useState } from "react";
import {
  getConfirmPending,
  resolveConfirm,
  subscribeConfirm,
  type ConfirmKind,
} from "../lib/appConfirm";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

function kindLabel(kind: ConfirmKind): string {
  if (kind === "error") return t("confirm.kindError");
  if (kind === "info") return t("confirm.kindInfo");
  return t("confirm.kindWarn");
}

export function ConfirmDialog() {
  useLocale();
  const [, bump] = useState(0);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeConfirm(() => bump((n) => n + 1)), []);

  const pending = getConfirmPending();

  useModalFocusTrap({
    active: Boolean(pending),
    containerRef: panelRef,
    onEscape: () => resolveConfirm(false),
    initialFocusSelector: ".btn.primary, .btn.danger",
  });

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const target = e.target as HTMLElement | null;
        // Let the focused button handle Enter; only default-confirm otherwise.
        if (target?.closest?.("button")) return;
        e.preventDefault();
        resolveConfirm(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  if (!pending) return null;

  const kind = pending.kind ?? "warning";

  return (
    <div
      className="modal-overlay confirm-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-msg`}
    >
      <button
        type="button"
        className="modal-backdrop"
        onClick={() => resolveConfirm(false)}
        aria-label={t("common.cancel")}
      />
      <div className={`modal-panel confirm-panel confirm-${kind}`} ref={panelRef}>
        <div className="confirm-icon" aria-hidden>
          {kind === "error" ? "!" : kind === "info" ? "i" : "!"}
        </div>
        <div className="confirm-body">
          <div className="modal-kicker">{kindLabel(kind)}</div>
          <h2 id={titleId}>{pending.title ?? "Markelle"}</h2>
          <p id={`${titleId}-msg`} className="confirm-message">
            {pending.message}
          </p>
        </div>
        <div className="confirm-actions">
          {!pending.hideCancel && (
            <button type="button" className="btn ghost" onClick={() => resolveConfirm(false)}>
              {pending.cancelLabel ?? t("common.cancel")}
            </button>
          )}
          <button
            type="button"
            className={kind === "error" ? "btn danger" : "btn primary"}
            onClick={() => resolveConfirm(true)}
            autoFocus
          >
            {pending.okLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
