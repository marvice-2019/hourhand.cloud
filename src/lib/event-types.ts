// Pure validation for the event type editor. Limits mirror the checks on event_types and custom_questions in docs/schema.sql.
import type { Plan } from "./billing/plans";
import { LOCATION_KINDS, type DurationOption, type EventLocation, type EventType, type EventTypeDraft, type LocationKind, type QuestionDraft } from "./data/types";
import { cleanRedirectUrl } from "./calendar-links";
import { QUESTION_KINDS } from "./intake/conditions";
import { INTAKE_QUESTION_MESSAGES, checkIntakeFields } from "./intake/questions";
import { MAX_DURATION_OPTIONS } from "./durations";

export const DURATION = { min: 5, max: 720 } as const;
export const START_INCREMENTS = [5, 10, 15, 20, 30, 45, 60] as const;
export const BUFFER = { min: 0, max: 240 } as const;
export const BOOKING_WINDOW = { min: 1, max: 730 } as const;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;
/** /<host>/portal is the client portal and /<host>/opengraph-image the share card, so no event type can take those links. */
export const RESERVED_EVENT_SLUGS: ReadonlySet<string> = new Set(["portal", "opengraph-image"]);
export const SLUG_TAKEN = "That link is already used by another event type";
/** Guest prices in paise: ₹1 to ₹5,00,000. */
export const PRICE = { min: 100, max: 50_000_000 } as const;
export const PRICE_INVALID = "Enter a price in rupees, like 499 or 499.50 (at least ₹1).";

/** Locations whose value the host must fill in, with the label shown for that value. */
export const LOCATION_VALUE_LABEL: Partial<Record<LocationKind, string>> = {
  in_person: "Address",
  phone_guest_calls: "Your phone number",
  custom: "Location details",
};

/** What the editor sends. Numbers arrive as the strings typed into the inputs. */
export interface EventTypeForm {
  name: string;
  slug: string;
  durationMinutes: string;
  description: string;
  locationKind: LocationKind | "";
  locationValue: string;
  minNoticeMinutes: string;
  bookingWindowDays: string;
  startIncrementMinutes: string;
  bufferBeforeMinutes: string;
  bufferAfterMinutes: string;
  /** Blank means no limit. */
  dailyLimit: string;
  cancelCutoffMinutes: string;
  /** Most weeks a guest can book in one go; "1" means no repeats. */
  maxRepeats: string;
  /** Refundable no-show deposit in rupees as typed; blank means none. Free event types only. */
  deposit: string;
  /** Rupees as typed. Blank means free. */
  price: string;
  /** Left off the public profile; its own link still books. */
  hidden: boolean;
  /** Where guests go after booking; blank means they stay on the confirmation page. */
  redirectUrl?: string;
  /** Blank means no weekly limit. */
  weeklyLimit?: string;
  /** The host's cancellation policy; blank means none. */
  cancelPolicy?: string;
  /** Guests per session: blank or 1 is one-on-one, 2 to 500 makes it a group class. */
  seats?: string;
  /**
   * Other lengths the guest may pick instead of durationMinutes, each with an optional price in rupees (blank = the
   * event's price). Empty or left out = one length only.
   */
  durations?: { minutes: string; price: string }[];
}

/** The most guests a group class takes (event_types.seat_limit). */
export const MAX_SEATS = 500;

/** The most weeks a guest can book in one go (event_types.max_repeats). */
export const MAX_WEEKS = 12;

export type EventTypeErrors = Partial<Record<keyof EventTypeForm, string>>;
export type QuestionErrors = { label?: string; choices?: string; condition?: string; range?: string }[];

/**
 * Every message the validators below can give, by code, in English. The English goes in `errors` as before; the code
 * and its values go in `codes`, so the dashboard can show the same message in the host's language
 * (host catalogue key "eventTypes.err" + the code with a capital first letter).
 */
