import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { installEarlyOpenListeners } from "./lib/pendingOpen";

void installEarlyOpenListeners();

// Suppress WebView2 / Chromium default context menu (Inspect, Reload, etc.),
// but let the native menu through inside editable surfaces so the OS
// spelling / emoji / paste menus still work (the app exposes a spellcheck
// setting, so killing them here would contradict it).
document.addEventListener(
  "contextmenu",
  (e) => {
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
      )
    ) {
      return;
    }
    e.preventDefault();
  },
  true,
);

/*
  COLD START CONTRACT — frontend half
  ───────────────────────────────────
  The native window is created hidden (`visible: false` in tauri.conf.json)
  because WebView2 needs roughly 0.6–1.7s to spawn its browser/GPU processes
  before it can produce a single frame. Showing the window any earlier means the
  user stares at a flat `backgroundColor` rectangle for that whole gap — that was
  the reported "cold start is a long black screen".

  We reveal it here, as soon as this module evaluates. The inline splash in
  index.html is already parsed and its CSS is inline, so the first frame the
  compositor presents is the branded splash, not an empty surface.

  DO NOT defer this behind `requestAnimationFrame` or a zero-ish `setTimeout`.
  A hidden WebView2 window has its rendering suspended, and Chromium throttles
  timers in it — both were observed to never fire at all, leaving the window
  hidden until the native 5s failsafe. The call has to be synchronous.

  `show()` is idempotent, so the timer below is only a second chance in case the
  IPC round-trip was dropped; it is not the primary path.
*/
const revealWindow = () => {
  // Observable from DevTools / CDP: tells a future debugging session whether
  // this module body ran and whether the reveal was reached at all.
  document.documentElement.dataset.boot = "revealing";
  try {
    void getCurrentWindow()
      .show()
      .then(() => {
        document.documentElement.dataset.boot = "revealed";
      })
      .catch((err) => {
        document.documentElement.dataset.boot = "reveal-failed";
        console.warn("markelle: window reveal failed", err);
      });
  } catch (err) {
    /* plain browser / web preview, or missing helper */
    document.documentElement.dataset.boot = "reveal-failed";
    console.warn("markelle: window reveal failed", err);
  }
};

revealWindow();
window.setTimeout(revealWindow, 300);

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root");
}

/*
  Boot graph:
  1. index.html inline splash paints with ZERO JS modules (it also reveals the
     window above, so it is the first thing the user sees).
  2. The React app graph loads next and takes over #root.
  Dual-WebView splash was removed — a second WebView is also blank until it
  paints, and it doubles WebView2 init cost.

  Heavy reader assets (KaTeX, highlight.js, Source Serif 4, Mermaid) are NOT
  imported here: they belong to MarkdownView, which is lazy. See
  styles/boot-fonts.css for the split.
*/
void import("./App").then(({ default: App }) => {
  void import("./components/ErrorBoundary").then(({ ErrorBoundary }) => {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  });
});
