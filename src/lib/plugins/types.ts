export interface PluginCommand {
  id: string;
  title: string;
  keybinding?: string | null;
}

export interface PluginSettingField {
  key: string;
  label: string;
  type?: "boolean" | "string" | "number";
  default?: boolean | string | number;
}

export interface PluginContributes {
  css: string[];
  commands: PluginCommand[];
  bodyClass?: string | null;
  /** Optional settings schema (plugin API v2). */
  settings?: PluginSettingField[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /** builtin | user | vault */
  source: string;
  root: string;
  contributes: PluginContributes;
}

export interface BuiltinPlugin extends PluginInfo {
  source: "builtin";
  /** CSS text shipped with the app */
  cssText?: string;
  /** Run when plugin is enabled or command fires */
  activate?: (api: PluginApi) => void | (() => void);
  runCommand?: (commandId: string, api: PluginApi) => void;
}

export type PluginSettingsStore = Record<string, Record<string, unknown>>;

export interface PluginApi {
  toggleBodyClass: (className: string, force?: boolean) => boolean;
  setStatus: (message: string) => void;
  getEnabled: (pluginId: string) => boolean;
  /** Read a plugin setting (falls back to schema default). */
  getSetting: (pluginId: string, key: string) => unknown;
  /** Persist a plugin setting in-memory + notify host. */
  setSetting: (pluginId: string, key: string, value: unknown) => void;
}

export const STYLE_TAG_PREFIX = "markelle-plugin-style-";
export const VAULT_STYLE_TAG_ID = "markelle-vault-style";
