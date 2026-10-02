import { describe, expect, it } from "vitest";
import { countTasks, toggleTaskAt } from "./taskToggle";

describe("taskToggle", () => {
  const src = `- [ ] one
- [x] two
  - [ ] nested
`;

  it("counts tasks", () => {
    expect(countTasks(src)).toBe(3);
  });

  it("toggles unchecked to checked", () => {
    expect(toggleTaskAt(src, 0)).toContain("- [x] one");
  });

  it("toggles checked to unchecked", () => {
    expect(toggleTaskAt(src, 1)).toContain("- [ ] two");
  });

  it("returns null for out-of-range", () => {
    expect(toggleTaskAt(src, 9)).toBeNull();
  });

  it("preserves surrounding whitespace and text", () => {
    expect(toggleTaskAt("-   [ ] spaced task", 0)).toBe("-   [x] spaced task");
    expect(toggleTaskAt("1.  [x]   numbered", 0)).toBe("1.  [ ]   numbered");
  });
});
