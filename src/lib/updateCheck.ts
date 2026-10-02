/** Check GitHub Releases for a newer version (best-effort, no auto-download). */

export interface UpdateInfo {
  latest: string;
  current: string;
  url: string;
  newer: boolean;
}

function parseSemver(v: string): number[] {
  return v
    .replace(/^v/i, "")
    .split(".")
    .map((p) => Number.parseInt(p.replace(/[^\d].*$/, ""), 10) || 0);
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

const DEFAULT_REPO = "Lrj410/Markelle";

export async function checkForUpdates(
  current: string,
  repo = DEFAULT_REPO,
  signal?: AbortSignal,
): Promise<UpdateInfo> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!res.ok) throw new Error(`更新检查失败 (${res.status})`);
  const data = (await res.json()) as { tag_name?: string; html_url?: string };
  const latest = (data.tag_name ?? "").replace(/^v/i, "");
  if (!latest) throw new Error("未找到最新版本");
  return {
    latest,
    current: current.replace(/^v/i, ""),
    url: data.html_url ?? `https://github.com/${repo}/releases`,
    newer: isNewerVersion(latest, current),
  };
}
