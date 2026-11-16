// Dates, times, numbers and rupees for the host's dashboard and emails, in the host's language. Digits stay Latin and
// numbers use Indian grouping (1,00,000) in every language, as the guest pages do.
import type { ReactNode } from "react";
import { formatDate, formatTime, type HourCycle } from "../../format";
import { intlTag } from "../guest";
import { formatAmount } from "../../money";
import { ht, htNodes, type HostKey, type HostLocale, type Vars } from "./index";

const tag = (locale: HostLocale) => intlTag(locale);

/** "Tuesday, 20 October 2026" in the host's language. */
export const hostDate = (d: Date, tz: string, locale: HostLocale) => formatDate(d, tz, locale);

/** "Tue, 20 Oct" in the host's language. */
export function hostShortDate(d: Date, tz: string, locale: HostLocale): string {
  return new Intl.DateTimeFormat(tag(locale), { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
}

/** "October 2026" in the host's language; `d` is read in UTC unless a zone is given. */
export function hostMonth(d: Date, locale: HostLocale, tz = "UTC"): string {
  return new Intl.DateTimeFormat(tag(locale), { timeZone: tz, month: "long", year: "numeric" }).format(d);
}

/** "3:30 pm" or "15:30". */
export const hostTime = (d: Date, tz: string, cycle: HourCycle, locale: HostLocale) => formatTime(d, tz, cycle, locale);

/** 125000 -> "1,25,000". */
export function hostNumber(n: number, locale: HostLocale): string {
  return new Intl.NumberFormat(tag(locale)).format(n);
}

/** Paise to rupees: 12550000 -> "₹1,25,500", 12345 -> "₹123.45". Whole rupees drop the paise, as formatMoney does. */
export function hostINR(minor: number, locale: HostLocale): string {
  const major = minor / 100;
  const digits = Number.isInteger(major) ? 0 : 2;
  return new Intl.NumberFormat(tag(locale), { style: "currency", currency: "INR", minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(major);
}

/** "15 Nov 2026" (dateStyle medium). */
export function hostMediumDate(d: Date, tz: string, locale: HostLocale): string {
  return new Intl.DateTimeFormat(tag(locale), { dateStyle: "medium", timeZone: tz }).format(d);
}

/** "15 Nov 2026, 3:30 pm" (dateStyle medium, timeStyle short). */
export function hostMediumDateTime(d: Date, tz: string, locale: HostLocale): string {
  return new Intl.DateTimeFormat(tag(locale), { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(d);
}

/** "Sat, 15 Nov 2026" for a calendar date "YYYY-MM-DD". English keeps the British order the availability page always used. */
export function hostDayDate(date: string, locale: HostLocale): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale === "en" ? "en-GB" : tag(locale), { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** "India Standard Time" for Asia/Kolkata, in the host's language; null when Intl has no name for the zone. */
export function hostZoneLongName(timezone: string, locale: HostLocale): string | null {
  const part = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : tag(locale), { timeZone: timezone, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
  return part?.value ?? null;
}

/** An amount in any currency: rupees as hostINR, others as formatAmount writes them (the same in every language). */
export function hostMoney(minor: number, currency: string | null | undefined, locale: HostLocale): string {
  return (currency ?? "INR").toUpperCase() === "INR" ? hostINR(minor, locale) : formatAmount(minor, currency);
}

/** "16 Nov" (day and short month). */
export function hostDayMonth(d: Date, tz: string, locale: HostLocale): string {
  return new Intl.DateTimeFormat(tag(locale), { day: "numeric", month: "short", timeZone: tz }).format(d);
}

export interface HostI18n {
  locale: HostLocale;
  t: (key: HostKey, vars?: Vars) => string;
  tNodes: (key: HostKey, nodes: Record<string, ReactNode>) => ReactNode[];
  date: (d: Date, tz: string) => string;
  shortDate: (d: Date, tz: string) => string;
  month: (d: Date, tz?: string) => string;
  time: (d: Date, tz: string, cycle?: HourCycle) => string;
  number: (n: number) => string;
  inr: (minor: number) => string;
  money: (minor: number, currency: string | null | undefined) => string;
  dayMonth: (d: Date, tz: string) => string;
  mediumDate: (d: Date, tz: string) => string;
  mediumDateTime: (d: Date, tz: string) => string;
  dayDate: (date: string) => string;
  zoneLongName: (timezone: string) => string | null;
}

/** Everything a page needs to speak the host's language, bound to one locale. Pure: works on the server and in the browser. */
export function makeHostI18n(locale: HostLocale): HostI18n {
  return {
    locale,
    t: (key, vars) => ht(locale, key, vars),
    tNodes: (key, nodes) => htNodes(locale, key, nodes),
    date: (d, tz) => hostDate(d, tz, locale),
    shortDate: (d, tz) => hostShortDate(d, tz, locale),
    month: (d, tz) => hostMonth(d, locale, tz),
    time: (d, tz, cycle = "12h") => hostTime(d, tz, cycle, locale),
    number: (n) => hostNumber(n, locale),
    inr: (minor) => hostINR(minor, locale),
    money: (minor, currency) => hostMoney(minor, currency, locale),
    dayMonth: (d, tz) => hostDayMonth(d, tz, locale),
    mediumDate: (d, tz) => hostMediumDate(d, tz, locale),
    mediumDateTime: (d, tz) => hostMediumDateTime(d, tz, locale),
    dayDate: (date) => hostDayDate(date, locale),
    zoneLongName: (timezone) => hostZoneLongName(timezone, locale),
  };
}
