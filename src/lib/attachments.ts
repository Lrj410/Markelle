import { formatMdImageDestination } from "./mediaPath";
import { joinPath } from "./paths";

const DEFAULT_ATTACHMENT_FOLDER = "attachments";

/** Sanitize a relative attachment folder from settings. */
export function normalizeAttachmentFolder(raw: string | undefined | null): string {
  const trimmed = (raw ?? DEFAULT_ATTACHMENT_FOLDER).trim().replace(/\\/g, "/");
  const segments = trimmed
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
  if (segments.some((seg) => seg === "." || seg === "..")) {
    return DEFAULT_ATTACHMENT_FOLDER;
  }
  const cleaned = segments.join("/");
  return cleaned || DEFAULT_ATTACHMENT_FOLDER;
}

/** Build `folder/yyyy/mm/safeName` under the vault-relative attachment root. */
export function buildAttachmentRelativePath(
  attachmentFolder: string,
  fileName: string,
  now = new Date(),
): string {
  const folder = normalizeAttachmentFolder(attachmentFolder);
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const safe = sanitizeFileName(fileName);
  return joinPath(folder, yyyy, mm, safe);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME_LENGTH = 180;

export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "file";
  const cleaned = base
    .replace(/[<>:"|?*]/g, "_")
    // Strip ASCII control characters (illegal in Windows filenames).
    .split("")
    .filter((ch) => ch.charCodeAt(0) > 31)
    .join("")
    .replace(/^\.+/, "_")
    // Trailing dots/spaces are illegal on Windows.
    .replace(/[. ]+$/, "");
  if (!cleaned) return "file";

  // Truncate the stem so the extension survives the length cap.
  const dot = cleaned.lastIndexOf(".");
  const hasExt = dot > 0 && dot < cleaned.length - 1;
  let stem = hasExt ? cleaned.slice(0, dot) : cleaned;
  const ext = hasExt ? cleaned.slice(dot) : "";
  if (stem.length + ext.length > MAX_NAME_LENGTH) {
    stem = stem.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length));
  }
  // Trailing dots/spaces in the stem are illegal on Windows — and stripping them
  // first also stops "con .txt" from slipping past the reserved-name check.
  stem = stem.replace(/[. ]+$/, "");
  if (WINDOWS_RESERVED.test(stem)) stem = `${stem}_`;
  if (!stem) stem = "file";
  return `${stem}${ext}`;
}

/** Prefer a timestamped name when colliding style matters less than uniqueness. */
export function uniqueAttachmentName(original: string, now = new Date()): string {
  const safe = sanitizeFileName(original || "paste.png");
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    "-",
    String(now.getMilliseconds()).padStart(3, "0"),
  ].join("");
  // Extra entropy for same-ms multi-paste (clipboard bursts).
  const salt = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .padStart(3, "0");
  return `${stem}-${stamp}-${salt}${ext || ".png"}`;
}

export function markdownImageLink(vaultRelativePosix: string, alt = ""): string {
  const path = vaultRelativePosix.replace(/\\/g, "/");
  return `![${alt}](${formatMdImageDestination(path)})`;
}

export function isImageFileName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|avif|ico|heic|heif)$/i.test(name);
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/") && !/svg/i.test(file.type)) return true;
  if (/heic|heif/i.test(file.type)) return true;
  return isImageFileName(file.name || "");
}

export function isAttachmentDropCandidate(path: string): boolean {
  return isImageFileName(path) || /\.(pdf|mp3|mp4|wav|webm|zip)$/i.test(path);
}

/**
 * Collect image/files from a paste or drop DataTransfer.
 * Screenshots often land in `items` as image/* blobs, not in `files`.
 */
export function filesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<File>();

  const push = (f: File | null) => {
    if (!f || seen.has(f)) return;
    seen.add(f);
    out.push(f);
  };

  for (const f of Array.from(data.files ?? [])) push(f);

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (!f) continue;
    // Clipboard bitmaps often have empty name — stamp a default so writers succeed.
    if (!f.name && f.type.startsWith("image/")) {
      const ext =
        f.type === "image/jpeg"
          ? ".jpg"
          : f.type === "image/webp"
            ? ".webp"
            : f.type === "image/gif"
              ? ".gif"
              : ".png";
      push(new File([f], `paste${ext}`, { type: f.type }));
    } else {
      push(f);
    }
  }

  return out;
}

/** Guess a display alt from a File (strip stamp / path). */
export function imageAltFromFile(file: File): string {
  const raw = (file.name || "image").replace(/\\/g, "/").split("/").pop() || "image";
  return raw.replace(/-\d{8}-\d{6}(?=\.[^.]+$)/, "") || "image";
}
