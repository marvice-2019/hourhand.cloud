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

export interface PaidShare { amountMinor: number; sessions: number; refundedMinor: number; refundDueMinor: number; currency: string; provider: "razorpay" | "stripe" }

/**
 * What a guest gets back for cancelling, by the same rules queueRefunds applies: a booking paid on its own (or its
 * deposit) in full; a week of a paid series its share, and with its `laterWeeks` still to come their shares too, never
 * more than is left on the payment. Null when nothing was paid.
 */
export function refundPreview(p: Pick<PaidShare, "amountMinor" | "sessions" | "refundedMinor" | "refundDueMinor"> | null, laterWeeks: number): { thisOnly: number; withLater: number } | null {
  if (!p) return null;
  if (p.sessions <= 1) return { thisOnly: p.amountMinor, withLater: p.amountMinor };
  const left = Math.max(0, p.amountMinor - p.refundedMinor - p.refundDueMinor);
  const unit = p.amountMinor / p.sessions;
  return { thisOnly: Math.min(unit, left), withLater: Math.min(unit * (1 + laterWeeks), left) };
}

/** The paid payment a booking's cancel would refund from: its own, or its series' (held by the first week). */
export async function paidShareFor(db: Db, bookingId: string): Promise<PaidShare | null> {
  const { rows: [p] } = await db.query(
    `select p.amount_minor, p.sessions, p.refunded_minor, p.refund_due_minor, p.currency, p.provider from bookings b
     join payments p on p.status = 'paid' and (p.booking_id = b.id or (b.series_id is not null and p.booking_id = b.series_id and p.sessions > 1))
     where b.id = $1 order by p.booking_id = b.id desc, p.created_at desc limit 1`, [bookingId]);
  return p ? { amountMinor: p.amount_minor, sessions: p.sessions, refundedMinor: p.refunded_minor, refundDueMinor: p.refund_due_minor, currency: p.currency, provider: p.provider } : null;
}

/**
 * The host's view of a paid series' payment: "₹2,000 for 4 weekly sessions (₹500 each)", and where its refunds stand
 * ("₹1,000 being refunded to the guest; ₹500 refunded so far"). Null parts for a booking paid on its own.
 */
export function seriesPaymentNotes(
  p: { amountMinor: number; sessions: number; status: string; refundedMinor: number; refundDueMinor: number }, money: (minor: number) => string,
): { what: string | null; refunds: string | null } {
  if (p.sessions <= 1) return { what: null, refunds: null };
  const what = `${money(p.amountMinor)} for ${p.sessions} weekly sessions (${money(p.amountMinor / p.sessions)} each)`;
  const due = p.status === "refund_pending" ? p.amountMinor - p.refundedMinor : p.refundDueMinor;
  const parts = [
    due > 0 ? `${money(due)} being refunded to the guest` : "",
    p.refundedMinor > 0 && p.status !== "refunded" ? `${money(p.refundedMinor)} refunded so far` : "",
  ].filter(Boolean);
  return { what, refunds: parts.length ? `${parts.join("; ")}.` : null };
}

/** The host's cancel form: what cancelling this booking refunds the guest, and with its later weeks. */
export function hostCancelRefundNote(
  preview: { thisOnly: number; withLater: number } | null, laterWeeks: number, money: (minor: number) => string, providerName = "Razorpay",
): string | null {
  if (!preview || preview.thisOnly <= 0) return null;
  const later = laterWeeks > 0 && preview.withLater > preview.thisOnly ? ` (${money(preview.withLater)} if you also cancel the later weeks)` : "";
  return `The guest gets ${money(preview.thisOnly)} back${later}, refunded from your ${providerName} account.`;
}

/** A payment as a provider's refund job claims it: enough to know what is owed back and to record what was refunded. */
export interface DueRefund { id: string; status: string; amount_minor: number; refunded_minor: number; refund_due_minor: number }

/** Selects the payments a refund job settles: owed back in full, or with a share queued (cancelled weeks of a series). */
export const REFUND_DUE_SQL = "(status = 'refund_pending' or (status = 'paid' and refund_due_minor > 0))";

/** What this refund should bring the payment's refunded total up to, for a claimed row. */
export const targetOf = (row: DueRefund) =>
  refundTarget({ status: row.status, amountMinor: row.amount_minor, refundedMinor: row.refunded_minor, refundDueMinor: row.refund_due_minor });

/**
 * Records, inside the caller's transaction, that `total` has now been refunded on the payment (it was refunded_minor when
 * claimed). Guarded on that figure, so a refund is recorded once; a share queued meanwhile stays queued. A refund that
 * completes the payment marks it refunded (dated on the payment); a partial one gets a payment_refunds row so earnings
 * date it. Returns the amount this refund added, or 0 when it was already recorded.
 */
export async function recordRefund(db: Db, row: DueRefund, refundId: string, total: number, now: Date): Promise<number> {
  const reached = Math.min(total, row.amount_minor);
  const delta = reached - row.refunded_minor;
  const full = reached >= row.amount_minor;
  const { rowCount } = await db.query(
    `update payments set refund_id = $2, refunded_minor = $3, refund_due_minor = greatest(0, refunded_minor + refund_due_minor - $3),
       status = case when $5 then 'refunded' else status end, refunded_at = case when $5 then $4 else refunded_at end,
       last_error = null, updated_at = $4
     where id = $1 and refunded_minor = $6 and ${REFUND_DUE_SQL}`,
    [row.id, refundId, reached, now, full, row.refunded_minor]);
  if (!rowCount || delta <= 0) return 0;
  if (!full) await db.query("insert into payment_refunds (payment_id, amount_minor, provider_refund_id, refunded_at) values ($1, $2, $3, $4)", [row.id, delta, refundId, now]);
  return delta;
}
