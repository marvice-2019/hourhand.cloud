// The host catalogue: every language has every English key with the same placeholders; the language comes from the
// signed-in host's saved preference; dates, numbers and rupees follow it.
import { describe, expect, it, vi } from "vitest";
import { HOST_CATALOGS, HOST_LOCALES, hostLocaleOf, ht, isHostLocale } from "./index";
import { hostDate, hostINR, hostNumber, makeHostI18n } from "./format";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Keys missing or extra in `catalog` compared with English, and lines whose placeholders differ. */
export function parityProblems(english: Record<string, string>, catalog: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const [key, line] of Object.entries(english)) {
    const other = catalog[key];
    if (!other?.trim()) problems.push(`missing ${key}`);
    else if (placeholders(other).join() !== placeholders(line).join()) problems.push(`placeholders ${key}: ${placeholders(other)} vs ${placeholders(line)}`);
  }
  for (const key of Object.keys(catalog)) if (!(key in english)) problems.push(`extra ${key}`);
  return problems;
}

describe("host catalogue parity", () => {
  it("has every English key, non-empty, with the same placeholders, in every dashboard language", () => {
    for (const locale of HOST_LOCALES) expect(parityProblems(HOST_CATALOGS.en, HOST_CATALOGS[locale]), locale).toEqual([]);
  });

  it("notices a removed key, a renamed placeholder and an extra key", () => {
    const withoutKey: Record<string, string> = { ...HOST_CATALOGS.en };
    delete withoutKey["nav.bookings"];
    expect(parityProblems(HOST_CATALOGS.en, withoutKey)).toEqual(["missing nav.bookings"]);
    expect(parityProblems(HOST_CATALOGS.en, { ...HOST_CATALOGS.en, "nav.acting": "Managing {person}" })).toEqual(["placeholders nav.acting: person vs name"]);
    expect(parityProblems(HOST_CATALOGS.en, { ...HOST_CATALOGS.en, "nav.nope": "x" })).toEqual(["extra nav.nope"]);
  });

  it("keys carry their namespace", () => {
    for (const key of Object.keys(HOST_CATALOGS.en)) expect(key).toMatch(/^[a-z][A-Za-z]*\.[A-Za-z0-9]+$/);
  });

  it("fills placeholders and leaves unknown ones as written", () => {
    expect(ht("en", "nav.manageOwner", { name: "Priya" })).toBe("Manage Priya's account");
    expect(ht("en", "nav.manageOwner")).toBe("Manage {name}'s account");
  });
});

describe("choosing the host's language", () => {
  it("uses the saved preference when it is a dashboard language, otherwise English", () => {
    expect(hostLocaleOf({ hostLocale: "en" })).toBe("en");
    expect(hostLocaleOf({ hostLocale: "fr" })).toBe("en");
    expect(hostLocaleOf({ hostLocale: null })).toBe("en");
    expect(hostLocaleOf(null)).toBe("en");
    expect(isHostLocale("xx")).toBe(false);
    for (const l of HOST_LOCALES) expect(hostLocaleOf({ hostLocale: l })).toBe(l);
  });

  it("reads it on the server from the signed-in person, not the account they manage", async () => {
    vi.resetModules();
    const actor = { id: "a", email: "a@x.in", name: "A", slug: "aaa", timezone: "Asia/Kolkata", timeFormat: "12h" as const, locale: "kn", hostLocale: HOST_LOCALES[HOST_LOCALES.length - 1] };
    const host = { ...actor, id: "h", hostLocale: "en" };
    vi.doMock("../../auth/session", () => ({ getHostContext: async () => ({ host, actor, acting: true }) }));
    const { getHostI18n } = await import("./server");
    const i18n = await getHostI18n();
    expect(i18n.locale).toBe(actor.hostLocale);
    expect(i18n.locale).not.toBe(actor.locale); // the booking-page language is a separate setting
    vi.doUnmock("../../auth/session");
  });

  it("falls back to English when nobody is signed in", async () => {
    vi.resetModules();
    vi.doMock("../../auth/session", () => ({ getHostContext: async () => null }));
    const { getHostI18n } = await import("./server");
    expect((await getHostI18n()).locale).toBe("en");
    vi.doUnmock("../../auth/session");
  });
});

