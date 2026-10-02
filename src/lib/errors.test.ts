import { describe, expect, it } from "vitest";
import { formatAppError } from "./errors";
import { t } from "./i18n";

describe("formatAppError", () => {
  it("does not leak raw vault messages (which may contain paths)", () => {
    const err = new Error("Invalid vault: C:/Users/secret/MyVault");
    const out = formatAppError(err, t("vault.openFailed"));
    expect(out).toBe(t("vault.openFailed"));
    expect(out).not.toContain("secret");
  });

  it("still formats non-vault invalid paths", () => {
    expect(formatAppError(new Error("invalid path"))).toContain(t("error.invalid", { detail: "" }).trim());
  });
});
