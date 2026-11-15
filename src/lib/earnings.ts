import type pg from "pg";

// A host's month in money and sessions (India time). Read straight from payments, package purchases, invoices and
// bookings, so it always agrees with them. The rupee figures count INR only, in paise; money taken in any other
// currency (Stripe) is reported per currency in otherCurrencies and never added to them.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IST = 330 * 60_000;

/** Razorpay's standard domestic rate (2%, plus 18% GST on the fee), for an estimate only: hosts' actual pricing varies. */
export const RAZORPAY_FEE_BP = 200;

export interface EarningsLine { eventTypeId: string; eventName: string; bookingsMinor: number; packagesMinor: number }

export interface MonthlyEarnings {
  month: string;
  /** Prices paid for bookings this month. */
  bookingsMinor: number;
  /** Session packages paid this month. */
  packagesMinor: number;
  /** Refunds of prices made this month. */
  refundsMinor: number;
  /** Deposits kept for no-shows, for sessions this month. */
  depositsKeptMinor: number;
  /** Deposits paid this month and not yet refunded or kept. */
  depositsHeldMinor: number;
  /** bookings + packages − refunds + deposits kept. */
  netMinor: number;
  /** GST on this month's invoices, less credit notes; part of net, owed to the government. */
  gstMinor: number;
  /** Razorpay's fees as charged (GST included) on rupee money captured this month, where Razorpay has reported them. */
  feesMinor: number;
  /** An estimate (2% + 18% GST) for money whose real fee isn't in yet; 0 once every fee is known. */
  feeEstimateMinor: number;
  sessions: { held: number; noShows: number; cancelledByGuest: number; cancelledByHost: number; upcoming: number };
  byEventType: EarningsLine[];
  /** Net received per other currency (prices + packages + kept deposits − refunds), in that currency's minor units. */
  otherCurrencies: { currency: string; netMinor: number }[];
}

/** The month's bounds in UTC for "YYYY-MM" in India time; null if it isn't a month. */
export function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  return { from: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) - IST), to: new Date(Date.UTC(Number(m[1]), Number(m[2]), 1) - IST) };
}

/** "2026-10" for an instant, in India time. */
export const monthOf = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 7);

