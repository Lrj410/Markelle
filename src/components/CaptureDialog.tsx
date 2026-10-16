import { useEffect, useId, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

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
  const textRef = useRef(text);
  const savingRef = useRef(saving);
  textRef.current = text;
  savingRef.current = saving;

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
    <Modal
      open={open}
      onClose={onClose}
      titleId={titleId}
      panelClassName="capture-panel"
      initialFocusSelector=".capture-input"
    >
      <div className="modal-head">
        <h2 id={titleId}>{t("capture.title")}</h2>
        <button type="button" className="settings-close" onClick={onClose} aria-label={t("common.close")}>
          ×
        </button>
      </div>
      <textarea
        className="capture-input"
        rows={6}
        value={text}
        placeholder={t("capture.placeholder")}
        onChange={(e) => setText(e.target.value)}
      />
      {error ? (
        <p className="settings-hint form-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="settings-hint">{t("capture.hint")}</p>
      )}
      <div className="about-actions">
        <Button variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
        <Button
          variant="primary"
          disabled={!text.trim() || saving}
          onClick={() => void submit()}
        >
          {t("capture.save")}
        </Button>
      </div>
    </Modal>
  );
}
