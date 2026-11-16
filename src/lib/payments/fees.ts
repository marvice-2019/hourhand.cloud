import type pg from "pg";
import type { PaymentCheckDeps } from "./booking-payments";
import { isZeroDecimal, type StripeDeps, type StripeFee } from "./stripe-checkout";

// The payment provider's fee on each captured payment, fetched for any row that doesn't have it yet: payments captured
// before fees were recorded, ones confirmed by a path that didn't return the fee, package purchases, and Stripe payments
// (whose fee only exists once Stripe has made the charge's balance transaction). Writes only the fee columns, and only
// while they are empty. Every row gets one try; one paid in the last week is tried again hourly until the fee is known.
// A failure on one host never stops the others.

const RETRY_MS = 60 * 60_000;
const RETRY_FOR_MS = 7 * 24 * 60 * 60_000;

export interface FeeResult { checked: number; recorded: number; errors: number }

type Table = "payments" | "package_purchases";
type Provider = "razorpay" | "stripe";
interface DueRow { id: string; host_id: string; provider_payment_id: string; currency: string }

async function claim(pool: pg.Pool, table: Table, provider: Provider, now: Date, limit: number): Promise<DueRow[]> {
  const status = table === "payments" ? "status in ('paid', 'refund_pending', 'refunded')" : "status = 'paid'";
  const { rows } = await pool.query<DueRow>(
    `with due as (
       select id from ${table}
       where fee_minor is null and provider = $5 and provider_payment_id is not null and ${status}
         and (fee_checked_at is null
           or (fee_checked_at < $1::timestamptz - $3 * interval '1 millisecond' and paid_at > $1::timestamptz - $4 * interval '1 millisecond'))
       order by fee_checked_at nulls first, paid_at desc limit $2 for update skip locked)
     update ${table} t set fee_checked_at = $1 from due where t.id = due.id
     returning t.id, t.host_id, t.provider_payment_id, t.currency`, [now, limit, RETRY_MS, RETRY_FOR_MS, provider]);
  return rows;
}

async function run(
  pool: pg.Pool, provider: Provider, now: Date, limit: number,
  fetchFee: (row: DueRow) => Promise<{ feeMinor: number; taxMinor: number } | null>,
): Promise<FeeResult> {
  const result: FeeResult = { checked: 0, recorded: 0, errors: 0 };
  for (const table of ["payments", "package_purchases"] as const) {
    for (const row of await claim(pool, table, provider, now, limit)) {
      result.checked += 1;
      try {
        const fee = await fetchFee(row);
        if (!fee) continue;
        const { rowCount } = await pool.query(
          `update ${table} set fee_minor = $2, fee_tax_minor = $3 where id = $1 and fee_minor is null`, [row.id, fee.feeMinor, fee.taxMinor]);
        result.recorded += rowCount ?? 0;
      } catch (error) {
        result.errors += 1;
        console.error(`[jobs] ${provider} fee fetch failed for ${table} ${row.id}:`, (error as Error).message ?? error);
      }
    }
  }
  return result;
}

/** Records Razorpay's fee on up to `limit` payments and `limit` package purchases that don't have one yet. */
export function recordMissingFees(deps: PaymentCheckDeps & { pool: pg.Pool }, now: Date, limit = 20): Promise<FeeResult> {
  return run(deps.pool, "razorpay", now, limit, async (row) => {
    const auth = await deps.authFor(row.host_id);
    if (!auth) return null; // Razorpay disconnected: tried again only while the payment is recent
    return (await deps.ordersFor(auth).getPayment(row.provider_payment_id)).fee;
  });
}

/**
 * Stripe's fee in the currency the guest paid. Stripe states it in the account's settlement currency; when that differs,
 * it is converted back at Stripe's own exchange rate for that charge (settlement = charge × rate). Zero-decimal
 * currencies count minor units differently, so a conversion involving one is left unrecorded, as is a different
 * currency with no rate.
 */
export function stripeFeeIn(fee: StripeFee, paidCurrency: string): { feeMinor: number; taxMinor: number } | null {
  const paid = paidCurrency.toUpperCase();
  if (fee.currency === paid) return { feeMinor: fee.feeMinor, taxMinor: fee.taxMinor };
  if (!fee.exchangeRate || isZeroDecimal(fee.currency) || isZeroDecimal(paid)) return null;
  const feeMinor = Math.round(fee.feeMinor / fee.exchangeRate);
  return { feeMinor, taxMinor: Math.min(feeMinor, Math.round(fee.taxMinor / fee.exchangeRate)) };
}

/** Records Stripe's fee the same way, in the currency the guest paid (see stripeFeeIn). */
export function recordMissingStripeFees(deps: StripeDeps, now: Date, limit = 20): Promise<FeeResult> {
  const fetchFee = deps.api.paymentFee?.bind(deps.api);
  if (!fetchFee) return Promise.resolve({ checked: 0, recorded: 0, errors: 0 });
  return run(deps.pool, "stripe", now, limit, async (row) => {
    const account = await deps.accountFor(row.host_id);
    if (!account) return null;
    const fee = await fetchFee(account.accountId, row.provider_payment_id);
    return fee ? stripeFeeIn(fee, row.currency) : null;
  });
}
