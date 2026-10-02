export function matchKeybinding(binding: string, event: KeyboardEvent): boolean {
  const parts = binding.toLowerCase().split("+").map((p) => p.trim());
  const key = parts[parts.length - 1] ?? "";
  const needCtrl =
    parts.includes("ctrl") ||
    parts.includes("control") ||
    parts.includes("cmd") ||
    parts.includes("meta");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");
  const meta = event.ctrlKey || event.metaKey;
  if (needCtrl !== meta) return false;
  if (needShift !== event.shiftKey) return false;
  if (needAlt !== event.altKey) return false;
  return event.key.toLowerCase() === key;
}
