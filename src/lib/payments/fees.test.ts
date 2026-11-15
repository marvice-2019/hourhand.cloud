// Razorpay's fee recorded on payments: at capture, and by the background job for rows without one. Postgres parts run
// only with TEST_DATABASE_URL (own database <name>_fees).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { applyPurchasePayment } from "../packages/packages";
import { businessReport } from "../reports/report";
import { resolvePeriod } from "../reports/period";
import { monthlyEarnings } from "../earnings";
import { applyCapturedPayment, confirmPayment } from "./booking-payments";
import { recordMissingFees } from "./fees";
import type { HostRazorpayAuth } from "./host-razorpay";
import { feeOf, type RazorpayOrders, type RazorpayPayment } from "./razorpay-orders";

const BASE = process.env.TEST_DATABASE_URL;

describe("reading Razorpay's fee", () => {
  it("takes fee and tax from a captured or refunded payment only", () => {
    expect(feeOf({ status: "captured", fee: 1_180, tax: 180 })).toEqual({ feeMinor: 1_180, taxMinor: 180 });
    expect(feeOf({ status: "refunded", fee: 1_180, tax: 180 })).toEqual({ feeMinor: 1_180, taxMinor: 180 });
    expect(feeOf({ status: "captured", fee: 0, tax: 0 })).toEqual({ feeMinor: 0, taxMinor: 0 }); // a zero-fee plan is a real fee
    expect(feeOf({ status: "captured", fee: 500 })).toEqual({ feeMinor: 500, taxMinor: 0 });
    expect(feeOf({ status: "authorized", fee: 1_180, tax: 180 })).toBeNull(); // not charged yet
    expect(feeOf({ status: "captured", fee: null, tax: null })).toBeNull();
    expect(feeOf({ status: "captured", fee: 100, tax: 180 })).toBeNull(); // tax can't exceed the fee
    expect(feeOf({ status: "captured", fee: -5, tax: 0 })).toBeNull();
    expect(feeOf({ status: "captured", fee: "1180", tax: 180 })).toBeNull();
  });
});

