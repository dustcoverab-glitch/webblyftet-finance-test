import { describe, expect, it } from "vitest";
import { decryptString, encryptString } from "../src/lib/crypto";
import { testKey } from "./helpers";

describe("crypto token storage", () => {
  it("encrypts and decrypts a token roundtrip", async () => {
    const encrypted = await encryptString("secret-access-token", testKey());

    expect(encrypted).not.toContain("secret-access-token");
    await expect(decryptString(encrypted, testKey())).resolves.toBe("secret-access-token");
  });
});
