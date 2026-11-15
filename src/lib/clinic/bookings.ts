import type pg from "pg";
import { requirePracticeRole } from "./practices";
import { ClinicAccessError, mayReadClientNotes } from "./roles";

// What a practice admin sees across practitioners: who is booked with whom, when. Never the practitioner's private
// client notes, and never the guest's intake answers (those can carry clinical detail); the practitioner opens those
// in their own dashboard.

type Db = Pick<pg.Pool, "query">;

export interface PracticeBooking {
  id: string; startAt: Date; endAt: Date; status: string;
  practitioner: { id: string; name: string };
  eventName: string;
  guests: { name: string; email: string }[];
}

const DAY = 86_400_000;

/** The 7 days starting today (UTC day boundary), `week` weeks from now; capped at a year either way. */
export function weekRange(week: number, now = new Date()): { from: Date; to: Date; week: number } {
  const w = Math.max(-52, Math.min(52, Number.isFinite(week) ? Math.trunc(week) : 0));
  const from = new Date(Math.floor(now.getTime() / DAY) * DAY + w * 7 * DAY);
  return { from, to: new Date(from.getTime() + 7 * DAY), week: w };
}

/** Bookings of everyone in the actor's practice within [from, to), earliest first. Owner or admin only. */
export async function listPracticeBookings(db: Db, actorId: string, range: { from: Date; to: Date }, limit = 500): Promise<PracticeBooking[]> {
  const ctx = await requirePracticeRole(db, actorId, "bookings.view_all");
  const { rows } = await db.query(
    `select b.id, b.start_at, b.end_at, b.status, u.id as host_id, u.name as host_name, e.name as event_name,
       coalesce(json_agg(json_build_object('name', i.name, 'email', i.email) order by i.created_at) filter (where i.id is not null), '[]') as guests
     from practice_members m
     join users u on u.id = m.user_id and u.deleted_at is null
     join bookings b on b.host_id = m.user_id
     join event_types e on e.id = b.event_type_id
     left join invitees i on i.booking_id = b.id
     where m.practice_id = $1 and m.accepted_at is not null and b.start_at >= $2 and b.start_at < $3
     group by b.id, u.id, e.name
     order by b.start_at
     limit $4`, [ctx.practice.id, range.from, range.to, limit]);
  return rows.map((r) => ({
    id: r.id, startAt: r.start_at, endAt: r.end_at, status: r.status,
    practitioner: { id: r.host_id, name: r.host_name }, eventName: r.event_name,
    guests: (r.guests as { name: string; email: string }[]).map((g) => ({ name: g.name, email: g.email })),
  }));
}

/**
 * A client note, read as `actorId`. Only the practitioner who wrote it may read it: being an admin, the owner, or in
 * the same practice gives no access. Use this wherever practice code could reach another practitioner's notes.
 */
export async function clientNoteAs(db: Db, actorId: string, hostId: string, email: string): Promise<string | null> {
  if (!mayReadClientNotes(actorId, hostId)) throw new ClinicAccessError("client_notes");
  const { rows: [r] } = await db.query("select note from client_notes where host_id = $1 and email = $2", [hostId, email]);
  return r ? (r.note as string) : null;
}
