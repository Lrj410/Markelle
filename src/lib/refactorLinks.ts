import { basename } from "./paths";

/**
 * Refactors `[[wikilink]]` and `![[embed]]` references in Markdown text
 * when a note's stem (filename without .md) changes.
 */
export function refactorWikilinks(
  content: string,
  oldStem: string,
  newStem: string,
): string {
  if (!oldStem || !newStem || oldStem === newStem) return content;

  const oldLower = oldStem.toLowerCase();
  // Regex matches:
  // 1: (!?\[\[)
  // 2: target (non-empty, no ']', '#', '|', or newlines)
  // 3: optional #heading
  // 4: optional |alias or |size
  // 5: (\]\])
  const wikiRegex = /(!?\[\[)([^\]#|\r\n]+)(#[^\]|\r\n]*)?(\|[^\]\r\n]*)?(\]\])/g;

  return content.replace(wikiRegex, (match, prefix, target, heading, alias, suffix) => {
    const trimmed = (target as string).trim();
    const trimmedLower = trimmed.toLowerCase();

    const isExact = trimmedLower === oldLower;
    const hasPathPrefix = trimmedLower.endsWith("/" + oldLower);

    if (isExact) {
      const leadingSpace = target.match(/^\s*/)?.[0] || "";
      const trailingSpace = target.match(/\s*$/)?.[0] || "";
      return `${prefix}${leadingSpace}${newStem}${trailingSpace}${heading || ""}${alias || ""}${suffix}`;
    }

    if (hasPathPrefix) {
      const idx = trimmed.lastIndexOf("/");
      const dirPart = trimmed.slice(0, idx + 1);
      const leadingSpace = target.match(/^\s*/)?.[0] || "";
      const trailingSpace = target.match(/\s*$/)?.[0] || "";
      return `${prefix}${leadingSpace}${dirPart}${newStem}${trailingSpace}${heading || ""}${alias || ""}${suffix}`;
    }

    return match;
  });
}

/**
 * Refactors standard markdown links pointing to markdown files, e.g. `[text](./old.md)`.
 */
export function refactorMarkdownFileLinks(
  content: string,
  oldFileName: string,
  newFileName: string,
): string {
  if (!oldFileName || !newFileName || oldFileName === newFileName) return content;

  const oldDecoded = decodeURIComponent(oldFileName).toLowerCase();
  // Match [text](path.md)
  const mdLinkRegex = /(\[[^\]]*\]\()([^)\r\n]+)(\))/g;

  return content.replace(mdLinkRegex, (match, prefix, href, suffix) => {
    // Separate anchor #heading if present
    const hashIdx = href.indexOf("#");
    const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
    const hash = hashIdx >= 0 ? href.slice(hashIdx) : "";

    const decodedPath = decodeURIComponent(rawPath.trim());
    const base = basename(decodedPath);

    if (base.toLowerCase() === oldDecoded) {
      const dirIdx = rawPath.lastIndexOf("/");
      const dirPart = dirIdx >= 0 ? rawPath.slice(0, dirIdx + 1) : "";
      const encodedNewName = encodeURI(newFileName);
      return `${prefix}${dirPart}${encodedNewName}${hash}${suffix}`;
    }

    return match;
  });
}

/**
 * Refactor both wikilinks and standard markdown file links when a file is renamed.
 */
export function refactorAllLinks(
  content: string,
  oldPathOrName: string,
  newPathOrName: string,
): string {
  const oldBase = basename(oldPathOrName);
  const newBase = basename(newPathOrName);

  const oldStem = oldBase.replace(/\.(md|markdown)$/i, "");
  const newStem = newBase.replace(/\.(md|markdown)$/i, "");

  let result = refactorWikilinks(content, oldStem, newStem);
  if (oldBase.match(/\.(md|markdown)$/i) && newBase.match(/\.(md|markdown)$/i)) {
    result = refactorMarkdownFileLinks(result, oldBase, newBase);
  }
  return result;
}
