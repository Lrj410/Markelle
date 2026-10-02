import { invoke } from "@tauri-apps/api/core";
import { extractWikiLinks } from "./obsidian";
import { joinPath, toPosixPath, basename, trimTrailingSep } from "./paths";
import {
  decodeFsPath,
  parseMdImageDestination,
  softenImageDestinations,
} from "./mediaPath";
import { isVaultRootRelativePath } from "./markdown";

const MEDIA_EXT =
  /\.(png|jpe?g|gif|webp|bmp|avif|ico|heic|heif|mp3|wav|ogg|m4a|aac|flac|mp4|webm|ogv|mov|pdf)$/i;

export function isMediaTarget(target: string): boolean {
  return MEDIA_EXT.test(target.trim().replace(/\\/g, "/"));
}

/** Unique media targets from wiki embeds + standard markdown image/src-like paths. */
export function collectMediaTargets(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const t = decodeFsPath(raw.trim().replace(/\\/g, "/")).split(/[?#]/)[0] ?? "";
    if (!t || !isMediaTarget(t)) return;
    if (
      t.startsWith("http://") ||
      t.startsWith("https://") ||
      t.startsWith("data:") ||
      t.startsWith("blob:") ||
      t.startsWith("mklasset:")
    ) {
      return;
    }
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const link of extractWikiLinks(source)) {
    if (link.embed && link.target) push(link.target);
  }

  const softened = softenImageDestinations(source);
  const mdImg = /!\[[^\]]*]\(([^)\n]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdImg.exec(softened))) {
    const dest = parseMdImageDestination(m[1] ?? "");
    if (dest) push(dest);
  }

  return out.slice(0, 80);
}

/**
 * Sync candidate absolute paths (Obsidian-style guesses).
 * First hit that exists is preferred by the Rust resolver; this list seeds UI tests.
 * NOTE: currently exercised only by tests — keep it (do not delete) as the
 * documented reference for the Rust resolver's search order.
 */
export function candidateMediaAbsPaths(
  target: string,
  baseDir: string,
  vaultRoot?: string | null,
  attachmentFolder = "attachments",
): string[] {
  let raw = decodeFsPath(target.trim().replace(/\\/g, "/"));
  if (!raw) return [];
  // `/C:/Users/...` → `C:/Users/...`
  if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
  // Broken links that still embed an absolute Windows path
  const driveAt = raw.search(/[A-Za-z]:\//);
  if (driveAt > 0) {
    raw = raw.slice(driveAt);
  }

  const out: string[] = [];
  const push = (p: string) => {
    const n = toPosixPath(p);
    if (!n || out.includes(n)) return;
    out.push(n);
  };

  if (/^[a-zA-Z]:\//.test(raw) || (raw.startsWith("/") && !raw.startsWith("//"))) {
    push(raw);
  }

  const base = toPosixPath(baseDir).replace(/\/$/, "");
  const root = vaultRoot ? toPosixPath(vaultRoot).replace(/\/$/, "") : "";
  const name = basename(raw);
  const folder =
    attachmentFolder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "attachments";

  if (base && !/^[a-zA-Z]:\//.test(raw)) {
    push(joinPath(base, raw));
  }
  if (root) {
    if (!raw.includes("..")) push(joinPath(root, raw));
    push(joinPath(root, name));
    push(joinPath(root, folder, name));
    // Dated attachment folders (Markelle paste/import convention).
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    push(joinPath(root, folder, yyyy, mm, name));
    // Previous month (notes edited across month boundary).
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const py = String(prev.getFullYear());
    const pm = String(prev.getMonth() + 1).padStart(2, "0");
    if (py !== yyyy || pm !== mm) {
      push(joinPath(root, folder, py, pm, name));
    }
    if (!raw.includes("..") && raw.includes("/")) {
      push(joinPath(root, folder, raw));
    }
    push(joinPath(base, folder, name));
  }

  return out;
}

/** Resolve a media wiki/markdown target to an absolute filesystem path (ACL-gated). */
export async function resolveVaultMedia(
  root: string | null | undefined,
  baseDir: string,
  target: string,
  attachmentFolder?: string,
): Promise<string | null> {
  const t = decodeFsPath(target.trim());
  if (!t || !isMediaTarget(t)) return null;
  try {
    const path = await invoke<string>("resolve_vault_media", {
      root: root ?? "",
      baseDir,
      target: t,
      attachmentFolder: attachmentFolder ?? null,
    });
    return path || null;
  } catch {
    return null;
  }
}

/** Resolve many targets → map of original target → absolute path. */
export async function resolveMediaMap(
  root: string | null | undefined,
  baseDir: string,
  targets: string[],
  attachmentFolder?: string,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const slice = targets.slice(0, 80);
  // Sync seed vault-root-relative paths so nested notes paint correctly even if
  // the Rust walk is slow / momentarily fails (existence still gated by mklasset ACL).
  if (root) {
    const r = trimTrailingSep(toPosixPath(root));
    for (const target of slice) {
      const t = decodeFsPath(target.trim());
      if (isVaultRootRelativePath(t)) {
        const abs = joinPath(r, t);
        map[target] = abs;
        if (t !== target) map[t] = abs;
      }
    }
  }
  await Promise.all(
    slice.map(async (target) => {
      const abs = await resolveVaultMedia(root, baseDir, target, attachmentFolder);
      if (abs) {
        map[target] = abs;
        const decoded = decodeFsPath(target);
        if (decoded !== target) map[decoded] = abs;
      }
    }),
  );
  return map;
}