describe.skipIf(!BASE)("recording fees (Postgres)", () => {
  let pool: pg.Pool;
  let host: string;
  let et: string;
  const now = new Date("2026-10-20T06:00:00Z");
  const auth: HostRazorpayAuth = { headers: () => ({}), keyId: "rzp_test_x", verifyPaymentSignature: () => true };
  /** A stand-in for the host's Razorpay: payments by id, counting fetches. */
  const fake = (payments: Record<string, Partial<RazorpayPayment>>) => {
    const calls = { get: 0, capture: 0 };
    const orders: RazorpayOrders = {
      async createOrder() { throw new Error("unused"); },
      async orderPayments() { return []; },
      async getPayment(id) { calls.get += 1; return { id, orderId: null, amount: 0, currency: "INR", status: "captured", fee: null, ...payments[id] }; },
      async capture(id) { calls.capture += 1; return { id, orderId: null, amount: 0, currency: "INR", status: "captured", fee: null, ...payments[id], ...payments[`${id}:captured`] }; },
      async refund() { throw new Error("unused"); },
      async listRefunds() { return []; },
    };
    return { orders, calls };
  };
  let k = 0;
  /** A booking held for payment, with its pending payment row. */
  const held = async (o: { order?: string; amount?: number; kind?: string } = {}) => {
    k += 1;
    const start = new Date(Date.UTC(2026, 9, 21 + k, 6));
    const end = new Date(start.getTime() + 3_600_000);
    const { rows: [b] } = await pool.query(
      `insert into bookings (event_type_id, host_id, start_at, end_at, buffered_start, buffered_end, status, idempotency_key, hold_expires_at)
       values ($1, $2, $3, $4, $3, $4, 'pending_payment', $5, $6) returning id`, [et, host, start, end, `fee-${k}`, new Date(now.getTime() + 600_000)]);
    await pool.query("insert into invitees (booking_id, host_id, name, email, timezone) values ($1, $2, 'G', $3, 'Asia/Kolkata')", [b.id, host, `g${k}@example.in`]);
    await pool.query(
      `insert into payments (booking_id, host_id, provider, provider_order_id, amount_minor, currency, status, kind) values ($1, $2, 'razorpay', $3, $4, 'INR', 'pending', $5)`,
      [b.id, host, o.order ?? `order_fee_${k}`, o.amount ?? 100_000, o.kind ?? "payment"]);
    return b.id as string;
  };
  const feeRow = async (bookingId: string) =>
    (await pool.query("select fee_minor, fee_tax_minor from payments where booking_id = $1", [bookingId])).rows[0];

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_fees`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const admin = new URL(BASE!);
    admin.pathname = "/postgres";
    const c = new pg.Client({ connectionString: admin.toString() });
    await c.connect();
    try {
      await c.query(`drop database if exists ${name} with (force)`);
      await c.query(`create database ${name}`);
    } finally {
      await c.end();
    }
    await migrate(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    host = (await pool.query("insert into users (email, name, slug) values ('fee@example.com', 'Fee Host', 'fee-host') returning id")).rows[0].id;
    et = (await pool.query("insert into event_types (user_id, name, slug, duration_minutes) values ($1, 'Coaching', 'coaching', 60) returning id", [host])).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("records the fee Razorpay returns when the payment is captured", async () => {
    const b = await held({ order: "order_cap" });
    const { orders } = fake({
      pay_cap: { orderId: "order_cap", amount: 100_000, status: "authorized" },
      "pay_cap:captured": { status: "captured", fee: { feeMinor: 2_360, taxMinor: 360 } },
    });
    expect(await confirmPayment({ pool, auth, orders }, { bookingId: b, paymentId: "pay_cap", signature: "s" }, now)).toBe("confirmed");
    expect(await feeRow(b)).toEqual({ fee_minor: 2_360, fee_tax_minor: 360 });
  });

  it("leaves the fee empty when Razorpay didn't report one; a repeat confirm leaves a known fee alone", async () => {
    const b = await held();
    await applyCapturedPayment(pool, b, "pay_nofee", now);
    expect(await feeRow(b)).toEqual({ fee_minor: null, fee_tax_minor: null });
    await pool.query("update payments set fee_minor = 2000, fee_tax_minor = 305 where booking_id = $1", [b]);
    expect(await applyCapturedPayment(pool, b, "pay_nofee", now, { feeMinor: 1, taxMinor: 0 })).toBe("already");
    expect(await feeRow(b)).toEqual({ fee_minor: 2_000, fee_tax_minor: 305 });
  });

  it("records the fee on a late payment for a cancelled booking (it's still charged, and refunded later)", async () => {
    const b = await held();
    await pool.query("update bookings set status = 'cancelled', hold_expires_at = null, cancelled_at = $2, cancelled_by = 'system' where id = $1", [b, now]);
    expect(await applyCapturedPayment(pool, b, "pay_late", now, { feeMinor: 2_360, taxMinor: 360 })).toBe("refund_pending");
    expect(await feeRow(b)).toEqual({ fee_minor: 2_360, fee_tax_minor: 360 });
  });

  it("fetches missing fees in the background, once per row, for payments, deposits and packages", async () => {
    await pool.query("update payments set fee_minor = coalesce(fee_minor, 0), fee_checked_at = $1", [now]); // earlier rows are done
    const b1 = await held();
    await applyCapturedPayment(pool, b1, "pay_bg1", now);
    const b2 = await held({ kind: "deposit", amount: 20_000 });
    await applyCapturedPayment(pool, b2, "pay_bg2", now);
    const b3 = await held();
    await applyCapturedPayment(pool, b3, "pay_bg3", now); // Razorpay hasn't reported this one's fee yet
    const { rows: [pkg] } = await pool.query("insert into packages (user_id, event_type_id, name, sessions, price_minor, valid_days) values ($1, $2, '5 sessions', 5, 400000, 90) returning id", [host, et]);
    const { rows: [buy] } = await pool.query(
      `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, idempotency_key, provider_order_id)
       values ($1, $2, $3, 5, 400000, 90, 'K', 'k@example.in', 'fee-pkg', 'order_pkg') returning id`, [pkg.id, host, et]);
    await applyPurchasePayment(pool, buy.id, "pay_pkg", now);

    const { orders, calls } = fake({
      pay_bg1: { fee: { feeMinor: 2_360, taxMinor: 360 } }, pay_bg2: { fee: { feeMinor: 472, taxMinor: 72 } },
      pay_bg3: { fee: null }, pay_pkg: { fee: { feeMinor: 9_440, taxMinor: 1_440 } },
    });
    const deps = { pool, authFor: async () => auth, ordersFor: () => orders };
    expect(await recordMissingFees(deps, now)).toEqual({ checked: 4, recorded: 3, errors: 0 });
    expect(await feeRow(b1)).toEqual({ fee_minor: 2_360, fee_tax_minor: 360 });
    expect(await feeRow(b2)).toEqual({ fee_minor: 472, fee_tax_minor: 72 });
    expect(await feeRow(b3)).toEqual({ fee_minor: null, fee_tax_minor: null });
    expect((await pool.query("select fee_minor, fee_tax_minor from package_purchases where id = $1", [buy.id])).rows[0]).toEqual({ fee_minor: 9_440, fee_tax_minor: 1_440 });

    // Within the hour nothing is fetched again; after it, only the recent payment still missing its fee.
    expect(await recordMissingFees(deps, new Date(now.getTime() + 60_000))).toEqual({ checked: 0, recorded: 0, errors: 0 });
    expect(calls.get).toBe(4);
    expect((await recordMissingFees(deps, new Date(now.getTime() + 2 * 3_600_000))).checked).toBe(1);
    // A week on, a payment whose fee never came is left alone.
    expect((await recordMissingFees(deps, new Date(now.getTime() + 8 * 24 * 3_600_000))).checked).toBe(0);
  });

  it("puts real fees in the reports and estimates only what's still missing", async () => {
    const period = resolvePeriod({ month: "2026-10" }, "Asia/Kolkata", new Date("2026-11-15T06:00:00Z"));
    const r = (await businessReport(pool, host, period, now))!;
    const inr = r.currencies[0];
    // Fees: 2360 (captured at confirm) + 2000 (set by hand) + 2360 (late payment) + 2360 + 472 (deposit) + 9440 (package)
    // + 0s on the rows marked done; the one payment still without a fee (₹1,000) is estimated.
    expect(inr.feesReportedMinor).toBe(2_360 + 2_000 + 2_360 + 2_360 + 472 + 9_440); // the late payment's fee counts though it's refunded
    expect(inr.feeTaxReportedMinor).toBe(360 + 305 + 360 + 360 + 72 + 1_440);
    expect(inr.feeEstimateMinor).toBe(Math.round((100_000 * 200 * 1.18) / 10_000));
    const e = (await monthlyEarnings(pool, host, "2026-10", new Date("2026-11-15T06:00:00Z")))!;
    expect(e.feesMinor).toBe(inr.feesReportedMinor);
    expect(e.feeEstimateMinor).toBe(inr.feeEstimateMinor);
  });
});
