// Intake conditions and the client file against real Postgres (only with TEST_DATABASE_URL; uses its own database
// <name>_intake, dropped and recreated on every run).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/migrate";
import { seed } from "../../scripts/seed";
import { clientMoney } from "./client-file";
import { createPgStore } from "./data/pg-store";
import type { DataStore, EventType, User } from "./data/types";

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("intake and client file (TEST_DATABASE_URL)", () => {
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

  it("stores a condition by its parent's id, keeps it across re-saves and reorders, and drops it with its parent", async () => {
    const first = await store.saveQuestions(priya.id, coaching.id, [
      { id: null, label: "First session?", kind: "single_select", required: true, choices: ["Yes", "No"], showIf: null },
      { id: null, label: "What brings you here?", kind: "long_text", required: true, choices: [], showIf: { parent: 0, anyOf: ["Yes"] } },
    ]);
    expect(first[1].showIf).toEqual({ questionId: first[0].id, anyOf: ["Yes"] });
    // Saved again as the editor sends it: same ids, parent by position.
    const again = await store.saveQuestions(priya.id, coaching.id, [
      { id: first[0].id, label: "First session?", kind: "single_select", required: true, choices: ["Yes", "No"], showIf: null },
      { id: null, label: "Anything else?", kind: "short_text", required: false, choices: [], showIf: null },
      { id: first[1].id, label: "What brings you here?", kind: "long_text", required: true, choices: [], showIf: { parent: 0, anyOf: ["Yes"] } },
    ]);
    const listed = await store.listCustomQuestions(priya.id, coaching.id);
    expect(listed.map((q) => q.id)).toEqual(again.map((q) => q.id));
    expect(listed[2].showIf).toEqual({ questionId: first[0].id, anyOf: ["Yes"] });
    expect(listed[1].showIf).toBeNull();
    // Another host can't see them.
    const arun = (await store.getUserBySlug("arun"))!;
    expect(await store.listCustomQuestions(arun.id, coaching.id)).toEqual([]);
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
    // Someone else's payment and a payment that never completed stay out.
    await pool.query(`insert into payments (booking_id, host_id, provider, amount_minor, currency, status, kind) values ($1, $2, 'razorpay', 99900, 'INR', 'pending', 'payment')`, [booking.id, priya.id]);

    const money = await clientMoney(pool, priya.id, email.toUpperCase());
    expect(money.lines.map(({ kind, amountMinor, refundedMinor, status }) => ({ kind, amountMinor, refundedMinor, status }))).toEqual([
      { kind: "package", amountMinor: 600000, refundedMinor: 0, status: "paid" },
      { kind: "deposit", amountMinor: 50000, refundedMinor: 50000, status: "refunded" },
      { kind: "payment", amountMinor: 150000, refundedMinor: 0, status: "paid" },
    ]);
    expect(money).toMatchObject({ paidMinor: 800000, refundedMinor: 50000 });
    const arun = (await store.getUserBySlug("arun"))!;
    expect((await clientMoney(pool, arun.id, email)).lines).toEqual([]);
  });
});
