// Every guest text catalog, found on its own: each module in src/lib/i18n is loaded, and every export keyed by exactly
// the languages in LOCALES is checked against English. A new catalog (polls, the portal, follow-ups...) is covered the
// moment it is exported here, with no per-catalog test to remember, and a new language fails here until every catalog
// has it. CI runs this file as its own "i18n catalogs" job so it can be a required check on main.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCALES } from "./guest";

const DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SRC = join(DIR, "..", "..");
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const KNOWN = new Set<string>(LOCALES);
/**
 * A per-language catalog: an English entry that is an object of lines, and nothing keyed by anything but a language
 * code. Missing languages don't stop it being found, so a catalog that lacks the newest ones still fails below.
 */
const isLocaleMap = (v: unknown): v is Record<string, Record<string, unknown>> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const map = v as Record<string, unknown>;
  return typeof map.en === "object" && map.en !== null && Object.keys(map).every((k) => KNOWN.has(k));
};

const modules = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();

/** [file, export name, catalog] for every per-language catalog exported from src/lib/i18n. */
const catalogs = await Promise.all(modules.map(async (file) => {
  const mod = (await import(join(DIR, file))) as Record<string, unknown>;
  return Object.entries(mod).filter(([, v]) => isLocaleMap(v)).map(([name, v]) => [file, name, v as Record<string, Record<string, unknown>>] as const);
})).then((found) => found.flat());

describe("i18n catalogs", () => {
  it("finds every catalog in src/lib/i18n (the five there today at least)", () => {
    const names = catalogs.map(([file, name]) => `${file}:${name}`);
    for (const known of ["guest.ts:CATALOGS", "mail.ts:MAIL_CATALOGS", "poll.ts:POLL_CATALOGS", "portal.ts:PORTAL_CATALOGS", "follow-up.ts:FOLLOW_UP_CATALOGS"]) {
      expect(names).toContain(known);
    }
  });

  for (const [file, name, catalog] of catalogs) {
    const en = catalog.en as Record<string, unknown>;
    for (const locale of LOCALES) {
      it(`${file} ${name}: ${locale} has every English line, non-empty, with the same placeholders`, () => {
        const lines = catalog[locale] as Record<string, unknown> | undefined;
        expect(lines, `${name} has no ${locale} catalog at all`).toBeTypeOf("object");
        if (!lines) return;
        const missing = Object.keys(en).filter((k) => typeof lines[k] !== "string" || !(lines[k] as string).trim());
        const extra = Object.keys(lines).filter((k) => !(k in en));
        expect(missing, `${name}.${locale} is missing`).toEqual([]);
        expect(extra, `${name}.${locale} has lines English doesn't`).toEqual([]);
        for (const [key, english] of Object.entries(en)) {
          if (typeof english !== "string") continue;
          expect(placeholders(lines[key] as string), `${name}.${locale}.${key}`).toEqual(placeholders(english));
        }
      });
    }
  }

  it("has no per-language catalog declared outside src/lib/i18n, where this test wouldn't find it", () => {
    const outside: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (path !== DIR) walk(path); continue; }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        if (/Record<\s*Locale\s*,/.test(readFileSync(path, "utf8"))) outside.push(relative(SRC, path));
      }
    };
    walk(SRC);
    expect(outside, "move these catalogs into src/lib/i18n so the catalog check covers them").toEqual([]);
  });
});
