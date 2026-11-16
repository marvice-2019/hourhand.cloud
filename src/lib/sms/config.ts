// Booking texts by SMS (roadmap 1.2). India only for now, through MSG91 on the DLT system TRAI requires: every text
// must match a template registered on a DLT portal, sent under a registered 6-letter header. A missing setting turns
// SMS off entirely: nothing is queued, nothing is sent, and the booking form doesn't offer it. There is no silent
// fallback to a half-configured provider.

export type SmsKind = "booked_guest" | "reminder_guest" | "cancelled_guest" | "rescheduled_guest";
export const SMS_KINDS: readonly SmsKind[] = ["booked_guest", "reminder_guest", "cancelled_guest", "rescheduled_guest"];
export const isSmsKind = (kind: string): kind is SmsKind => (SMS_KINDS as readonly string[]).includes(kind);

/** The one text reminder: a day ahead, like WhatsApp's. Each text is paid for, and the email reminders still go. */
export const SMS_REMINDER_MINUTES = 1440;

/** The languages that have their own DLT templates. Every other language gets the English text. */
export type SmsLang = "en" | "hi";

export interface SmsConfig {
  provider: "msg91";
  authKey: string;
  /** The DLT header (sender ID), six letters. */
  senderId: string;
  /** MSG91's template id per message and language. A missing Hindi id means Hindi guests get the English text. */
  templates: Record<SmsKind, Record<"en", string> & Partial<Record<"hi", string>>>;
  /** Shared secret the delivery-report webhook must present. */
  webhookSecret: string;
  baseUrl: string;
}

type Env = Record<string, string | undefined>;

const ENV_FOR: Record<SmsKind, string> = {
  booked_guest: "MSG91_TEMPLATE_BOOKED", reminder_guest: "MSG91_TEMPLATE_REMINDER",
  cancelled_guest: "MSG91_TEMPLATE_CANCELLED", rescheduled_guest: "MSG91_TEMPLATE_RESCHEDULED",
};

/** Null unless every setting is present and the header is a valid six-letter DLT header. */
export function smsConfig(env: Env = process.env): SmsConfig | null {
  if (env.SMS_PROVIDER !== "msg91") return null;
  const authKey = env.MSG91_AUTH_KEY, senderId = env.MSG91_SENDER_ID, webhookSecret = env.MSG91_WEBHOOK_SECRET;
  if (!authKey || !senderId || !webhookSecret || !/^[A-Z]{6}$/.test(senderId)) return null;
  const templates = {} as SmsConfig["templates"];
  for (const kind of SMS_KINDS) {
    const en = env[ENV_FOR[kind]], hi = env[`${ENV_FOR[kind]}_HI`];
    if (!en) return null;
    templates[kind] = hi ? { en, hi } : { en };
  }
  // The e2e run and the tests point this at a fake server; a real deployment always talks to MSG91.
  const fake = env.NODE_ENV !== "production" || env.HOURHAND_E2E === "1" ? env.MSG91_API_BASE_URL : undefined;
  return { provider: "msg91", authKey, senderId, templates, webhookSecret, baseUrl: fake || "https://control.msg91.com" };
}

/**
 * An Indian mobile number as MSG91 wants it (91 and ten digits), or null. Only Indian mobiles (6-9 then nine digits)
 * get texts: every other guest gets email, and WhatsApp if they ticked it.
 */
export function smsNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const plus = phone.trim().startsWith("+");
  let digits = phone.replace(/\D/g, "");
  if (!plus && digits.startsWith("00")) digits = digits.slice(2);
  else if (!plus && /^0?[6-9]\d{9}$/.test(digits)) digits = `91${digits.slice(-10)}`;
  return /^91[6-9]\d{9}$/.test(digits) ? digits : null;
}
