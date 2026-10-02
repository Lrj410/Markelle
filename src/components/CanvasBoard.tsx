import { useEffect, useRef, useState } from "react";
import { emptyCanvas, newCard, parseCanvas, type CanvasDoc } from "../lib/canvasModel";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

interface Props {
  open: boolean;
  initialJson?: string;
  onClose: () => void;
  onSave: (json: string) => Promise<void>;
}

export function CanvasBoard({ open, initialJson, onClose, onSave }: Props) {
  useLocale();
  const panelRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<CanvasDoc>(() =>
    initialJson ? parseCanvas(initialJson) : emptyCanvas(),
  );
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Reset the board whenever it is (re)opened or the stored JSON changes, so a
  // close/reopen never keeps stale edits and a saved doc is actually reloaded.
  useEffect(() => {
    if (!open) return;
    setDoc(initialJson ? parseCanvas(initialJson) : emptyCanvas());
    setDragId(null);
    setSaving(false);
  }, [open, initialJson]);

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    onEscape: onClose,
    initialFocusSelector: ".btn.primary",
  });

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Canvas">
      <button type="button" className="modal-backdrop" onClick={onClose} aria-label={t("common.close")} />
      <div className="modal-panel canvas-board-panel" ref={panelRef}>
        <div className="modal-head canvas-board-head">
          <h2 className="canvas-board-title">Canvas</h2>
          <button
            type="button"
            className="btn ghost"
            onClick={() =>
              setDoc((d) => ({ ...d, cards: [...d.cards, newCard()], updatedAt: Date.now() }))
            }
          >
            {t("canvas.addText")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={saving}
            onClick={() => {
              void (async () => {
                setSaving(true);
                try {
                  const next = { ...doc, updatedAt: Date.now() };
                  await onSave(JSON.stringify(next, null, 2));
                  setDoc(next);
                } finally {
                  setSaving(false);
                }
              })();
            }}
          >
            {t("canvas.save")}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <div
          className="canvas-board-stage"
          onPointerMove={(e) => {
            if (!dragId) return;
            const stage = e.currentTarget.getBoundingClientRect();
            const x = Math.max(0, e.clientX - stage.left - dragOffset.current.x);
            const y = Math.max(0, e.clientY - stage.top - dragOffset.current.y);
            setDoc((d) => ({
              ...d,
              cards: d.cards.map((c) => (c.id === dragId ? { ...c, x, y } : c)),
              updatedAt: Date.now(),
            }));
          }}
          onPointerUp={() => setDragId(null)}
          onPointerLeave={() => setDragId(null)}
        >
          {doc.cards.map((card) => (
            <div
              key={card.id}
              className="canvas-card"
              style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
            >
              <div
                className="canvas-card-handle"
                onPointerDown={(e) => {
                  e.preventDefault();
                  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                  const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                  dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                  setDragId(card.id);
                }}
              />
              <textarea
                className="canvas-card-text"
                value={card.text}
                onChange={(e) => {
                  const text = e.target.value;
                  setDoc((d) => ({
                    ...d,
                    cards: d.cards.map((c) => (c.id === card.id ? { ...c, text } : c)),
                  }));
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
