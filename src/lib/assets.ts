/**
 * ACL-gated media URL. Served by the Rust `mklasset` protocol which calls
 * `ensure_allowed` on every request — closing a vault immediately stops loads.
 */
export function toGatedAssetUrl(absolutePath: string): string {
  // Decode at most once so `%20` never becomes `%2520` — repeated decoding would
  // corrupt real filenames that legitimately contain `%2F` / `%25`.
  const normalized = decodeOnce(absolutePath.replace(/\\/g, "/"));
  const encoded = encodeURIComponent(normalized);
  return `mklasset://localhost/${encoded}`;
}

function decodeOnce(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function isGatedAssetUrl(href: string): boolean {
  return href.startsWith("mklasset:") || href.includes("mklasset.localhost");
}
