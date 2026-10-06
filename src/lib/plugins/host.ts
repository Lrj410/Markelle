import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { BUILTIN_PLUGINS } from "./builtin";
import {
  STYLE_TAG_PREFIX,
  VAULT_STYLE_TAG_ID,
  type BuiltinPlugin,
  type PluginApi,
  type PluginInfo,
  type PluginSettingsStore,
} from "./types";

export async function getUserPluginsDir(): Promise<string> {
  return invoke<string>("get_user_plugins_dir");
}

export async function listDiskPlugins(
  vaultRoot: string | null,
): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("list_plugins", {
    vaultRoot: vaultRoot ?? null,
  });
}

export async function readPluginFile(
  root: string,
  relative: string,
): Promise<string> {
  return invoke<string>("read_plugin_file", { root, relative });
}

export async function readVaultStyle(
  vaultRoot: string,
): Promise<string | null> {
  return invoke<string | null>("read_vault_style", { vaultRoot });
}

export function mergePlugins(disk: PluginInfo[]): PluginInfo[] {
  const map = new Map<string, PluginInfo>();
  for (const p of BUILTIN_PLUGINS) map.set(p.id, p);
  for (const p of disk) {
    if (!map.has(p.id)) map.set(p.id, p);
  }
  return [...map.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "zh-CN"),
  );
}

function ensureStyleTag(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

function removeStyleTag(id: string) {
  document.getElementById(id)?.remove();
}

/**
 * Decode CSS escape sequences so escape-based bypasses (`u\72l(`, `@im\port`,
 * `\75 rl(`) cannot smuggle a blocked construct past the literal regexes.
 * Handles `\` + 1–6 hex digits (+ optional terminating whitespace) and `\c`
 * character escapes; `\<newline>` is a line continuation and is dropped.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([\s\S]))/g, (_m, hex, chr) => {
    if (hex) {
      const code = parseInt(hex, 16);
      if (code === 0 || code > 0x10ffff) return "\uFFFD";
      return String.fromCodePoint(code);
    }
    return chr;
  });
}

/** Class names we are willing to write into `<html class>` from a plugin manifest. */
export function isSafeBodyClass(className: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(className);
}

/** Scope untrusted vault/disk CSS to the reader pane; block @import / breakout. */
export function scopeReaderCss(raw: string): string {
  // Normalise escapes FIRST, then block. The decoded string is also the output
  // so an escaped `url(` cannot survive into the stylesheet.
  const cleaned = decodeCssEscapes(raw)
    .replace(/@import\s+[^;]+;/gi, "/* @import blocked */")
    .replace(/@import\s+["'][^"']+["']/gi, "/* @import blocked */")
    .replace(/expression\s*\(/gi, "/* expression blocked */")
    .replace(/-moz-binding\s*:/gi, "/* binding blocked */")
    .replace(/behavior\s*:/gi, "/* behavior blocked */")
    .replace(/javascript\s*:/gi, "/* javascript blocked */")
    .replace(/vbscript\s*:/gi, "/* vbscript blocked */")
    // Block all url() / image-set() fetches from untrusted CSS (tracking / exfil / relative).
    .replace(/url\s*\(\s*[^)]*\)/gi, "/* url blocked */")
    .replace(/image-set\s*\([^)]*\)/gi, "/* image-set blocked */");

  // Reject brace imbalance so authors cannot close @scope and style chrome.
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let inComment = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    const next = cleaned[i + 1];
    if (inComment) {
      if (ch === "*" && next === "/") {
        inComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && next === "*") {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) {
        return "/* CSS rejected: unbalanced braces */";
      }
    }
  }
  if (depth !== 0) {
    return "/* CSS rejected: unbalanced braces */";
  }

  // @scope keeps rules off chrome / overlay surfaces (Chromium/WebView2).
  return `@scope (.main-pane) to (.activity-bar, .statusbar, .cmdk-overlay, .plugin-overlay, .dock-slot) {\n${cleaned}\n}`;
}

export function createPluginApi(
  enabledIds: Set<string>,
  setStatus: (message: string) => void,
  settingsStore: PluginSettingsStore = {},
  onSettingsChange?: (next: PluginSettingsStore) => void,
  plugins: PluginInfo[] = [],
): PluginApi {
  const defaultsFor = (pluginId: string, key: string): unknown => {
    const plugin = plugins.find((p) => p.id === pluginId);
    const field = plugin?.contributes.settings?.find((s) => s.key === key);
    return field?.default;
  };

  return {
    toggleBodyClass(className, force) {
      const root = document.documentElement;
      // A plugin manifest / command must not write arbitrary class tokens
      // (e.g. extra classes or attribute-injection) onto <html>.
      if (!isSafeBodyClass(className)) return root.classList.contains(className);
      const next = force ?? !root.classList.contains(className);
      root.classList.toggle(className, next);
      return next;
    },
    setStatus,
    getEnabled(pluginId) {
      return enabledIds.has(pluginId);
    },
    getSetting(pluginId, key) {
      const bag = settingsStore[pluginId];
      if (bag && key in bag) return bag[key];
      return defaultsFor(pluginId, key);
    },
    setSetting(pluginId, key, value) {
      const next: PluginSettingsStore = {
        ...settingsStore,
        [pluginId]: { ...(settingsStore[pluginId] ?? {}), [key]: value },
      };
      onSettingsChange?.(next);
    },
  };
}

