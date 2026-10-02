import { useEffect, useMemo, useState } from "react";
import { listVaultTags, type TagInfo } from "../lib/vault";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

interface Props {
  vaultRoot: string | null;
  onOpenFile: (path: string) => void;
}

function noteLabel(path: string): string {
  return path.split(/[/\\]/).pop()?.replace(/\.md$/i, "") ?? path;
}

/** App must call this from `renderDockPanel` for PanelId `"tags"`. */
export function TagsPanel({ vaultRoot, onOpenFile }: Props) {
  useLocale();
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultRoot) {
      setTags([]);
      setLoading(false);
      setExpanded(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await listVaultTags(vaultRoot);
          if (!cancelled) setTags(result);
        } catch {
          if (!cancelled) setTags([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [vaultRoot]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((item) => item.tag.toLowerCase().includes(q));
  }, [tags, filter]);

  if (!vaultRoot) {
    return (
      <aside className="tags-panel backlinks-panel dock-fill" aria-label={t("panel.tags")}>
        <p className="backlinks-empty">{t("vault.needOpen")}</p>
      </aside>
    );
  }

  return (
    <aside className="tags-panel backlinks-panel dock-fill" aria-label={t("panel.tags")}>
      <div className="tags-filter">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="#"
          aria-label={t("tags.filter")}
        />
      </div>
      {loading && tags.length === 0 && (
        <p className="backlinks-empty quiet">…</p>
      )}
      {!loading && filtered.length === 0 && (
        <p className="backlinks-empty">{t("cmd.empty")}</p>
      )}
      {filtered.length > 0 && (
        <div className="backlinks-head">
          {t("panel.tags")}
          {loading ? "…" : ""}
        </div>
      )}
      {filtered.map((item) => {
        const open = expanded === item.tag;
        return (
          <div key={item.tag} className="tag-group">
            <button
              type="button"
              className="tag-item backlink-item"
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : item.tag)}
            >
              <span className="backlink-name">
                #{item.tag}
                <span className="tag-count">{item.count}</span>
              </span>
            </button>
            {open &&
              item.paths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="tag-note backlink-item"
                  onClick={() => onOpenFile(path)}
                >
                  <span className="backlink-name">{noteLabel(path)}</span>
                  <span className="backlink-preview">{path}</span>
                </button>
              ))}
          </div>
        );
      })}
    </aside>
  );
}
