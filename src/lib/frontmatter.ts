export type FrontmatterValue = string | boolean | number | string[];

export interface FrontmatterResult {
  data: Record<string, FrontmatterValue>;
  body: string;
}

/** Minimal YAML frontmatter parser (scalars + string / block arrays). */
export function parseFrontmatter(source: string): FrontmatterResult {
  const text = source.replace(/^\uFEFF/, "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { data: {}, body: source };
  }
  // Closing fence must be a line consisting solely of `---` (trailing blanks ok);
  // a body divider like `----` or `--- text` must not end the frontmatter.
  const endRe = /\n---[ \t]*(?=\r?\n|$)/g;
  endRe.lastIndex = 3;
  const endMatch = endRe.exec(text);
  if (!endMatch) return { data: {}, body: source };
  const end = endMatch.index;
  const block = text.slice(4, end).replace(/^\r?\n/, "");
  const after = text.slice(end + endMatch[0].length).replace(/^\r?\n/, "");
  const data: Record<string, FrontmatterValue> = {};

  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Block list continuation: `  - item` under a previous key.
    if (line.startsWith("- ")) {
      continue;
    }

    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;

    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      data[key] = value.slice(1, -1);
      continue;
    }
    if (value === "true" || value === "false") {
      data[key] = value === "true";
      continue;
    }
    if (value !== "" && !Number.isNaN(Number(value))) {
      data[key] = Number(value);
      continue;
    }

    // Empty value → look ahead for block sequence (`- item`).
    if (value === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = (lines[j] ?? "").trim();
        if (!next) {
          j += 1;
          continue;
        }
        if (!next.startsWith("- ")) break;
        items.push(next.slice(2).trim().replace(/^["']|["']$/g, ""));
        j += 1;
      }
      if (items.length > 0) {
        data[key] = items;
        i = j - 1;
        continue;
      }
      data[key] = "";
      continue;
    }

    data[key] = value;
  }

  return { data, body: after };
}

const TAG_RE = /(?:^|[\s([{（【])#([\p{L}\p{N}_/-]+)/gu;

export function extractTags(source: string): string[] {
  const { data, body } = parseFrontmatter(source);
  const tags = new Set<string>();
  const fmTags = data.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) tags.add(String(t));
  } else if (typeof fmTags === "string" && fmTags) {
    tags.add(fmTags);
  }
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(body))) {
    const t = m[1];
    if (t) tags.add(t);
  }
  return [...tags];
}

function formatYamlScalar(value: string): string {
  if (value === "") return '""';
  if (/[:#{}|>*&!%@`'"]/.test(value) || /[[\]]/.test(value) || /^\s|\s$/.test(value) || value.includes("\n")) {
    return JSON.stringify(value);
  }
  return value;
}

/** Serialize a flat frontmatter map to a `---\\n...\\n---` block (no trailing body). */
export function serializeFrontmatter(data: Record<string, FrontmatterValue>): string {
  const keys = Object.keys(data);
  if (keys.length === 0) return "";
  const lines: string[] = [];
  for (const key of keys) {
    const value = data[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => formatYamlScalar(String(v))).join(", ")}]`);
    } else if (typeof value === "boolean" || typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${formatYamlScalar(value)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---`;
}

/** Replace (or insert) YAML frontmatter; preserves body from `parseFrontmatter`. */
export function replaceFrontmatter(
  source: string,
  data: Record<string, FrontmatterValue>,
): string {
  const { body } = parseFrontmatter(source);
  const block = serializeFrontmatter(data);
  if (!block) return body;
  const bodyPart = body.replace(/^\r?\n/, "");
  return bodyPart ? `${block}\n${bodyPart}` : `${block}\n`;
}
