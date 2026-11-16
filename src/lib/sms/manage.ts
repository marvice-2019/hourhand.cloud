import type pg from "pg";
import { SMS_REMINDER_MINUTES, smsNumber } from "./config";
import { smsRecipient } from "./outbox";

// The guest's own switch for booking texts, on the manage page. Off: the booking's queued texts are dropped and no more
// are queued. On again (or on for the first time, for an Indian mobile on the booking): the texts that the switch
// dropped and are still ahead go back in the queue.

const TURNED_OFF = "guest turned off text messages";

type Result = { status: number; body: Record<string, unknown> };

export async function handleSmsToggle(pool: pg.Pool, token: string, input: unknown, now: Date): Promise<Result> {
  const on = (input as { on?: unknown } | null)?.on;
  if (typeof on !== "boolean") return { status: 400, body: { error: "invalid_request", fields: { on: "Send true or false." } } };
  const { rows: [i] } = await pool.query(
    `select i.booking_id, i.phone, b.status, b.host_id, b.start_at from invitees i join bookings b on b.id = i.booking_id where i.manage_token = $1`, [token]);
  if (!i) return { status: 404, body: { error: "not_found" } };
  if (i.status !== "confirmed") return { status: 409, body: { error: "booking_not_confirmed" } };
  if (on && !smsNumber(i.phone)) return { status: 409, body: { error: "no_indian_mobile" } };
  await pool.query("update invitees set sms_opt_in_at = case when $2::boolean then coalesce(sms_opt_in_at, $3) end where booking_id = $1", [i.booking_id, on, now]);
  if (on) {
    await pool.query(
      `update notifications set status = 'queued', last_error = null, updated_at = $2
       where booking_id = $1 and channel = 'sms' and status = 'skipped' and last_error = $3 and send_at > $2`, [i.booking_id, now, TURNED_OFF]);
    // Turned on after booking: the day-ahead reminder, unless it's past or going on WhatsApp.
    const to = await smsRecipient(pool, i.phone, true);
    const at = new Date(new Date(i.start_at).getTime() - SMS_REMINDER_MINUTES * 60_000);
    if (to && at > now) {
      await pool.query(
        `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
         select $1, $2, 'sms', 'reminder_guest', $3, $4, $5
         where not exists (select 1 from notifications where dedupe_key = $6 and status in ('queued', 'sent'))
         on conflict (dedupe_key) do nothing`,
        [i.booking_id, i.host_id, to, at, `booking:${i.booking_id}:sms:reminder_guest:${SMS_REMINDER_MINUTES}`, `booking:${i.booking_id}:wa:reminder_guest:${SMS_REMINDER_MINUTES}`]);
    }
  } else {
    await pool.query(
      "update notifications set status = 'skipped', last_error = $3, updated_at = $2 where booking_id = $1 and channel = 'sms' and status = 'queued'",
      [i.booking_id, now, TURNED_OFF]);
  }
  return { status: 200, body: { on } };
}

/** The manage token behind a text's short code, or null. Codes are letters and digits only, CODE_LENGTH long. */
export async function manageTokenForCode(pool: pg.Pool, code: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{12}$/.test(code)) return null;
  const { rows: [r] } = await pool.query("select manage_token from invitees where sms_code = $1", [code]);
  return (r?.manage_token as string | undefined) ?? null;
}

/** "+91 ••••• •3210": enough for the guest to recognise their number on a page anyone with the link can open. */
export const maskedPhone = (number: string) => `+91 ••••• •${number.slice(-4)}`;
