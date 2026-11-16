import { intlTag } from "../i18n/guest";
import type { SmsKind, SmsLang } from "./config";

// The texts. Each must match, word for word, a content template registered on a DLT portal: operators compare every
// text against its template and drop any that don't match. {booking}, {when} and {code} are the template's three
// {#var#} slots, in order (TRAI allows three variables per template without extra justification, each up to 30
// characters). {link} is the fixed address before the code and part of the registered text: TRAI only lets whitelisted
// links through. docs/deploy.md lists the exact texts to register; dltText() makes them, and a test checks they agree.

export const TEMPLATES: Record<SmsKind, Record<SmsLang, string>> = {
  booked_guest: {
    en: "Your {booking} is booked for {when}. To change or cancel: {link}{code}",
    hi: "आपका {booking} {when} के लिए बुक है। बदलने या रद्द करने के लिए: {link}{code}",
  },
  reminder_guest: {
    en: "Reminder: your {booking} is on {when}. To change or cancel: {link}{code}",
    hi: "याद दिला दें: आपका {booking} {when} को है। बदलने या रद्द करने के लिए: {link}{code}",
  },
  cancelled_guest: {
    en: "Your {booking} on {when} is cancelled. To book again: {link}{code}",
    hi: "{when} का आपका {booking} रद्द हो गया है। फिर से बुक करने के लिए: {link}{code}",
  },
  rescheduled_guest: {
    en: "Your {booking} has moved to {when}. To change or cancel: {link}{code}",
    hi: "आपका {booking} अब {when} को है। बदलने या रद्द करने के लिए: {link}{code}",
  },
};

type Var = "booking" | "when" | "code";
const SLOT = /\{(booking|when|code)\}/g;

/** DLT caps each {#var#} at 30 characters. */
export const DLT_VAR_MAX = 30;
/** Characters in a short code: 12 of 62 letters and digits, about 71 bits, so the manage page can't be guessed. */
export const CODE_LENGTH = 12;
/**
 * The most segments one text may take. English fits one (160 GSM characters). Hindi is Unicode, 70 characters for a
 * single segment and 67 per segment once split; no booking text fits 70, so Hindi gets three. An English text with a
 * name in another script turns Unicode too, and gets the same three.
 */
export const MAX_SEGMENTS = { gsm: 1, unicode: 3 } as const;

// GSM 03.38: the basic set counts one, the extension set two (it's sent as escape + character).
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";

export function isGsm(text: string): boolean {
  for (const ch of text) if (!GSM_BASIC.includes(ch) && !GSM_EXT.includes(ch)) return false;
  return true;
}

/** Length as the network counts it: GSM septets, or UTF-16 code units for Unicode. */
export function smsLength(text: string): number {
  if (!isGsm(text)) return text.length;
  let n = 0;
  for (const ch of text) n += GSM_EXT.includes(ch) ? 2 : 1;
  return n;
}

/** Segments a text is billed as: 160/153 GSM characters, 70/67 Unicode. */
export function segments(text: string): number {
  const n = smsLength(text);
  if (isGsm(text)) return n <= 160 ? 1 : Math.ceil(n / 153);
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

/** The longest text that fits its budget: one GSM segment is 160; three Unicode segments are 3 × 67. */
const maxLength = (gsm: boolean) => (gsm ? 160 * MAX_SEGMENTS.gsm : 67 * MAX_SEGMENTS.unicode);

/** "https://hourhand.cloud/m/": the fixed part of every text's link. */
export function linkPrefix(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/m/`;
}

/** The text to register on the DLT portal, with {#var#} in each slot. */
export function dltText(kind: SmsKind, lang: SmsLang, baseUrl: string): string {
  return TEMPLATES[kind][lang].replace("{link}", linkPrefix(baseUrl)).replace(SLOT, "{#var#}");
}

export interface SmsContext {
  guestName: string;
  hostName: string;
  eventName: string;
  startAt: Date;
  guestTimezone: string;
  /** The language the guest booked in. Only Hindi has its own texts. */
  locale: string;
  /** The booking's short code: the link opens /m/<code>. */
  code: string;
}

/** "Mon, 16 Nov, 3:30 pm IST" in the guest's zone; GMT+4 and the like outside India. Plain spaces only (GSM). */
export function smsWhen(at: Date, tz: string, lang: SmsLang): string {
  const date = new Intl.DateTimeFormat(intlTag(lang), { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(at);
  const time = new Intl.DateTimeFormat(intlTag(lang), { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(at).toLowerCase();
  const zone = tz === "Asia/Kolkata" ? "IST"
    : new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "UTC";
  return `${date}, ${time} ${zone}`.replace(/[\s  ]+/g, " ").trim();
}

export interface FilledSms {
  lang: SmsLang;
  /** The values of the template's {#var#} slots, in order. */
  vars: string[];
  /** The text the guest will read, for length checks and the logs. */
  text: string;
  segments: number;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** Cuts at `n` characters (by code point, so a Devanagari letter isn't split in half), without trailing spaces. */
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("").trim();

/** "Coaching with Priya" (Hindi: "Priya के साथ Coaching"), the first slot. */
function bookingName(c: SmsContext, lang: SmsLang, eventMax: number, hostMax: number): string {
  const event = cut(clean(c.eventName), eventMax) || "booking", host = cut(clean(c.hostName), hostMax);
  if (!host) return event;
  return lang === "hi" ? `${host} के साथ ${event}` : `${event} with ${host}`;
}

/**
 * Fills a template. The first slot is "<event> with <host>"; while it is over DLT's 30 characters, or the text over its
 * segment budget, the longer of event and host loses a character (down to 3 each). The time and the code are never cut.
 */
export function fillSms(kind: SmsKind, c: SmsContext, baseUrl: string): FilledSms {
  const lang: SmsLang = c.locale === "hi" ? "hi" : "en";
  const template = TEMPLATES[kind][lang].replace("{link}", linkPrefix(baseUrl));
  let eventMax = Array.from(clean(c.eventName)).length, hostMax = Array.from(clean(c.hostName)).length;
  const order = [...template.matchAll(SLOT)].map((m) => m[1] as Var);
  const when = cut(smsWhen(c.startAt, c.guestTimezone, lang), DLT_VAR_MAX);
  for (;;) {
    const values: Record<Var, string> = { booking: bookingName(c, lang, eventMax, hostMax), when, code: c.code };
    const text = template.replace(SLOT, (_, k: Var) => values[k]);
    if (Array.from(values.booking).length <= DLT_VAR_MAX && smsLength(text) <= maxLength(isGsm(text))) {
      return { lang, vars: order.map((k) => values[k]), text, segments: segments(text) };
    }
    if (eventMax <= 3 && hostMax <= 3) throw new Error(`SMS ${kind}/${lang} can't fit its limits`);
    if (eventMax >= hostMax) eventMax--; else hostMax--;
  }
}
