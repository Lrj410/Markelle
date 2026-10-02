/**
 * Process-wide queue for OS / second-instance open requests.
 * Installed before React mounts so the 350ms Rust startup emit cannot be lost
 * to listener registration races (Strict Mode remount, slow store hydrate).
 */

export type PendingOpen =
  | { kind: "file"; path: string }
  | { kind: "vault"; path: string };

const queue: PendingOpen[] = [];
let consumer: ((item: PendingOpen) => void) | null = null;
let earlyUnlisten: (() => void) | null = null;
let installPromise: Promise<void> | null = null;

export function enqueuePendingOpen(item: PendingOpen): void {
  const path = item.path?.trim();
  if (!path) return;
  const normalized = { ...item, path };
  if (consumer) {
    consumer(normalized);
    return;
  }
  // Collapse duplicate paths while waiting for the App consumer.
  const key = `${normalized.kind}:${path.replace(/\\/g, "/").toLowerCase()}`;
  const exists = queue.some(
    (q) => `${q.kind}:${q.path.replace(/\\/g, "/").toLowerCase()}` === key,
  );
  if (!exists) queue.push(normalized);
}

export function setPendingOpenConsumer(
  fn: ((item: PendingOpen) => void) | null,
): void {
  consumer = fn;
  if (!fn) return;
  const drained = queue.splice(0, queue.length);
  for (const item of drained) fn(item);
}

/** True when an OS open is waiting and App has not attached yet. */
export function hasPendingOpen(): boolean {
  return queue.length > 0;
}

export async function installEarlyOpenListeners(): Promise<void> {
  if (earlyUnlisten) return;
  // Reuse a single in-flight install so Strict Mode / concurrent callers cannot
  // register the listeners twice.
  if (installPromise) return installPromise;
  installPromise = (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const u1 = await listen<string>("open-file-request", (event) => {
        enqueuePendingOpen({ kind: "file", path: event.payload });
      });
      const u2 = await listen<string>("open-vault-request", (event) => {
        enqueuePendingOpen({ kind: "vault", path: event.payload });
      });
      earlyUnlisten = () => {
        u1();
        u2();
        earlyUnlisten = null;
        installPromise = null;
      };
    } catch {
      // Allow a later retry after a transient import/listen failure.
      installPromise = null;
    }
  })();
  return installPromise;
}
