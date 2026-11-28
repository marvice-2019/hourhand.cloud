import type pg from "pg";
import { hostDisplayName } from "../display-name";
import { renderPracticeInviteMail, renderWaitlistMail, type RenderedMail } from "../mail/templates";

// Emails the Clinic plan sends, rendered by the job worker. Kinds start with "practice_" so the worker hands them here.

export type ClinicMailKind = "practice_invite" | "practice_waitlist_guest";

export function isClinicMail(kind: string): kind is ClinicMailKind {
  return kind === "practice_invite" || kind === "practice_waitlist_guest";
}

type Row = { kind: string; recipient: string; dedupe_key: string; booking_id: string | null };

export async function renderClinicMail(pool: Pick<pg.Pool, "query">, c: Row, baseUrl: string, now = new Date()): Promise<RenderedMail | { skip: string }> {
  if (c.kind === "practice_waitlist_guest") {
    // The booking is the cancelled (or moved) one; its start is the freed time, with that booking's practitioner.
    const m = /^practice-waitlist:([0-9a-f-]{36})$/.exec(c.dedupe_key);
    if (!m) return { skip: "not a practice waitlist email" };
    const { rows: [w] } = await pool.query(
      `select w.name, w.timezone, b.start_at, e.name as event_name, e.slug as event_slug, e.active, u.name as host_name, u.email::text as host_email, u.slug as host_slug, u.deleted_at
       from practice_waitlist w join bookings b on b.id = $2 join event_types e on e.id = b.event_type_id join users u on u.id = b.host_id
       where w.id = $1`, [m[1], c.booking_id]);
    if (!w) return { skip: "waitlist entry gone" };
    if (new Date(w.start_at).getTime() <= now.getTime()) return { skip: "the time has passed" };
    if (!w.active || w.deleted_at || !w.host_slug) return { skip: "event no longer bookable" };
    const start = new Date(w.start_at);
    return renderWaitlistMail({ guestName: w.name, hostName: hostDisplayName(w.host_name, w.host_email), eventName: w.event_name, start, timezone: w.timezone,
      url: `${baseUrl}/${w.host_slug}/${w.event_slug}?at=${encodeURIComponent(start.toISOString())}` });
  }
  if (c.kind === "practice_invite") {
    const m = /^practice:([0-9a-f-]{36}):([0-9a-f-]{36}):/.exec(c.dedupe_key);
    if (!m) return { skip: "not a practice invitation" };
    const { rows: [r] } = await pool.query(
      `select p.name as practice_name, o.name as owner_name, o.email as owner_email, x.role
       from practice_members x join practices p on p.id = x.practice_id join users o on o.id = p.owner_id
       where x.id = $1 and p.id = $2 and x.email = $3 and x.accepted_at is null and o.deleted_at is null and practice_is_live(p.id)`,
      [m[2], m[1], c.recipient]);
    if (!r) return { skip: "invitation withdrawn or already accepted" };
    return renderPracticeInviteMail({ practiceName: r.practice_name, inviterName: r.owner_name, replyTo: r.owner_email, role: r.role, url: `${baseUrl}/sign-in` });
  }
  return { skip: `unknown clinic email ${c.kind}` };
}
