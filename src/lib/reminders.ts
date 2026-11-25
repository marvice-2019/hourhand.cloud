import type pg from "pg";
import { NotFoundError } from "./data/types";

// Reminder times chosen by the host for each event type (db/migrations/0070_reminder_times.sql). The guest's reminders
// are queued from these when a booking is made or moved (src/lib/data/notifications.ts); bookings already made keep the
// reminders they were given.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The times a host can pick, in minutes before the start. Must match the check in 0070_reminder_times.sql. */
export const REMINDER_CHOICES = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080] as const;
export const MAX_REMINDERS = 3;
/** A day and an hour before: what every booking got before hosts could choose. */
export const DEFAULT_REMINDER_MINUTES: readonly number[] = [1440, 60];

/** The editor's checkboxes (`r<minutes>` = "on"). Up to 3 of the choices; anything else is refused. Longest first. */
export function validateReminderForm(form: Record<string, string | undefined>): { ok: true; value: number[] } | { ok: false; error: "too_many" } {
  const picked = REMINDER_CHOICES.filter((m) => { const v = form[`r${m}`]; return v === "on" || v === "1" || v === "true"; });
  if (picked.length > MAX_REMINDERS) return { ok: false, error: "too_many" };
  return { ok: true, value: [...picked].sort((a, z) => z - a) };
}

/** Clean list for queueing: known choices only, no repeats, at most 3, longest first. */
export function normaliseReminderMinutes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_REMINDER_MINUTES];
  const known = new Set<number>(REMINDER_CHOICES);
  return [...new Set(raw.map(Number).filter((m) => known.has(m)))].sort((a, z) => z - a).slice(0, MAX_REMINDERS);
}

/** One event type's reminder times. Not the host's own event type: the default (the page 404s before this matters). */
export async function getReminderMinutes(db: Db, hostId: string, eventTypeId: string): Promise<number[]> {
  if (!UUID.test(hostId) || !UUID.test(eventTypeId)) return [...DEFAULT_REMINDER_MINUTES];
  const { rows: [r] } = await db.query("select reminder_minutes from event_types where id = $1 and user_id = $2", [eventTypeId, hostId]);
  return r ? normaliseReminderMinutes(r.reminder_minutes) : [...DEFAULT_REMINDER_MINUTES];
}

/** Saves one event type's reminder times. Only the host's own event type; anything else is NotFoundError. */
export async function saveReminderMinutes(db: Db, hostId: string, eventTypeId: string, minutes: number[], now: Date): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(eventTypeId)) throw new NotFoundError("Event type");
  const { rowCount } = await db.query(
    "update event_types set reminder_minutes = $3, updated_at = $4 where id = $1 and user_id = $2",
    [eventTypeId, hostId, normaliseReminderMinutes(minutes), now]);
  if (!rowCount) throw new NotFoundError("Event type");
}
