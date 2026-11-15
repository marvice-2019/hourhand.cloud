import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { parseKey } from "../crypto/seal";

// Links in the follow-up email: a feedback link (one booking, expires 30 days after it was issued) and an opt-out link
// (one host and one guest email, no expiry, like any unsubscribe link). Both are signed so nobody can make one for
// another booking or address; neither needs a login. Single use for feedback is enforced by the database (one answer
// per booking), not by the token.

export const FEEDBACK_LINK_DAYS = 30;
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The signing key, derived from TOKEN_ENCRYPTION_KEY with HKDF so it is never the encryption key itself. Throws when
 * TOKEN_ENCRYPTION_KEY is missing or malformed; the worker then skips follow-ups with that reason.
 */
export function linkKey(raw: string | undefined = process.env.TOKEN_ENCRYPTION_KEY): Buffer {
  return Buffer.from(hkdfSync("sha256", parseKey(raw), Buffer.alloc(0), "hourhand follow-up links v1", 32));
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const sign = (key: Buffer, purpose: string, body: string) => createHmac("sha256", key).update(`${purpose}|${body}`).digest().subarray(0, 18).toString("base64url");

function sigOk(key: Buffer, purpose: string, body: string, sig: string): boolean {
  const want = Buffer.from(sign(key, purpose, body));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** `f.<bookingId>.<expires, unix seconds>.<signature>` */
export function feedbackToken(key: Buffer, bookingId: string, issuedAt: Date): string {
  const exp = Math.floor((issuedAt.getTime() + FEEDBACK_LINK_DAYS * DAY) / 1000);
  const body = `${bookingId}.${exp}`;
  return `f.${body}.${sign(key, "feedback", body)}`;
}

export type FeedbackTokenCheck = { ok: true; bookingId: string } | { ok: false; reason: "invalid" | "expired" };

/** The signature is checked before the expiry, so a forged token always reads as invalid, never as "expired". */
export function readFeedbackToken(key: Buffer, token: unknown, now: Date): FeedbackTokenCheck {
  if (typeof token !== "string" || token.length > 200) return { ok: false, reason: "invalid" };
  const m = /^f\.([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{24})$/i.exec(token);
  if (!m || !UUID.test(m[1]) || !sigOk(key, "feedback", `${m[1]}.${m[2]}`, m[3])) return { ok: false, reason: "invalid" };
  if (Number(m[2]) * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, bookingId: m[1].toLowerCase() };
}

/** `o.<hostId>.<email, base64url>.<signature>` */
export function optOutToken(key: Buffer, hostId: string, email: string): string {
  const body = `${hostId}.${b64(email.trim().toLowerCase())}`;
  return `o.${body}.${sign(key, "opt-out", body)}`;
}

export function readOptOutToken(key: Buffer, token: unknown): { hostId: string; email: string } | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const m = /^o\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{1,500})\.([A-Za-z0-9_-]{24})$/i.exec(token);
  if (!m || !UUID.test(m[1]) || !sigOk(key, "opt-out", `${m[1]}.${m[2]}`, m[3])) return null;
  return { hostId: m[1].toLowerCase(), email: unb64(m[2]) };
}
