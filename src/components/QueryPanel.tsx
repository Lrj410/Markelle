import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { queryVault, type QueryHit } from "../lib/vault";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { EmptyState } from "./ui/EmptyState";

interface Props {
  vaultRoot: string | null;
  onOpenFile: (path: string, line?: number) => void;
}

export function QueryPanel({ vaultRoot, onOpenFile }: Props) {
  useLocale();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<QueryHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ran, setRan] = useState(false);

  // Guards against setState after unmount and against a slower earlier query
  // overwriting a newer one.
  const mountedRef = useRef(true);
  const runIdRef = useRef(0);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const run = async () => {
    if (!vaultRoot) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setError("");
      setRan(false);
      return;
    }
    const myRun = ++runIdRef.current;
    const stale = () => !mountedRef.current || myRun !== runIdRef.current;
    setLoading(true);
    setError("");
    setRan(true);
    try {
      const result = await queryVault(vaultRoot, q);
      if (stale()) return;
      setHits(result);
    } catch (err) {
      if (stale()) return;
      setHits([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!stale()) setLoading(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    }
  };

  if (!vaultRoot) {
    return (
      <aside className="query-panel panel-shell dock-fill" aria-label={t("panel.query")}>
        <EmptyState>{t("vault.needOpen")}</EmptyState>
      </aside>
    );
  }

  return (
    <aside className="query-panel panel-shell dock-fill" aria-label={t("panel.query")}>
      <form className="query-form" onSubmit={onSubmit}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("query.hint")}
          aria-label={t("panel.query")}
        />
        <button type="submit" className="btn primary query-run" disabled={loading}>
          {t("query.run")}
        </button>
      </form>
      <p className="query-hint panel-empty quiet">{t("query.hint")}</p>
      {error && <EmptyState>{error}</EmptyState>}
      {loading && (
        <EmptyState quiet busy>
          {t("common.loading")}
        </EmptyState>
      )}
      {!loading && !error && ran && hits.length === 0 && (
        <EmptyState>{t("query.empty")}</EmptyState>
      )}
      {hits.length > 0 && (
        <div className="panel-list-head">
          {t("panel.query")}
          {loading ? ` · ${t("common.loading")}` : ` · ${hits.length}`}
        </div>
      )}
      {hits.map((hit) => (
        <button
          key={hit.path}
          type="button"
          className="backlink-item"
          onClick={() => onOpenFile(hit.path)}
        >
          <span className="backlink-name">{hit.name}</span>
          <span className="backlink-preview">{hit.path}</span>
        </button>
      ))}
    </aside>
  );
}
