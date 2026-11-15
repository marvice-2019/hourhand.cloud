// Paid bookings against real Postgres and a fake Razorpay (only with TEST_DATABASE_URL; uses its own database <name>_bp,
// dropped and recreated on every run).
import { closeAccount } from "../data/account-lifecycle";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import { SlotTakenError, type DataStore, type EventType, type User } from "../data/types";
import { freeSlots, handleCreateBooking, type PaymentDeps } from "../booking";
import type { Plan } from "../billing/plans";
import { handleConfirmPayment } from "./confirm-handler";
import { keyPairAuth } from "./host-razorpay";
import { razorpayOrders } from "./razorpay-orders";
import { handleCancel } from "../manage";
import { monthlyEarnings, monthOf } from "../earnings";
import { gstinCheckChar } from "../gst/gst";
import { removeTaxProfile, saveTaxProfile } from "../gst/invoices";
import { applyCapturedPayment, bookingPayment, confirmPayment, DEPOSIT_HOLD_MS, HOLD_MINUTES, PaymentStartError, PaymentVerifyError, processRefunds, reconcilePayments, releaseDeposits, startPaidBooking } from "./booking-payments";

const BASE = process.env.TEST_DATABASE_URL;
const auth = keyPairAuth("rzp_test_abcdefgh12", "k");
const sign = (order: string, payment: string) => createHmac("sha256", "k").update(`${order}|${payment}`).digest("hex");

interface FakePayment { id: string; order_id: string; amount: number; currency: string; status: string }
interface FakeRefund { id: string; status: string; amount: number; receipt?: string }

/** Razorpay's orders and payments endpoints, enough for start, confirm and the reconciler. */
function fakeRazorpay() {
  const state = {
    creates: 0, failCreate: false, failOrderPayments: false, onOrderPayments: null as null | (() => Promise<void>), payments: new Map<string, FakePayment>(),
    failRefund: false, refundCalls: [] as { paymentId: string; body: { amount?: number; receipt: string } }[], refunds: new Map<string, FakeRefund[]>(),
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    if (method === "POST" && path === "/v1/orders") {
      if (state.failCreate) return json({ error: { code: "SERVER_ERROR", description: "down" } }, 503);
      state.creates += 1;
      const body = JSON.parse(String(init.body));
      return json({ id: `order_${state.creates}_${Math.random().toString(36).slice(2, 8)}`, amount: body.amount, currency: body.currency, status: "created" });
    }
    const o = /^\/v1\/orders\/([^/]+)\/payments$/.exec(path);
    if (o && method === "GET") {
      if (state.failOrderPayments) return json({ error: { code: "SERVER_ERROR", description: "orders down" } }, 503);
      await state.onOrderPayments?.();
      return json({ items: [...state.payments.values()].filter((p) => p.order_id === decodeURIComponent(o[1])) });
    }
    const rf = /^\/v1\/payments\/([^/]+)\/(refund|refunds)$/.exec(path);
    if (rf) {
      const pay = state.payments.get(decodeURIComponent(rf[1]));
      if (!pay) return json({ error: { code: "BAD_REQUEST_ERROR", description: "no such payment" } }, 400);
      const list = state.refunds.get(pay.id) ?? [];
      if (rf[2] === "refunds") return json({ items: list });
      const body = JSON.parse(String(init.body));
      state.refundCalls.push({ paymentId: pay.id, body });
      if (state.failRefund) return json({ error: { code: "SERVER_ERROR", description: "refunds down" } }, 503);
      if (list.some((r) => r.receipt === body.receipt)) return json({ error: { code: "BAD_REQUEST_ERROR", description: "Duplicate receipt" } }, 400);
      const refund = { id: `rfnd_${Math.random().toString(36).slice(2, 10)}`, status: "pending", amount: body.amount ?? pay.amount, receipt: body.receipt };
      state.refunds.set(pay.id, [...list, refund]);
      return json(refund);
    }
    const m = /^\/v1\/payments\/([^/]+)(\/capture)?$/.exec(path);
    const p = m && state.payments.get(decodeURIComponent(m[1]));
    if (!p) return json({ error: { code: "BAD_REQUEST_ERROR", description: "no such payment" } }, 400);
    if (m[2] && method === "POST") p.status = "captured";
    return json(p);
  }) as unknown as typeof fetch;
  return { state, orders: razorpayOrders(auth, { baseUrl: "https://rp.fake", fetchImpl }) };
}

