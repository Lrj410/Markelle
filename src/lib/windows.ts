import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export async function openPathInNewWindow(path: string): Promise<void> {
  const name = path.split(/[/\\]/).pop() ?? "Markelle";
  // Suffix keeps labels unique when two opens land in the same millisecond.
  const label = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const url = `/?file=${encodeURIComponent(path)}`;

  const win = new WebviewWindow(label, {
    url,
    title: `${name} — Markelle`,
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    decorations: false,
    focus: true,
    center: true,
  });

  await new Promise<void>((resolve, reject) => {
    const offs: Array<Promise<() => void>> = [];
    let settled = false;
    // Holds the failsafe timer id so `finish` can cancel it (assigned below).
    const timerBox: { id?: ReturnType<typeof setTimeout> } = {};
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (timerBox.id !== undefined) clearTimeout(timerBox.id);
      for (const off of offs) void off.then((fn) => fn()).catch(() => undefined);
      if (err === undefined) resolve();
      else reject(err instanceof Error ? err : new Error(String(err)));
    };
    // Never hang forever if the native window neither creates nor errors.
    timerBox.id = setTimeout(() => finish(new Error("window creation timed out")), 8000);
    offs.push(win.once("tauri://created", () => finish()));
    offs.push(win.once("tauri://error", (event: unknown) => finish(event)));
  });
}

export function readStartupFileParam(): string | null {
  const file = new URLSearchParams(window.location.search).get("file");
  return file && file.trim() ? file : null;
}
