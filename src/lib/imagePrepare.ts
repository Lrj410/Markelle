/**
 * Prepare attachment images before vault write:
 * - HEIC/HEIF → JPEG (via heic-to)
 * - Downscale long edge above `maxEdge` (default 2048)
 * - Re-encode large bitmaps as JPEG to keep paste/import snappy
 */

import { t } from "./i18n";

export const DEFAULT_MAX_EDGE = 2048;
export const DEFAULT_PASS_THROUGH_BYTES = 2 * 1024 * 1024;
export const DEFAULT_JPEG_QUALITY = 0.85;

export interface PreparedImage {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  resized: boolean;
  converted: boolean;
}

export function isHeicLike(name: string, mime = ""): boolean {
  const n = name.toLowerCase();
  const m = mime.toLowerCase();
  return (
    m.includes("heic") ||
    m.includes("heif") ||
    n.endsWith(".heic") ||
    n.endsWith(".heif")
  );
}

function replaceExt(name: string, ext: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "image";
  return `${base}${ext.startsWith(".") ? ext : `.${ext}`}`;
}

async function blobToUint8(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function convertHeicToJpeg(blob: Blob): Promise<Blob> {
  const { heicTo } = await import("heic-to");
  return heicTo({
    blob,
    type: "image/jpeg",
    quality: DEFAULT_JPEG_QUALITY,
  });
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(t("md.imgEncodeFailed")))),
      "image/jpeg",
      quality,
    );
  });
}

type DecodedImage = {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, tw: number, th: number) => void;
  close: () => void;
};

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("md.imgDecodeFailed")));
    img.src = url;
  });
}

/** Prefer createImageBitmap; fall back to <img> for odd JPEGs WebView rejects. */
async function decodeImage(blob: Blob): Promise<DecodedImage | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, tw, th) => ctx.drawImage(bitmap, 0, 0, tw, th),
      close: () => bitmap.close(),
    };
  } catch {
    /* fall through */
  }
  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(blob);
    const img = await loadHtmlImage(objectUrl);
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      draw: (ctx, tw, th) => ctx.drawImage(img, 0, 0, tw, th),
      close: () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      },
    };
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return null;
  }
}

/**
 * Decode + optionally resize a raster image Blob.
 * Returns null when the browser cannot decode (caller may pass through).
 */
export async function resizeImageBlob(
  blob: Blob,
  maxEdge = DEFAULT_MAX_EDGE,
  quality = DEFAULT_JPEG_QUALITY,
): Promise<{ blob: Blob; resized: boolean } | null> {
  const decoded = await decodeImage(blob);
  if (!decoded) return null;
  try {
    const w = decoded.width;
    const h = decoded.height;
    if (!w || !h) return null;
    const long = Math.max(w, h);
    if (long <= maxEdge && blob.size <= DEFAULT_PASS_THROUGH_BYTES) {
      return { blob, resized: false };
    }
    const scale = long > maxEdge ? maxEdge / long : 1;
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    decoded.draw(ctx, tw, th);
    const out = await canvasToJpegBlob(canvas, quality);
    return { blob: out, resized: scale < 1 || out.size < blob.size };
  } finally {
    decoded.close();
  }
}

/**
 * Normalize an incoming File/Blob for vault storage.
 */
export async function prepareImageForImport(
  file: File | Blob,
  fileName?: string,
  opts?: { maxEdge?: number; quality?: number },
): Promise<PreparedImage> {
  const maxEdge = opts?.maxEdge ?? DEFAULT_MAX_EDGE;
  const quality = opts?.quality ?? DEFAULT_JPEG_QUALITY;
  const name =
    fileName ||
    (file instanceof File && file.name ? file.name : "paste.png");
  const mime = file.type || "";

  let working: Blob = file;
  let outName = name;
  let converted = false;

  if (isHeicLike(name, mime)) {
    working = await convertHeicToJpeg(file);
    outName = replaceExt(name, ".jpg");
    converted = true;
  }

  const resized = await resizeImageBlob(working, maxEdge, quality);
  if (resized) {
    const bytes = await blobToUint8(resized.blob);
    const finalName =
      resized.resized || converted
        ? replaceExt(outName, ".jpg")
        : outName;
    return {
      bytes,
      fileName: finalName,
      mime: resized.blob.type || "image/jpeg",
      resized: resized.resized,
      converted,
    };
  }

  // Undecodable (rare) — store original bytes.
  const bytes = await blobToUint8(working);
  return {
    bytes,
    fileName: outName,
    mime: working.type || mime || "application/octet-stream",
    resized: false,
    converted,
  };
}

/** Pure helper for tests — compute target size given max edge. */
export function targetSize(width: number, height: number, maxEdge: number): {
  width: number;
  height: number;
  scale: number;
} {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height, scale: 1 };
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}
