import { randomBytes, randomUUID } from "node:crypto";

// The small, pure parts of referrals: codes, cookies, and the email comparison used by the self-referral rule.

export const REFERRAL_COOKIE = "hh_ref";
export const DEVICE_COOKIE = "hh_dev";
export const DAY_MS = 86_400_000;
/** How long a referral link counts after it is opened, and how far back a shared device counts as the same person. */
export const REFERRAL_WINDOW_DAYS = 30;
/** At most this many rewarded referrals per referrer in any 12 months. */
export const YEARLY_REWARD_CAP = 12;

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o, 1/l: read aloud and typed from a screenshot
export const CODE_RE = /^[a-z0-9]{10}$/;

/** A random 10-character code (about 50 bits). Not derived from the host's name or slug. */
export function newReferralCode(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function newDeviceId(): string {
  return randomUUID();
}

export const isDeviceId = (v: string | undefined | null): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

/** The referral cookie holds the code and when the link was opened, so the 30 days are checked on the server too. */
export function referralCookieValue(code: string, openedAt: Date): string {
  return `${code}.${openedAt.getTime()}`;
}

/** The code from a referral cookie still inside its 30 days, or null. */
export function parseReferralCookie(value: string | undefined | null, now: Date): string | null {
  const m = /^([a-z0-9]{10})\.(\d{10,15})$/.exec(value ?? "");
  if (!m) return null;
  const openedAt = Number(m[2]);
  if (openedAt > now.getTime() + 60_000) return null; // from the future: not ours
  return now.getTime() - openedAt <= REFERRAL_WINDOW_DAYS * DAY_MS ? m[1] : null;
}

/** Reads one cookie from a Cookie header. */
export function cookieFrom(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/**
 * One mailbox, however it's written: lower case, no "+tag", and for Gmail no dots (Gmail ignores them). Two addresses
 * on the same domain are still different people (a team at one company may refer each other).
 */
export function normaliseEmail(email: string): string {
  const [rawLocal, rawDomain = ""] = email.trim().toLowerCase().split("@");
  let local = rawLocal.split("+")[0];
  let domain = rawDomain;
  if (GMAIL.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}
