import { describe, expect, it } from "vitest";
import { parseLink, portalKey, signLink, verifyLink } from "./tokens";

const key = portalKey({ BETTER_AUTH_SECRET: "test-secret-0123456789abcdef" });
const claims = { hostId: "6f1c2d3e-0000-4000-8000-000000000001", email: "meera@example.com", expiresAt: new Date("2026-11-15T10:15:00Z") };

describe("portal link signature", () => {
  it("verifies a link against the claims it was signed with", () => {
    const { token } = signLink(key, claims);
    const p = parseLink(token)!;
    expect(verifyLink(key, p.nonce, p.sig, claims)).toBe(true);
    // Email case doesn't matter: emails are compared as the same address.
    expect(verifyLink(key, p.nonce, p.sig, { ...claims, email: "Meera@Example.com" })).toBe(true);
  });

  it("refuses a link whose stored claims were changed: another host, another email, a later expiry", () => {
    const { token } = signLink(key, claims);
    const p = parseLink(token)!;
    expect(verifyLink(key, p.nonce, p.sig, { ...claims, hostId: "6f1c2d3e-0000-4000-8000-000000000002" })).toBe(false);
    expect(verifyLink(key, p.nonce, p.sig, { ...claims, email: "someone@example.com" })).toBe(false);
    expect(verifyLink(key, p.nonce, p.sig, { ...claims, expiresAt: new Date(claims.expiresAt.getTime() + 60_000) })).toBe(false);
  });

  it("refuses a forged signature, another nonce, or another server's key", () => {
    const a = parseLink(signLink(key, claims).token)!;
    const b = parseLink(signLink(key, claims).token)!;
    expect(a.nonce).not.toBe(b.nonce);
    expect(verifyLink(key, a.nonce, b.sig, claims)).toBe(false);
    const flipped = (a.sig[0] === "A" ? "B" : "A") + a.sig.slice(1);
    expect(verifyLink(key, a.nonce, flipped, claims)).toBe(false);
    const other = portalKey({ BETTER_AUTH_SECRET: "another-secret-0123456789" });
    expect(verifyLink(other, a.nonce, a.sig, claims)).toBe(false);
  });

  it("stores only a hash of the nonce, never the token", () => {
    const { token, nonceHash } = signLink(key, claims);
    expect(nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(nonceHash);
  });

  it("parses only well-formed tokens", () => {
    expect(parseLink(undefined)).toBeNull();
    expect(parseLink("")).toBeNull();
    expect(parseLink("abc.def")).toBeNull();
    const { token } = signLink(key, claims);
    expect(parseLink(`${token}.x`)).toBeNull();
    expect(parseLink(token)).not.toBeNull();
  });

  it("needs a real secret", () => {
    expect(() => portalKey({})).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => portalKey({ BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
  });
});
