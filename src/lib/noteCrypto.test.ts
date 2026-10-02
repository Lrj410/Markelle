import { describe, expect, it } from "vitest";
import { decryptNote, encryptNote, isEncryptedNote } from "./noteCrypto";
import { isNewerVersion } from "./updateCheck";

describe("noteCrypto", () => {
  it("round-trips", async () => {
    const enc = await encryptNote("# Secret\n\nhello", "pass-测试");
    expect(isEncryptedNote(enc)).toBe(true);
    const pt = await decryptNote(enc, "pass-测试");
    expect(pt).toBe("# Secret\n\nhello");
  });

  it("rejects wrong passphrase", async () => {
    const enc = await encryptNote("x", "right");
    await expect(decryptNote(enc, "wrong")).rejects.toBeTruthy();
  });
});

describe("updateCheck", () => {
  it("compares semver", () => {
    expect(isNewerVersion("0.0.13", "0.0.12")).toBe(true);
    expect(isNewerVersion("0.0.12", "0.0.12")).toBe(false);
    expect(isNewerVersion("0.0.11", "0.0.12")).toBe(false);
  });
});
