import { normalizePath } from "./openTab";

/** Convert any OS separators to `/` without lowercasing. */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Trim trailing `/` (and legacy `\`) from a path string. */
export function trimTrailingSep(path: string): string {
  return toPosixPath(path).replace(/\/+$/, "");
}

/** Join path segments with `/` (works for Windows drive letters and POSIX). */
export function joinPath(...parts: string[]): string {
  if (parts.length === 0) return "";
  const cleaned = parts
    .map((p, i) => {
      let s = toPosixPath(p);
      if (i > 0) s = s.replace(/^\/+/, "");
      s = s.replace(/\/+$/, "");
      return s;
    })
    .filter((s, i) => s.length > 0 || i === 0);
  return cleaned.join("/");
}

export function dirname(path: string): string {
  const p = trimTrailingSep(path);
  const i = p.lastIndexOf("/");
  if (i <= 0) return p.includes(":") ? p.slice(0, 2) || p : "";
  return p.slice(0, i);
}

export function basename(path: string): string {
  const p = trimTrailingSep(path);
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Best-effort display path for status UI (keep `/` for consistency). */
export function toDisplayPath(path: string): string {
  return toPosixPath(path);
}

/**
 * Pick `root/preferredName`, or `root/stem-2.ext`, … until not in `existing`
 * (existing keys should be normalizePath'd).
 */
export function allocateUniquePath(
  root: string,
  preferredName: string,
  existing: Set<string>,
): string {
  const base = trimTrailingSep(root);
  const dot = preferredName.lastIndexOf(".");
  const stem = dot > 0 ? preferredName.slice(0, dot) : preferredName;
  const ext = dot > 0 ? preferredName.slice(dot) : "";

  let name = preferredName;
  let path = joinPath(base, name);
  let i = 2;
  while (existing.has(normalizePath(path))) {
    name = `${stem}-${i}${ext}`;
    path = joinPath(base, name);
    i += 1;
    if (i > 500) {
      throw new Error("无法分配唯一文件名");
    }
  }
  return path;
}
