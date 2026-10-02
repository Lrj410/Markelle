import { createTabId, isDirty, type DocTab } from "./tabs";
import type { OpenedFile } from "./files";

/** Windows hosts compare paths case-insensitively (drive letters, ACL checks). */
const IS_WINDOWS_HOST =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent ?? "");

function isCaseInsensitivePath(path: string): boolean {
  // Windows-style paths (drive prefix or `\` separators) follow Windows semantics
  // regardless of host; POSIX paths stay case-sensitive on case-sensitive hosts.
  return IS_WINDOWS_HOST || /^[a-zA-Z]:/.test(path) || path.includes("\\");
}

export function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return isCaseInsensitivePath(path) ? normalized.toLowerCase() : normalized;
}

/** Collapse `.` / `..` segments after normalize (Windows drive-aware). */
export function resolvePathSegments(path: string): string {
  const norm = normalizePath(path);
  const parts = norm.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) continue;
      const top = stack[stack.length - 1]!;
      if (/^[a-z]:$/i.test(top)) continue;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

export function pathsEqual(a: string, b: string): boolean {
  return resolvePathSegments(a) === resolvePathSegments(b);
}

/** True if `child` is the same as or under `root` (path segments). */
export function isPathUnder(child: string, root: string): boolean {
  const c = resolvePathSegments(child);
  const r = resolvePathSegments(root);
  return c === r || c.startsWith(`${r}/`);
}

/** Same parent directory (siblings under an opened note's folder). */
export function isSameDirectory(a: string, b: string): boolean {
  const na = resolvePathSegments(a);
  const nb = resolvePathSegments(b);
  const pa = na.includes("/") ? na.slice(0, na.lastIndexOf("/")) : "";
  const pb = nb.includes("/") ? nb.slice(0, nb.lastIndexOf("/")) : "";
  return pa !== "" && pa === pb;
}

export function findTabByPath(tabs: DocTab[], path: string): DocTab | undefined {
  const key = normalizePath(path);
  return tabs.find((tab) => normalizePath(tab.path) === key);
}

function tabFromOpened(
  opened: OpenedFile,
  baseDir: string,
  id: string,
  prev?: DocTab,
): DocTab {
  // 只信后端：2MB–50MB 的文件后端会完整返回全文，前端不能按 size 猜成“大文件”。
  const large = Boolean(opened.large);
  return {
    id,
    path: opened.path,
    name: opened.name,
    content: opened.content,
    savedContent: opened.content,
    baseDir,
    size: opened.size,
    // Must mirror the backend: when it only returned a preview, `content` is a
    // fragment and saving it would truncate the note on disk.
    truncated: opened.truncated,
    // Default to read mode for all files (large and small); preserve user mode if existing.
    mode: prev?.mode ?? "read",
    encoding: opened.encoding,
    diskMtimeMs: opened.mtimeMs,
    bytesRead: opened.size,
    large,
    hydrateRatio: 1,
    backendBuffer: false,
    largeDirty: false,
  };
}

/** Pure tab upsert — returns next tabs + id to focus (safe under React 18 batching). */
export function upsertOpenedTab(
  prev: DocTab[],
  opened: OpenedFile,
  baseDir: string,
  forceFull: boolean,
): { tabs: DocTab[]; focusId: string } {
  const existing = findTabByPath(prev, opened.path);
  if (existing) {
    const keepDirty = !forceFull && isDirty(existing) && !opened.truncated;
    const next = tabFromOpened(opened, baseDir, existing.id, existing);
    if (keepDirty) {
      next.content = existing.content;
    }
    // Preserve mode on reload for all files (large and small).
    if (existing.mode) {
      next.mode = existing.mode;
    }
    return {
      focusId: existing.id,
      tabs: prev.map((tab) => (tab.id === existing.id ? next : tab)),
    };
  }

  const focusId = createTabId();
  const tab = tabFromOpened(opened, baseDir, focusId);
  return { tabs: [...prev, tab], focusId };
}

/** If activeId is missing or stale, pick a sensible tab. */
export function resolveActiveId(
  tabs: DocTab[],
  activeId: string | null,
): string | null {
  if (tabs.length === 0) return null;
  if (activeId && tabs.some((t) => t.id === activeId)) return activeId;
  return tabs[tabs.length - 1]?.id ?? null;
}
