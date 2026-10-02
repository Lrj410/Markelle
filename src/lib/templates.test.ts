import { describe, expect, it } from "vitest";
import {
  createDailyNote,
  dailyNotePath,
  dailyNoteSeed,
  formatDateYmd,
  formatTimeHm,
  renderTemplate,
} from "./templates";

describe("templates", () => {
  const fixed = new Date(2026, 8, 27, 15, 42, 0); // local Sep 27 2026 15:42

  it("formats date and time", () => {
    expect(formatDateYmd(fixed)).toBe("2026-09-27");
    expect(formatTimeHm(fixed)).toBe("15:42");
  });

  it("replaces template placeholders", () => {
    expect(
      renderTemplate("# {{title}}\n\n{{date}} {{time}}", {
        title: "草稿",
        date: "2026-09-27",
        time: "15:42",
      }),
    ).toBe("# 草稿\n\n2026-09-27 15:42");
  });

  it("builds daily note path under 日记/ (or custom folder)", () => {
    expect(dailyNotePath("C:/vault", fixed)).toBe("C:/vault/日记/2026-09-27.md");
    expect(dailyNotePath("C:\\vault\\", fixed)).toBe("C:/vault/日记/2026-09-27.md");
    expect(dailyNotePath("C:/vault", fixed, "Daily")).toBe("C:/vault/Daily/2026-09-27.md");
  });

  it("seeds daily note markdown", () => {
    expect(dailyNoteSeed(fixed)).toBe("# 2026-09-27\n\n2026-09-27\n\n");
  });

  it("createDailyNote returns path and content", () => {
    const note = createDailyNote("C:/vault", fixed);
    expect(note.dateKey).toBe("2026-09-27");
    expect(note.path).toBe("C:/vault/日记/2026-09-27.md");
    expect(note.content).toContain("# 2026-09-27");
  });
});
