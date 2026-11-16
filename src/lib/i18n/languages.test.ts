// Roadmap 3.7: Marathi, Bengali, Malayalam and Gujarati on every guest-facing surface. These checks hold for every
// language in LOCALES, so a new language (or a key added to English) fails here until each catalog has it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateBookingRequest } from "../booking";
import { formatDate, formatTime } from "../format";
import { renderBookingMail, type BookingMailContext } from "../mail/templates";
import { whatsappMessage } from "../whatsapp";
import { templateMessage } from "../whatsapp-cloud";
import { CATALOGS, LOCALES, LOCALE_NAMES, LOCATION_KEYS, intlTag, isLocale, resolveLocale, t, type Locale } from "./guest";
import { MAIL_CATALOGS } from "./mail";

const NEW = ["mr", "bn", "ml", "gu"] as const;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** The Unicode block each language is written in, to catch a line left in English or pasted from the wrong language. */
const SCRIPT: Record<(typeof NEW)[number], RegExp> = { mr: /[ऀ-ॿ]/, bn: /[ঀ-৿]/, ml: /[ഀ-ൿ]/, gu: /[઀-૿]/ };
/** Lines that are brand or product names, the same in every language. */
const SAME_EVERYWHERE = new Set(["locGoogleMeet", "locZoom", "locTeams", "locHourhandVideo"]);

describe("every language has every line", () => {
  for (const [name, catalogs] of [["guest", CATALOGS], ["mail", MAIL_CATALOGS]] as const) {
    const en = catalogs.en as Record<string, string>;
    for (const locale of LOCALES) {
      it(`${name} catalog: ${locale} has exactly the English keys`, () => {
        const lines = catalogs[locale] as Record<string, string | undefined>;
        const missing = Object.keys(en).filter((k) => !lines[k]?.trim());
        const extra = Object.keys(lines).filter((k) => !(k in en));
        expect(missing, `${locale} is missing ${name} keys`).toEqual([]);
        expect(extra, `${locale} has ${name} keys English doesn't`).toEqual([]);
      });
      it(`${name} catalog: ${locale} keeps every placeholder`, () => {
        const lines = catalogs[locale] as Record<string, string>;
        for (const [key, english] of Object.entries(en)) expect(placeholders(lines[key] ?? ""), `${locale}.${key}`).toEqual(placeholders(english));
      });
    }
  }

  it("writes the new languages in their own script, and keeps brand names in Latin", () => {
    for (const locale of NEW) {
      for (const [key, line] of Object.entries({ ...CATALOGS[locale], ...MAIL_CATALOGS[locale] })) {
        if (SAME_EVERYWHERE.has(key)) expect(line, `${locale}.${key}`).toBe((CATALOGS.en as Record<string, string>)[key]);
        else expect(line, `${locale}.${key}`).toMatch(SCRIPT[locale]);
      }
      expect(CATALOGS[locale].chatWhatsApp).toContain("WhatsApp");
      expect(CATALOGS[locale].offline).toContain("Hourhand");
      expect(MAIL_CATALOGS[locale].fGuest).toContain("Hourhand");
    }
  });
});

describe("the language picker", () => {
  it("lists all nine languages, each named in its own script", () => {
    expect(LOCALES).toEqual(["en", "hi", "ta", "te", "kn", "mr", "bn", "ml", "gu"]);
    expect(LOCALE_NAMES).toMatchObject({ mr: "मराठी", bn: "বাংলা", ml: "മലയാളം", gu: "ગુજરાતી" });
    for (const locale of NEW) expect(LOCALE_NAMES[locale]).toMatch(SCRIPT[locale]);
  });
});

