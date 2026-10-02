/** Shared body/source type size — Ctrl+wheel and settings both land here. */

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 17;

/** Fired after CSS vars update so CodeMirror can `requestMeasure` without a theme rebuild. */
export const FONT_SIZE_EVENT = "markelle:font-size";

export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

/** Immediate paint path — no React. Reader + source both read these vars. */
export function applyFontSizeCss(px: number): void {
  const size = clampFontSize(px);
  const value = `${size}px`;
  const root = document.documentElement;
  root.style.setProperty("--reader-font-size", value);
  root.style.setProperty("--source-font-size", value);
  window.dispatchEvent(new CustomEvent(FONT_SIZE_EVENT, { detail: size }));
}

/**
 * Convert a wheel delta into a ±1 step. Trackpads send many small deltas;
 * accumulate so zoom stays controllable without flooding React.
 */
export function wheelDeltaToSteps(deltaY: number, deltaMode: number, acc: { value: number }): number {
  // DOM_DELTA_LINE = 1, DOM_DELTA_PAGE = 2 — normalize toward pixels.
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  acc.value += px;
  const threshold = 40;
  let steps = 0;
  while (acc.value >= threshold) {
    acc.value -= threshold;
    steps -= 1;
  }
  while (acc.value <= -threshold) {
    acc.value += threshold;
    steps += 1;
  }
  return steps;
}
