import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { RecentEntry } from "../lib/types";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

interface Props {
  recent: RecentEntry[];
  recentVaults?: string[];
  previewCount?: number;
  onOpen: () => void;
  onOpenVault: () => void;
  onOpenPath: (path: string) => void;
  onOpenVaultPath?: (path: string) => void;
  onClearRecent: () => void;
  onNewNote?: () => void;
  onOpenCmdk?: () => void;
}

function shortenPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  const drive = /^[A-Za-z]:/.test(parts[0] ?? "") ? parts[0] : null;
  const tail = parts.slice(-2).join("/");
  if (drive) return `${drive}/…/${tail}`;
  return `…/${tail}`;
}

export function Welcome({
  recent,
  recentVaults = [],
  previewCount = 10,
  onOpen,
  onOpenVault,
  onOpenPath,
  onOpenVaultPath,
  onClearRecent,
  onNewNote,
  onOpenCmdk,
}: Props) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const [version, setVersion] = useState("0.1.0");

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  const hasRecent = recent.length > 0;
  const limit = Math.max(4, previewCount);
  const visible =
    expanded || recent.length <= limit ? recent : recent.slice(0, limit);
  const hiddenCount = Math.max(0, recent.length - limit);

  return (
    <div className={hasRecent ? "welcome has-recent" : "welcome"}>
      <div className="welcome-inner">
        {/* Hero Section */}
        <header className="welcome-hero">
          <div className="welcome-brand-container">
            <div className="welcome-logo-box">
              <img
                className="welcome-logo"
                src="/markelle.svg"
                alt="Markelle"
                width={48}
                height={48}
              />
            </div>
            <div className="welcome-brand-text">
              <div className="welcome-brand-row">
                <span className="welcome-title">Markelle</span>
                <span className="welcome-version-pill">v{version}</span>
              </div>
              <p className="welcome-subtitle">{t("welcome.subtitle")}</p>
            </div>
          </div>
        </header>

        {/* Quick Action Grid */}
        <section className="welcome-quick-actions" aria-label={t("welcome.quickActions")}>
          <div className="welcome-action-grid">
            <button
              type="button"
              className="welcome-card-btn"
              onClick={onOpen}
              title={t("welcome.openFile")}
            >
              <div className="welcome-card-icon welcome-icon-file">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </div>
              <div className="welcome-card-info">
                <span className="welcome-card-title">{t("welcome.openFile")}</span>
                <span className="welcome-card-hint">{t("welcome.openFileHint")}</span>
              </div>
              <kbd className="welcome-card-kbd">Ctrl+O</kbd>
            </button>

            <button
              type="button"
              className="welcome-card-btn"
              onClick={onOpenVault}
              title={t("welcome.openVault")}
            >
              <div className="welcome-card-icon welcome-icon-vault">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                </svg>
              </div>
              <div className="welcome-card-info">
                <span className="welcome-card-title">{t("welcome.openVault")}</span>
                <span className="welcome-card-hint">{t("welcome.openVaultHint")}</span>
              </div>
              <kbd className="welcome-card-kbd">Ctrl+Shift+O</kbd>
            </button>

            {onNewNote && (
              <button
                type="button"
                className="welcome-card-btn"
                onClick={onNewNote}
                title={t("welcome.newNote")}
              >
                <div className="welcome-card-icon welcome-icon-new">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </div>
                <div className="welcome-card-info">
                  <span className="welcome-card-title">{t("welcome.newNote")}</span>
                  <span className="welcome-card-hint">{t("welcome.newNoteHint")}</span>
                </div>
                <kbd className="welcome-card-kbd">Ctrl+N</kbd>
              </button>
            )}

            {onOpenCmdk && (
              <button
                type="button"
                className="welcome-card-btn"
                onClick={onOpenCmdk}
                title={t("welcome.commandPalette")}
              >
                <div className="welcome-card-icon welcome-icon-cmd">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <div className="welcome-card-info">
                  <span className="welcome-card-title">{t("welcome.commandPalette")}</span>
                  <span className="welcome-card-hint">{t("welcome.cmdHint")}</span>
                </div>
                <kbd className="welcome-card-kbd">Ctrl+K</kbd>
              </button>
            )}
          </div>
        </section>

        {/* Recent Vaults Section */}
        {recentVaults.length > 0 && onOpenVaultPath && (
          <section className="recent recent-vaults">
            <div className="recent-head">
              <h2>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                </svg>
                {t("welcome.recentVaults")}
                <span className="recent-count">{recentVaults.length}</span>
              </h2>
            </div>
            <ul className="recent-list">
              {recentVaults.slice(0, 8).map((path) => (
                <li key={path}>
                  <button type="button" onClick={() => onOpenVaultPath(path)} title={path}>
                    <div className="recent-item-row">
                      <span className="recent-item-icon">📁</span>
                      <span className="recent-name">{path.split(/[/\\]/).pop() ?? path}</span>
                    </div>
                    <span className="recent-path">{shortenPath(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Recent Files Section */}
        {hasRecent && (
          <section className="recent recent-files">
            <div className="recent-head">
              <h2>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                {t("welcome.recentFiles")}
                <span className="recent-count">{recent.length}</span>
              </h2>
              <button type="button" className="btn ghost recent-clear-btn" onClick={onClearRecent}>
                {t("welcome.clearRecent")}
              </button>
            </div>
            <ul className="recent-list">
              {visible.map((item) => (
                <li key={item.path}>
                  <button
                    type="button"
                    onClick={() => onOpenPath(item.path)}
                    title={item.path}
                  >
                    <div className="recent-item-row">
                      <span className="recent-item-icon">📄</span>
                      <span className="recent-name">{item.name}</span>
                    </div>
                    <span className="recent-path">{shortenPath(item.path)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <button
                type="button"
                className="btn ghost recent-more"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? t("welcome.collapse") : t("welcome.showMore", { count: hiddenCount })}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