export async function monthlyEarnings(db: Db, hostId: string, month: string, now: Date): Promise<MonthlyEarnings | null> {
  const range = monthRange(month);
  if (!range || !UUID.test(hostId)) return null;
  const { from, to } = range;
  const args = [hostId, from, to];
  const [money, refunds, packages, kept, held, gst, sessions, byBooking, byPackage, others, fees] = await Promise.all([
    db.query(`select coalesce(sum(amount_minor), 0)::bigint as total from payments
              where host_id = $1 and currency = 'INR' and kind = 'payment' and paid_at >= $2 and paid_at < $3 and status in ('paid', 'refund_pending', 'refunded')`, args),
    // A refund's month is when it was recorded.
    db.query(`select coalesce(sum(refunded_minor), 0)::bigint as total from payments
              where host_id = $1 and currency = 'INR' and kind = 'payment' and status = 'refunded' and refunded_at >= $2 and refunded_at < $3`, args),
    db.query(`select coalesce(sum(price_minor), 0)::bigint as total from package_purchases where host_id = $1 and currency = 'INR' and status = 'paid' and paid_at >= $2 and paid_at < $3`, args),
    db.query(`select coalesce(sum(p.amount_minor), 0)::bigint as total from payments p join bookings b on b.id = p.booking_id join invitees i on i.booking_id = b.id
              where p.host_id = $1 and p.currency = 'INR' and p.kind = 'deposit' and p.status = 'paid' and i.no_show_at is not null and b.start_at >= $2 and b.start_at < $3`, args),
    db.query(`select coalesce(sum(p.amount_minor), 0)::bigint as total from payments p join bookings b on b.id = p.booking_id join invitees i on i.booking_id = b.id
              where p.host_id = $1 and p.currency = 'INR' and p.kind = 'deposit' and p.status = 'paid' and i.no_show_at is null and p.paid_at >= $2 and p.paid_at < $3`, args),
    db.query(`select coalesce(sum(case when kind = 'credit_note' then -1 else 1 end * (cgst_minor + sgst_minor + igst_minor)), 0)::bigint as total
              from invoices where host_id = $1 and issued_at >= $2 and issued_at < $3`, args),
    db.query(`select count(*) filter (where b.status = 'confirmed' and b.start_at <= $4 and i.no_show_at is null)::int as held,
                     count(*) filter (where b.status = 'confirmed' and i.no_show_at is not null)::int as no_shows,
                     count(*) filter (where b.status = 'cancelled' and b.cancelled_by = 'guest' and coalesce(b.cancel_reason, '') <> 'Rescheduled')::int as by_guest,
                     count(*) filter (where b.status = 'cancelled' and b.cancelled_by = 'host' and coalesce(b.cancel_reason, '') <> 'Rescheduled')::int as by_host,
                     count(*) filter (where b.status = 'confirmed' and b.start_at > $4)::int as upcoming
              from bookings b join invitees i on i.booking_id = b.id where b.host_id = $1 and b.start_at >= $2 and b.start_at < $3`, [...args, now]),
    db.query(`select e.id, e.name, coalesce(sum(p.amount_minor), 0)::bigint as total from payments p join bookings b on b.id = p.booking_id join event_types e on e.id = b.event_type_id
              where p.host_id = $1 and p.currency = 'INR' and p.kind = 'payment' and p.paid_at >= $2 and p.paid_at < $3 and p.status in ('paid', 'refund_pending', 'refunded') group by e.id, e.name`, args),
    db.query(`select e.id, e.name, coalesce(sum(k.price_minor), 0)::bigint as total from package_purchases k join event_types e on e.id = k.event_type_id
              where k.host_id = $1 and k.currency = 'INR' and k.status = 'paid' and k.paid_at >= $2 and k.paid_at < $3 group by e.id, e.name`, args),
    // Everything not in rupees, by currency, on the same rules as the rupee figures above.
    db.query(`select currency, sum(amount)::bigint as total from (
                select currency, amount_minor as amount from payments
                  where host_id = $1 and kind = 'payment' and paid_at >= $2 and paid_at < $3 and status in ('paid', 'refund_pending', 'refunded')
                union all select currency, -refunded_minor from payments
                  where host_id = $1 and kind = 'payment' and status = 'refunded' and refunded_at >= $2 and refunded_at < $3
                union all select currency, price_minor from package_purchases where host_id = $1 and status = 'paid' and paid_at >= $2 and paid_at < $3
                union all select p.currency, p.amount_minor from payments p join bookings b on b.id = p.booking_id join invitees i on i.booking_id = b.id
                  where p.host_id = $1 and p.kind = 'deposit' and p.status = 'paid' and i.no_show_at is not null and b.start_at >= $2 and b.start_at < $3
              ) m where upper(currency) <> 'INR' group by currency order by currency`, args),
    // Razorpay's real fees on rupee money captured this month (refunded or not: a refund doesn't give the fee back), and
    // the income whose fee isn't known yet, which is all that gets estimated.
    db.query(`select coalesce(sum(fee), 0)::bigint as fees, coalesce(sum(unknown), 0)::bigint as unknown from (
                select fee_minor as fee, 0 as unknown from payments
                  where host_id = $1 and currency = 'INR' and fee_minor is not null and status in ('paid', 'refund_pending', 'refunded') and paid_at >= $2 and paid_at < $3
                union all select fee_minor, 0 from package_purchases
                  where host_id = $1 and currency = 'INR' and fee_minor is not null and status = 'paid' and paid_at >= $2 and paid_at < $3
                union all select 0, amount_minor from payments
                  where host_id = $1 and currency = 'INR' and kind = 'payment' and fee_minor is null and status in ('paid', 'refund_pending', 'refunded') and paid_at >= $2 and paid_at < $3
                union all select 0, price_minor from package_purchases
                  where host_id = $1 and currency = 'INR' and fee_minor is null and status = 'paid' and paid_at >= $2 and paid_at < $3
                union all select 0, p.amount_minor from payments p join bookings b on b.id = p.booking_id join invitees i on i.booking_id = b.id
                  where p.host_id = $1 and p.currency = 'INR' and p.kind = 'deposit' and p.fee_minor is null and p.status = 'paid' and i.no_show_at is not null
                    and b.start_at >= $2 and b.start_at < $3
              ) f`, args),
  ]);
  const n = (r: { rows: { total: string | number }[] }) => Number(r.rows[0].total);
  const bookingsMinor = n(money), packagesMinor = n(packages), refundsMinor = n(refunds), depositsKeptMinor = n(kept);
  const lines = new Map<string, EarningsLine>();
  const line = (id: string, name: string) => lines.get(id) ?? lines.set(id, { eventTypeId: id, eventName: name, bookingsMinor: 0, packagesMinor: 0 }).get(id)!;
  for (const r of byBooking.rows) line(r.id, r.name).bookingsMinor = Number(r.total);
  for (const r of byPackage.rows) line(r.id, r.name).packagesMinor = Number(r.total);
  const s = sessions.rows[0];
  const received = bookingsMinor + packagesMinor + depositsKeptMinor;
  const unknownFeeMinor = Number(fees.rows[0].unknown);
  return {
    month, bookingsMinor, packagesMinor, refundsMinor, depositsKeptMinor, depositsHeldMinor: n(held),
    netMinor: received - refundsMinor, gstMinor: n(gst),
    feesMinor: Number(fees.rows[0].fees),
    feeEstimateMinor: Math.round((unknownFeeMinor * RAZORPAY_FEE_BP * 1.18) / 10_000),
    sessions: { held: s.held, noShows: s.no_shows, cancelledByGuest: s.by_guest, cancelledByHost: s.by_host, upcoming: s.upcoming },
    byEventType: [...lines.values()].sort((a, b) => b.bookingsMinor + b.packagesMinor - (a.bookingsMinor + a.packagesMinor)),
    otherCurrencies: others.rows.map((r) => ({ currency: String(r.currency).toUpperCase(), netMinor: Number(r.total) })).filter((o) => o.netMinor !== 0),
  };
}