export async function applyEnabledPlugins(
  plugins: PluginInfo[],
  enabledIds: string[],
  setStatus: (message: string) => void,
  settingsStore: PluginSettingsStore = {},
  onSettingsChange?: (next: PluginSettingsStore) => void,
): Promise<void> {
  const enabled = new Set(enabledIds);
  const api = createPluginApi(
    enabled,
    setStatus,
    settingsStore,
    onSettingsChange,
    plugins,
  );

  // Remove styles / theme classes for disabled plugins
  for (const plugin of plugins) {
    const tagId = STYLE_TAG_PREFIX + plugin.id;
    if (!enabled.has(plugin.id)) {
      removeStyleTag(tagId);
      const bodyClass = plugin.contributes.bodyClass;
      if (bodyClass && isSafeBodyClass(bodyClass)) {
        document.documentElement.classList.remove(bodyClass);
      }
      // Toggle-managed themes (bodyClass null) still need cleanup on disable.
      if (plugin.id === "sepia-reading") {
        document.documentElement.classList.remove("plugin-sepia-reading");
      }
    }
  }

  for (const plugin of plugins) {
    if (!enabled.has(plugin.id)) continue;
    const tagId = STYLE_TAG_PREFIX + plugin.id;
    const style = ensureStyleTag(tagId);

    const builtin = BUILTIN_PLUGINS.find((b) => b.id === plugin.id) as
      | BuiltinPlugin
      | undefined;

    if (builtin?.cssText) {
      // Builtin chrome themes (sepia / immersion) may style the whole shell.
      style.textContent = builtin.cssText;
    } else if (plugin.contributes.css.length > 0) {
      const chunks: string[] = [];
      for (const rel of plugin.contributes.css) {
        try {
          chunks.push(await readPluginFile(plugin.root, rel));
        } catch {
          /* skip missing css */
        }
      }
      style.textContent = scopeReaderCss(chunks.join("\n\n"));
    }

    const bodyClass = plugin.contributes.bodyClass;
    // Always-on chrome via bodyClass. Toggle themes (sepia / immersive) leave
    // bodyClass null and restore state from activate() or App.
    if (bodyClass && isSafeBodyClass(bodyClass)) {
      document.documentElement.classList.add(bodyClass);
    }

    builtin?.activate?.(api);
  }
}

export async function applyVaultStyle(vaultRoot: string | null): Promise<void> {
  if (!vaultRoot) {
    removeStyleTag(VAULT_STYLE_TAG_ID);
    return;
  }
  try {
    const css = await readVaultStyle(vaultRoot);
    if (!css) {
      removeStyleTag(VAULT_STYLE_TAG_ID);
      return;
    }
    ensureStyleTag(VAULT_STYLE_TAG_ID).textContent = scopeReaderCss(css);
  } catch {
    removeStyleTag(VAULT_STYLE_TAG_ID);
  }
}

export function runPluginCommand(
  plugins: PluginInfo[],
  commandId: string,
  enabledIds: string[],
  setStatus: (message: string) => void,
  settingsStore: PluginSettingsStore = {},
  onSettingsChange?: (next: PluginSettingsStore) => void,
): boolean {
  const enabled = new Set(enabledIds);
  const api = createPluginApi(
    enabled,
    setStatus,
    settingsStore,
    onSettingsChange,
    plugins,
  );

  for (const plugin of plugins) {
    const cmd = plugin.contributes.commands.find((c) => c.id === commandId);
    if (!cmd) continue;
    if (!enabled.has(plugin.id)) {
      setStatus(t("ailib.pluginEnableFirst", { name: plugin.name }));
      return true;
    }
    const builtin = BUILTIN_PLUGINS.find((b) => b.id === plugin.id);
    if (builtin?.runCommand) {
      builtin.runCommand(commandId, api);
      return true;
    }
    const bodyClass = plugin.contributes.bodyClass;
    if (bodyClass && isSafeBodyClass(bodyClass)) {
      const on = api.toggleBodyClass(bodyClass);
      setStatus(
        on
          ? t("ailib.pluginEnabled", { name: plugin.name })
          : t("ailib.pluginDisabled", { name: plugin.name }),
      );
      return true;
    }
  }
  return false;
}
