import { describe, expect, it } from "vitest";
import { LOCALES } from "./guest";
import { PORTAL_CATALOGS, pt } from "./portal";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("portal catalog", () => {
  it("has every English key, non-empty, with the same placeholders, in every language", () => {
    for (const locale of LOCALES) {
      for (const [key, english] of Object.entries(PORTAL_CATALOGS.en)) {
        const line = (PORTAL_CATALOGS[locale] as Record<string, string | undefined>)[key];
        expect(line?.trim(), `${locale}.${key}`).toBeTruthy();
        expect(placeholders(line ?? ""), `${locale}.${key}`).toEqual(placeholders(english));
      }
      expect(Object.keys(PORTAL_CATALOGS[locale]).sort()).toEqual(Object.keys(PORTAL_CATALOGS.en).sort());
    }
  });

  it("fills placeholders and leaves unknown ones as written", () => {
    expect(pt("en", "leftOf", { left: 2, n: 5 })).toBe("2 of 5 sessions left");
    expect(pt("ta", "minutes", { n: 30 })).toBe("30 நிமி");
    expect(pt("en", "signedInAs")).toBe("Signed in as {email}");
  });
});
