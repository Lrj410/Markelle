import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractTags,
  parseFrontmatter,
  replaceFrontmatter,
  type FrontmatterValue,
} from "../lib/frontmatter";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

interface Props {
  /** Stable id for the open doc — remounts inputs when switching tabs. */
  docKey: string;
  source: string;
  /** When set, chips become editable and changes write back into the document. */
  onSourceChange?: (next: string) => void;
}

function formatValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function tagsDraftFromData(data: Record<string, FrontmatterValue>): string {
  const fmTags = data.tags;
  if (Array.isArray(fmTags)) return fmTags.join(", ");
  if (typeof fmTags === "string") return fmTags;
  return "";
}

/** Free-text draft of every non-tag frontmatter field (controlled inputs). */
function fieldsDraftFromData(data: Record<string, FrontmatterValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "tags") continue;
    out[key] = formatValue(value);
  }
  return out;
}

function parseEditedValue(raw: string, previous: FrontmatterValue): FrontmatterValue {
  const trimmed = raw.trim();
  if (Array.isArray(previous) || trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof previous === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  if (typeof previous === "number" && trimmed !== "" && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  return trimmed;
}

export function PropertiesStrip({ docKey, source, onSourceChange }: Props) {
  useLocale();
  const parsed = useMemo(() => parseFrontmatter(source), [source]);
  const tags = useMemo(() => extractTags(source), [source]);
  const editable = Boolean(onSourceChange);
  const [draftTags, setDraftTags] = useState(() => tagsDraftFromData(parsed.data));
  const [draftFields, setDraftFields] = useState(() => fieldsDraftFromData(parsed.data));
  /** Ignore blur commits that race a tab switch (stale input → wrong note). */
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;

  useEffect(() => {
    setDraftTags(tagsDraftFromData(parsed.data));
    setDraftFields(fieldsDraftFromData(parsed.data));
  }, [docKey, source, parsed.data]);

  const entries = Object.entries(parsed.data).filter(([k]) => k !== "tags");
  if (!editable && entries.length === 0 && tags.length === 0) return null;

  const commitField = (key: string, raw: string, previous: FrontmatterValue, atDoc: string) => {
    if (!onSourceChange) return;
    if (atDoc !== docKeyRef.current) return;
    const current = sourceRef.current;
    const nextData: Record<string, FrontmatterValue> = { ...parseFrontmatter(current).data };
    const nextVal = parseEditedValue(raw, previous);
    const prevStr = formatValue(previous);
    if (formatValue(nextVal) === prevStr) return;
    if (nextVal === "" || (Array.isArray(nextVal) && nextVal.length === 0)) {
      delete nextData[key];
    } else {
      nextData[key] = nextVal;
    }
    onSourceChange(replaceFrontmatter(current, nextData));
  };

  const commitTags = (raw: string, atDoc: string) => {
    if (!onSourceChange) return;
    if (atDoc !== docKeyRef.current) return;
    const current = sourceRef.current;
    const nextData: Record<string, FrontmatterValue> = { ...parseFrontmatter(current).data };
    const list = raw
      .split(",")
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean);
    const prev = tagsDraftFromData(nextData);
    if (list.join(", ") === prev) return;
    if (list.length === 0) delete nextData.tags;
    else nextData.tags = list;
    onSourceChange(replaceFrontmatter(current, nextData));
  };

  const emptyEditable = editable && entries.length === 0 && !draftTags;

  return (
    <div
      className={`props-strip${editable ? " props-strip-editable" : ""}`}
      role="group"
      aria-label={t("props.label")}
    >
      <span className="props-strip-label" aria-hidden>
        {t("props.kicker")}
      </span>
      <div className="props-strip-fields">
        {entries.map(([key, value]) =>
          editable ? (
            <label key={`${docKey}:${key}`} className="props-chip props-chip-edit">
              <em>{key}</em>
              <input
                type="text"
                className="props-chip-input"
                key={`${docKey}:${key}:input`}
                value={draftFields[key] ?? formatValue(value)}
                spellCheck={false}
                onChange={(e) => setDraftFields((d) => ({ ...d, [key]: e.target.value }))}
                onBlur={(e) => commitField(key, e.target.value, value, docKey)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            </label>
          ) : (
            <span key={`${docKey}:${key}`} className="props-chip">
              <em>{key}</em>
              <span className="props-chip-value">{formatValue(value)}</span>
            </span>
          ),
        )}
        {editable ? (
          <label className="props-chip props-chip-edit props-tag-edit">
            <em>tags</em>
            <input
              type="text"
              className="props-chip-input"
              value={draftTags}
              placeholder={
                emptyEditable ? t("props.tagsPlaceholderEmpty") : t("props.tagsPlaceholder")
              }
              spellCheck={false}
              onChange={(e) => setDraftTags(e.target.value)}
              onBlur={(e) => commitTags(e.target.value, docKey)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </label>
        ) : (
          tags.slice(0, 8).map((tag) => (
            <span key={`${docKey}:tag:${tag}`} className="props-tag">
              #{tag}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