export const EVENT_TYPE_MESSAGES = {
  notBoolean: "Choose whether it shows on your booking page.",
  notText: "Enter text for this field.",
  locationUnknown: "Pick a location from the list.",
  nameMissing: "Give this event type a name.",
  slugEmpty: "Add a link using letters or numbers.",
  slugPattern: "Use lowercase letters, numbers and hyphens, starting with a letter or number (60 characters at most).",
  slugReserved: "That link is used by your booking page itself. Pick another.",
  slugTaken: SLUG_TAKEN,
  durationRange: "Pick a length between {min} and {max} minutes.",
  minutesZeroOrMore: "Enter 0 or more minutes.",
  windowRange: "Enter between {min} and {max} days.",
  startIncrement: "Pick one of the listed start times.",
  bufferRange: "Enter between {min} and {max} minutes.",
  limitOneOrMore: "Enter 1 or more, or leave it blank for no limit.",
  priceInvalid: PRICE_INVALID,
  repeatsRange: "Enter 1 (no repeats) up to {max} weeks.",
  repeatsPaid: "Weekly repeats work on free event types for now. Sell a package for paid sessions.",
  depositWithPrice: "A priced event doesn't need a deposit: the price already commits the guest. Leave one of them empty.",
  repeatsDeposit: "Weekly repeats can't take a deposit. Set repeats to 1, or remove the deposit.",
  locationValueAddress: "Add the address so guests know where to go.",
  locationValuePhone: "Add your phone number so guests know where to go.",
  locationValueDetails: "Add the location details so guests know where to go.",
  weeklyBelowDaily: "Make the weekly limit at least the daily one.",
  policyTooLong: "Keep the policy to 1,000 characters.",
  seatsRange: "Enter 2 to {max} guests for a group class, or leave it blank for one-on-one.",
  seatsPaid: "Group classes are free for now. Remove the price, or make it one-on-one.",
  seatsDeposit: "Group classes can't take a deposit yet. Remove the deposit, or make it one-on-one.",
  seatsRepeats: "Group classes are booked one week at a time for now. Set repeats to 1.",
  redirectUrl: "Enter a full https:// address, or leave it blank.",
  questionLabel: "Write the question guests will see.",
  questionKind: "Pick a kind of answer.",
  questionChoices: "Add at least two choices, one per line.",
  durationsText: "Enter each length in minutes.",
  durationsTooMany: "Offer up to {max} lengths in all.",
  durationsRange: "Each length is between {min} and {max} minutes.",
  durationsTwice: "{minutes} minutes is listed twice. Give each length once.",
  durationsPriceFirst: "Set the event's price first; a length's own price replaces it for that length.",
  durationsGroup: "A group class runs for one length. Remove the other lengths, or make it one-on-one.",
  ...INTAKE_QUESTION_MESSAGES,
} as const;
export type EventTypeErrorCode = keyof typeof EVENT_TYPE_MESSAGES;
export interface CodedError { code: EventTypeErrorCode; vars?: Record<string, number> }
export type EventTypeErrorCodes = Partial<Record<keyof EventTypeForm, CodedError>>;
export type QuestionErrorCodes = { label?: CodedError; choices?: CodedError; condition?: CodedError; range?: CodedError }[];

/** The English line for a code, with its values filled in. */
export const eventTypeMessage = ({ code, vars = {} }: CodedError): string =>
  EVENT_TYPE_MESSAGES[code].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const LOCATION_VALUE_CODE: Partial<Record<LocationKind, EventTypeErrorCode>> = {
  in_person: "locationValueAddress", phone_guest_calls: "locationValuePhone", custom: "locationValueDetails",
};

/** "45-min Coaching Session!" -> "45-min-coaching-session". */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

