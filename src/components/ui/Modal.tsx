import { useId, useRef, type ReactNode } from "react";
import clsx from "clsx";
import { t } from "../../lib/i18n";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Extra classes on `.modal-panel`. */
  panelClassName?: string;
  titleId?: string;
  /** Used when there is no labelled heading. */
  ariaLabel?: string;
  ariaDescribedBy?: string;
  role?: "dialog" | "alertdialog";
  initialFocusSelector?: string;
  /** Hide the full-screen dimmer click target (rare). */
  disableBackdropClose?: boolean;
  overlayClassName?: string;
}

/**
 * Shared modal chrome: overlay, backdrop, focus trap, Escape.
 * Callers supply header/body/actions inside `children`.
 */
export function Modal({
  open,
  onClose,
  children,
  panelClassName,
  titleId,
  ariaLabel,
  ariaDescribedBy,
  role = "dialog",
  initialFocusSelector,
  disableBackdropClose,
  overlayClassName,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const fallbackTitleId = useId();
  const labelledBy = titleId ?? (ariaLabel ? undefined : fallbackTitleId);

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    onEscape: onClose,
    initialFocusSelector,
  });

  if (!open) return null;

  return (
    <div
      className={clsx("modal-overlay", overlayClassName)}
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
    >
      <button
        type="button"
        className="modal-backdrop"
        onClick={disableBackdropClose ? undefined : onClose}
        tabIndex={-1}
        aria-label={t("common.close")}
      />
      <div className={clsx("modal-panel", panelClassName)} ref={panelRef}>
        {children}
      </div>
    </div>
  );
}
