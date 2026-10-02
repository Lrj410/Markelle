import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get(): Promise<unknown> {
      return null;
    }
    async set(): Promise<void> {
      /* noop */
    }
    async save(): Promise<void> {
      /* noop */
    }
  },
}));

import { flushStore, saveSettings } from "./storage";
import { DEFAULT_SETTINGS } from "./types";

describe("settings persistence", () => {
  it("settles every concurrent saveSettings promise", async () => {
    const a = saveSettings(DEFAULT_SETTINGS);
    const b = saveSettings(DEFAULT_SETTINGS);
    // The debounced persist must resolve both waiters (no dropped Promise).
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  it("flushStore settles a pending scheduled persist", async () => {
    const pending = saveSettings(DEFAULT_SETTINGS);
    // Let store.set resolve so the debounce timer is scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushStore();
    await expect(pending).resolves.toBeUndefined();
  });
});
