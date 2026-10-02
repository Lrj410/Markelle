import type { TocItem } from "../lib/toc";
import clsx from "clsx";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

interface Props {
  items: TocItem[];
  open: boolean;
  activeId?: string;
  onJump: (id: string) => void;
  onClose?: () => void;
  onAdjustLevel?: (id: string, delta: -1 | 1) => void;
  /** Move heading to absolute index among outline items. */
  onReorder?: (id: string, toIndex: number) => void;
}

export function TocSidebar({
  items,
  open,
  activeId,
  onJump,
  onClose,
  onAdjustLevel,
  onReorder,
}: Props) {
  useLocale();
  if (!open) return null;

  return (
    <aside className="toc-sidebar dock-fill" aria-label={t("panel.toc")}>
      {items.length === 0 ? (
        <div className="toc-empty">
          <strong>{t("toc.emptyTitle")}</strong>
          <p>{t("toc.emptyBody")}</p>
          {onClose && (
            <button type="button" className="btn ghost toc-empty-close" onClick={onClose}>
              {t("toc.close")}
            </button>
          )}
        </div>
      ) : (
        <nav className="toc-list" aria-label={t("panel.toc")}>
          {items.map((item, index) => (
            <div
              key={item.id}
              className={clsx("toc-row", { active: item.id === activeId })}
              draggable={Boolean(onReorder)}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/toc-index", String(index));
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!onReorder) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                if (!onReorder) return;
                e.preventDefault();
                const raw = e.dataTransfer.getData("text/toc-index");
                const from = Number(raw);
                if (!Number.isFinite(from) || from === index) return;
                const id = items[from]?.id;
                if (!id) return;
                onReorder(id, index);
              }}
            >
              <button
                type="button"
                className={clsx("toc-item", `level-${item.level}`, {
                  active: item.id === activeId,
                })}
                title={item.text}
                onClick={() => onJump(item.id)}
              >
                {item.text}
              </button>
              {onAdjustLevel && (
                <span className="toc-level-btns">
                  <button
                    type="button"
                    className="btn ghost toc-lvl"
                    title={t("toc.promote")}
                    aria-label={t("toc.promote")}
                    onClick={() => onAdjustLevel(item.id, -1)}
                  >
                    H−
                  </button>
                  <button
                    type="button"
                    className="btn ghost toc-lvl"
                    title={t("toc.demote")}
                    aria-label={t("toc.demote")}
                    onClick={() => onAdjustLevel(item.id, 1)}
                  >
                    H+
                  </button>
                </span>
              )}
              {onReorder && (
                <span className="toc-level-btns">
                  <button
                    type="button"
                    className="btn ghost toc-lvl"
                    title={t("toc.moveUp")}
                    aria-label={t("toc.moveUp")}
                    disabled={index === 0}
                    onClick={() => onReorder(item.id, index - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn ghost toc-lvl"
                    title={t("toc.moveDown")}
                    aria-label={t("toc.moveDown")}
                    disabled={index === items.length - 1}
                    onClick={() => onReorder(item.id, index + 1)}
                  >
                    ↓
                  </button>
                </span>
              )}
            </div>
          ))}
        </nav>
      )}
    </aside>
  );
}
