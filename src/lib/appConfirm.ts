import { t } from "./i18n";

export type ConfirmKind = "info" | "warning" | "error";

export interface ConfirmRequest {
  message: string;
  title?: string;
  kind?: ConfirmKind;
  okLabel?: string;
  cancelLabel?: string;
  hideCancel?: boolean;
}

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** In-app confirm that matches Markelle chrome (replaces native OS ask dialogs). */
export function askConfirm(
  message: string,
  opts?: Omit<ConfirmRequest, "message">,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (pending) {
      pending.resolve(false);
    }
    pending = {
      message,
      title: opts?.title ?? "Markelle",
      kind: opts?.kind ?? "warning",
      okLabel: opts?.okLabel,
      cancelLabel: opts?.cancelLabel,
      hideCancel: opts?.hideCancel,
      resolve,
    };
    emit();
  });
}

/** In-app alert dialog with single confirm button */
export function askAlert(
  message: string,
  opts?: Omit<ConfirmRequest, "message" | "hideCancel">,
): Promise<void> {
  return askConfirm(message, {
    ...opts,
    hideCancel: true,
    okLabel: opts?.okLabel ?? t("confirm.ok"),
  }).then(() => {});
}

export function getConfirmPending(): Pending | null {
  return pending;
}

export function resolveConfirm(ok: boolean): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(ok);
}

export function subscribeConfirm(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
