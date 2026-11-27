// B11: the 6-digit codes a guest enters to prove their email before booking (docs/specs/B11-verify-guest-email.md).
// Only an HMAC of each code is stored, keyed by a server secret and bound to the event type and address.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/** Codes work for this long after they're sent. */
export const GUEST_EMAIL_CODE_MINUTES = 10;
/** Wrong tries before a code ends. */
export const GUEST_EMAIL_CODE_TRIES = 5;

/** A fresh 6-digit code, leading zeros kept. */
export function newGuestEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Hash of a code for one event type and address (any case), as stored and compared. */
export function hashGuestEmailCode(code: string, eventTypeId: string, email: string, secret: string): string {
  return createHmac("sha256", secret).update(`guest-email-code:${eventTypeId}:${email.toLowerCase()}:${code}`).digest("hex");
}

/** Compares two stored hashes in constant time. */
export function sameGuestEmailCodeHash(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The key for code hashes: GUEST_EMAIL_CODE_SECRET or else BETTER_AUTH_SECRET (both server-only). */
export function guestEmailCodeSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.GUEST_EMAIL_CODE_SECRET || env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET (or GUEST_EMAIL_CODE_SECRET) must be set to check guests' email codes");
  return secret;
}
