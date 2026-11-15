import type pg from "pg";
import type { PaymentCheckDeps } from "./booking-payments";

// Razorpay's fee on each captured payment, fetched from Razorpay for any row that doesn't have it yet: payments
// captured before fees were recorded, ones confirmed by a path that didn't return the fee, and package purchases.
// Writes only the fee columns, and only while they are empty. Every row gets one try; one paid in the last week is
// tried again hourly until Razorpay reports its fee. A failure on one host never stops the others.

const RETRY_MS = 60 * 60_000;
const RETRY_FOR_MS = 7 * 24 * 60 * 60_000;

export interface FeeResult { checked: number; recorded: number; errors: number }

type Table = "payments" | "package_purchases";

async function claim(pool: pg.Pool, table: Table, now: Date, limit: number) {
  const due = table === "payments"
    ? "fee_minor is null and provider = 'razorpay' and provider_payment_id is not null and status in ('paid', 'refund_pending', 'refunded')"
    : "fee_minor is null and status = 'paid'";
  const { rows } = await pool.query<{ id: string; host_id: string; provider_payment_id: string }>(
    `with due as (
       select id from ${table}
       where ${due} and (fee_checked_at is null
         or (fee_checked_at < $1::timestamptz - $3 * interval '1 millisecond' and paid_at > $1::timestamptz - $4 * interval '1 millisecond'))
       order by fee_checked_at nulls first, paid_at desc limit $2 for update skip locked)
     update ${table} t set fee_checked_at = $1 from due where t.id = due.id
     returning t.id, t.host_id, t.provider_payment_id`, [now, limit, RETRY_MS, RETRY_FOR_MS]);
  return rows;
}

/** Records Razorpay's fee on up to `limit` payments and `limit` package purchases that don't have one yet. */
export async function recordMissingFees(deps: PaymentCheckDeps & { pool: pg.Pool }, now: Date, limit = 20): Promise<FeeResult> {
  const result: FeeResult = { checked: 0, recorded: 0, errors: 0 };
  for (const table of ["payments", "package_purchases"] as const) {
    for (const row of await claim(deps.pool, table, now, limit)) {
      result.checked += 1;
      try {
        const auth = await deps.authFor(row.host_id);
        if (!auth) continue; // Razorpay disconnected: tried again only while the payment is recent
        const p = await deps.ordersFor(auth).getPayment(row.provider_payment_id);
        if (!p.fee) continue;
        const { rowCount } = await deps.pool.query(
          `update ${table} set fee_minor = $2, fee_tax_minor = $3 where id = $1 and fee_minor is null`, [row.id, p.fee.feeMinor, p.fee.taxMinor]);
        result.recorded += rowCount ?? 0;
      } catch (error) {
        result.errors += 1;
        console.error(`[jobs] fee fetch failed for ${table} ${row.id}:`, (error as Error).message ?? error);
      }
    }
  }
  return result;
}
