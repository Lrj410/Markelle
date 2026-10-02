import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { t } from "../lib/i18n";

export interface ContextMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** Fixed-position menu used by editor / reader (browser context menu is suppressed). */
export function EditorContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLButtonElement>("button:not([disabled])");
    first?.focus();
  }, []);

  const menuW = 188;
  const menuH = Math.min(320, 12 + items.length * 34);
  const left = Math.min(Math.max(8, x), window.innerWidth - menuW - 8);
  const top = Math.min(Math.max(8, y), window.innerHeight - menuH - 8);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([disabled])',
      ) ?? [],
    );
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(current + 1) % buttons.length]!.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(current - 1 + buttons.length) % buttons.length]!.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]!.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]!.focus();
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="editor-ctx vault-ctx"
      style={{ left, top }}
      role="menu"
      aria-labelledby={labelId}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span id={labelId} className="sr-only">
        {t("ctx.menu")}
      </span>
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="editor-ctx-sep" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            className={clsx("vault-ctx-item", { danger: item.danger })}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