describe("choosing the language", () => {
  it("takes a new language from ?lang or the host's default, and falls back to English", () => {
    expect(resolveLocale("mr", "en")).toBe("mr");
    expect(resolveLocale(undefined, "bn")).toBe("bn");
    expect(resolveLocale("xx", "ml")).toBe("ml");
    expect(resolveLocale("gu", "hi")).toBe("gu");
    expect(resolveLocale("MR", null)).toBe("en"); // codes are lower case, as the picker writes them
    expect(resolveLocale("or", "as")).toBe("en"); // Odia and Assamese aren't offered yet
    expect(isLocale("bn")).toBe(true);
  });

  it("keeps a new language with the booking, so the emails follow it", () => {
    const req = { slug: "priya", event: "coaching", start: "2031-04-01T05:00:00.000Z", name: "Kiran", email: "kiran@example.in", timezone: "Asia/Kolkata", idempotencyKey: "lang-key-37" };
    for (const locale of NEW) {
      const v = validateBookingRequest({ ...req, locale });
      expect(v.ok && v.value.locale).toBe(locale);
    }
  });

  it("lets the database store every language (migration matches LOCALES)", () => {
    const sql = readFileSync(new URL("../../../db/migrations/0031_invitee_locale_more_languages.sql", import.meta.url), "utf8");
    const allowed = [...(/check \(locale in \(([^)]*)\)\)/.exec(sql)?.[1] ?? "").matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual([...LOCALES].sort());
  });
});

describe("dates and times in the new languages", () => {
  const at = new Date("2026-10-20T10:00:00Z"); // Tuesday 20 October 2026, 3:30 pm IST
  const cases: Record<(typeof NEW)[number], { weekday: string; month: string }> = {
    mr: { weekday: "मंगळवार", month: "ऑक्टोबर" },
    bn: { weekday: "মঙ্গলবার", month: "অক্টোবর" },
    ml: { weekday: "ചൊവ്വാഴ്ച", month: "ഒക്‌ടോബർ" },
    gu: { weekday: "મંગળવાર", month: "ઑક્ટોબર" },
  };

  it("has the ICU data for each language in India (full-icu)", () => {
    expect(Intl.DateTimeFormat.supportedLocalesOf(NEW.map((l) => `${l}-IN`))).toEqual(["mr-IN", "bn-IN", "ml-IN", "gu-IN"]);
  });

  for (const locale of NEW) {
    it(`${locale}: names the day and month in the language, with Latin digits`, () => {
      const date = formatDate(at, "Asia/Kolkata", locale);
      expect(date).toContain(cases[locale].weekday);
      expect(date).toContain(cases[locale].month);
      expect(date).toMatch(/\b20\b/);
      expect(date).toContain("2026");
      expect(date).not.toMatch(/[०-९০-৯൦-൯૦-૯]/); // no native digits, even where the language defaults to them
      expect(formatTime(at, "Asia/Kolkata", "24h", locale)).toBe("15:30");
      expect(formatTime(at, "Asia/Kolkata", "12h", locale)).toMatch(/^3:30\s?\S+$/);
      expect(formatTime(at, "Asia/Kolkata", "12h", locale)).not.toMatch(/[०-९০-৯൦-൯૦-૯]/);
      expect(intlTag(locale)).toBe(`${locale}-IN-u-nu-latn`);
    });
  }
});

const ctx: BookingMailContext = {
  bookingId: "b1", eventName: "Coaching", hostName: "Priya Sharma", hostEmail: "priya@example.com", hostTimezone: "Asia/Kolkata", hostTimeFormat: "24h",
  guestName: "Kiran", guestEmail: "kiran@example.com", guestTimezone: "Asia/Kolkata",
  startAt: new Date("2026-11-03T04:30:00Z"), endAt: new Date("2026-11-03T05:00:00Z"),
  location: { kind: "google_meet", value: null }, joinUrl: "https://meet.google.com/abc-defg-hij", answers: [],
  cancelledBy: "host", cancelReason: "Unwell", previousStartAt: new Date("2026-11-02T04:30:00Z"), paidMinor: 50000,
  issuedAt: new Date("2026-10-11T00:00:00Z"),
  manageUrl: "https://hourhand.test/b/manage-token", dashboardUrl: "https://hourhand.test/dashboard/bookings/b1",
};

/** English phrases from the guest emails that must never show up in a translated one. */
const ENGLISH = /You're booked|Coming up soon|Your booking|Reschedule or cancel|Sent by Hourhand|Reminder:|Booked:|Cancelled:|Moved:|Hi Kiran|refunded| min\b|Change or cancel/;