/**
 * Queues last month's earnings email for every host who took money or held sessions that month. Safe to call often:
 * each host gets one per month (dedupe key), sent from the 1st of the next month, India time.
 */
export async function queueMonthlyReports(db: Db, now: Date): Promise<number> {
  const last = monthOf(new Date(monthRange(monthOf(now))!.from.getTime() - 1));
  const { from, to } = monthRange(last)!;
  const { rowCount } = await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     select null, u.id, 'email', 'earnings_host', u.email, $3, 'earnings:' || u.id || ':' || $4
     from users u where u.deleted_at is null and (
       exists (select 1 from payments p where p.host_id = u.id and p.paid_at >= $1 and p.paid_at < $2)
       or exists (select 1 from package_purchases k where k.host_id = u.id and k.paid_at >= $1 and k.paid_at < $2)
       or exists (select 1 from bookings b where b.host_id = u.id and b.status = 'confirmed' and b.start_at >= $1 and b.start_at < $2))
     on conflict (dedupe_key) do nothing`, [from, to, now, last]);
  return rowCount ?? 0;
}

/** The report as CSV rows for an accountant: one line per figure, rupees with two decimals; other currencies on their own lines. */
export function earningsCsv(e: MonthlyEarnings): string {
  const r = (m: number) => (m / 100).toFixed(2);
  const cell = (v: string) => (/[",\n\r]/.test(v) || /^[=+\-@\t\r]/.test(v) ? `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
  // Figures we format ourselves stay numbers (a refund is "-12.00"); only text cells get the formula guard.
  const value = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? v : cell(v));
  const rows = [
    ["Month", e.month], ["Bookings paid", r(e.bookingsMinor)], ["Packages paid", r(e.packagesMinor)], ["Deposits kept (no-shows)", r(e.depositsKeptMinor)],
    ["Refunds", r(-e.refundsMinor)], ["Net received", r(e.netMinor)], ["of which GST", r(e.gstMinor)], ["Razorpay fees (as charged)", r(e.feesMinor)], ["Razorpay fees (estimated until reported)", r(e.feeEstimateMinor)],
    ["Deposits still held", r(e.depositsHeldMinor)], ["Sessions held", String(e.sessions.held)], ["No-shows", String(e.sessions.noShows)],
    ["Cancelled by guest", String(e.sessions.cancelledByGuest)], ["Cancelled by you", String(e.sessions.cancelledByHost)],
    ...e.byEventType.map((l) => [`${l.eventName}`, r(l.bookingsMinor + l.packagesMinor)]),
    ...e.otherCurrencies.map((o) => [`Net received in ${o.currency} (not in the rupee figures)`, r(o.netMinor)]),
  ];
  return ["Item,Value", ...rows.map(([k, v]) => `${cell(k)},${value(v)}`)].join("\r\n") + "\r\n";
}
