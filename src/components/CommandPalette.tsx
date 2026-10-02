import { useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { searchVault, type SearchHit } from "../lib/vault";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  disabled?: boolean;
  run: () => void;
}

interface Props {
  open: boolean;
  commands: CommandItem[];
  onClose: () => void;
  /** When set, queries also search vault file contents. */
  vaultRoot?: string | null;
  onOpenSearchHit?: (path: string, line: number) => void;
}

export function CommandPalette({
  open,
  commands,
  onClose,
  vaultRoot,
  onOpenSearchHit,
}: Props) {
  useLocale();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = commands.filter((c) => !c.disabled);
    if (!q) return list;
    return list.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.hint?.toLowerCase().includes(q) ||
        c.group?.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const searchItems: CommandItem[] = useMemo(() => {
    if (!onOpenSearchHit) return [];
    return hits.map((hit) => ({
      id: `search:${hit.path}:${hit.line}`,
      label: hit.name,
      hint: `L${hit.line} · ${hit.preview}`,
      group: t("cmd.groupSearch"),
      run: () => onOpenSearchHit(hit.path, hit.line),
    }));
  }, [hits, onOpenSearchHit]);

  const combined = useMemo(() => {
    const q = query.trim();
    if (!q) return filtered;
    return [...filtered.slice(0, 40), ...searchItems];
  }, [filtered, searchItems, query]);

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    onEscape: onClose,
    initialFocusSelector: ".cmdk-input",
  });

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setHits([]);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query, combined.length]);

  useEffect(() => {
    if (!open || !vaultRoot || !onOpenSearchHit) {
      setHits([]);
      return;
    }
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchVault(vaultRoot, q)
        .then((result) => {
          if (!cancelled) setHits(result.slice(0, 24));
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, vaultRoot, onOpenSearchHit]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, Math.max(combined.length - 1, 0)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = combined[index];
        if (item) {
          onClose();
          item.run();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, combined, index, onClose]);

  if (!open) return null;

  return (
    <div className="cmdk-overlay" role="dialog" aria-modal="true" aria-label={t("cmd.label")}>
      <button
        type="button"
        className="cmdk-backdrop"
        onClick={onClose}
        aria-label={t("common.close")}
      />
      <div className="cmdk-panel" ref={panelRef}>
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("cmd.placeholder")}
          aria-label={t("cmd.searchAria")}
          role="combobox"
          aria-expanded={true}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            combined.length > 0 ? `${listId}-opt-${index}` : undefined
          }
        />
        <ul id={listId} className="cmdk-list" role="listbox">
          {combined.length === 0 && (
            <li className="cmdk-empty">{searching ? t("cmd.searching") : t("cmd.empty")}</li>
          )}
          {combined.map((item, i) => (
            <li key={item.id}>
              <button
                id={`${listId}-opt-${i}`}
                type="button"
                role="option"
                aria-selected={i === index}
                className={clsx("cmdk-item", { active: i === index })}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  onClose();
                  item.run();
                }}
              >
                <span className="cmdk-label">
                  {item.group ? <em>{item.group}</em> : null}
                  {item.label}
                </span>
                {item.hint ? <kbd>{item.hint}</kbd> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="cmdk-foot">
          <span>{t("cmd.footNav")}</span>
          <span>{t("cmd.footEnter")}</span>
          <span>{t("cmd.footEsc")}</span>
          {vaultRoot ? <span>{t("cmd.footContent")}</span> : null}
        </div>
      </div>
    </div>
  );
}
