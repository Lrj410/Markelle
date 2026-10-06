import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { getUserPluginsDir } from "../lib/plugins/host";
import type { PluginInfo, PluginSettingsStore } from "../lib/plugins/types";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

interface Props {
  open: boolean;
  plugins: PluginInfo[];
  enabledIds: string[];
  onClose: () => void;
  onToggle: (pluginId: string, enabled: boolean) => void;
  onRunCommand: (commandId: string) => void;
  pluginSettings?: PluginSettingsStore;
  onPluginSetting?: (pluginId: string, key: string, value: unknown) => void;
}

export function PluginPanelBody({
  plugins,
  enabledIds,
  onToggle,
  onRunCommand,
  pluginSettings = {},
  onPluginSetting,
}: Omit<Props, "open" | "onClose">) {
  useLocale();
  const [dir, setDir] = useState("");

  useEffect(() => {
    void getUserPluginsDir().then(setDir).catch(() => setDir(""));
  }, []);

  const enabled = new Set(enabledIds);

  return (
    <div className="plugin-panel-body">
      <p className="plugin-help">{t("plugins.help")}</p>

      {dir && (
        <button
          type="button"
          className="btn ghost plugin-dir-btn"
          onClick={() => void revealItemInDir(dir)}
        >
          {t("plugins.openDir")}
        </button>
      )}

      <ul className="plugin-list">
        {plugins.map((plugin) => {
          const isOn = enabled.has(plugin.id);
          const settings = plugin.contributes.settings ?? [];
          return (
            <li key={plugin.id} className={clsx("plugin-card", { on: isOn })}>
              <div className="plugin-card-main">
                <div className="plugin-card-title">
                  <strong>{plugin.name}</strong>
                  <span className="plugin-badge">{plugin.source}</span>
                </div>
                <p>{plugin.description || t("plugins.noDesc")}</p>
                <div className="plugin-meta">
                  v{plugin.version}
                  {plugin.author ? ` · ${plugin.author}` : ""}
                </div>
                {plugin.contributes.commands.length > 0 && isOn && (
                  <div className="plugin-cmds">
                    {plugin.contributes.commands.map((cmd) => (
                      <button
                        key={cmd.id}
                        type="button"
                        className="btn ghost"
                        onClick={() => onRunCommand(cmd.id)}
                      >
                        {cmd.title}
                        {cmd.keybinding ? ` (${cmd.keybinding})` : ""}
                      </button>
                    ))}
                  </div>
                )}
                {settings.length > 0 && isOn && onPluginSetting && (
                  <div
                    className="plugin-settings"
                    role="group"
                    aria-label={t("plugins.settingsAria", { name: plugin.name })}
                  >
                    {settings.map((field) => {
                      const bag = pluginSettings[plugin.id] ?? {};
                      const current =
                        field.key in bag ? bag[field.key] : field.default;
                      if (field.type === "boolean" || typeof field.default === "boolean") {
                        return (
                          <label key={field.key} className="plugin-setting-row">
                            <input
                              type="checkbox"
                              className="ui-check"
                              checked={Boolean(current)}
                              onChange={(e) =>
                                onPluginSetting(plugin.id, field.key, e.target.checked)
                              }
                            />
                            <span>{field.label}</span>
                          </label>
                        );
                      }
                      return (
                        <label key={field.key} className="plugin-setting-row">
                          <span>{field.label}</span>
                          <input
                            type={field.type === "number" ? "number" : "text"}
                            value={current == null ? "" : String(current)}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const value =
                                field.type === "number" ? Number(raw) : raw;
                              onPluginSetting(plugin.id, field.key, value);
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
              <label className="plugin-switch">
                <input
                  type="checkbox"
                  className="ui-check"
                  checked={isOn}
                  onChange={(e) => onToggle(plugin.id, e.target.checked)}
                />
                <span>{isOn ? t("plugins.enabled") : t("plugins.disabled")}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PluginPanel({
  open,
  plugins,
  enabledIds,
  onClose,
  onToggle,
  onRunCommand,
  pluginSettings,
  onPluginSetting,
}: Props) {
  useLocale();
  const panelRef = useRef<HTMLDivElement>(null);

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    onEscape: onClose,
    initialFocusSelector: ".btn",
  });

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("plugins.aria")}>
      <button type="button" className="modal-backdrop" onClick={onClose} aria-label={t("common.close")} />
      <div className="modal-panel plugin-panel" ref={panelRef}>
        <div className="modal-head">
          <div>
            <div className="modal-kicker">{t("plugins.kicker")}</div>
            <h2>{t("plugins.title")}</h2>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <div className="modal-body">
          <PluginPanelBody
            plugins={plugins}
            enabledIds={enabledIds}
            onToggle={onToggle}
            onRunCommand={onRunCommand}
            pluginSettings={pluginSettings}
            onPluginSetting={onPluginSetting}
          />
        </div>
      </div>
    </div>
  );
}
