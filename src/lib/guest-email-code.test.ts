import { describe, expect, it } from "vitest";
import { guestEmailCodeSecret, hashGuestEmailCode, newGuestEmailCode, sameGuestEmailCodeHash } from "./guest-email-code";

describe("guest email codes (B11)", () => {
  it("are 6 digits, leading zeros kept", () => {
    for (let i = 0; i < 50; i++) expect(newGuestEmailCode()).toMatch(/^\d{6}$/);
  });

  it("hash differently per code, event type and address, but not per address case", () => {
    const h = hashGuestEmailCode("123456", "et1", "a@example.com", "k");
    expect(h).toBe(hashGuestEmailCode("123456", "et1", "A@Example.COM", "k"));
    expect(h).not.toBe(hashGuestEmailCode("123457", "et1", "a@example.com", "k"));
    expect(h).not.toBe(hashGuestEmailCode("123456", "et2", "a@example.com", "k"));
    expect(h).not.toBe(hashGuestEmailCode("123456", "et1", "b@example.com", "k"));
    expect(h).not.toBe(hashGuestEmailCode("123456", "et1", "a@example.com", "other key"));
    expect(h).not.toContain("123456");
  });

  it("compares hashes", () => {
    expect(sameGuestEmailCodeHash("abc", "abc")).toBe(true);
    expect(sameGuestEmailCodeHash("abc", "abd")).toBe(false);
    expect(sameGuestEmailCodeHash("abc", "abcd")).toBe(false);
  });

  it("needs a server key", () => {
    expect(guestEmailCodeSecret({ BETTER_AUTH_SECRET: "x" })).toBe("x");
    expect(guestEmailCodeSecret({ GUEST_EMAIL_CODE_SECRET: "y", BETTER_AUTH_SECRET: "x" })).toBe("y");
    expect(() => guestEmailCodeSecret({})).toThrow(/must be set/);
  });
});
