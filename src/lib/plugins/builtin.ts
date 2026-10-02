import type { BuiltinPlugin } from "./types";

/** Immersion visuals live in shell.css (`html.immersive`). Plugin toggles via App. */
const focusCss = `/* immersion chrome — see shell.css html.immersive */`;

const sepiaCss = `
html.plugin-sepia-reading {
  --paper: #f3ead7;
  --paper-elevated: #f7f0e2;
  --ink: #3b2f2f;
  --ink-soft: #6d5c54;
  --line: #ddcfb8;
  --accent: #8a5a2b;
  --accent-soft: #eadcc6;
  --surface: #f0e6d2;
  --border: #d4c4a8;
  --btn-primary-bg: #8a5a2b;
  --btn-primary-fg: #f7f0e2;
  --btn-primary-hover: #6e4722;
}
html[data-theme="dark"].plugin-sepia-reading {
  --paper: #1c1712;
  --paper-elevated: #2a2218;
  --ink: #e8dcc8;
  --ink-soft: #b5a48f;
  --line: #4a3c2e;
  --accent: #d4a574;
  --accent-soft: #3a2e20;
  --surface: #241e17;
  --border: #4a3c2e;
  --btn-primary-bg: #c4925a;
  --btn-primary-fg: #1c1712;
  --btn-primary-hover: #d4a574;
}
`;

export const IMMERSIVE_TOGGLE_EVENT = "markelle:toggle-immersive";

export const SEPIA_BODY_CLASS = "plugin-sepia-reading";

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: "focus-mode",
    name: "沉浸阅读",
    version: "0.0.1",
    description: "隐藏壳层与侧栏，只留正文。F11 / Ctrl+Shift+F 切换，Esc 退出。",
    author: "Markelle",
    source: "builtin",
    root: "builtin:focus-mode",
    cssText: focusCss,
    contributes: {
      css: [],
      commands: [
        {
          id: "focus-mode.toggle",
          title: "切换沉浸阅读",
          keybinding: "Ctrl+Shift+F",
        },
      ],
      bodyClass: null,
    },
    runCommand: (commandId) => {
      if (commandId === "focus-mode.toggle") {
        window.dispatchEvent(new CustomEvent(IMMERSIVE_TOGGLE_EVENT));
      }
    },
  },
  {
    id: "sepia-reading",
    name: "羊皮纸阅读",
    version: "0.0.1",
    description: "温暖纸色阅读主题，适合长文。",
    author: "Markelle",
    source: "builtin",
    root: "builtin:sepia-reading",
    cssText: sepiaCss,
    contributes: {
      css: [],
      commands: [
        {
          id: "sepia-reading.toggle",
          title: "切换羊皮纸",
          keybinding: null,
        },
      ],
      // null: do not force-on in applyEnabledPlugins (that fought toggle + persist).
      bodyClass: null,
      settings: [
        {
          key: "active",
          label: "羊皮纸主题开启",
          type: "boolean",
          default: true,
        },
      ],
    },
    activate: (api) => {
      const on = api.getSetting("sepia-reading", "active") !== false;
      api.toggleBodyClass(SEPIA_BODY_CLASS, on);
    },
    runCommand: (commandId, api) => {
      if (commandId === "sepia-reading.toggle") {
        const next = api.getSetting("sepia-reading", "active") === false;
        api.toggleBodyClass(SEPIA_BODY_CLASS, next);
        api.setSetting("sepia-reading", "active", next);
        api.setStatus(next ? "羊皮纸已开启" : "羊皮纸已关闭");
      }
    },
  },
];
