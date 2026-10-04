import { useState, type FormEvent, type KeyboardEvent } from "react";
import { queryVault, type QueryHit } from "../lib/vault";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

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

  const run = async () => {
    if (!vaultRoot) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setError("");
      setRan(false);
      return;
    }
    setLoading(true);
    setError("");
    setRan(true);
    try {
      setHits(await queryVault(vaultRoot, q));
    } catch (err) {
      setHits([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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
      <aside className="query-panel backlinks-panel dock-fill" aria-label={t("panel.query")}>
        <p className="backlinks-empty">{t("vault.needOpen")}</p>
      </aside>
    );
  }

  return (
    <aside className="query-panel backlinks-panel dock-fill" aria-label={t("panel.query")}>
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
      <p className="query-hint backlinks-empty quiet">{t("query.hint")}</p>
      {error && <p className="backlinks-empty">{error}</p>}
      {loading && <p className="backlinks-empty quiet">…</p>}
      {!loading && !error && ran && hits.length === 0 && (
        <p className="backlinks-empty">{t("cmd.empty")}</p>
      )}
      {hits.length > 0 && (
        <div className="backlinks-head">
          {t("panel.query")}
          {loading ? "…" : ` · ${hits.length}`}
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
