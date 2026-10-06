import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [activeIndex, setActiveIndex] = useState(0);

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selected = options[selectedIndex] ?? options[0];

  const focusOption = useCallback((index: number) => {
    const menu = menuRef.current;
    if (!menu) return;
    const items = menu.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (!items.length) return;
    const clamped = Math.min(Math.max(0, index), items.length - 1);
    items[clamped]?.focus();
    setActiveIndex(clamped);
  }, []);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const place = () => {
      const r = rootRef.current!.getBoundingClientRect();
      const menuH = menuRef.current?.offsetHeight ?? options.length * 36 + 8;
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const openUp = spaceBelow < menuH && r.top > spaceBelow;
      const width = Math.max(r.width, 148);
      setMenuStyle({
        position: "fixed",
        top: openUp ? undefined : r.bottom + 4,
        bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
        left: Math.min(r.left, window.innerWidth - width - 8),
        width,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  // Move focus onto the selected (or first) option once the list is mounted.
  useLayoutEffect(() => {
    if (!open) return;
    const start = selectedIndex >= 0 ? selectedIndex : 0;
    setActiveIndex(start);
    const raf = requestAnimationFrame(() => {
      const menu = menuRef.current;
      const items = menu?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      items?.[start]?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      const count = items?.length ?? 0;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab") {
        close();
        return;
      }
      if (!count) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusOption(activeIndex + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        focusOption(activeIndex - 1);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        focusOption(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        focusOption(count - 1);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const opt = options[activeIndex];
        if (opt) {
          onChange(opt.value);
          close();
        }
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, activeIndex, options, onChange, close, focusOption]);

  return (
    <div
      ref={rootRef}
      className={clsx("ui-select", className, { "is-open": open, "is-disabled": disabled })}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ui-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          if (disabled) return;
          if (open) close();
          else setOpen(true);
        }}
      >
        <span className="ui-select-value">{selected?.label ?? ""}</span>
        <span className="ui-select-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            className="ui-select-menu"
            style={menuStyle}
            role="listbox"
            aria-label={ariaLabel}
          >
            {options.map((opt, index) => {
              const active = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  tabIndex={index === activeIndex ? 0 : -1}
                  aria-selected={active}
                  className={clsx("ui-select-option", { active })}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span>{opt.label}</span>
                  {active && <span className="ui-select-check" aria-hidden>✓</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
