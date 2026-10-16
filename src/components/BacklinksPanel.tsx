import { useEffect, useState } from "react";
import { findBacklinks, type BacklinkHit } from "../lib/vault";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { EmptyState } from "./ui/EmptyState";

interface Props {
  vaultRoot: string | null;
  notePath: string | null;
  onOpenFile: (path: string, line?: number) => void;
}

export function BacklinksPanel({ vaultRoot, notePath, onOpenFile }: Props) {
  useLocale();
  const [hits, setHits] = useState<BacklinkHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [forPath, setForPath] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!vaultRoot || !notePath) {
      setHits([]);
      setForPath(null);
      setLoading(false);
      setError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await findBacklinks(vaultRoot, notePath);
          if (!cancelled) {
            setHits(result);
            setForPath(notePath);
            setError(false);
          }
        } catch {
          if (!cancelled) {
            setHits([]);
            setForPath(notePath);
            setError(true);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [vaultRoot, notePath]);

  if (!vaultRoot || !notePath) {
    return (
      <aside className="backlinks-panel panel-shell dock-fill" aria-label={t("backlinks.label")}>
        <EmptyState>{t("backlinks.needNote")}</EmptyState>
      </aside>
    );
  }

  const stale = forPath !== notePath;
  const noteStem =
    notePath.split(/[/\\]/).pop()?.replace(/\.md$/i, "") ?? "note";

  return (
    <aside className="backlinks-panel panel-shell dock-fill" aria-label={t("backlinks.label")}>
      {loading && stale && (
        <EmptyState quiet busy>
          {t("backlinks.updating")}
        </EmptyState>
      )}
      {error && !loading && <EmptyState>{t("error.fallback")}</EmptyState>}
      {!loading && !error && hits.length === 0 && (
        <EmptyState>{t("backlinks.empty", { stem: noteStem })}</EmptyState>
      )}
      {hits.length > 0 && (
        <div className="panel-list-head backlinks-head">
          {t("backlinks.head")}
          {stale ? ` · ${t("common.loading")}` : ""}
        </div>
      )}
      {hits.map((hit) => (
        <button
          key={`${hit.path}:${hit.line}`}
          type="button"
          className="backlink-item"
          onClick={() => onOpenFile(hit.path, hit.line > 0 ? hit.line : undefined)}
        >
          <span className="backlink-name">
            {hit.name}
            {hit.line > 0 ? `:${hit.line}` : ""}
          </span>
          <span className="backlink-preview">{hit.preview}</span>
        </button>
      ))}
    </aside>
  );
}
