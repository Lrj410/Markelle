import { basename } from "./paths";

function stripMdExt(path: string): string {
  return path.replace(/\.(md|markdown)$/i, "");
}

function normalizeSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Refactors `[[wikilink]]` and `![[embed]]` references in Markdown text
 * when a note's stem (filename without .md) or path changes.
 */
export function refactorWikilinks(
  content: string,
  oldStem: string,
  newStem: string,
  oldRelPath?: string,
  newRelPath?: string,
): string {
  if (!content) return "";
  const oldStemNorm = (oldStem || "").trim();
  const newStemNorm = (newStem || "").trim();
  const oldPathStem = oldRelPath ? stripMdExt(normalizeSlash(oldRelPath)).trim() : "";
  const newPathStem = newRelPath ? stripMdExt(normalizeSlash(newRelPath)).trim() : "";

  const hasPathChange =
    Boolean(oldPathStem && newPathStem && oldPathStem.toLowerCase() !== newPathStem.toLowerCase());
  const hasStemChange =
    Boolean(oldStemNorm && newStemNorm && oldStemNorm.toLowerCase() !== newStemNorm.toLowerCase());

  if (!hasPathChange && !hasStemChange) return content;

  const oldLower = oldStemNorm.toLowerCase();
  const oldPathLower = oldPathStem.toLowerCase();

  // Regex matches:
  // 1: (!?\[\[)
  // 2: target (non-empty, no ']', '#', '|', or newlines)
  // 3: optional #heading
  // 4: optional |alias or |size
  // 5: (\]\])
  const wikiRegex = /(!?\[\[)([^\]#|\r\n]+)(#[^\]|\r\n]*)?(\|[^\]\r\n]*)?(\]\])/g;

  return content.replace(wikiRegex, (match, prefix, target, heading, alias, suffix) => {
    const rawTarget = target as string;
    const trimmed = rawTarget.trim();
    const trimmedNorm = normalizeSlash(trimmed);
    const trimmedLower = trimmedNorm.toLowerCase();

    const leadingSpace = rawTarget.match(/^\s*/)?.[0] || "";
    const trailingSpace = rawTarget.match(/\s*$/)?.[0] || "";

    // 1. Check if target matches path-qualified stem (e.g. [[docs/Guide]] -> [[archive/Guide]])
    if (hasPathChange) {
      if (trimmedLower === oldPathLower) {
        return `${prefix}${leadingSpace}${newPathStem}${trailingSpace}${heading || ""}${alias || ""}${suffix}`;
      }
      if (trimmedLower.endsWith("/" + oldPathLower)) {
        const idx = trimmedLower.lastIndexOf("/" + oldPathLower);
        const prefixDir = trimmed.slice(0, idx + 1);
        return `${prefix}${leadingSpace}${prefixDir}${newPathStem}${trailingSpace}${heading || ""}${alias || ""}${suffix}`;
      }
    }

    // 2. If stem changed, check exact stem or stem with prefix
    if (hasStemChange) {
      const isExact = trimmedLower === oldLower;
      const hasStemPrefix = trimmedLower.endsWith("/" + oldLower);

      if (isExact) {
        return `${prefix}${leadingSpace}${newStemNorm}${trailingSpace}${heading || ""}${alias || ""}${suffix}`;
      }

      if (hasStemPrefix) {
        const idx = trimmed.lastIndexOf("/");
        const dirPart = trimmed.slice(0, idx + 1);
        return `${prefix}${leadingSpace}${dirPart}${newStemNorm}${trailingSpace}${heading || ""}${alias || ""}${suffix}`;
      }
    }

    return match;
  });
}

/**
 * Refactors standard markdown links pointing to markdown files, e.g. `[text](./old.md)`.
 */
export function refactorMarkdownFileLinks(
  content: string,
  oldPathOrName: string,
  newPathOrName: string,
): string {
  if (!content || !oldPathOrName || !newPathOrName) return content;
  const oldNorm = normalizeSlash(oldPathOrName.trim());
  const newNorm = normalizeSlash(newPathOrName.trim());
  if (oldNorm.toLowerCase() === newNorm.toLowerCase()) return content;

  const oldBase = basename(oldNorm);
  const newBase = basename(newNorm);
  const oldBaseDecoded = decodeURIComponent(oldBase).toLowerCase();

  // Match [text](path.md)
  const mdLinkRegex = /(\[[^\]]*\]\()([^)\r\n]+)(\))/g;

  return content.replace(mdLinkRegex, (match, prefix, href, suffix) => {
    // Separate anchor #heading if present
    const hashIdx = href.indexOf("#");
    const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
    const hash = hashIdx >= 0 ? href.slice(hashIdx) : "";

    const decodedRaw = decodeURIComponent(rawPath.trim());
    const decodedNorm = normalizeSlash(decodedRaw);
    const decodedNormLower = decodedNorm.toLowerCase();

    // Check if link matches path suffix (e.g. href="docs/old.md" or "./docs/old.md" matching "docs/old.md")
    if (oldNorm.includes("/")) {
      const oldNormLower = oldNorm.toLowerCase();
      if (decodedNormLower === oldNormLower) {
        return `${prefix}${encodeURI(newNorm)}${hash}${suffix}`;
      }
      if (decodedNormLower.endsWith("/" + oldNormLower)) {
        const idx = decodedNormLower.lastIndexOf("/" + oldNormLower);
        const prefixDir = decodedNorm.slice(0, idx + 1);
        return `${prefix}${prefixDir}${encodeURI(newNorm)}${hash}${suffix}`;
      }
      if (decodedNormLower.startsWith("./") && decodedNormLower.slice(2) === oldNormLower) {
        return `${prefix}./${encodeURI(newNorm)}${hash}${suffix}`;
      }
    }

    // Match by basename if base changed
    const base = basename(decodedNorm);
    if (oldBase.toLowerCase() !== newBase.toLowerCase() && base.toLowerCase() === oldBaseDecoded) {
      const dirIdx = rawPath.lastIndexOf("/");
      const dirPart = dirIdx >= 0 ? rawPath.slice(0, dirIdx + 1) : "";
      const encodedNewName = encodeURI(newBase);
      return `${prefix}${dirPart}${encodedNewName}${hash}${suffix}`;
    }

    return match;
  });
}

/**
 * Refactor both wikilinks and standard markdown file links when a file is renamed or moved.
 */
export function refactorAllLinks(
  content: string,
  oldPathOrName: string,
  newPathOrName: string,
): string {
  const oldBase = basename(oldPathOrName);
  const newBase = basename(newPathOrName);

  const oldStem = stripMdExt(oldBase);
  const newStem = stripMdExt(newBase);

  const oldNorm = normalizeSlash(oldPathOrName);
  const newNorm = normalizeSlash(newPathOrName);

  let result = refactorWikilinks(content, oldStem, newStem, oldNorm, newNorm);
  if (oldBase.match(/\.(md|markdown)$/i) || newBase.match(/\.(md|markdown)$/i)) {
    result = refactorMarkdownFileLinks(result, oldNorm, newNorm);
  }
  return result;
}

