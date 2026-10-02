import { describe, expect, it } from "vitest";
import { matchKeybinding } from "./keybinding";

function key(
  keyName: string,
  mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {},
): KeyboardEvent {
  return {
    key: keyName,
    ctrlKey: Boolean(mods.ctrl),
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt),
    metaKey: Boolean(mods.meta),
  } as KeyboardEvent;
}

describe("matchKeybinding", () => {
  it("matches ctrl chords", () => {
    expect(matchKeybinding("Ctrl+K", key("k", { ctrl: true }))).toBe(true);
    expect(matchKeybinding("Ctrl+Shift+F", key("f", { ctrl: true, shift: true }))).toBe(
      true,
    );
    expect(matchKeybinding("Ctrl+K", key("k"))).toBe(false);
  });
});