function whole(raw: string): number | null {
  const t = raw.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** "499.50" -> 49950 paise; "" -> null (free); anything else or outside ₹1 to ₹5,00,000 -> "invalid". No floats, so no rounding error. */
export function parsePrice(raw: string): number | null | "invalid" {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return "invalid";
  const [rupees, paise = ""] = t.split(".");
  const minor = Number(rupees) * 100 + Number(paise.padEnd(2, "0"));
  return minor < PRICE.min || minor > PRICE.max ? "invalid" : minor;
}

/** Paise back to what the host typed: 49900 -> "499", 49950 -> "499.50". */
export function priceInput(minor: number | null): string {
  if (minor === null) return "";
  const paise = minor % 100;
  return paise === 0 ? String(minor / 100) : `${Math.floor(minor / 100)}.${String(paise).padStart(2, "0")}`;
}

/**
 * Why this host may not charge guests yet, or null when they may. Charging is a paid-plan feature and the money goes to
 * the host's own Razorpay or Stripe account (Stripe only once its onboarding is finished). Making an event free is always allowed.
 */
export function priceGateError(input: { priceMinor: number | null; demo: boolean; plan: Plan; paymentsReady: boolean }): string | null {
  if (input.priceMinor === null) return null;
  if (input.demo) return "Prices can't be set on the demo data.";
  if (input.plan === "free") return "Charging guests needs the Solo or Duo plan.";
  if (!input.paymentsReady) return "Connect Razorpay (India) or Stripe under Integrations first, so payments go to your account.";
  return null;
}

/** Checks the form against the schema limits. `takenSlugs` are the user's other event type slugs. */
/** Postgres `int` holds up to this; a larger number is a field error, not a failed save. */
const INT_MAX = 2147483647;

export function validateEventType(form: EventTypeForm, takenSlugs: readonly string[]):
  { ok: true; value: EventTypeDraft } | { ok: false; errors: EventTypeErrors } {
  const r = checkEventType(form, takenSlugs);
  return r.ok ? r : { ok: false, errors: r.errors };
}

/** validateEventType plus each message's code, for showing the errors in the host's language. */
export function checkEventType(form: EventTypeForm, takenSlugs: readonly string[]):
  { ok: true; value: EventTypeDraft } | { ok: false; errors: EventTypeErrors; codes: EventTypeErrorCodes } {
  const errors: EventTypeErrors = {};
  const codes: EventTypeErrorCodes = {};
  const fail = (field: keyof EventTypeForm, code: EventTypeErrorCode, vars?: Record<string, number>) => {
    codes[field] = vars ? { code, vars } : { code };
    errors[field] = eventTypeMessage(codes[field]);
  };

  // The form arrives from the client, so check every field is text before using string methods on it.
  for (const key of Object.keys(NEW_EVENT_TYPE_FORM) as (keyof EventTypeForm)[]) {
    if (key === "hidden") {
      // A checkbox: true or false (an older client may leave it out, which means shown).
      if (form.hidden !== undefined && typeof form.hidden !== "boolean") fail("hidden", "notBoolean");
    } else if (key === "durations") {
      const d = form.durations;
      if (d !== undefined && (!Array.isArray(d) || d.length > 20 || d.some((r) => typeof r !== "object" || r === null || typeof r.minutes !== "string" || typeof r.price !== "string"))) {
        fail("durations", "durationsText");
      }
    } else if (key === "redirectUrl" || key === "weeklyLimit" || key === "cancelPolicy" || key === "seats") {
      // Optional, so an older client may leave them out.
      if (form[key] !== undefined && typeof form[key] !== "string") fail(key, "notText");
    } else if (typeof form[key] !== "string") fail(key, "notText");
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors, codes };

  if (form.locationKind && !LOCATION_KINDS.includes(form.locationKind)) fail("locationKind", "locationUnknown");

  const name = form.name.trim();
  if (!name) fail("name", "nameMissing");

  const slug = form.slug.trim() ? form.slug.trim().toLowerCase() : slugify(name);
  if (!slug) {
    if (name) fail("slug", "slugEmpty");
  } else if (!SLUG_PATTERN.test(slug)) {
    fail("slug", "slugPattern");
  } else if (RESERVED_EVENT_SLUGS.has(slug)) {
    fail("slug", "slugReserved");
  } else if (takenSlugs.includes(slug)) {
    fail("slug", "slugTaken");
  }

  const number = (key: Exclude<keyof EventTypeForm, "hidden" | "redirectUrl" | "cancelPolicy" | "durations">, min: number, max: number, code: EventTypeErrorCode, vars?: Record<string, number>): number => {
    const n = whole(form[key] ?? "");
    if (n === null || n < min || n > max) fail(key, code, vars);
    return n ?? 0;
  };

  const durationMinutes = number("durationMinutes", DURATION.min, DURATION.max, "durationRange", { min: DURATION.min, max: DURATION.max });
  const minNoticeMinutes = number("minNoticeMinutes", 0, INT_MAX, "minutesZeroOrMore");
  const bookingWindowDays = number("bookingWindowDays", BOOKING_WINDOW.min, BOOKING_WINDOW.max, "windowRange", { min: BOOKING_WINDOW.min, max: BOOKING_WINDOW.max });
  const startIncrementMinutes = number("startIncrementMinutes", 0, 60, "startIncrement");
  if (!errors.startIncrementMinutes && !(START_INCREMENTS as readonly number[]).includes(startIncrementMinutes)) {
    fail("startIncrementMinutes", "startIncrement");
  }
  const bufferBeforeMinutes = number("bufferBeforeMinutes", BUFFER.min, BUFFER.max, "bufferRange", { min: BUFFER.min, max: BUFFER.max });
  const bufferAfterMinutes = number("bufferAfterMinutes", BUFFER.min, BUFFER.max, "bufferRange", { min: BUFFER.min, max: BUFFER.max });
  const cancelCutoffMinutes = number("cancelCutoffMinutes", 0, INT_MAX, "minutesZeroOrMore");
  const dailyLimit = form.dailyLimit.trim() ? number("dailyLimit", 1, INT_MAX, "limitOneOrMore") : null;

  const price = parsePrice(form.price);
  if (price === "invalid") fail("price", "priceInvalid");
  const priceMinor = price === "invalid" ? null : price;
  const maxRepeats = number("maxRepeats", 1, MAX_WEEKS, "repeatsRange", { max: MAX_WEEKS });
  if (!errors.maxRepeats && maxRepeats > 1 && priceMinor !== null) fail("maxRepeats", "repeatsPaid");
  const deposit = parsePrice(form.deposit);
  if (deposit === "invalid") fail("deposit", "priceInvalid");
  const depositMinor = deposit === "invalid" ? null : deposit;
  if (!errors.deposit && depositMinor !== null && priceMinor !== null) fail("deposit", "depositWithPrice");
  if (!errors.maxRepeats && !errors.deposit && depositMinor !== null && maxRepeats > 1) fail("maxRepeats", "repeatsDeposit");

  const valueLabel = form.locationKind ? LOCATION_VALUE_LABEL[form.locationKind] : undefined;
  const locationValue = form.locationValue.trim();
  const valueCode = form.locationKind ? LOCATION_VALUE_CODE[form.locationKind] : undefined;
  if (valueLabel && valueCode && !locationValue) fail("locationValue", valueCode);

  const weeklyLimit = (form.weeklyLimit ?? "").trim() ? number("weeklyLimit", 1, INT_MAX, "limitOneOrMore") : null;
  if (!errors.weeklyLimit && !errors.dailyLimit && weeklyLimit !== null && dailyLimit !== null && weeklyLimit < dailyLimit) fail("weeklyLimit", "weeklyBelowDaily");
  const cancelPolicy = (form.cancelPolicy ?? "").trim().replace(/\r\n/g, "\n");
  if (cancelPolicy.length > 1000) fail("cancelPolicy", "policyTooLong");
  const seatsRaw = (form.seats ?? "").trim();
  const seats = seatsRaw && seatsRaw !== "1" ? number("seats", 2, MAX_SEATS, "seatsRange", { max: MAX_SEATS }) : null;
  if (seats !== null && !errors.seats) {
    // Group classes start free and single-week; paid seats, deposits and repeats come later.
    if (priceMinor !== null) fail("seats", "seatsPaid");
    else if (depositMinor !== null) fail("seats", "seatsDeposit");
    else if (maxRepeats > 1) fail("seats", "seatsRepeats");
  }
  const durationOptions = errors.durations ? [] : validateDurations(form.durations ?? [], durationMinutes, priceMinor, (code, vars) => fail("durations", code, vars));
  if (durationOptions.length > 0 && seats !== null && !errors.seats && !errors.durations) fail("durations", "durationsGroup");
  const redirectUrl = cleanRedirectUrl(form.redirectUrl ?? "");
  if (redirectUrl === undefined) fail("redirectUrl", "redirectUrl");

  if (Object.keys(errors).length > 0) return { ok: false, errors, codes };
  return {
    ok: true,
    value: {
      name, slug, description: form.description.trim() || null, durationMinutes, minNoticeMinutes, bookingWindowDays,
      startIncrementMinutes, bufferBeforeMinutes, bufferAfterMinutes, dailyLimit, cancelCutoffMinutes, maxRepeats, depositMinor,
      priceMinor, currency: priceMinor === null && depositMinor === null ? null : "INR", hidden: form.hidden === true, redirectUrl: redirectUrl ?? null, weeklyLimit, cancelPolicy: cancelPolicy || null,
      seatLimit: seats, durationOptions,
      location: form.locationKind ? { kind: form.locationKind, value: valueLabel ? locationValue : null } : null,
    },
  };
}

/**
 * The other lengths the host typed, as the event type's full list of options (the main length included, shortest
 * first), or [] when there are none. Problems go into `errors.durations`.
 */
function validateDurations(
  rows: { minutes: string; price: string }[], main: number, priceMinor: number | null, fail: (code: EventTypeErrorCode, vars?: Record<string, number>) => void,
): DurationOption[] {
  const filled = rows.filter((r) => r.minutes.trim() || r.price.trim());
  if (filled.length === 0) return [];
  if (filled.length + 1 > MAX_DURATION_OPTIONS) {
    fail("durationsTooMany", { max: MAX_DURATION_OPTIONS });
    return [];
  }
  const options: DurationOption[] = [{ minutes: main, priceMinor: null }];
  for (const r of filled) {
    const minutes = whole(r.minutes);
    if (minutes === null || minutes < DURATION.min || minutes > DURATION.max) {
      fail("durationsRange", { min: DURATION.min, max: DURATION.max });
      return [];
    }
    if (options.some((o) => o.minutes === minutes)) {
      fail("durationsTwice", { minutes });
      return [];
    }
    const price = parsePrice(r.price);
    if (price === "invalid") {
      fail("priceInvalid");
      return [];
    }
    if (price !== null && priceMinor === null) {
      fail("durationsPriceFirst");
      return [];
    }
    options.push({ minutes, priceMinor: price });
  }
  return options.sort((a, b) => a.minutes - b.minutes);
}

/** Starting values for a new event type: the schema defaults, 30 minutes on Google Meet. */
export const NEW_EVENT_TYPE_FORM: EventTypeForm = {
  name: "", slug: "", durationMinutes: "30", description: "", locationKind: "google_meet", locationValue: "", minNoticeMinutes: "240",
  bookingWindowDays: "60", startIncrementMinutes: "30", bufferBeforeMinutes: "0", bufferAfterMinutes: "0", dailyLimit: "", cancelCutoffMinutes: "0", maxRepeats: "1", deposit: "",
  price: "", hidden: false, redirectUrl: "", weeklyLimit: "", cancelPolicy: "", seats: "", durations: [],
};

/** The editor's values for a saved event type and its first location. */
export function toForm(et: EventType, location: EventLocation | undefined): EventTypeForm {
  return {
    name: et.name, slug: et.slug, durationMinutes: String(et.durationMinutes), description: et.description ?? "",
    locationKind: location?.kind ?? "", locationValue: location?.value ?? "", minNoticeMinutes: String(et.minNoticeMinutes),
    bookingWindowDays: String(et.bookingWindowDays), startIncrementMinutes: String(et.startIncrementMinutes),
    bufferBeforeMinutes: String(et.bufferBeforeMinutes), bufferAfterMinutes: String(et.bufferAfterMinutes),
    dailyLimit: et.dailyLimit === null ? "" : String(et.dailyLimit), cancelCutoffMinutes: String(et.cancelCutoffMinutes), maxRepeats: String(et.maxRepeats), deposit: priceInput(et.depositMinor),
    price: priceInput(et.priceMinor), hidden: et.hidden, redirectUrl: et.redirectUrl ?? "",
    weeklyLimit: et.weeklyLimit === null ? "" : String(et.weeklyLimit), cancelPolicy: et.cancelPolicy ?? "",
    seats: et.seatLimit === null ? "" : String(et.seatLimit),
    durations: et.durationOptions.filter((o) => o.minutes !== et.durationMinutes).map((o) => ({ minutes: String(o.minutes), price: priceInput(o.priceMinor) })),
  };
}


/** Checks each question; the error list lines up with the input list. */
export function validateQuestions(questions: readonly QuestionDraft[]):
  { ok: true; value: QuestionDraft[] } | { ok: false; errors: QuestionErrors } {
  const r = checkQuestions(questions);
  return r.ok ? r : { ok: false, errors: r.errors };
}

/** validateQuestions plus each message's code. */
export function checkQuestions(questions: readonly QuestionDraft[]):
  { ok: true; value: QuestionDraft[] } | { ok: false; errors: QuestionErrors; codes: QuestionErrorCodes } {
  let ok = true;
  const value: QuestionDraft[] = [];
  const codes: QuestionErrorCodes = [];
  const errors: QuestionErrors = questions.map((q, index) => {
    const e: QuestionErrors[number] = {};
    const c: QuestionErrorCodes[number] = {};
    codes.push(c);
    const label = typeof q.label === "string" ? q.label.trim() : "";
    if (!label) c.label = { code: "questionLabel" };
    if (!QUESTION_KINDS.includes(q.kind)) c.label = { code: "questionKind" };
    const isSelect = q.kind === "single_select" || q.kind === "multi_select";
    const choices = isSelect && Array.isArray(q.choices) ? q.choices.map((x) => String(x).trim()).filter(Boolean) : [];
    if (isSelect && choices.length < 2) c.choices = { code: "questionChoices" };
    // Conditions, first-booking-only and number bounds: src/lib/intake/questions.ts.
    const extra = checkIntakeFields(q, index, value);
    if (extra.errors.condition) c.condition = { code: extra.errors.condition };
    if (extra.errors.range) c.range = { code: extra.errors.range };
    for (const k of ["label", "choices", "condition", "range"] as const) if (c[k]) e[k] = eventTypeMessage(c[k]!);
    if (e.label || e.choices || e.condition || e.range) ok = false;
    value.push({ id: q.id, label, kind: q.kind, required: q.required === true, choices, ...extra.value });
    return e;
  });
  return ok ? { ok: true, value } : { ok: false, errors, codes };
}
