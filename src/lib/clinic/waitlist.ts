import type pg from "pg";
import { validateWaitlist, WAITLIST_JOINS_PER_WEEK, type WaitlistInput } from "../waitlist";
import { practiceBySlug } from "./practices";

// The shared waitlist: a guest waits for a service on a day, with any practitioner who offers it. When one of those
// practitioners' bookings frees a time on that day, every guest waiting is emailed once with that time.

type Db = Pick<pg.PoolClient, "query">;
const DAY_MS = 86_400_000;

export type PracticeWaitlistResult = { ok: true } | { ok: false; status: 400 | 404 | 429; fields?: Record<string, string> };

/** The longest booking window among the service's listed offers, so a guest can wait for any day someone could book. */
async function serviceTarget(db: Db, practiceSlug: string, serviceSlug: string): Promise<{ practiceId: string; serviceId: string; windowDays: number } | null> {
  const practice = await practiceBySlug(db, practiceSlug);
  if (!practice?.live || typeof serviceSlug !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/i.test(serviceSlug)) return null;
  const { rows: [r] } = await db.query(
    `select s.id, max(e.booking_window_days) as window_days
     from practice_services s join practice_service_event_types l on l.service_id = s.id join event_types e on e.id = l.event_type_id
     join practice_members m on m.practice_id = s.practice_id and m.user_id = e.user_id and m.accepted_at is not null and m.practises and m.active
     join users u on u.id = e.user_id and u.deleted_at is null
     where s.practice_id = $1 and s.slug = $2 and e.active and not e.hidden
     group by s.id`, [practice.id, serviceSlug]);
  return r ? { practiceId: practice.id, serviceId: r.id, windowDays: Number(r.window_days) } : null;
}

/**
 * Adds the guest to a service's waitlist for a day. Joining twice keeps one entry. The weekly cap per address counts
 * single-host and practice waitlists together, so a stranger can't use either to send an address more email.
 */
export async function joinPracticeWaitlist(db: Db, input: Record<string, unknown>, now: Date, isZone: (tz: unknown) => tz is string): Promise<PracticeWaitlistResult> {
  const target = await serviceTarget(db, String(input.practice ?? ""), String(input.service ?? ""));
  if (!target) return { ok: false, status: 404 };
  const v = validateWaitlist(input, now, target.windowDays, isZone);
  if (!v.ok) return { ok: false, status: 400, fields: v.fields };
  const value: WaitlistInput & { window: { start: Date; end: Date } } = v.value;
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const { rows: [c] } = await db.query(
    `select (select count(*)::int from waitlist where email = $1 and created_at > $2)
          + (select count(*)::int from practice_waitlist where email = $1 and created_at > $2) as n,
       exists (select 1 from practice_waitlist where email = $1 and service_id = $3 and day = $4) as same`,
    [value.email, since, target.serviceId, value.day]);
  if (c.n >= WAITLIST_JOINS_PER_WEEK && !c.same) return { ok: false, status: 429 };
  await db.query(
    `insert into practice_waitlist (practice_id, service_id, day, timezone, window_start, window_end, name, email, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (service_id, day, email) do update set name = excluded.name`,
    [target.practiceId, target.serviceId, value.day, value.timezone, value.window.start, value.window.end, value.name, value.email, now]);
  return { ok: true };
}

/**
 * Inside the transaction that frees a booking's time: if the booking's event type offers a practice service, and its
 * practitioner is still listed in a live practice, queues one email for each guest waiting on that service for that
 * day, and marks them so they hear once. Only for a time still ahead.
 */
export async function queuePracticeWaitlistFor(db: Db, bookingId: string, now: Date): Promise<number> {
  const { rows } = await db.query(
    `with freed as (
       select b.id, b.host_id, b.start_at, l.service_id
       from bookings b
       join event_types e on e.id = b.event_type_id and e.active
       join practice_service_event_types l on l.event_type_id = b.event_type_id
       join practice_services s on s.id = l.service_id
       join practice_members m on m.practice_id = s.practice_id and m.user_id = b.host_id and m.accepted_at is not null and m.practises and m.active
       where b.id = $1 and b.start_at > $2 and practice_is_live(s.practice_id)),
     picked as (
       update practice_waitlist w set notified_at = $2 from freed f
       where w.service_id = f.service_id and w.notified_at is null and f.start_at >= w.window_start and f.start_at < w.window_end
       returning w.id, w.email, f.host_id, f.id as booking_id)
     insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     select p.booking_id, p.host_id, 'email', 'practice_waitlist_guest', p.email, $2, 'practice-waitlist:' || p.id
     from picked p on conflict (dedupe_key) do nothing returning id`, [bookingId, now]);
  return rows.length;
}

/** Guests' emails are kept only while their day can still open up: a day after it ends, the entry goes. */
export async function prunePracticeWaitlist(db: Db, now: Date): Promise<number> {
  const { rowCount } = await db.query("delete from practice_waitlist where window_end < $1", [new Date(now.getTime() - DAY_MS)]);
  return rowCount ?? 0;
}

type Limiter = { take(key: string, limit: { max: number; windowMs: number }): boolean };

/** POST /api/practice-waitlist: a guest waits for a practice's service on a day. Needs Postgres (the job queue). */
export async function handleJoinPracticeWaitlist(
  pool: pg.Pool | null, input: unknown, now: Date, isZone: (tz: unknown) => tz is string,
  limit?: { clientKey: string; limiter: Limiter; perIp: { max: number; windowMs: number }; perEmail: { max: number; windowMs: number } },
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!pool) return { status: 409, body: { error: "waitlist_unavailable" } };
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (limit && (!limit.limiter.take(`pwaitlist-ip:${limit.clientKey}`, limit.perIp) || (email && !limit.limiter.take(`pwaitlist-email:${email}`, limit.perEmail)))) {
    return { status: 429, body: { error: "too_many_requests" } };
  }
  const r = await joinPracticeWaitlist(pool, body, now, isZone);
  if (r.ok) return { status: 200, body: { ok: true } };
  if (r.status === 404) return { status: 404, body: { error: "not_found" } };
  if (r.status === 400) return { status: 400, body: { error: "invalid_request", fields: r.fields ?? {} } };
  return { status: 429, body: { error: "too_many_requests" } };
}
