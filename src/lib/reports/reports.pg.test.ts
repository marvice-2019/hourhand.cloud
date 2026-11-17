// Business reports against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_reports). Invoices and
// credit notes are issued by the real GST code, so the reconciliation below is the one hosts get.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { monthlyEarnings } from "../earnings";
import { creditNoteForRefund, invoiceForMembershipGrant, invoiceForPayment, invoiceForPurchase } from "../gst/invoices";
import { reportAccess } from "./access";
import { gstCsv } from "./csv";
import { gstDocuments } from "./ledger";
import { resolvePeriod } from "./period";
import { businessReport } from "./report";

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("business reports (Postgres)", () => {
  let pool: pg.Pool;
  let host: string;
  let late: string;
  let ny: string;
  let other: string;
  const now = new Date("2026-11-15T06:00:00Z");
  const oct = (day: number, h = 6) => new Date(Date.UTC(2026, 9, day, h, 0));
  const october = () => resolvePeriod({ month: "2026-10" }, "Asia/Kolkata", now);

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_reports`;
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
    const user = async (slug: string, tz = "Asia/Kolkata") =>
      (await pool.query("insert into users (email, name, slug, timezone) values ($1, $2, $3, $4) returning id", [`${slug}@example.com`, slug, slug, tz])).rows[0].id as string;
    host = await user("rep-host");
    late = await user("rep-late");
    ny = await user("rep-ny", "America/New_York");
    other = await user("rep-other");
    const profile = (u: string, prefix: string) => pool.query(
      `insert into tax_profiles (user_id, legal_name, address, state_code, gstin, sac, rate_bp, invoice_prefix) values ($1, 'Host LLP', '1 MG Road, Bengaluru', '29', '29ABCDE1234F1Z5', '999293', 1800, $2)`, [u, prefix]);
    await profile(host, "RP");
    const et = async (u: string, nm: string, slug: string, cutoff = 0) =>
      (await pool.query("insert into event_types (user_id, name, slug, duration_minutes, cancel_cutoff_minutes) values ($1, $2, $3, 60, $4) returning id", [u, nm, slug, cutoff])).rows[0].id as string;
    const coaching = await et(host, "Coaching", "coaching");
    const intro = await et(host, "Intro", "intro");
    let k = 0;
    type Pay = { amount: number; kind?: string; paidAt: Date; refundedAt?: Date; currency?: string; invoice?: boolean };
    /** A booking with an optional payment; a priced INR payment gets its invoice (and credit note) from the GST code, as in production. */
    const booking = async (u: string, e: string, start: Date, o: { status?: string; by?: string; cancelledAt?: Date; noShow?: boolean; email?: string; name?: string; pay?: Pay } = {}) => {
      k += 1;
      const status = o.status ?? "confirmed";
      const end = new Date(start.getTime() + 3_600_000);
      const { rows: [b] } = await pool.query(
        `insert into bookings (event_type_id, host_id, start_at, end_at, buffered_start, buffered_end, status, idempotency_key, cancelled_at, cancelled_by)
         values ($1, $2, $3, $4, $3, $4, $5, $6, $7, $8) returning id`,
        [e, u, start, end, status, `rep-${k}`, status === "cancelled" ? (o.cancelledAt ?? start) : null, status === "cancelled" ? (o.by ?? "guest") : null]);
      await pool.query("insert into invitees (booking_id, host_id, name, email, timezone, no_show_at) values ($1, $2, $3, $4, 'Asia/Kolkata', $5)",
        [b.id, u, o.name ?? "Guest", o.email ?? `g${k}@example.in`, o.noShow ? end : null]);
      if (!o.pay) return;
      const p = o.pay;
      const { rows: [pay] } = await pool.query(
        `insert into payments (booking_id, host_id, provider, amount_minor, currency, status, kind, paid_at, provider_order_id)
         values ($1, $2, $3, $4, $5, 'paid', $6, $7, $8) returning id`,
        [b.id, u, p.currency === "USD" ? "stripe" : "razorpay", p.amount, p.currency ?? "INR", p.kind ?? "payment", p.paidAt, `order_r${k}`]);
      if (p.invoice !== false && (p.kind ?? "payment") === "payment") await invoiceForPayment(pool, pay.id, p.paidAt);
      if (p.refundedAt) {
        await pool.query("update payments set status = 'refunded', refunded_minor = amount_minor, refunded_at = $2, refund_id = $3 where id = $1", [pay.id, p.refundedAt, `rfnd_${k}`]);
        if ((p.kind ?? "payment") === "payment") await creditNoteForRefund(pool, pay.id, p.refundedAt);
      }
    };
    await booking(host, coaching, oct(3), { email: "Asha@Example.in", name: "Asha", pay: { amount: 100_000, paidAt: oct(1) } });
    await booking(host, coaching, oct(20), { email: "asha@example.in", name: "Asha", pay: { amount: 100_000, paidAt: oct(15) } });
    await booking(host, coaching, oct(10), { status: "cancelled", by: "guest", cancelledAt: oct(9, 12), email: "ravi@example.in", name: "Ravi", pay: { amount: 50_000, paidAt: oct(2), refundedAt: oct(4) } });
    // Paid in September, refunded in October: the invoice (RP/2627/000004) is September's, the credit note October's.
    await booking(host, coaching, new Date("2026-09-28T06:00:00Z"), { status: "cancelled", by: "guest", cancelledAt: new Date("2026-09-20T06:00:00Z"), pay: { amount: 30_000, paidAt: new Date("2026-09-10T06:00:00Z"), refundedAt: oct(6) } });
    // 1 Oct 00:30 in India: October here, though UTC says 30 September.
    await booking(host, coaching, new Date("2026-09-30T19:00:00Z"), { pay: { amount: 70_000, paidAt: new Date("2026-09-30T19:00:00Z") } });
    await booking(host, intro, oct(12), { noShow: true, email: "ravi@example.in", name: "Ravi", pay: { amount: 20_000, kind: "deposit", paidAt: oct(5) } });
    await booking(host, intro, oct(14), { pay: { amount: 20_000, kind: "deposit", paidAt: oct(6) } });
    await booking(host, intro, oct(21), { pay: { amount: 20_000, kind: "deposit", paidAt: oct(7), refundedAt: oct(22) } });
    await booking(host, coaching, oct(25), { status: "cancelled", by: "host" });
    // A Stripe session in dollars (no Indian invoice).
    await booking(host, coaching, oct(26), { email: "sam@example.com", name: "Sam", pay: { amount: 9_900, currency: "USD", paidAt: oct(24), invoice: false } });
    await booking(host, coaching, oct(31, 19), {}); // 1 Nov in India
    await booking(other, await et(other, "Theirs", "theirs"), oct(3), { pay: { amount: 999_900, paidAt: oct(1) } });
    const { rows: [pkg] } = await pool.query("insert into packages (user_id, event_type_id, name, sessions, price_minor, valid_days) values ($1, $2, '5 sessions', 5, 400000, 90) returning id", [host, coaching]);
    const { rows: [buy] } = await pool.query(
      `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, idempotency_key, status, paid_at, expires_at, provider_payment_id)
       values ($1, $2, $3, 5, 400000, 90, 'Kiran', 'kiran@example.in', 'rep-pkg', 'paid', $4, $4, 'pay_rep_pkg') returning id`, [pkg.id, host, coaching, oct(8)]);
    await invoiceForPurchase(pool, buy.id, oct(8));

    // A host who added GST details mid-month: the first sale has no invoice.
    const lateEt = await et(late, "Yoga", "yoga");
    await booking(late, lateEt, oct(3), { pay: { amount: 60_000, paidAt: oct(2) } });
    await profile(late, "LT");
    await booking(late, lateEt, oct(13), { pay: { amount: 40_000, paidAt: oct(12) } });

    // A New York host: 1 Oct 02:00 UTC is still 30 September there.
    const nyEt = await et(ny, "Session", "session");
    await booking(ny, nyEt, new Date("2026-10-05T14:00:00Z"), { pay: { amount: 25_000, paidAt: new Date("2026-10-01T02:00:00Z"), invoice: false } });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reconciles: net sales equal the invoices less credit notes for the period", async () => {
    const r = (await businessReport(pool, host, october(), now))!;
    const inr = r.currencies.find((c) => c.currency === "INR")!;
    // Sales: 1000 + 1000 + 500 + 700 + package 4000; refunds: 500 (October sale) + 300 (September sale).
    expect(inr).toMatchObject({ bookingsMinor: 320_000, packagesMinor: 400_000, grossMinor: 720_000, refundsMinor: 80_000, netSalesMinor: 640_000 });
    expect(r.gst).toMatchObject({ invoices: 5, creditNotes: 2, totalMinor: 640_000 });
    expect(inr.netSalesMinor).toBe(r.gst.totalMinor);
    expect(r.uninvoicedMinor).toBe(0);
    expect(r.gst.outputTaxMinor).toBe(r.gst.cgstMinor + r.gst.sgstMinor + r.gst.igstMinor);
    expect(r.gst.taxableMinor + r.gst.outputTaxMinor).toBe(r.gst.totalMinor);

    // The GST export adds up to the same figure, with the September invoice referenced from October's credit note.
    const csv = gstCsv(await gstDocuments(pool, host, october().from, october().to), "Oct").trimEnd().split("\r\n").slice(2).map((l) => l.split(","));
    expect(csv.reduce((s, c) => s + Math.round(Number(c[13]) * 100), 0)).toBe(inr.netSalesMinor);
    expect(csv.filter((c) => c[0] === "Credit note").map((c) => [c[13], c[14]])).toEqual([["-500.00", "RP/2627/000003"], ["-300.00", "RP/2627/000004"]]);
    expect(csv.find((c) => c[1] === "RP/2627/000003")![14]).toBe("CNRP/2627/000001");
  });

  it("shows a gap when some sales weren't invoiced", async () => {
    const r = (await businessReport(pool, late, october(), now))!;
    expect(r.currencies[0].netSalesMinor).toBe(100_000);
    expect(r.gst.totalMinor).toBe(40_000);
    expect(r.uninvoicedMinor).toBe(60_000);
  });

  it("adds forfeited deposits, keeps held ones out, and separates currencies", async () => {
    const r = (await businessReport(pool, host, october(), now))!;
    expect(r.currencies.map((c) => c.currency)).toEqual(["INR", "USD"]);
    expect(r.currencies[0]).toMatchObject({ depositsKeptMinor: 20_000, depositsHeldMinor: 20_000, netIncomeMinor: 660_000, feesReportedMinor: null });
    expect(r.currencies[1]).toMatchObject({ grossMinor: 9_900, netIncomeMinor: 9_900, feeEstimateMinor: null });
    // The month's email and the dashboard agree on the rupee figures.
    const e = (await monthlyEarnings(pool, host, "2026-10", now))!;
    expect(e.netMinor).toBe(r.currencies[0].netIncomeMinor); // rupees only: the dollars are reported apart
    expect(e.otherCurrencies).toEqual([{ currency: "USD", netMinor: r.currencies[1].netIncomeMinor }]);
    expect(e.gstMinor).toBe(r.gst.outputTaxMinor);
  });

  it("counts sessions, no-shows and late cancellations", async () => {
    const r = (await businessReport(pool, host, october(), now))!;
    expect(r.sessions).toEqual({ delivered: 6, upcoming: 0, noShows: 1, noShowRate: 1 / 7, cancelled: 2, cancelledByGuest: 1, cancelledByHost: 1, lateCancellations: 1 });
    expect(r.topClients.slice(0, 3).map((c) => [c.name, c.netMinor, c.sessions])).toEqual([["Kiran", 400_000, 0], ["Asha", 200_000, 2], ["Guest", 70_000, 1]]);
    expect(r.byEventType.filter((l) => l.currency === "INR").map((l) => [l.eventName, l.bookingsMinor + l.packagesMinor + l.depositsKeptMinor])).toEqual([["Coaching", 640_000], ["Intro", 20_000]]);
  });

  it("trends month on month and bounds periods in the host's own zone", async () => {
    const r = (await businessReport(pool, host, resolvePeriod({ period: "this_fy" }, "Asia/Kolkata", now), now))!;
    const inr = r.trend.filter((t) => t.currency === "INR");
    expect(inr.find((t) => t.month === "2026-09")!.netSalesMinor).toBe(30_000);
    expect(inr.find((t) => t.month === "2026-10")!.netSalesMinor).toBe(640_000);
    const nyOct = (await businessReport(pool, ny, resolvePeriod({ month: "2026-10" }, "America/New_York", now), now))!;
    const nySep = (await businessReport(pool, ny, resolvePeriod({ month: "2026-09" }, "America/New_York", now), now))!;
    expect(nyOct.currencies).toEqual([]);
    expect(nySep.currencies[0].grossMinor).toBe(25_000);
  });

  it("keeps Free to the last 30 days and to the host's own money", async () => {
    const free = reportAccess({ period: "this_fy" }, "Asia/Kolkata", "free", now);
    const r = (await businessReport(pool, host, free.period, now, free.earliest))!;
    expect(r.period.first).toBe("2026-10-17");
    expect(r.currencies.map((c) => [c.currency, c.grossMinor])).toEqual([["USD", 9_900]]); // the rupee sales are all before the 17th
    expect(r.trendMonths).toEqual(["2026-10", "2026-11"]);
    const theirs = (await businessReport(pool, other, october(), now))!;
    expect(theirs.currencies[0].grossMinor).toBe(999_900);
    expect(await businessReport(pool, "not-a-uuid", october(), now)).toBeNull();
  });

  it("counts membership months as sales, so they reconcile with their invoices too", async () => {
    const m = (await pool.query("insert into users (email, name, slug) values ('rep-member@example.com', 'Member Host', 'rep-member') returning id")).rows[0].id as string;
    await pool.query(
      `insert into tax_profiles (user_id, legal_name, address, state_code, gstin, sac, rate_bp, invoice_prefix) values ($1, 'Host LLP', '1 MG Road, Bengaluru', '29', '29ABCDE1234F1Z5', '999293', 1800, 'MB')`, [m]);
    const { rows: [plan] } = await pool.query(
      "insert into membership_plans (user_id, name, sessions, price_minor, rollover, provider_plan_id) values ($1, 'Monthly 4', 4, 300000, 'none', 'plan_rep_m') returning id", [m]);
    const { rows: [mem] } = await pool.query(
      `insert into memberships (plan_id, host_id, sessions, price_minor, rollover, guest_name, guest_email, idempotency_key, status)
       values ($1, $2, 4, 300000, 'none', 'Meera', 'meera@example.in', 'rep-mem-1', 'active') returning id`, [plan.id, m]);
    for (const [n, at] of [["1", oct(3)], ["2", new Date("2026-11-03T06:00:00Z")]] as const) {
      const { rows: [g] } = await pool.query(
        `insert into membership_grants (membership_id, host_id, provider_payment_id, amount_minor, period_start, period_end, credits, granted_at)
         values ($1, $2, $3, 300000, $4, $4::timestamptz + interval '1 month', 4, $4) returning id`, [mem.id, m, `pay_rep_mem_${n}`, at]);
      await invoiceForMembershipGrant(pool, g.id, at);
    }
    const r = (await businessReport(pool, m, october(), now))!;
    expect(r.currencies[0]).toMatchObject({ membershipsMinor: 300_000, grossMinor: 300_000, netSalesMinor: 300_000 });
    expect(r.gst.totalMinor).toBe(300_000);
    expect(r.uninvoicedMinor).toBe(0);
    expect(r.topClients.map((c) => [c.name, c.netMinor])).toEqual([["Meera", 300_000]]);
    expect(r.byEventType.map((l) => [l.eventName, l.membershipsMinor])).toEqual([["Monthly 4", 300_000]]);
  });
});
