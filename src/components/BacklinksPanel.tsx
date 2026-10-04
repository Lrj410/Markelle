import { useEffect, useState } from "react";
import { findBacklinks, type BacklinkHit } from "../lib/vault";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

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
      <aside className="backlinks-panel dock-fill" aria-label={t("backlinks.label")}>
        <p className="backlinks-empty">{t("backlinks.needNote")}</p>
      </aside>
    );
  }

  const stale = forPath !== notePath;
  const noteStem =
    notePath.split(/[/\\]/).pop()?.replace(/\.md$/i, "") ?? "note";

  return (
    <aside className="backlinks-panel dock-fill" aria-label={t("backlinks.label")}>
      {loading && stale && <p className="backlinks-empty quiet">{t("backlinks.updating")}</p>}
      {error && !loading && (
        <p className="backlinks-empty">{t("error.fallback")}</p>
      )}
      {!loading && !error && hits.length === 0 && (
        <p className="backlinks-empty">{t("backlinks.empty", { stem: noteStem })}</p>
      )}
      {hits.length > 0 && (
        <div className="backlinks-head">
          {t("backlinks.head")}
          {stale ? "…" : ""}
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