describe.skipIf(!BASE)("paid bookings (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let eventTypeId: string;
  let slot = 0;
  // Each test books its own far-future slot, three hours apart so buffers never overlap.
  const nextStart = () => new Date(Date.UTC(2033, 0, 3, 0, 0) + slot++ * 3 * 3_600_000);
  const guest = { name: "Asha", email: "asha@example.in", timezone: "Asia/Kolkata", phone: null, answers: [] };
  const input = (o: { startAt?: Date; key?: string } = {}) =>
    ({ eventTypeId, startAt: o.startAt ?? nextStart(), idempotencyKey: o.key ?? `bp-${slot}-${Math.random()}`, invitee: guest, priceMinor: 50_000 });
  const booking = async (id: string) => (await pool.query("select status, hold_expires_at, cancelled_at from bookings where id = $1", [id])).rows[0];
  const payment = async (id: string) => (await pool.query("select * from payments where booking_id = $1", [id])).rows;
  const notifications = async (id: string) => Number((await pool.query("select count(*) from notifications where booking_id = $1", [id])).rows[0].count);
  /** A started booking plus a captured payment for its order, as Checkout would report it. */
  async function paid(fake = fakeRazorpay(), o: Partial<FakePayment> = {}) {
    const r = await startPaidBooking({ pool, store, auth, orders: fake.orders }, input(), new Date());
    const order = r.payment!.orderId;
    const pay: FakePayment = { id: `pay_${Math.random().toString(36).slice(2, 10)}`, order_id: order, amount: 50_000, currency: "INR", status: "captured", ...o };
    fake.state.payments.set(pay.id, pay);
    return { fake, r, order, pay, deps: { pool, auth, orders: fake.orders } };
  }

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_bp`;
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
    eventTypeId = (await store.listEventTypes(priya.id))[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("starts a held booking with one order on the host's account and no emails yet", async () => {
    const fake = fakeRazorpay();
    const r = await startPaidBooking({ pool, store, auth, orders: fake.orders }, input(), new Date());
    expect(r.booking.status).toBe("pending_payment");
    expect(r.payment).toMatchObject({ keyId: "rzp_test_abcdefgh12", amount: 50_000, currency: "INR", holdExpiresAt: r.booking.holdExpiresAt });
    expect(fake.state.creates).toBe(1);
    expect(await payment(r.booking.id)).toEqual([expect.objectContaining({ provider: "razorpay", provider_order_id: r.payment!.orderId, status: "pending", amount_minor: 50_000 })]);
    expect(await notifications(r.booking.id)).toBe(0);
  });

  it("a repeated request reuses the same order", async () => {
    const fake = fakeRazorpay();
    const req = input();
    const a = await startPaidBooking({ pool, store, auth, orders: fake.orders }, req, new Date());
    const b = await startPaidBooking({ pool, store, auth, orders: fake.orders }, req, new Date());
    expect(b.booking.id).toBe(a.booking.id);
    expect(b.payment!.orderId).toBe(a.payment!.orderId);
    expect(fake.state.creates).toBe(1);
    expect(await payment(a.booking.id)).toHaveLength(1);
  });

  it("frees the slot when the order can't be created", async () => {
    const fake = fakeRazorpay();
    fake.state.failCreate = true;
    const req = input();
    const err = await startPaidBooking({ pool, store, auth, orders: fake.orders }, req, new Date()).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentStartError);
    expect(err.retryable).toBe(true);
    const { rows } = await pool.query("select id, status, cancelled_by, cancel_reason, hold_expires_at from bookings where idempotency_key = $1", [req.idempotencyKey]);
    expect(rows[0]).toMatchObject({ status: "cancelled", cancelled_by: "system", cancel_reason: "Payment could not start", hold_expires_at: null });
    expect(await payment(rows[0].id)).toHaveLength(0);
  });

  it("a held slot can't be booked by someone else", async () => {
    const fake = fakeRazorpay();
    const startAt = nextStart();
    await startPaidBooking({ pool, store, auth, orders: fake.orders }, input({ startAt }), new Date());
    await expect(startPaidBooking({ pool, store, auth, orders: fake.orders }, input({ startAt }), new Date())).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("confirms a good payment: booking confirmed, payment paid, emails queued", async () => {
    const { r, pay, deps } = await paid();
    expect(await confirmPayment(deps, { bookingId: r.booking.id, paymentId: pay.id, signature: sign(r.payment!.orderId, pay.id) }, new Date())).toBe("confirmed");
    expect(await booking(r.booking.id)).toMatchObject({ status: "confirmed", hold_expires_at: null });
    expect((await payment(r.booking.id))[0]).toMatchObject({ status: "paid", provider_payment_id: pay.id, paid_at: expect.any(Date) });
    expect(await notifications(r.booking.id)).toBeGreaterThan(0);
  });

  const unchanged = async (bookingId: string) => {
    expect(await booking(bookingId)).toMatchObject({ status: "pending_payment" });
    expect((await payment(bookingId))[0]).toMatchObject({ status: "pending", provider_payment_id: null });
    expect(await notifications(bookingId)).toBe(0);
  };

  it("rejects a bad signature and changes nothing", async () => {
    const { r, pay, deps } = await paid();
    await expect(confirmPayment(deps, { bookingId: r.booking.id, paymentId: pay.id, signature: sign("order_other", pay.id) }, new Date()))
      .rejects.toMatchObject({ reason: "bad_signature" });
    await unchanged(r.booking.id);
  });

  it("rejects a payment for a different amount and changes nothing", async () => {
    const { r, pay, deps } = await paid(fakeRazorpay(), { amount: 100 });
    await expect(confirmPayment(deps, { bookingId: r.booking.id, paymentId: pay.id, signature: sign(r.payment!.orderId, pay.id) }, new Date()))
      .rejects.toMatchObject({ reason: "mismatch" });
    await unchanged(r.booking.id);
  });

  it("won't confirm a booking with a payment made for another booking's order", async () => {
    const fake = fakeRazorpay();
    const a = await paid(fake);
    const b = await paid(fake);
    // The client holds b's genuine payment and signature, and submits them for booking a.
    const err = await confirmPayment(a.deps, { bookingId: a.r.booking.id, paymentId: b.pay.id, signature: sign(b.order, b.pay.id) }, new Date()).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentVerifyError);
    await unchanged(a.r.booking.id);
    await unchanged(b.r.booking.id);
  });

  it("captures an authorized payment, then confirms", async () => {
    const { r, pay, deps, fake } = await paid(fakeRazorpay(), { status: "authorized" });
    expect(await confirmPayment(deps, { bookingId: r.booking.id, paymentId: pay.id, signature: sign(r.payment!.orderId, pay.id) }, new Date())).toBe("confirmed");
    expect(fake.state.payments.get(pay.id)!.status).toBe("captured");
    expect(await booking(r.booking.id)).toMatchObject({ status: "confirmed" });
  });

  it("rejects a payment that isn't paid, and an unknown booking", async () => {
    const { r, pay, deps } = await paid(fakeRazorpay(), { status: "failed" });
    await expect(confirmPayment(deps, { bookingId: r.booking.id, paymentId: pay.id, signature: sign(r.payment!.orderId, pay.id) }, new Date()))
      .rejects.toMatchObject({ reason: "not_paid" });
    await unchanged(r.booking.id);
    await expect(confirmPayment(deps, { bookingId: "00000000-0000-4000-8000-000000000000", paymentId: pay.id, signature: "x" }, new Date()))
      .rejects.toMatchObject({ reason: "no_payment" });
  });

  it("confirming twice is a no-op the second time", async () => {
    const { r, pay, deps } = await paid();
    const args = { bookingId: r.booking.id, paymentId: pay.id, signature: sign(r.payment!.orderId, pay.id) };
    expect(await confirmPayment(deps, args, new Date())).toBe("confirmed");
    const queued = await notifications(r.booking.id);
    expect(await confirmPayment(deps, args, new Date())).toBe("already");
    expect(await notifications(r.booking.id)).toBe(queued);
  });

  it("a payment for a booking cancelled meanwhile is marked for refund and the booking stays cancelled", async () => {
    const { r, pay, deps } = await paid();
    // The hold lapsed and was cleared the way the store expires holds.
    await pool.query(`update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason = 'Payment not completed', hold_expires_at = null
      where id = $1`, [r.booking.id]);
    expect(await confirmPayment(deps, { bookingId: r.booking.id, paymentId: pay.id, signature: sign(r.payment!.orderId, pay.id) }, new Date())).toBe("refund_pending");
    expect(await booking(r.booking.id)).toMatchObject({ status: "cancelled", cancelled_at: expect.any(Date) });
    expect((await payment(r.booking.id))[0]).toMatchObject({ status: "refund_pending", provider_payment_id: pay.id, paid_at: expect.any(Date) });
    expect(await applyCapturedPayment(pool, r.booking.id, pay.id, new Date())).toBe("refund_pending");
  });
  it("a host sees the payment on their own booking, and nobody else's", async () => {
    const r = await startPaidBooking({ pool, store, auth, orders: fakeRazorpay().orders }, input(), new Date());
    expect(await bookingPayment(pool, r.booking.hostId, r.booking.id)).toMatchObject({ status: "pending" });
    const arun = (await store.getUserBySlug("arun"))!;
    expect(await bookingPayment(pool, arun.id, r.booking.id)).toBeNull();
  });

  it("closing the host's account releases a held booking (checked inside a rolled-back transaction)", async () => {
    const fake = fakeRazorpay();
    const r = await startPaidBooking({ pool, store, auth, orders: fake.orders }, input(), new Date());
    const client = await pool.connect();
    try {
      await client.query("begin");
      await closeAccount(client, r.booking.hostId, new Date());
      const { rows: [b] } = await client.query("select status, hold_expires_at, cancelled_by from bookings where id = $1", [r.booking.id]);
      expect(b).toMatchObject({ status: "cancelled", hold_expires_at: null, cancelled_by: "system" });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  describe("reconciler", () => {
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    const run = (fake: ReturnType<typeof fakeRazorpay>, now: Date) =>
      reconcilePayments({ pool, authFor: async () => auth, ordersFor: () => fake.orders }, now, 100);
    /** A held booking whose guest never came back to our page; `pay` is what Razorpay holds for its order, if anything. */
    async function abandoned(fake = fakeRazorpay(), o: Partial<FakePayment> | null = null) {
      const r = await startPaidBooking({ pool, store, auth, orders: fake.orders }, input(), new Date());
      const pay = o && { id: `pay_${Math.random().toString(36).slice(2, 10)}`, order_id: r.payment!.orderId, amount: 50_000, currency: "INR", status: "captured", ...o };
      if (pay) fake.state.payments.set(pay.id, pay);
      return { fake, id: r.booking.id, pay, startAt: r.booking.startAt };
    }

    // Each test counts only its own rows: settle whatever earlier tests left pending.
    beforeEach(async () => {
      await pool.query("update payments set status = 'failed' where status = 'pending'");
    });

    it("confirms a guest who paid and closed the tab", async () => {
      const { fake, id, pay } = await abandoned(undefined, {});
      expect(await run(fake, later(2))).toMatchObject({ claimed: 1, confirmed: 1, errors: 0 });
      expect(await booking(id)).toMatchObject({ status: "confirmed", hold_expires_at: null });
      expect((await payment(id))[0]).toMatchObject({ status: "paid", provider_payment_id: pay!.id });
      expect(await notifications(id)).toBeGreaterThan(0);
    });

    it("a payment landing just after the hold ran out is still found and refunded", async () => {
      const { fake, id } = await abandoned();
      expect(await run(fake, later(HOLD_MINUTES + 1))).toMatchObject({ expired: 1 });
      // The guest's Checkout completes a moment later and they close the tab before our page hears about it.
      const order = (await pool.query("select provider_order_id from payments where booking_id = $1", [id])).rows[0].provider_order_id;
      fake.state.payments.set("pay_late", { id: "pay_late", order_id: order, amount: 50_000, currency: "INR", status: "captured" });
      expect(await run(fake, later(HOLD_MINUTES + 3))).toMatchObject({ refundPending: 1 });
      expect((await payment(id))[0]).toMatchObject({ status: "refund_pending", provider_payment_id: "pay_late" });
      expect(await booking(id)).toMatchObject({ status: "cancelled" });
    });

    it("the same holds when a new booking released the lapsed hold", async () => {
      const { fake, id } = await abandoned();
      // Lapse the hold by the database clock; the next insert for this host releases it.
      await pool.query("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [id]);
      await startPaidBooking({ pool, store, auth, orders: fake.orders }, input(), new Date());
      expect(await booking(id)).toMatchObject({ status: "cancelled" });
      const order = (await pool.query("select provider_order_id from payments where booking_id = $1", [id])).rows[0].provider_order_id;
      fake.state.payments.set("pay_late2", { id: "pay_late2", order_id: order, amount: 50_000, currency: "INR", status: "captured" });
      await run(fake, later(2));
      expect((await payment(id))[0]).toMatchObject({ status: "refund_pending" });
    });

    it("gives up on a released hold's payment once the late window has passed", async () => {
      const { fake, id } = await abandoned();
      await run(fake, later(HOLD_MINUTES + 1));
      await run(fake, later(HOLD_MINUTES + 40));
      expect((await payment(id))[0]).toMatchObject({ status: "failed" });
    });

    it("someone else capturing the same payment first doesn't stop the booking confirming", async () => {
      const { fake, id, pay } = await abandoned(undefined, { status: "authorized" });
      // The host's auto-capture (or the browser's confirm) wins the race; Razorpay refuses our second capture.
      fake.orders.capture = async (paymentId: string) => {
        fake.state.payments.get(paymentId)!.status = "captured";
        throw new Error("This payment has already been captured");
      };
      expect(await run(fake, later(2))).toMatchObject({ confirmed: 1, errors: 0 });
      expect((await payment(id))[0]).toMatchObject({ status: "paid", provider_payment_id: pay!.id });
    });

    it("captures an authorized payment and confirms", async () => {
      const { fake, id, pay } = await abandoned(undefined, { status: "authorized" });
      expect(await run(fake, later(2))).toMatchObject({ claimed: 1, confirmed: 1 });
      expect(fake.state.payments.get(pay!.id)!.status).toBe("captured");
      expect(await booking(id)).toMatchObject({ status: "confirmed" });
    });

    it("expires an unpaid hold past its time and frees the slot", async () => {
      const { fake, id, startAt } = await abandoned();
      expect(await run(fake, later(HOLD_MINUTES + 1))).toMatchObject({ claimed: 1, expired: 1 });
      const { rows } = await pool.query("select status, cancelled_by, cancel_reason, hold_expires_at from bookings where id = $1", [id]);
      expect(rows[0]).toMatchObject({ status: "cancelled", cancelled_by: "system", cancel_reason: "Payment not completed", hold_expires_at: null });
      // The payment stays pending through the late window, so a payment landing just after the hold is still caught.
      expect((await payment(id))[0]).toMatchObject({ status: "pending" });
      // The hold hasn't lapsed by the database clock, so only the reconciler can have freed the slot.
      const again = await startPaidBooking({ pool, store, auth, orders: fake.orders }, input({ startAt }), new Date());
      expect(again.booking.status).toBe("pending_payment");
    });

    it("leaves an unpaid hold alone while it is still running", async () => {
      const { fake, id } = await abandoned();
      expect(await run(fake, later(2))).toMatchObject({ claimed: 1, confirmed: 0, expired: 0 });
      await unchanged(id);
    });

    it("an expiring hold doesn't cancel a booking confirmed while Razorpay was being asked", async () => {
      const { fake, id } = await abandoned();
      fake.state.onOrderPayments = async () => { await applyCapturedPayment(pool, id, "pay_from_checkout", new Date()); };
      expect(await run(fake, later(HOLD_MINUTES + 1))).toMatchObject({ claimed: 1, expired: 0 });
      expect(await booking(id)).toMatchObject({ status: "confirmed" });
      expect((await payment(id))[0]).toMatchObject({ status: "paid" });
    });

    it("an API error on one host leaves that row pending and still settles another host's", async () => {
      const broken = fakeRazorpay();
      broken.state.failOrderPayments = true;
      const working = fakeRazorpay();
      const arunAuth = keyPairAuth("rzp_test_arun1234ab", "k2");
      const arun = (await store.getUserBySlug("arun"))!;
      const arunEvent = (await store.listEventTypes(arun.id))[0].id;
      const a = await abandoned(broken);
      const b = await startPaidBooking({ pool, store, auth: arunAuth, orders: working.orders }, { ...input(), eventTypeId: arunEvent }, new Date());
      const pay = { id: "pay_arun_1", order_id: b.payment!.orderId, amount: 50_000, currency: "INR", status: "captured" };
      working.state.payments.set(pay.id, pay);
      const r = await reconcilePayments({ pool, authFor: async (hostId) => (hostId === arun.id ? arunAuth : auth), ordersFor: (x) => (x === arunAuth ? working.orders : broken.orders) }, later(2));
      expect(r).toMatchObject({ claimed: 2, confirmed: 1, errors: 1 });
      expect((await payment(a.id))[0]).toMatchObject({ status: "pending", last_error: expect.stringContaining("orders down") });
      expect(await booking(b.booking.id)).toMatchObject({ status: "confirmed" });
    });

    it("a payment captured after the system cancelled the booking is marked for refund", async () => {
      const { fake, id, pay } = await abandoned(undefined, {});
      await pool.query(`update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason = 'Payment not completed', hold_expires_at = null
        where id = $1`, [id]);
      expect(await run(fake, later(2))).toMatchObject({ claimed: 1, refundPending: 1 });
      expect(await booking(id)).toMatchObject({ status: "cancelled" });
      expect((await payment(id))[0]).toMatchObject({ status: "refund_pending", provider_payment_id: pay!.id });
    });

    it("doesn't check a payment again within a minute", async () => {
      const { fake, id } = await abandoned();
      const first = later(2);
      expect(await run(fake, first)).toMatchObject({ claimed: 1 });
      expect(await run(fake, new Date(first.getTime() + 30_000))).toMatchObject({ claimed: 0 });
      expect(await run(fake, new Date(first.getTime() + 61_000))).toMatchObject({ claimed: 1 });
      await unchanged(id);
    });
  });
  describe("refunds", () => {
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    const run = (fake: ReturnType<typeof fakeRazorpay>, now: Date, connected = true) =>
      processRefunds({ pool, authFor: async () => (connected ? auth : null), ordersFor: () => fake.orders }, now, 100);
    /** A confirmed, paid booking. */
    async function confirmed(fake = fakeRazorpay()) {
      const p = await paid(fake);
      await confirmPayment(p.deps, { bookingId: p.r.booking.id, paymentId: p.pay.id, signature: sign(p.order, p.pay.id) }, new Date());
      return { ...p, id: p.r.booking.id };
    }
    const cancelled = async (fake?: ReturnType<typeof fakeRazorpay>) => {
      const c = await confirmed(fake);
      await store.cancelBooking(priya.id, c.id, "host", "Away");
      return c;
    };

    // Each test counts only its own rows: settle whatever earlier tests left awaiting a refund.
    beforeEach(async () => {
      await pool.query("update payments set status = 'refunded' where status = 'refund_pending'");
    });

    it("a host cancelling a paid booking refunds it in full, once", async () => {
      const { fake, id, pay } = await cancelled();
      const [row] = await payment(id);
      expect(row).toMatchObject({ status: "refund_pending", checked_at: null });
      expect(await run(fake, new Date())).toEqual({ claimed: 1, refunded: 1, errors: 0 });
      const refund = fake.state.refunds.get(pay.id)![0];
      expect((await payment(id))[0]).toMatchObject({ status: "refunded", refund_id: refund.id, refunded_minor: 50_000, last_error: null });
      expect(fake.state.refundCalls).toEqual([{ paymentId: pay.id, body: expect.objectContaining({ receipt: `hh-${row.id}`, notes: { booking_id: id } }) }]);
      expect(fake.state.refundCalls[0].body.amount).toBeUndefined();
      expect(await run(fake, later(10))).toMatchObject({ claimed: 0 });
      expect(fake.state.refundCalls).toHaveLength(1);
    });

    it("a failed refund stays pending with its error and is retried after five minutes", async () => {
      const fake = fakeRazorpay();
      const { id } = await cancelled(fake);
      fake.state.failRefund = true;
      const first = new Date();
      expect(await run(fake, first)).toMatchObject({ claimed: 1, refunded: 0, errors: 1 });
      expect((await payment(id))[0]).toMatchObject({ status: "refund_pending", last_error: expect.stringContaining("refunds down") });
      fake.state.failRefund = false;
      expect(await run(fake, new Date(first.getTime() + 60_000))).toMatchObject({ claimed: 0 });
      expect(await run(fake, new Date(first.getTime() + 6 * 60_000))).toMatchObject({ claimed: 1, refunded: 1 });
      expect((await payment(id))[0]).toMatchObject({ status: "refunded", refunded_minor: 50_000, last_error: null });
    });

    it("a refund already made at Razorpay is recorded without refunding again", async () => {
      const fake = fakeRazorpay();
      const { id, pay } = await cancelled(fake);
      fake.state.refunds.set(pay.id, [{ id: "rfnd_old_failed", status: "failed", amount: 50_000 }, { id: "rfnd_earlier", status: "processed", amount: 50_000 }]);
      expect(await run(fake, new Date())).toMatchObject({ claimed: 1, refunded: 1 });
      expect((await payment(id))[0]).toMatchObject({ status: "refunded", refund_id: "rfnd_earlier", refunded_minor: 50_000 });
      expect(fake.state.refundCalls).toHaveLength(0);
    });

    it("a disconnected host's refund stays pending", async () => {
      const { fake, id } = await cancelled();
      expect(await run(fake, new Date(), false)).toMatchObject({ claimed: 1, refunded: 0 });
      expect((await payment(id))[0]).toMatchObject({ status: "refund_pending", last_error: "Razorpay disconnected" });
      expect(fake.state.refundCalls).toHaveLength(0);
    });

    it("refunds a payment that landed after the system cancelled the booking", async () => {
      const { fake, r, pay } = await paid();
      await pool.query("update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', hold_expires_at = null where id = $1", [r.booking.id]);
      expect(await applyCapturedPayment(pool, r.booking.id, pay.id, new Date())).toBe("refund_pending");
      expect(await run(fake, new Date())).toMatchObject({ claimed: 1, refunded: 1 });
      expect((await payment(r.booking.id))[0]).toMatchObject({ status: "refunded", refunded_minor: 50_000 });
    });

    it("rescheduling a paid booking moves the payment to the new booking, with no refund", async () => {
      const { fake, id, pay } = await confirmed();
      const moved = await store.rescheduleBooking(priya.id, id, nextStart(), `bp-move-${Math.random()}`);
      expect(await payment(id)).toEqual([]);
      expect(await payment(moved.id)).toEqual([expect.objectContaining({ status: "paid", provider_payment_id: pay.id })]);
      expect(await run(fake, new Date())).toMatchObject({ claimed: 0 });
      expect(fake.state.refundCalls).toHaveLength(0);
    });

    it("cancelling a free booking touches no payments", async () => {
      const before = (await pool.query("select id, status, updated_at from payments order by id")).rows;
      const free = await store.createBooking({ eventTypeId, startAt: nextStart(), idempotencyKey: `bp-free-${Math.random()}`, invitee: guest });
      await store.cancelBooking(priya.id, free.id, "host");
      expect((await booking(free.id)).status).toBe("cancelled");
      expect((await pool.query("select id, status, updated_at from payments order by id")).rows).toEqual(before);
    });
  });
  describe("no-show deposits", () => {
    /** A deposit booking, paid and confirmed, for a session at `startAt`. */
    async function deposited(startAt: Date) {
      const fake = fakeRazorpay();
      const r = await startPaidBooking({ pool, store, auth, orders: fake.orders }, { ...input({ startAt }), priceMinor: 20_000, kind: "deposit" }, new Date());
      const pay: FakePayment = { id: `pay_${Math.random().toString(36).slice(2, 10)}`, order_id: r.payment!.orderId, amount: 20_000, currency: "INR", status: "captured" };
      fake.state.payments.set(pay.id, pay);
      await confirmPayment({ pool, auth, orders: fake.orders }, { bookingId: r.booking.id, paymentId: pay.id, signature: sign(pay.order_id, pay.id) }, new Date());
      return r.booking;
    }
    const pay = async (id: string) => (await pool.query("select kind, status from payments where booking_id = $1", [id])).rows[0];

    it("is refunded a day after the session, kept for a no-show, and left alone before then", async () => {
      const past = (h: number) => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - h * 3_600_000);
      const showed = await deposited(past(30));
      const noShow = await deposited(past(33));
      const recent = await deposited(past(5));
      expect(await pay(showed.id)).toEqual({ kind: "deposit", status: "paid" });
      await store.setNoShow(priya.id, noShow.id, true, new Date());
      await releaseDeposits(pool, new Date());
      expect((await pay(showed.id)).status).toBe("refund_pending");
      expect((await pay(noShow.id)).status).toBe("paid");
      expect((await pay(recent.id)).status).toBe("paid");
      // Exactly at the edge it waits; a moment later it goes.
      const recentEnd = (await booking(recent.id)) && (await pool.query("select end_at from bookings where id = $1", [recent.id])).rows[0].end_at as Date;
      await releaseDeposits(pool, new Date(recentEnd.getTime() + DEPOSIT_HOLD_MS - 60_000));
      expect((await pay(recent.id)).status).toBe("paid");
      await releaseDeposits(pool, new Date(recentEnd.getTime() + DEPOSIT_HOLD_MS + 60_000));
      expect((await pay(recent.id)).status).toBe("refund_pending");
    });

    it("a price is never released as if it were a deposit", async () => {
      const fake = fakeRazorpay();
      const startAt = new Date(Date.now() - 40 * 3_600_000);
      const r = await startPaidBooking({ pool, store, auth, orders: fake.orders }, input({ startAt }), new Date());
      const p: FakePayment = { id: `pay_${Math.random().toString(36).slice(2, 10)}`, order_id: r.payment!.orderId, amount: 50_000, currency: "INR", status: "captured" };
      fake.state.payments.set(p.id, p);
      await confirmPayment({ pool, auth, orders: fake.orders }, { bookingId: r.booking.id, paymentId: p.id, signature: sign(p.order_id, p.id) }, new Date());
      await releaseDeposits(pool, new Date());
      expect(await pay(r.booking.id)).toEqual({ kind: "payment", status: "paid" });
    });
  });

  describe("booking routes", () => {
    const now = () => new Date();
    let et: EventType;
    const setPrice = async (minor: number | null) => {
      await pool.query("update event_types set price_minor = $2, currency = $3 where id = $1", [eventTypeId, minor, minor === null ? null : "INR"]);
      et = (await store.listEventTypes(priya.id)).find((e) => e.id === eventTypeId)!;
    };
    const deps = (fake = fakeRazorpay(), o: { plan?: Plan; connected?: boolean } = {}): PaymentDeps =>
      ({ pool, authFor: async () => (o.connected === false ? null : auth), ordersFor: () => fake.orders, planFor: async () => o.plan ?? "solo" });
    /** A booking request for the next time the engine offers, with every required question answered. */
    async function request(key = randomUUID(), minutes = et.durationMinutes) {
      const start = (await freeSlots(store, priya, { ...et, durationMinutes: minutes }, now(), new Date(Date.now() + 14 * 86_400_000), now()))[0];
      const questions = await store.listCustomQuestions(priya.id, eventTypeId);
      const answers = Object.fromEntries(questions.filter((q) => q.required).map((q) => [q.id, "yes"]));
      return { slug: "priya", event: et.slug, start: start.toISOString(), name: "Asha", email: "asha@example.in", timezone: "Asia/Kolkata", answers, idempotencyKey: key };
    }
    type Created = { bookingId: string; manageToken: string; payment: { orderId: string; holdExpiresAt: string } | null };

    beforeEach(() => setPrice(50_000));
    afterAll(() => setPrice(null));

    it("a free event with a deposit holds the booking for the deposit amount", async () => {
      await setPrice(null);
      await pool.query("update event_types set deposit_minor = 20000 where id = $1", [eventTypeId]);
      et = (await store.listEventTypes(priya.id)).find((e) => e.id === eventTypeId)!;
      try {
        const fake = fakeRazorpay();
        const res = await handleCreateBooking(store, await request(), now(), undefined, deps(fake));
        expect(res.status).toBe(201);
        const body = res.body as Created & { payment: { amount: number } };
        expect(body.payment.amount).toBe(20_000);
        expect((await pool.query("select kind, amount_minor from payments where booking_id = $1", [body.bookingId])).rows[0]).toEqual({ kind: "deposit", amount_minor: 20_000 });
        expect(await handleCreateBooking(store, { ...(await request()), weeks: 2 }, now(), undefined, deps(fake))).toMatchObject({ status: 400 });
      } finally {
        await pool.query("update event_types set deposit_minor = null where id = $1", [eventTypeId]);
      }
    });

    it("refuses a priced event when the host is on Free, has no Razorpay, or payments aren't set up", async () => {
      const req = await request();
      expect(await handleCreateBooking(store, req, now(), undefined, deps(undefined, { plan: "free" }))).toEqual({ status: 409, body: { error: "payments_unavailable" } });
      expect(await handleCreateBooking(store, req, now(), undefined, deps(undefined, { connected: false }))).toEqual({ status: 409, body: { error: "payments_unavailable" } });
      expect(await handleCreateBooking(store, req, now(), undefined, null)).toEqual({ status: 409, body: { error: "payments_unavailable" } });
      expect((await store.listBookings(priya.id)).some((b) => b.idempotencyKey === req.idempotencyKey)).toBe(false);
    });

    it("a repeat after the attempt ended says so, and a repeat of a confirmed booking returns it even after the host disconnects", async () => {
      const fake = fakeRazorpay();
      const req = await request();
      const first = (await handleCreateBooking(store, req, now(), undefined, deps(fake))).body as Created;
      await pool.query("update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason = 'Payment not completed', hold_expires_at = null where id = $1", [first.bookingId]);
      expect(await handleCreateBooking(store, req, now(), undefined, deps(fake))).toMatchObject({ status: 409, body: { error: "attempt_expired" } });

      const req2 = await request();
      const second = (await handleCreateBooking(store, req2, now(), undefined, deps(fake))).body as Created;
      await pool.query("update bookings set status = 'confirmed', hold_expires_at = null where id = $1", [second.bookingId]);
      expect(await handleCreateBooking(store, req2, now(), undefined, deps(fake, { connected: false }))).toMatchObject({ status: 200, body: { bookingId: second.bookingId } });
    });

    it("holds a priced booking and returns its payment; a repeat returns the same order", async () => {
      const fake = fakeRazorpay();
      const req = await request();
      const first = await handleCreateBooking(store, req, now(), undefined, deps(fake));
      expect(first.status).toBe(201);
      const body = first.body as Created;
      expect(body.payment).toMatchObject({ keyId: auth.keyId, amount: 50_000, currency: "INR" });
      expect(new Date(body.payment!.holdExpiresAt).getTime()).toBeGreaterThan(Date.now());
      expect((await booking(body.bookingId)).status).toBe("pending_payment");
      const again = await handleCreateBooking(store, req, now(), undefined, deps(fake));
      expect(again.status).toBe(200);
      expect((again.body as Created).payment!.orderId).toBe(body.payment!.orderId);
      expect(fake.state.creates).toBe(1);
    });

    it("answers 502 when the order can't be created", async () => {
      const fake = fakeRazorpay();
      fake.state.failCreate = true;
      expect(await handleCreateBooking(store, await request(), now(), undefined, deps(fake))).toEqual({ status: 502, body: { error: "payment_unavailable" } });
    });

    it("confirms a good payment by manage token, and rejects a bad signature or unknown token", async () => {
      const fake = fakeRazorpay();
      const body = (await handleCreateBooking(store, await request(), now(), undefined, deps(fake))).body as Created;
      const pay: FakePayment = { id: "pay_route1", order_id: body.payment!.orderId, amount: 50_000, currency: "INR", status: "captured" };
      fake.state.payments.set(pay.id, pay);
      const d = deps(fake);
      expect(await handleConfirmPayment(store, d, { manageToken: body.manageToken, paymentId: pay.id, signature: "nope" }, now()))
        .toEqual({ status: 400, body: { error: "bad_signature" } });
      expect(await handleConfirmPayment(store, d, { manageToken: "no-such-token", paymentId: pay.id, signature: sign(pay.order_id, pay.id) }, now()))
        .toEqual({ status: 404, body: { error: "not_found" } });
      expect(await handleConfirmPayment(store, d, { manageToken: body.manageToken, paymentId: 5 }, now())).toMatchObject({ status: 400 });
      expect(await handleConfirmPayment(store, d, { manageToken: body.manageToken, paymentId: pay.id, signature: sign(pay.order_id, pay.id) }, now()))
        .toEqual({ status: 200, body: { status: "confirmed" } });
      expect((await booking(body.bookingId)).status).toBe("confirmed");
    });

    it("charges the price of the length the guest picked, and books that length", async () => {
      // The seeded type's own length plus a longer one with a price of its own.
      const main = et.durationMinutes;
      const longer = main + 30;
      await pool.query("update event_types set duration_options = $2, duration_prices = '{NULL,90000}' where id = $1", [eventTypeId, [main, longer]]);
      et = (await store.listEventTypes(priya.id)).find((e) => e.id === eventTypeId)!;
      try {
        const fake = fakeRazorpay();
        const long = { ...(await request(undefined, longer)), duration: longer };
        const res = await handleCreateBooking(store, long, now(), undefined, deps(fake));
        expect(res.status).toBe(201);
        const body = res.body as Created & { payment: { amount: number } };
        expect(body.payment.amount).toBe(90_000);
        const { rows: [b] } = await pool.query("select start_at, end_at from bookings where id = $1", [body.bookingId]);
        expect((b.end_at.getTime() - b.start_at.getTime()) / 60_000).toBe(longer);
        // The default length keeps the event's own price.
        const short = (await handleCreateBooking(store, await request(), now(), undefined, deps(fake))).body as Created & { payment: { amount: number } };
        expect(short.payment.amount).toBe(50_000);
        // A length the host doesn't offer is refused before anything is held.
        expect(await handleCreateBooking(store, { ...(await request()), duration: main + 5 }, now(), undefined, deps(fake)))
          .toMatchObject({ status: 400, body: { fields: { duration: expect.any(String) } } });
      } finally {
        await pool.query("update event_types set duration_options = '{}', duration_prices = '{}' where id = $1", [eventTypeId]);
      }
    });

    it("the database refuses a length's own price on a free event type, and lengths without the main one", async () => {
      await setPrice(null);
      const main = et.durationMinutes;
      await expect(pool.query("update event_types set duration_options = $2, duration_prices = '{NULL,90000}' where id = $1", [eventTypeId, [main, main + 30]])).rejects.toThrow(/duration_prices/);
      await expect(pool.query("update event_types set duration_options = $2, duration_prices = '{NULL,NULL}' where id = $1", [eventTypeId, [main + 15, main + 30]])).rejects.toThrow(/duration_options/);
    });

    describe("a paid weekly series", () => {
      const WEEK = 7 * 86_400_000;
      const UNIT = 50_000;
      beforeEach(async () => {
        await pool.query("update event_types set max_repeats = 4, cancel_cutoff_minutes = 0 where id = $1", [eventTypeId]);
        et = (await store.listEventTypes(priya.id)).find((e) => e.id === eventTypeId)!;
      });
      afterAll(async () => { await pool.query("update event_types set max_repeats = 1 where id = $1", [eventTypeId]); });

      /** A request for the first time open `weeks` weeks running, booked for that many weeks. */
      async function seriesRequest(weeks: number, key = randomUUID()) {
        const open = await freeSlots(store, priya, et, now(), new Date(Date.now() + 50 * 86_400_000), now());
        const set = new Set(open.map((d) => d.getTime()));
        const start = open.find((d) => Array.from({ length: weeks - 1 }, (_, i) => i + 1).every((w) => set.has(d.getTime() + w * WEEK)))!;
        return { ...(await request(key)), start: start.toISOString(), weeks };
      }
      const weeksOf = async (firstId: string) =>
        (await pool.query("select id, status, series_index, start_at from bookings where series_id = $1 order by series_index", [firstId])).rows;
      /** Books and pays a series of `weeks`; returns its first booking, the payment row and the fake Razorpay. */
      async function paidSeries(weeks: number, fake = fakeRazorpay()) {
        const res = await handleCreateBooking(store, await seriesRequest(weeks), now(), undefined, deps(fake));
        expect(res.status).toBe(201);
        const body = res.body as Created & { payment: { orderId: string; amount: number } };
        const pay: FakePayment = { id: `pay_s${Math.random().toString(36).slice(2, 10)}`, order_id: body.payment.orderId, amount: body.payment.amount, currency: "INR", status: "captured" };
        fake.state.payments.set(pay.id, pay);
        expect(await confirmPayment({ pool, auth, orders: fake.orders }, { bookingId: body.bookingId, paymentId: pay.id, signature: sign(pay.order_id, pay.id) }, now())).toBe("confirmed");
        return { body, pay, fake };
      }
      const manageToken = async (bookingId: string) => (await pool.query("select manage_token from invitees where booking_id = $1", [bookingId])).rows[0].manage_token as string;
      const refundDeps = (fake: ReturnType<typeof fakeRazorpay>) => ({ pool, authFor: async () => auth, ordersFor: () => fake.orders });

      it("holds every week together under one payment for the whole series, then confirms them all", async () => {
        const fake = fakeRazorpay();
        const res = await handleCreateBooking(store, await seriesRequest(3), now(), undefined, deps(fake));
        expect(res.status).toBe(201);
        const body = res.body as Created & { payment: { amount: number } };
        expect(body.payment.amount).toBe(3 * UNIT);
        expect(fake.state.creates).toBe(1);
        const held = await weeksOf(body.bookingId);
        expect(held.map((w) => [w.status, w.series_index])).toEqual([["pending_payment", 1], ["pending_payment", 2], ["pending_payment", 3]]);
        expect(await payment(body.bookingId)).toEqual([expect.objectContaining({ amount_minor: 3 * UNIT, sessions: 3, status: "pending" })]);
        for (const w of held) expect(await notifications(w.id)).toBe(0); // nothing goes out until it's paid

        const pay: FakePayment = { id: "pay_series_ok", order_id: (await payment(body.bookingId))[0].provider_order_id, amount: 3 * UNIT, currency: "INR", status: "captured" };
        fake.state.payments.set(pay.id, pay);
        expect(await confirmPayment({ pool, auth, orders: fake.orders }, { bookingId: body.bookingId, paymentId: pay.id, signature: sign(pay.order_id, pay.id) }, now())).toBe("confirmed");
        const done = await weeksOf(body.bookingId);
        expect(done.map((w) => w.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
        for (const w of done) expect(await notifications(w.id)).toBeGreaterThan(0);
        expect(await bookingPayment(pool, priya.id, done[2].id)).toMatchObject({ amountMinor: 3 * UNIT, sessions: 3, status: "paid" });
      });

      it("checks every week before taking payment: one week unavailable books and charges nothing", async () => {
        const fake = fakeRazorpay();
        const req = await seriesRequest(3);
        // Someone else takes the third week first.
        const third = new Date(new Date(req.start).getTime() + 2 * WEEK);
        await store.createBooking({ eventTypeId, startAt: third, idempotencyKey: `blocker-${randomUUID()}`, invitee: guest });
        const res = await handleCreateBooking(store, req, now(), undefined, deps(fake));
        expect(res).toMatchObject({ status: 409, body: { error: "weeks_unavailable", unavailable: [third.toISOString()] } });
        expect(fake.state.creates).toBe(0);
        expect((await pool.query("select count(*)::int as n from bookings where idempotency_key like $1", [`${req.idempotencyKey}%`])).rows[0].n).toBe(0);
      });

      it("creates all weeks or none: a week taken between the check and the write leaves nothing held", async () => {
        const fake = fakeRazorpay();
        const req = await seriesRequest(3);
        const startAt = new Date(req.start);
        await startPaidBooking({ pool, store, auth, orders: fake.orders }, { eventTypeId, startAt: new Date(startAt.getTime() + 2 * WEEK), idempotencyKey: `race-${randomUUID()}`, invitee: guest, priceMinor: UNIT }, now());
        await expect(startPaidBooking({ pool, store, auth, orders: fake.orders }, { eventTypeId, startAt, idempotencyKey: req.idempotencyKey, weeks: 3, invitee: guest, priceMinor: 3 * UNIT }, now()))
          .rejects.toBeInstanceOf(SlotTakenError);
        expect((await pool.query("select count(*)::int as n from bookings where idempotency_key like $1", [`${req.idempotencyKey}%`])).rows[0].n).toBe(0);
        expect(fake.state.creates).toBe(1); // only the other guest's order
      });

      it("a lapsed hold frees every week of the series", async () => {
        const fake = fakeRazorpay();
        const body = (await handleCreateBooking(store, await seriesRequest(2), now(), undefined, deps(fake))).body as Created;
        await pool.query("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1 or series_id = $1", [body.bookingId]);
        await pool.query("update payments set created_at = now() - interval '5 minutes' where booking_id = $1", [body.bookingId]);
        await reconcilePayments({ pool, authFor: async () => auth, ordersFor: () => fake.orders }, now());
        expect((await weeksOf(body.bookingId)).map((w) => w.status)).toEqual(["cancelled", "cancelled"]);
      });

      it("cancelling one future week refunds that week's share once; the rest of the series stays paid", async () => {
        const { body, pay, fake } = await paidSeries(3);
        const [, second] = await weeksOf(body.bookingId);
        expect(await handleCancel(store, await manageToken(second.id), null, now())).toMatchObject({ status: 200 });
        expect((await payment(body.bookingId))[0]).toMatchObject({ status: "paid", refund_due_minor: UNIT, refunded_minor: 0 });
        expect((await processRefunds(refundDeps(fake), now())).refunded).toBeGreaterThanOrEqual(1);
        expect(fake.state.refundCalls).toEqual([{ paymentId: pay.id, body: expect.objectContaining({ amount: UNIT }) }]);
        expect((await payment(body.bookingId))[0]).toMatchObject({ status: "paid", refund_due_minor: 0, refunded_minor: UNIT });
        expect((await pool.query("select amount_minor from payment_refunds where payment_id = (select id from payments where booking_id = $1)", [body.bookingId])).rows).toEqual([{ amount_minor: UNIT }]);
        // Run again: nothing more is refunded.
        await pool.query("update payments set checked_at = null where booking_id = $1", [body.bookingId]);
        await processRefunds(refundDeps(fake), now());
        expect(fake.state.refundCalls).toHaveLength(1);
        expect((await weeksOf(body.bookingId)).map((w) => w.status)).toEqual(["confirmed", "cancelled", "confirmed"]);
      });

      it("cancelling the series refunds every remaining future week, after an earlier partial refund", async () => {
        const { body, pay, fake } = await paidSeries(4);
        const [first, second] = await weeksOf(body.bookingId);
        await handleCancel(store, await manageToken(second.id), null, now());
        await processRefunds(refundDeps(fake), now());
        // Now the rest: the first week and every later one.
        expect(await handleCancel(store, await manageToken(first.id), null, now(), { laterWeeks: true })).toMatchObject({ status: 200 });
        expect((await weeksOf(body.bookingId)).map((w) => w.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
        expect((await payment(body.bookingId))[0]).toMatchObject({ status: "refund_pending", refunded_minor: UNIT });
        await processRefunds(refundDeps(fake), now());
        expect(fake.state.refundCalls.map((c) => c.body.amount)).toEqual([UNIT, 3 * UNIT]);
        expect(new Set(fake.state.refundCalls.map((c) => c.body.receipt)).size).toBe(2);
        expect((await payment(body.bookingId))[0]).toMatchObject({ status: "refunded", refunded_minor: 4 * UNIT, refund_due_minor: 0, refunded_at: expect.any(Date) });
        expect(fake.state.refunds.get(pay.id)!.reduce((s2, r) => s2 + r.amount, 0)).toBe(4 * UNIT);
      });

      it("cancelling the series from a later week refunds only the weeks still to come", async () => {
        const { body, fake } = await paidSeries(3);
        const [, second] = await weeksOf(body.bookingId);
        await handleCancel(store, await manageToken(second.id), null, now(), { laterWeeks: true });
        expect((await weeksOf(body.bookingId)).map((w) => w.status)).toEqual(["confirmed", "cancelled", "cancelled"]);
        expect((await payment(body.bookingId))[0]).toMatchObject({ status: "paid", refund_due_minor: 2 * UNIT });
        await processRefunds(refundDeps(fake), now());
        expect(fake.state.refundCalls.map((c) => c.body.amount)).toEqual([2 * UNIT]);
      });

      it("a week inside the cancel cutoff can't be cancelled by the guest, so nothing is refunded", async () => {
        const { body } = await paidSeries(2);
        const [first] = await weeksOf(body.bookingId);
        const tooLate = new Date(new Date(first.start_at).getTime() - 30 * 60_000);
        await pool.query("update event_types set cancel_cutoff_minutes = 120 where id = $1", [eventTypeId]);
        expect(await handleCancel(store, await manageToken(first.id), null, tooLate)).toEqual({ status: 409, body: { error: "past_cutoff" } });
        expect((await payment(body.bookingId))[0]).toMatchObject({ status: "paid", refund_due_minor: 0 });
      });

      it("a moved week keeps the series payment on the first booking, and its cancel still refunds its share", async () => {
        const { body } = await paidSeries(2);
        const [first] = await weeksOf(body.bookingId);
        const open = await freeSlots(store, priya, et, now(), new Date(Date.now() + 50 * 86_400_000), now(), first.id);
        const moved = await store.rescheduleBooking(priya.id, first.id, open.find((d) => d.getTime() !== new Date(first.start_at).getTime())!, `move-${randomUUID()}`);
        expect(await payment(body.bookingId)).toHaveLength(1);
        await handleCancel(store, moved.invitee.manageToken, null, now());
        expect((await payment(body.bookingId))[0]).toMatchObject({ status: "paid", refund_due_minor: UNIT });
      });

      it("invoices per-session price × count, and credits each partial refund", async () => {
        const gstin = "29AAPFU0939F1Z" + gstinCheckChar("29AAPFU0939F1Z");
        await saveTaxProfile(pool, priya.id, { legalName: "Priya Sharma Coaching LLP", address: "12 MG Road, Bengaluru 560001", stateCode: "29", gstin, sac: "999293", rateBp: 1800, invoicePrefix: "PRS" });
        try {
          const { body, fake } = await paidSeries(3);
          const paymentId = (await payment(body.bookingId))[0].id;
          const inv = async () => (await pool.query("select kind, description, total_minor, taxable_minor, cgst_minor, sgst_minor from invoices where payment_id = $1 order by issued_at, kind desc", [paymentId])).rows;
          expect(await inv()).toEqual([expect.objectContaining({ kind: "invoice", total_minor: 3 * UNIT, description: expect.stringMatching(/× 3 weekly sessions at ₹500\.00 each, from /) })]);
          const [, second] = await weeksOf(body.bookingId);
          await handleCancel(store, await manageToken(second.id), null, now());
          await processRefunds(refundDeps(fake), now());
          const [, note] = await inv();
          expect(note).toMatchObject({ kind: "credit_note", total_minor: UNIT, description: expect.stringMatching(/^Part refund of /) });
          expect(note.taxable_minor + note.cgst_minor + note.sgst_minor).toBe(UNIT);
          // Refunding the rest credits exactly what's left of the invoice.
          await handleCancel(store, await manageToken(body.bookingId), null, now(), { laterWeeks: true });
          await processRefunds(refundDeps(fake), now());
          const notes = (await inv()).filter((v) => v.kind === "credit_note");
          expect(notes.map((v) => v.total_minor)).toEqual([UNIT, 2 * UNIT]);
        } finally {
          await removeTaxProfile(pool, priya.id);
        }
      });

      it("earnings count a partial refund in its month, and the final refund only for what it added", async () => {
        const month = monthOf(new Date());
        const before = (await monthlyEarnings(pool, priya.id, month, now()))!.refundsMinor;
        const { body, fake } = await paidSeries(2);
        const [, second] = await weeksOf(body.bookingId);
        await handleCancel(store, await manageToken(second.id), null, now());
        await processRefunds(refundDeps(fake), now());
        expect((await monthlyEarnings(pool, priya.id, month, now()))!.refundsMinor - before).toBe(UNIT);
        await handleCancel(store, await manageToken(body.bookingId), null, now());
        await processRefunds(refundDeps(fake), now());
        expect((await monthlyEarnings(pool, priya.id, month, now()))!.refundsMinor - before).toBe(2 * UNIT);
      });

      it("a deposit still holds one booking: no series", async () => {
        await setPrice(null);
        await pool.query("update event_types set max_repeats = 1, deposit_minor = 20000 where id = $1", [eventTypeId]);
        et = (await store.listEventTypes(priya.id)).find((e) => e.id === eventTypeId)!;
        try {
          expect(await handleCreateBooking(store, { ...(await request()), weeks: 2 }, now(), undefined, deps())).toMatchObject({ status: 400 });
          await expect(pool.query("update event_types set max_repeats = 3 where id = $1", [eventTypeId])).rejects.toThrow(/event_types_repeat_free/);
        } finally {
          await pool.query("update event_types set deposit_minor = null where id = $1", [eventTypeId]);
        }
      });
    });

    it("a free event still books and confirms straight away, with or without payments", async () => {
      await setPrice(null);
      const r = await handleCreateBooking(store, await request(), now(), undefined, deps(undefined, { plan: "free" }));
      expect(r.status).toBe(201);
      expect((r.body as Created).payment).toBeUndefined();
      expect((await booking((r.body as Created).bookingId)).status).toBe("confirmed");
    });
  });
});