describe("guest emails in the new languages", () => {
  const kinds = ["booked_guest", "reminder_guest", "cancelled_guest", "rescheduled_guest"] as const;
  for (const locale of NEW) {
    for (const kind of kinds) {
      it(`${locale}: ${kind} is fully translated, with nothing left unfilled`, () => {
        const m = renderBookingMail(kind, { ...ctx, locale });
        for (const part of [m.subject, m.text, m.html]) {
          expect(part).not.toMatch(/\{\w+\}/); // every placeholder filled
          expect(part).not.toMatch(ENGLISH);
        }
        expect(m.subject).toMatch(SCRIPT[locale]);
        expect(m.subject).toContain("Coaching");
        expect(m.subject).toContain("Priya Sharma");
        expect(m.text).toContain("Kiran");
        expect(m.text).toContain(MAIL_CATALOGS[locale].fGuest.replace("{host}", "Priya Sharma"));
        if (kind !== "cancelled_guest") expect(m.text).toContain("https://hourhand.test/b/manage-token");
        if (kind !== "cancelled_guest") expect(m.text).toContain("Google Meet: https://meet.google.com/abc-defg-hij");
      });
    }

    it(`${locale}: the calendar file attached to the confirmation is in the language too`, () => {
      const m = renderBookingMail("booked_guest", { ...ctx, locale });
      const file = m.attachments?.find((a) => a.filename.endsWith(".ics"));
      const ics = file ? Buffer.from(String(file.content), "base64").toString("utf8") : "";
      expect(ics).toContain("BEGIN:VEVENT");
      expect(ics.replace(/\r\n /g, "")).toContain(`SUMMARY:${MAIL_CATALOGS[locale].calWith.replace("{event}", "Coaching").replace("{host}", "Priya Sharma")}`);
      expect(ics).not.toMatch(/ with Priya|Change or cancel/);
    });

    it(`${locale}: the refund line names the amount when the host cancels a paid booking`, () => {
      const m = renderBookingMail("cancelled_guest", { ...ctx, locale });
      expect(m.text).toContain("₹500");
      expect(m.text).toContain("Unwell");
    });
  }

  it("keeps the host's copy in English whatever the guest's language", () => {
    for (const locale of NEW) expect(renderBookingMail("booked_host", { ...ctx, locale }).subject.startsWith("New booking:")).toBe(true);
  });
});

describe("WhatsApp in the new languages", () => {
  const wa = { guestName: "Kiran Rao", hostName: "Priya", eventName: "Coaching", startAt: ctx.startAt, guestTimezone: "Asia/Kolkata", where: null, manageUrl: "https://h.test/b/x" };

  it("writes the host's own wa.me message in the guest's language (free text, no Meta approval needed)", () => {
    for (const locale of NEW) {
      const msg = whatsappMessage("reminder", { ...wa, locale });
      expect(msg).toMatch(SCRIPT[locale]);
      expect(msg).toContain("Kiran");
      expect(msg).not.toContain("Rao");
      expect(msg).toContain("https://h.test/b/x");
      expect(msg).not.toMatch(/\{\w+\}/);
    }
  });

  it("sends the automatic WhatsApp templates in English, since only English and Hindi are approved by Meta", () => {
    for (const locale of NEW) {
      const body = templateMessage("booked_guest", { ...wa, locale, manageToken: "tok" }, "919876543210");
      expect(body.template.language.code).toBe("en");
      expect(JSON.stringify(body)).not.toMatch(SCRIPT[locale]);
    }
  });
});

describe("booking-page lines in the new languages", () => {
  it("fills placeholders the same way as English", () => {
    for (const locale of NEW as readonly Locale[]) {
      expect(t(locale, "minutes", { n: 45 })).toContain("45");
      expect(t(locale, "everyWeek", { n: 3 })).toContain("3");
      expect(t(locale, "pay", { price: "₹1,500" })).toContain("₹1,500");
      for (const key of Object.values(LOCATION_KEYS)) expect(t(locale, key)).not.toBe("");
    }
  });
});
