import type { ReactNode } from "react";
import clsx from "clsx";
import type { ActivityId, PanelId } from "../lib/dock";
import { isPanelVisible, type DockLayout } from "../lib/dock";
import type { ColorScheme } from "../lib/types";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

interface Props {
  dock: DockLayout;
  graphOpen: boolean;
  vaultOpen: boolean;
  hasFile?: boolean;
  pluginsOpen: boolean;
  scheme: ColorScheme;
  dark: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onTogglePanel: (id: PanelId) => void;
  onGraph: () => void;
  onPlugins: () => void;
  onAbout: () => void;
  onSettings: () => void;
  settingsOpen?: boolean;
  onToggleTheme: () => void;
}

/** 18×18 optical icons — consistent 1.5 stroke, rounded terminals */
const ICONS: Record<ActivityId | "theme-sun" | "theme-moon" | "about", ReactNode> = {
  vault: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="3" y="4" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 7.5h6M6 10.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  toc: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M4 5.5h10M4 9h10M4 12.5h7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  backlinks: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="5" cy="9" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="13" cy="5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="13" cy="13" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6.8 8.1 11.2 5.9M6.8 9.9l4.4 2.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  tags: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M7 3.5 5.5 14.5M12.5 3.5 11 14.5M3.5 7h11M3 11h11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  query: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="m11.2 11.2 3.3 3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  history: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9 5.5V9l2.5 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  calendar: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="3" y="4" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 7.5h12M6 2.5v3M12 2.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  ai: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M9 2.2l1.4 3 3 1.4-3 1.4L9 11 7.6 8 4.6 6.6l3-1.4L9 2.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M13.5 11.2l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4ZM4.5 11.8l.5 1.1 1.1.5-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.5.5-1.1Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  ),
  plugins: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M7.5 3h3v2.4l1.8-1 1.2 2-1.8 1.1.7 2.2H15v3h-2.6l-.7 2.2 1.8 1.1-1.2 2-1.8-1V15h-3v-2.4l-1.8 1-1.2-2 1.8-1.1L5.5 9.7H3v-3h2.6l.7-2.2-1.8-1.1 1.2-2 1.8 1V3Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="9" r="1.35" fill="currentColor" />
    </svg>
  ),
  graph: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="5" cy="9" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="4.5" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="13.5" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10.5" cy="13.5" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6.5 8 7.8 5.8M10.5 5.5l1.7 1.4M12.1 9.4 11.3 12M9.2 12.4 6.5 10.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M7.4 2.8h3.2l.55 1.7 1.65-.55 2.25 2.25-.55 1.65 1.7.55v3.2l-1.7.55.55 1.65-2.25 2.25-1.65-.55-.55 1.7H7.4l-.55-1.7-1.65.55L2.95 13.2l.55-1.65L1.8 11V7.8l1.7-.55-.55-1.65L5.2 3.35l1.65.55.55-1.7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="9" r="2.1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  about: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 8.1v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="9" cy="5.9" r="0.95" fill="currentColor" />
    </svg>
  ),
  "theme-sun": (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9 2.2v1.6M9 14.2v1.6M2.2 9h1.6M14.2 9h1.6M4.1 4.1l1.1 1.1M12.8 12.8l1.1 1.1M13.9 4.1l-1.1 1.1M5.2 12.8l-1.1 1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  "theme-moon": (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M11.4 3.2A6.2 6.2 0 1 0 14.8 11a5.1 5.1 0 0 1-3.4-7.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

export function ActivityBar({
  dock,
  graphOpen,
  vaultOpen,
  hasFile: _hasFile = false,
  pluginsOpen,
  scheme,
  dark,
  expanded = true,
  onToggleExpanded,
  onTogglePanel,
  onGraph,
  onPlugins,
  onAbout,
  onSettings,
  settingsOpen = false,
  onToggleTheme,
}: Props) {
  useLocale();
  const themeLabel = t("panel.theme");

  const item = (
    id: PanelId,
    label: string,
    disabled?: boolean,
    titleExtra?: string,
  ) => (
    <button
      key={id}
      type="button"
      className={clsx("activity-btn", { active: isPanelVisible(dock, id) })}
      aria-label={label}
      aria-pressed={isPanelVisible(dock, id)}
      title={titleExtra ?? label}
      disabled={disabled}
      onClick={() => onTogglePanel(id)}
    >
      <span className="activity-btn-icon" aria-hidden="true">
        {ICONS[id]}
      </span>
      {expanded ? <span className="activity-btn-label">{label}</span> : null}
    </button>
  );

  const action = (
    key: string,
    label: string,
    icon: ReactNode,
    opts: {
      active?: boolean;
      disabled?: boolean;
      title?: string;
      onClick: () => void;
    },
  ) => (
    <button
      key={key}
      type="button"
      className={clsx("activity-btn", { active: opts.active })}
      aria-label={label}
      aria-pressed={opts.active !== undefined ? opts.active : undefined}
      title={opts.title ?? label}
      disabled={opts.disabled}
      onClick={opts.onClick}
    >
      <span className="activity-btn-icon" aria-hidden="true">
        {icon}
      </span>
      {expanded ? <span className="activity-btn-label">{label}</span> : null}
    </button>
  );

  return (
    <nav
      className={clsx("activity-bar", { expanded })}
      aria-label={t("panel.activity")}
    >
      <div className="activity-group">
        {item("vault", t("panel.vault"), false, `${t("panel.vault")} Ctrl+B`)}
        {item("ai", t("panel.ai"), false, `${t("panel.ai")} Alt+A`)}
        {item("toc", t("panel.toc"))}
        {item("backlinks", t("panel.backlinks"))}
        {item("tags", t("panel.tags"))}
        {item("query", t("panel.query"))}
        {item("history", t("panel.history"))}
        {item("calendar", t("panel.calendar"))}
        {action("graph", t("panel.graph"), ICONS.graph, {
          active: graphOpen,
          disabled: !vaultOpen,
          title: vaultOpen ? `${t("panel.graph")} Ctrl+G` : t("vault.needOpen"),
          onClick: onGraph,
        })}
        {action("plugins", t("panel.plugins"), ICONS.plugins, {
          active: pluginsOpen,
          title: `${t("panel.plugins")} Ctrl+,`,
          onClick: onPlugins,
        })}
      </div>
      <div className="activity-group activity-group-bottom">
        {onToggleExpanded ? (
          <button
            type="button"
            className="activity-btn activity-expand-toggle"
            aria-label={expanded ? t("panel.collapseRail") : t("panel.expandRail")}
            title={expanded ? t("panel.collapseRail") : t("panel.expandRail")}
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            <span className="activity-btn-icon" aria-hidden>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                {expanded ? (
                  <path
                    d="M11 4.5 6.5 9 11 13.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : (
                  <path
                    d="M7 4.5 11.5 9 7 13.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </svg>
            </span>
            {expanded ? (
              <span className="activity-btn-label">{t("panel.collapseRail")}</span>
            ) : null}
          </button>
        ) : null}
        {action("settings", t("panel.settings"), ICONS.settings, {
          active: settingsOpen,
          onClick: onSettings,
        })}
        {action(
          "theme",
          themeLabel,
          dark ? ICONS["theme-sun"] : ICONS["theme-moon"],
          {
            title: scheme === "system" ? `${themeLabel} (system)` : themeLabel,
            onClick: onToggleTheme,
          },
        )}
        {action("about", t("panel.about"), ICONS.about, {
          title: `${t("panel.about")} Markelle`,
          onClick: onAbout,
        })}
      </div>
    </nav>
  );
}
