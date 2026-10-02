import type { VaultNode } from "./vault";

export interface VaultFile {
  path: string;
  name: string;
  stem: string;
  relative: string;
}

function stemOf(name: string): string {
  return name.replace(/\.(md|markdown|mdown|mkd)$/i, "");
}

function normalizeKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export function flattenVaultFiles(root: string, tree: VaultNode): VaultFile[] {
  const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
  const files: VaultFile[] = [];

  const walk = (node: VaultNode) => {
    if (node.kind === "file") {
      const path = node.path;
      const name = node.name;
      const relative = path
        .replace(/\\/g, "/")
        .slice(rootNorm.length)
        .replace(/^\//, "");
      files.push({
        path,
        name,
        stem: stemOf(name),
        relative,
      });
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };

  walk(tree);
  return files;
}

export function resolveWikiTarget(
  target: string,
  files: VaultFile[],
): VaultFile | null {
  const raw = target.trim().replace(/\\/g, "/");
  if (!raw) return null;

  const candidates = [
    raw,
    raw.replace(/\.md$/i, ""),
    `${raw}.md`,
    raw.split("/").pop() ?? raw,
  ];

  const keys = candidates.map(normalizeKey);

  // Exact relative path
  for (const file of files) {
    const rel = normalizeKey(file.relative);
    const relNoExt = normalizeKey(file.relative.replace(/\.(md|markdown|mdown|mkd)$/i, ""));
    const name = normalizeKey(file.name);
    const stem = normalizeKey(file.stem);
    if (
      keys.includes(rel) ||
      keys.includes(relNoExt) ||
      keys.includes(name) ||
      keys.includes(stem)
    ) {
      return file;
    }
  }

  // Unique stem match (basename)
  const stemKey = normalizeKey(raw.split("/").pop() ?? raw).replace(/\.md$/i, "");
  const stemMatches = files.filter((f) => normalizeKey(f.stem) === stemKey);
  if (stemMatches.length === 1) return stemMatches[0]!;

  return null;
}
