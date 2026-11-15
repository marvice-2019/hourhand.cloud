import { randomInt } from "node:crypto";
import type pg from "pg";
import { hostPlan } from "../billing/account";
import { LIMITS } from "../billing/plans";
import { isSmsKind, smsConfig, smsNumber, type SmsConfig, type SmsKind } from "./config";
import { smsProvider } from "./provider";
import { CODE_LENGTH, fillSms } from "./templates";

// SMS rows in the notifications outbox (channel 'sms'). Rules: a text goes only to an Indian mobile whose guest ticked
// "text me", that hasn't been turned off on the manage page or blocked through DLT, and only when the same message isn't
// going on WhatsApp. WhatsApp wins when the guest ticked both; a WhatsApp message that can't go falls back to a text.

type Db = Pick<pg.PoolClient, "query">;

/** Who a booking's texts go to, or null for none: SMS set up, the guest's tick, an Indian mobile, not opted out. */
export async function smsRecipient(db: Db, phone: string | null, optedIn: boolean, enabled = smsConfig() !== null): Promise<string | null> {
  const to = enabled && optedIn ? smsNumber(phone) : null;
  if (!to) return null;
  return (await db.query("select 1 from sms_opt_outs where phone = $1", [to])).rowCount ? null : to;
}

/** The text's dedupe key, from the WhatsApp message it stands in for (or would have): one message, one channel. */
export const smsKeyFor = (waKey: string) => waKey.replace(":wa:", ":sms:");
const waKeyFor = (smsKey: string) => smsKey.replace(":sms:", ":wa:");

/**
 * A WhatsApp message that can't go (the host's plan or limit, a STOP, a refusal, a failed delivery): queue the same
 * message as a text instead, now, if the guest also ticked SMS. The text's own checks still run when it sends.
 */
export async function queueSmsFallback(db: Db, notificationId: string, now: Date, enabled = smsConfig() !== null): Promise<boolean> {
  if (!enabled) return false;
  const { rows: [w] } = await db.query(
    `select n.booking_id, n.user_id, n.kind, n.dedupe_key, i.phone, i.sms_opt_in_at is not null as sms_opt_in
     from notifications n join invitees i on i.booking_id = n.booking_id where n.id = $1 and n.channel = 'whatsapp'`, [notificationId]);
  if (!w || !isSmsKind(w.kind) || !w.dedupe_key.includes(":wa:")) return false;
  const to = await smsRecipient(db, w.phone, w.sms_opt_in, enabled);
  if (!to) return false;
  const { rowCount } = await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     values ($1, $2, 'sms', $3, $4, $5, $6) on conflict (dedupe_key) do nothing`,
    [w.booking_id, w.user_id, w.kind, to, now, smsKeyFor(w.dedupe_key)]);
  return (rowCount ?? 0) > 0;
}

/** This calendar month in India, where the plans are sold. */
const MONTH_START = "(date_trunc('month', $2::timestamptz at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')";

/** Texts a host's guests have been sent this month (IST). */
export async function smsUsedThisMonth(db: Db, userId: string, now: Date): Promise<number> {
  const { rows: [r] } = await db.query(
    `select count(*)::int as n from notifications where user_id = $1 and channel = 'sms' and status = 'sent' and sent_at >= ${MONTH_START}`, [userId, now]);
  return r.n;
}

interface SmsRow { id: string; booking_id: string | null; user_id: string; kind: string; recipient: string; dedupe_key: string }

/** Why a text shouldn't go (checked as it sends), or null. */
export async function smsSkipReason(db: Db, c: SmsRow, cfg: SmsConfig | null, now: Date): Promise<string | null> {
  if (!cfg) return "SMS is not configured on this server";
  if (!isSmsKind(c.kind)) return "not an SMS message";
  if (!smsNumber(c.recipient)) return "not an Indian mobile number";
  if ((await db.query("select 1 from sms_opt_outs where phone = $1", [c.recipient])).rowCount) return "number is blocked for texts (DLT opt-out)";
  const { rows: [i] } = await db.query("select sms_opt_in_at is not null as on from invitees where booking_id = $1", [c.booking_id]);
  if (!i?.on) return "guest turned off text messages";
  // Never both: the same message already went, or is still to go, on WhatsApp.
  const { rowCount: onWhatsApp } = await db.query("select 1 from notifications where dedupe_key = $1 and status in ('queued', 'sent')", [waKeyFor(c.dedupe_key)]);
  if (onWhatsApp) return "sent on WhatsApp instead";
  const limit = LIMITS[await hostPlan(db, c.user_id)].smsPerMonth;
  if (limit === 0) return "the host's plan doesn't include SMS";
  return (await smsUsedThisMonth(db, c.user_id, now)) >= limit ? `monthly SMS limit reached (${limit})` : null;
}

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function newSmsCode(): string {
  return Array.from({ length: CODE_LENGTH }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
}

/** The booking's short code, made on its first text. */
export async function smsCodeFor(db: Db, bookingId: string): Promise<string> {
  const { rows: [r] } = await db.query("update invitees set sms_code = coalesce(sms_code, $2) where booking_id = $1 returning sms_code", [bookingId, newSmsCode()]);
  if (!r) throw new Error("booking has no invitee");
  return r.sms_code as string;
}

export interface SmsSendContext { guestName: string; hostName: string; eventName: string; startAt: Date; guestTimezone: string; locale: string }

/** Fills and sends one text; returns the provider's id. Throws SmsError when the provider refuses or is down. */
export async function sendBookingSms(
  db: Db, cfg: SmsConfig, c: SmsRow, ctx: SmsSendContext, baseUrl: string, fetchFn: typeof fetch = fetch,
): Promise<string> {
  const code = await smsCodeFor(db, c.booking_id!);
  const filled = fillSms(c.kind as SmsKind, { ...ctx, code }, baseUrl);
  // A Hindi text with no Hindi template set up goes in English: a text off its template would be dropped by the operator.
  const usable = filled.lang === "hi" && !cfg.templates[c.kind as SmsKind].hi ? fillSms(c.kind as SmsKind, { ...ctx, code, locale: "en" }, baseUrl) : filled;
  const { id } = await smsProvider(cfg, fetchFn).send({ to: c.recipient, kind: c.kind as SmsKind, filled: usable });
  return id;
}
