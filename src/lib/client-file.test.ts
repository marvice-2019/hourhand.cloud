// The client file against real Postgres (only with TEST_DATABASE_URL; uses its own database
// <name>_intake, dropped and recreated on every run).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/migrate";
import { seed } from "../../scripts/seed";
import { clientMoney, latestAnswers } from "./client-file";
import { createPgStore } from "./data/pg-store";
import type { DataStore, EventType, User } from "./data/types";

const BASE = process.env.TEST_DATABASE_URL;

describe("the client file's answers", () => {
  const b = (id: string, created: string, answers: [string, string][], extra = {}) => ({
    id, startAt: new Date(created), createdAt: new Date(created), status: "confirmed" as const, cancelledBy: null,
    invitee: { answers: answers.map(([label, answer]) => ({ questionId: label, label, answer })) }, ...extra,
  }) as unknown as Parameters<typeof latestAnswers>[0][number];

  it("keep the latest answer to each question, by its wording, skipping blanks and lapsed payment holds", () => {
    const answers = latestAnswers([
      b("old", "2026-01-01T00:00:00Z", [["Goal", "Sleep better"], ["Medication", "None"]]),
      b("new", "2026-03-01T00:00:00Z", [["goal ", "Run a 10k"], ["Medication", " "]]),
      b("lapsed", "2026-04-01T00:00:00Z", [["Goal", "never booked"]], { status: "cancelled", cancelledBy: "system" }),
    ]);
    expect(answers.map(({ label, answer, bookingId }) => ({ label, answer, bookingId }))).toEqual([
      { label: "goal ", answer: "Run a 10k", bookingId: "new" },
      { label: "Medication", answer: "None", bookingId: "old" },
    ]);
  });
});

describe.skipIf(!BASE)("client file (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let coaching: EventType;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_intake`;
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
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("lists what a client paid: session payments, deposits and packages, with refunds and invoices, matched by email in any case", async () => {
    const booking = (await store.listBookings(priya.id)).find((b) => b.status === "confirmed")!;
    const email = booking.invitee.email;
    await pool.query(
      `insert into payments (booking_id, host_id, provider, amount_minor, currency, status, kind, paid_at, refunded_minor)
       values ($1, $2, 'razorpay', 150000, 'INR', 'paid', 'payment', now() - interval '2 days', 0),
              ($1, $2, 'razorpay', 50000, 'INR', 'refunded', 'deposit', now() - interval '1 day', 50000)`, [booking.id, priya.id]);
    const { rows: [pkg] } = await pool.query(
      "insert into packages (user_id, event_type_id, name, sessions, price_minor, valid_days) values ($1, $2, '5 sessions', 5, 600000, 90) returning id", [priya.id, coaching.id]);
    await pool.query(
      `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, idempotency_key, status, provider_payment_id, paid_at, expires_at)
       values ($1, $2, $3, 5, 600000, 90, 'Client', $4, 'cf-pkg-1', 'paid', 'pay_cf_1', now(), now() + interval '90 days')`, [pkg.id, priya.id, coaching.id, email.toUpperCase()]);
    // A Stripe payment in dollars is listed in dollars and totalled on its own.
    await pool.query(`insert into payments (booking_id, host_id, provider, amount_minor, currency, status, kind, paid_at) values ($1, $2, 'stripe', 4500, 'USD', 'paid', 'payment', now() - interval '3 days')`, [booking.id, priya.id]);
    // Someone else's payment and a payment that never completed stay out.
    await pool.query(`insert into payments (booking_id, host_id, provider, amount_minor, currency, status, kind) values ($1, $2, 'razorpay', 99900, 'INR', 'pending', 'payment')`, [booking.id, priya.id]);

    const money = await clientMoney(pool, priya.id, email.toUpperCase());
    expect(money.lines.map(({ kind, amountMinor, refundedMinor, status, currency }) => ({ kind, amountMinor, refundedMinor, status, currency }))).toEqual([
      { kind: "package", amountMinor: 600000, refundedMinor: 0, status: "paid", currency: "INR" },
      { kind: "deposit", amountMinor: 50000, refundedMinor: 50000, status: "refunded", currency: "INR" },
      { kind: "payment", amountMinor: 150000, refundedMinor: 0, status: "paid", currency: "INR" },
      { kind: "payment", amountMinor: 4500, refundedMinor: 0, status: "paid", currency: "USD" },
    ]);
    expect(money.totals).toEqual([{ currency: "INR", paidMinor: 800000, refundedMinor: 50000 }, { currency: "USD", paidMinor: 4500, refundedMinor: 0 }]);
    const arun = (await store.getUserBySlug("arun"))!;
    expect((await clientMoney(pool, arun.id, email)).lines).toEqual([]);
  });
});
