import type { PortalBooking, PortalPurchase } from "./store";

// What the portal shows, worked out from the client's rows: pure, so the rules are tested without a database.

const MIN = 60_000;

/** "2026-11-16": the calendar day of `d` in `tz`. */
export function dayIn(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The zone the client sees times in: the one they booked in most recently, else the host's. */
export function clientZone(bookings: PortalBooking[], hostZone: string): string {
  return [...bookings].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.timezone ?? hostZone;
}

export interface SessionRow {
  booking: PortalBooking;
  /** Its calendar day in the client's zone, for grouping. */
  day: string;
  /** "today" / "tomorrow" in the client's zone, else null. */
  relative: "today" | "tomorrow" | null;
  /** Online changes (reschedule or cancel) are still open under the host's cutoff. */
  canChange: boolean;
  /** Until when changes are open; null when there's no cutoff. */
  changeUntil: Date | null;
}

/**
 * Splits the client's bookings: upcoming is every confirmed session that hasn't ended (one in progress stays upcoming so
 * its join link is at hand), soonest first; past is everything else, latest first. Days are in the client's zone.
 */
export function splitSessions(bookings: PortalBooking[], now: Date, tz: string): { upcoming: SessionRow[]; past: SessionRow[] } {
  const today = dayIn(now, tz);
  const tomorrow = dayIn(new Date(now.getTime() + 86_400_000), tz);
  const row = (b: PortalBooking): SessionRow => {
    const day = dayIn(b.startAt, tz);
    const cutoff = b.eventType.cancelCutoffMinutes * MIN;
    return {
      booking: b, day, relative: day === today ? "today" : day === tomorrow ? "tomorrow" : null,
      canChange: b.status === "confirmed" && b.startAt.getTime() - now.getTime() >= cutoff && b.startAt.getTime() > now.getTime(),
      changeUntil: cutoff > 0 ? new Date(b.startAt.getTime() - cutoff) : null,
    };
  };
  const isUpcoming = (b: PortalBooking) => b.status === "confirmed" && b.endAt.getTime() > now.getTime();
  return {
    upcoming: bookings.filter(isUpcoming).sort((a, b) => a.startAt.getTime() - b.startAt.getTime()).map(row),
    past: bookings.filter((b) => !isUpcoming(b)).sort((a, b) => b.startAt.getTime() - a.startAt.getTime()).slice(0, 50).map(row),
  };
}

export interface Balance { left: number; expired: boolean; canBook: boolean }

/** Sessions left on a package, and whether it can still book. */
export function packageBalance(p: Pick<PortalPurchase, "sessions" | "used" | "expiresAt">, now: Date): Balance {
  const left = Math.max(0, p.sessions - p.used);
  const expired = p.expiresAt !== null && p.expiresAt.getTime() <= now.getTime();
  return { left, expired, canBook: left > 0 && !expired };
}

export interface RebookOption { slug: string; name: string; durationMinutes: number }

/**
 * Event types the client has had a session of (confirmed, not cancelled), most recent first, that can still be booked
 * publicly: active and not a one-off meeting.
 */
export function rebookOptions(bookings: PortalBooking[], limit = 6): RebookOption[] {
  const seen = new Map<string, RebookOption>();
  for (const b of [...bookings].sort((a, b) => b.startAt.getTime() - a.startAt.getTime())) {
    const e = b.eventType;
    if (b.status !== "confirmed" || !e.active || e.kind === "one_off" || seen.has(e.id)) continue;
    seen.set(e.id, { slug: e.slug, name: e.name, durationMinutes: e.durationMinutes });
  }
  return [...seen.values()].slice(0, limit);
}
