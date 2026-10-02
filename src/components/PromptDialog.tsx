import { useEffect, useId, useRef, useState } from "react";
import { getPromptPending, resolvePrompt, subscribePrompt } from "../lib/appPrompt";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

export function PromptDialog() {
  useLocale();
  const [, bump] = useState(0);
  const titleId = useId();
  const messageId = `${titleId}-msg`;
  const panelRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  useEffect(() => subscribePrompt(() => bump((n) => n + 1)), []);

  const pending = getPromptPending();

  useEffect(() => {
    if (!pending) return;
    setValue(pending.initialValue ?? "");
    setReveal(false);
  }, [pending]);

  useModalFocusTrap({
    active: Boolean(pending),
    containerRef: panelRef,
    onEscape: () => resolvePrompt(null),
    initialFocusSelector: "input",
  });

  if (!pending) return null;

  const masked = pending.masked === true;
  const canSubmit = value.trim().length > 0;
  const submit = () => {
    if (canSubmit) resolvePrompt(value);
  };

  return (
    <div
      className="modal-overlay confirm-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
    >
      <button
        type="button"
        className="modal-backdrop"
        onClick={() => resolvePrompt(null)}
        aria-label={t("common.cancel")}
      />
      <div className="modal-panel confirm-panel confirm-info" ref={panelRef}>
        <div className="confirm-icon" aria-hidden>
          ?
        </div>
        <div className="confirm-body">
          <div className="modal-kicker">{t("prompt.kicker")}</div>
          <h2 id={titleId}>{pending.title ?? "Markelle"}</h2>
          <p id={messageId} className="confirm-message">
            {pending.message}
          </p>
          <input
            type={masked && !reveal ? "password" : "text"}
            className="capture-input"
            style={{ minHeight: "auto" }}
            value={value}
            placeholder={pending.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-label={pending.message}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          {masked && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? t("prompt.hide") : t("prompt.reveal")}
            >
              {reveal ? t("prompt.hide") : t("prompt.reveal")}
            </button>
          )}
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={() => resolvePrompt(null)}>
            {pending.cancelLabel ?? t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            {pending.okLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
