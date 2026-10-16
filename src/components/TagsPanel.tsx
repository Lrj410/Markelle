import { useEffect, useMemo, useState } from "react";
import { listVaultTags, type TagInfo } from "../lib/vault";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { EmptyState } from "./ui/EmptyState";

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
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultRoot) {
      setTags([]);
      setLoading(false);
      setError("");
      setExpanded(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await listVaultTags(vaultRoot);
          if (!cancelled) setTags(result);
        } catch (err) {
          if (!cancelled) {
            setTags([]);
            setError(err instanceof Error ? err.message : String(err));
          }
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
      <aside className="tags-panel panel-shell dock-fill" aria-label={t("panel.tags")}>
        <EmptyState>{t("vault.needOpen")}</EmptyState>
      </aside>
    );
  }

  return (
    <aside className="tags-panel panel-shell dock-fill" aria-label={t("panel.tags")}>
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
        <EmptyState quiet busy>
          {t("common.loading")}
        </EmptyState>
      )}
      {error && <EmptyState>{error}</EmptyState>}
      {!loading && !error && filtered.length === 0 && (
        <EmptyState>{t("tags.empty")}</EmptyState>
      )}
      {filtered.length > 0 && (
        <div className="panel-list-head">
          {t("panel.tags")}
          {loading ? ` · ${t("common.loading")}` : ""}
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
