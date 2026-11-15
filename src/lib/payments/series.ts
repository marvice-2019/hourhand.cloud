import type pg from "pg";

// A weekly series on a priced event type is paid in one payment, held by the series' first booking. Nothing here is
// tied to one payment provider: the refund job of each provider settles what these queue.

type Db = Pick<pg.PoolClient, "query">;

/** What the guest pays for `sessions` weeks at `unitMinor` each. */
export const seriesCharge = (unitMinor: number, sessions: number) => unitMinor * sessions;

/**
 * Queues refunds for bookings that were just cancelled, inside the cancelling transaction. A booking paid on its own is
 * refunded in full, as before. A week of a paid series adds its share (amount / sessions) to the series payment's
 * refund_due_minor; once every remaining week is owed back, the payment is refunded in full instead.
 * Callers pass only bookings whose refund the cancel rules allow (the guest cutoff is checked before cancelling).
 */
export async function queueRefunds(db: Db, bookingIds: string[], now: Date): Promise<void> {
  if (bookingIds.length === 0) return;
  await db.query(
    `update payments set status = 'refund_pending', checked_at = null, updated_at = $2
     where booking_id = any($1::uuid[]) and status = 'paid' and sessions = 1`, [bookingIds, now]);
  await db.query(
    `update payments p set refund_due_minor = least(p.amount_minor - p.refunded_minor, p.refund_due_minor + (p.amount_minor / p.sessions) * w.n),
       checked_at = null, updated_at = $2
     from (select series_id, count(*)::int as n from bookings where id = any($1::uuid[]) and series_id is not null group by series_id) w
     where p.booking_id = w.series_id and p.sessions > 1 and p.status = 'paid'`, [bookingIds, now]);
  // Everything left is owed back: a full refund, recorded the same way as a single booking's.
  await db.query(
    `update payments p set status = 'refund_pending', refund_due_minor = 0, checked_at = null, updated_at = $2
     where p.sessions > 1 and p.status = 'paid' and p.refunded_minor + p.refund_due_minor >= p.amount_minor
       and p.booking_id in (select series_id from bookings where id = any($1::uuid[]) and series_id is not null)`, [bookingIds, now]);
}

/** What a payment should have refunded in total once its queued refund is done. */
export function refundTarget(p: { status: string; amountMinor: number; refundedMinor: number; refundDueMinor: number }): number {
  return p.status === "refund_pending" ? p.amountMinor : Math.min(p.amountMinor, p.refundedMinor + p.refundDueMinor);
}
