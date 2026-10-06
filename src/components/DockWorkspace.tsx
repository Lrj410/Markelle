import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import {
  movePanel,
  panelLabel,
  setSlotActive,
  setSlotSize,
  MIN_SIDE_SIZE,
  MIN_RIGHT_SIZE,
  MIN_BOTTOM_SIZE,
  MAX_SIDE_SIZE,
  MAX_BOTTOM_SIZE,
  type DockLayout,
  type DockSide,
  type PanelId,
} from "../lib/dock";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

interface Props {
  layout: DockLayout;
  onChange: (next: DockLayout) => void;
  renderPanel: (id: PanelId) => ReactNode;
  children: ReactNode;
}

const DROP_SIDES: DockSide[] = ["left", "right", "bottom"];

function DockWorkspaceInner({ layout, onChange, renderPanel, children }: Props) {
  useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [dropSide, setDropSide] = useState<DockSide | null>(null);
  const resizeRef = useRef<{ side: DockSide; start: number; size: number } | null>(null);

  const onDragStart = (id: PanelId) => (e: React.DragEvent) => {
    e.dataTransfer.setData("text/panel-id", id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(id);
  };

  const onDragEnd = () => {
    setDragging(null);
    setDropSide(null);
  };

  const onDragOverSide = (side: DockSide) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropSide(side);
  };

  const onDropSide = (side: DockSide) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = (e.dataTransfer.getData("text/panel-id") || dragging) as PanelId | "";
    setDragging(null);
    setDropSide(null);
    if (!id) return;
    onChange(movePanel(layout, id, side));
  };

  const beginResize = (side: DockSide) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = {
      side,
      start: side === "bottom" ? e.clientY : e.clientX,
      size: layoutRef.current[side].size,
    };
  };

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      e.preventDefault();
      const delta =
        r.side === "left"
          ? e.clientX - r.start
          : r.side === "right"
            ? r.start - e.clientX
            : r.start - e.clientY;
      onChange(setSlotSize(layoutRef.current, r.side, r.size + delta));
    },
    [onChange],
  );

  const onPointerUp = useCallback((e: PointerEvent) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    try {
      (e.target as HTMLElement | null)?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  const renderDock = (side: DockSide) => {
    const slot = layout[side];
    if (slot.panels.length === 0 || !slot.active) return null;
    const active = slot.panels.includes(slot.active) ? slot.active : null;
    if (!active) return null;
    // Lock cross-axis size so vault content min-width cannot inflate the slot.
    // The right dock omits an inline minWidth so the stylesheet's responsive
    // `min(320px, 40vw)` (and its ≤900px relaxation) can keep narrow windows
    // from overflowing.
    const style =
      side === "bottom"
        ? {
            height: slot.size,
            flex: "0 0 auto" as const,
            minHeight: MIN_BOTTOM_SIZE,
            maxHeight: slot.size,
            overflow: "hidden" as const,
          }
        : {
            width: slot.size,
            flex: side === "right" ? ("0 1 auto" as const) : ("0 0 auto" as const),
            minWidth: side === "right" ? MIN_RIGHT_SIZE : MIN_SIDE_SIZE,
            maxWidth: slot.size,
            overflow: "hidden" as const,
          };

    const minValue =
      side === "bottom" ? MIN_BOTTOM_SIZE : side === "right" ? MIN_RIGHT_SIZE : MIN_SIDE_SIZE;
    const maxValue = side === "bottom" ? MAX_BOTTOM_SIZE : MAX_SIDE_SIZE;

    const nudge = (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = 24;
      let delta = 0;
      if (side === "bottom") {
        if (e.key === "ArrowDown") delta = step;
        else if (e.key === "ArrowUp") delta = -step;
      } else if (side === "left") {
        if (e.key === "ArrowRight") delta = step;
        else if (e.key === "ArrowLeft") delta = -step;
      } else {
        if (e.key === "ArrowLeft") delta = step;
        else if (e.key === "ArrowRight") delta = -step;
      }
      if (!delta) return;
      e.preventDefault();
      const current = layoutRef.current[side].size;
      onChange(setSlotSize(layoutRef.current, side, current + delta));
    };

    return (
      <aside
        className={clsx("dock-slot", `dock-${side}`, {
          "dock-drop-target": dropSide === side && dragging,
        })}
        style={style}
        onDragOver={onDragOverSide(side)}
        onDragLeave={() => setDropSide((s) => (s === side ? null : s))}
        onDrop={onDropSide(side)}
        aria-label={
          side === "left" ? t("dock.left") : side === "right" ? t("dock.right") : t("dock.bottom")
        }
      >
        <div className="dock-tabs">
          <div
            className="dock-tabs-list"
            role="tablist"
            aria-label={
              side === "left"
                ? t("dock.left")
                : side === "right"
                  ? t("dock.right")
                  : t("dock.bottom")
            }
          >
            {slot.panels.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === active}
                className={clsx("dock-tab", { active: id === active })}
                draggable
                onDragStart={onDragStart(id)}
                onDragEnd={onDragEnd}
                onClick={() => onChange(setSlotActive(layout, side, id))}
              >
                {panelLabel(id)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="dock-tab-close"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={() => {
              onChange({
                ...layout,
                [side]: { ...slot, active: null },
              });
            }}
          >
            {side === "left" ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 3.5 5.5 8l4.5 4.5" />
              </svg>
            ) : side === "right" ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 3.5 10.5 8 6 12.5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3.5 6 8 10.5 12.5 6" />
              </svg>
            )}
          </button>
        </div>
        <div className="dock-body" key={active ?? "empty"}>
          {active ? renderPanel(active) : null}
        </div>
        <div
          className={clsx("dock-resizer", `dock-resizer-${side}`)}
          onPointerDown={beginResize(side)}
          role="separator"
          tabIndex={0}
          aria-orientation={side === "bottom" ? "horizontal" : "vertical"}
          aria-label={t("dock.resizer")}
          aria-valuenow={slot.size}
          aria-valuemin={minValue}
          aria-valuemax={maxValue}
          onKeyDown={nudge}
        />
      </aside>
    );
  };

  return (
    <div
      ref={rootRef}
      className={clsx("dock-workspace", { "is-dragging": Boolean(dragging) })}
    >
      {renderDock("left")}
      <div className="dock-center">
        {children}
        {/* bottom sits under center content */}
        {layout.bottom.panels.length > 0 && renderDock("bottom")}
      </div>
      {renderDock("right")}
      {dragging &&
        DROP_SIDES.map((side) =>
          layout[side].panels.length === 0 ? (
            <div
              key={`ghost-${side}`}
              className={clsx("dock-ghost", `dock-ghost-${side}`, {
                active: dropSide === side,
              })}
              onDragOver={onDragOverSide(side)}
              onDrop={onDropSide(side)}
            />
          ) : null,
        )}
    </div>
  );
}

export const DockWorkspace = memo(DockWorkspaceInner);
