export interface PromptRequest {
  /** Dialog heading; defaults to the "Markelle" brand name. */
  title?: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  /** Renders the input as a password field (with a show/hide toggle). */
  masked?: boolean;
  okLabel?: string;
  cancelLabel?: string;
}

type Pending = PromptRequest & { resolve: (value: string | null) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** In-app text prompt that matches Markelle chrome (replaces native window.prompt). */
export function askPrompt(opts: PromptRequest): Promise<string | null> {
  return new Promise((resolve) => {
    if (pending) {
      pending.resolve(null);
    }
    pending = {
      title: opts.title ?? "Markelle",
      message: opts.message,
      placeholder: opts.placeholder,
      initialValue: opts.initialValue,
      masked: opts.masked ?? false,
      okLabel: opts.okLabel,
      cancelLabel: opts.cancelLabel,
      resolve,
    };
    emit();
  });
}

export function getPromptPending(): Pending | null {
  return pending;
}

/** Resolve with the submitted value, or null when cancelled. */
export function resolvePrompt(value: string | null): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(value);
}

export function subscribePrompt(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
