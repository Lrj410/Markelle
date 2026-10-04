import { useEffect, useId, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (text: string) => Promise<void>;
}

export function CaptureDialog({ open, onClose, onSave }: Props) {
  useLocale();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);
  const savingRef = useRef(saving);
  textRef.current = text;
  savingRef.current = saving;

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    onEscape: onClose,
    initialFocusSelector: ".capture-input",
  });

  useEffect(() => {
    if (!open) return;
    setText("");
    setSaving(false);
    setError("");
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        const body = textRef.current.trim();
        if (!body || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setError("");
        void (async () => {
          try {
            await onSave(body);
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : t("app.captureFailed"));
          } finally {
            savingRef.current = false;
            setSaving(false);
          }
        })();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onSave]);

  if (!open) return null;

  const submit = async () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.captureFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" className="modal-backdrop" onClick={onClose} aria-label={t("common.close")} />
      <div className="modal-panel capture-panel" ref={panelRef}>
        <div className="modal-head">
          <h2 id={titleId}>{t("capture.title")}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <textarea
          className="capture-input"
          autoFocus
          rows={6}
          value={text}
          placeholder={t("capture.placeholder")}
          onChange={(e) => setText(e.target.value)}
        />
        {error ? (
          <p className="settings-hint" role="alert" style={{ color: "var(--danger, #b4452b)" }}>
            {error}
          </p>
        ) : (
          <p className="settings-hint">{t("capture.hint")}</p>
        )}
        <div className="about-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("common.close")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!text.trim() || saving}
            onClick={() => void submit()}
          >
            {t("capture.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
