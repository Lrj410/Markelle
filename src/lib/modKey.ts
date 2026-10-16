/** Platform modifier key for display (⌘ on Apple, Ctrl elsewhere). */

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || "";
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) return true;
  return /Mac OS X|Macintosh|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function modKeyLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

/** Build a chord like `Ctrl+Shift+B` / `⌘+Shift+B`. */
export function formatChord(...keys: string[]): string {
  return [modKeyLabel(), ...keys].join("+");
}

/** Rewrite display strings that hardcode `Ctrl` for the current platform. */
export function localizeChord(text: string): string {
  if (!isApplePlatform()) return text;
  return text.replace(/\bCtrl\b/g, "⌘");
}