describe("host formats", () => {
  const at = new Date("2026-10-20T10:00:00Z");
  it("writes English dates, numbers and rupees exactly as the dashboard did, with Indian grouping", () => {
    expect(hostDate(at, "Asia/Kolkata", "en")).toBe("Tuesday, 20 October 2026");
    expect(hostNumber(1234567, "en")).toBe("12,34,567");
    expect(hostINR(12550000, "en")).toBe("₹1,25,500");
    expect(hostINR(12345, "en")).toBe("₹123.45");
    const i = makeHostI18n("en");
    expect(i.time(at, "Asia/Kolkata")).toBe("3:30 pm");
    expect(i.time(at, "Asia/Kolkata", "24h")).toBe("15:30");
    expect(i.month(new Date("2026-10-01T00:00:00Z"))).toBe("October 2026");
  });
});

describe("English stays as it was", () => {
  it("prints plan prices exactly as priceLine does", async () => {
    const { priceLine } = await import("../../billing/plans");
    const { hostPriceLine } = await import("./price");
    const en = makeHostI18n("en");
    for (const plan of ["solo", "duo"] as const) for (const interval of ["month", "year"] as const) for (const currency of ["INR", "USD"] as const)
      expect(hostPriceLine(plan, interval, currency, en)).toBe(priceLine(plan, interval, currency));
    const { addonPriceLine } = await import("../../billing/plans");
    const { hostAddonPriceLine } = await import("./price");
    expect(hostAddonPriceLine("domain", en)).toBe(addonPriceLine("domain"));
  });

  it("prints the plan, domain and availability dates as before", () => {
    const en = makeHostI18n("en");
    const at = new Date("2026-11-15T10:00:00Z");
    expect(en.mediumDate(at, "Asia/Kolkata")).toBe(new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(at));
    expect(en.mediumDateTime(at, "Asia/Kolkata")).toBe(new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(at));
    expect(en.dayDate("2026-11-15")).toBe("Sun, 15 Nov 2026");
    expect(en.zoneLongName("Asia/Kolkata")).toBe("India Standard Time");
  });

  it("has a host line for every event type form error, with the same English", async () => {
    const { EVENT_TYPE_MESSAGES } = await import("../../event-types");
    for (const [code, english] of Object.entries(EVENT_TYPE_MESSAGES)) {
      const key = `eventTypes.err${code[0].toUpperCase()}${code.slice(1)}` as keyof typeof HOST_CATALOGS.en;
      expect(HOST_CATALOGS.en[key], code).toBe(english);
    }
  });

  it("asks for a missing phone number without the old 'Add the your' typo", async () => {
    const { NEW_EVENT_TYPE_FORM, validateEventType } = await import("../../event-types");
    const r = validateEventType({ ...NEW_EVENT_TYPE_FORM, name: "Call", locationKind: "phone_guest_calls", locationValue: "" }, []);
    expect(!r.ok && r.errors.locationValue).toBe("Add your phone number so guests know where to go.");
    expect(ht("en", "links.errAddPhone")).toBe("Add your phone number so your guest knows where to go.");
  });

  it("never leaves a code where an English message should be", async () => {
    const tables: Record<string, Record<string, string>> = {
      eventTypes: (await import("../../event-types")).EVENT_TYPE_MESSAGES,
      import: (await import("../../import/messages")).IMPORT_MESSAGES,
      availability: (await import("../../availability")).AVAILABILITY_MESSAGES,
      profile: (await import("../../profile")).PROFILE_MESSAGES,
      polls: (await import("../../polls/polls")).POLL_MESSAGES,
    };
    for (const [name, table] of Object.entries(tables)) for (const [code, english] of Object.entries(table)) {
      expect(english, `${name}.${code}`).not.toBe(code);
      expect(english, `${name}.${code}`).toMatch(/\s/);
    }
    const { NEW_EVENT_TYPE_FORM, validateEventType } = await import("../../event-types");
    const r = validateEventType({ ...NEW_EVENT_TYPE_FORM, name: "X", minNoticeMinutes: "-1", dailyLimit: "0" }, []);
    expect(!r.ok && r.errors).toMatchObject({ minNoticeMinutes: "Enter 0 or more minutes.", dailyLimit: "Enter 1 or more, or leave it blank for no limit." });
  });
});
