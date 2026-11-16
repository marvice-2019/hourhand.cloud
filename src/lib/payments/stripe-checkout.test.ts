// Guests paying Stripe-connected hosts: Checkout Sessions on the host's own account, confirmation only from Stripe's own
// record (webhook or session read-back), refunds, deposits, packages and the Connect webhook. Against a fake Stripe and
// real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_stc, recreated each run).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { freeSlots, handleCreateBooking, type PaymentDeps } from "../booking";
import { seal } from "../crypto/seal";
import { createPgStore } from "../data/pg-store";
import type { DataStore, User } from "../data/types";
import { invoiceForPayment, saveTaxProfile } from "../gst/invoices";
import { handleStartPurchase } from "../packages/handlers";
import { createPackage } from "../packages/packages";
import { PaymentStartError, releaseDeposits } from "./booking-payments";
import { fakeStripe } from "./fake-stripe";
import {
  chargeableCurrency, processStripeRefunds, reconcileStripePayments, reconcileStripePurchases, settleStripeSession, startStripeBooking,
  STRIPE_HOLD_MINUTES, stripeCheckoutApi, type StripeDeps,
} from "./stripe-checkout";
import { disconnectStripe, stripeConnectApi, STRIPE_API_VERSION } from "./stripe-connect";
import { handleConnectEvent, parseConnectDelivery } from "./stripe-webhook";

const WHSEC = "whsec_test_connect";
const signed = (body: unknown, at = new Date(), secret = WHSEC) => {
  const raw = JSON.stringify(body);
  const t = Math.floor(at.getTime() / 1000);
  return { raw, header: `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}` };
};

describe("Stripe Checkout basics (no database)", () => {
  it("only charges in currencies with hundredths, and never INR (that's Razorpay)", () => {
    expect(chargeableCurrency("USD")).toBe(true);
    expect(chargeableCurrency("GBP")).toBe(true);
    expect(chargeableCurrency("EUR")).toBe(true);
    expect(chargeableCurrency("JPY")).toBe(false);
    expect(chargeableCurrency("INR")).toBe(false);
    expect(chargeableCurrency(null)).toBe(false);
  });

  it("webhook signature: the Connect endpoint's own secret, fresh timestamps only", () => {
    const event = { id: "evt_1", type: "checkout.session.completed", account: "acct_abcdef123" };
    const good = signed(event);
    expect(parseConnectDelivery(good.raw, good.header, WHSEC)).toMatchObject({ ok: true });
    // Signed with another endpoint's secret (the platform's own endpoint, say).
    const other = signed(event, new Date(), "whsec_platform");
    expect(parseConnectDelivery(other.raw, other.header, WHSEC)).toEqual({ ok: false, status: 400, error: "bad_signature" });
    // A captured delivery replayed ten minutes later.
    const old = signed(event, new Date(Date.now() - 10 * 60_000));
    expect(parseConnectDelivery(old.raw, old.header, WHSEC)).toEqual({ ok: false, status: 400, error: "bad_signature" });
    // The body changed after signing.
    expect(parseConnectDelivery(good.raw.replace("evt_1", "evt_2"), good.header, WHSEC)).toMatchObject({ ok: false, error: "bad_signature" });
    expect(parseConnectDelivery(good.raw, null, WHSEC)).toMatchObject({ ok: false, error: "bad_signature" });
  });
});

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("Stripe Checkout for hosts (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let eventTypeId: string;
  const key = randomBytes(32);
  let slot = 0;
  const nextStart = () => new Date(Date.UTC(2034, 0, 3, 0, 0) + slot++ * 3 * 3_600_000);
  const guest = { name: "Sam", email: "sam@example.com", timezone: "Europe/London", phone: null, answers: [] };

  let fake: ReturnType<typeof fakeStripe>;
  let deps: StripeDeps;
  let accountId: string;
  const api = () => stripeCheckoutApi({ secretKey: "sk_test_platform", baseUrl: "https://stripe.fake", fetchImpl: fake.fetchImpl });
  const host = () => ({ accountId, onboarding: "active" as const, currency: "USD", country: "US", mode: "test" as const });

  /** Connects priya's Stripe account (as part A stores it) with the given onboarding state. */
  async function connect(onboarding: "active" | "pending" = "active", currency = "USD") {
    await pool.query("delete from integrations where user_id = $1 and provider in ('stripe', 'razorpay')", [priya.id]);
    await pool.query(
      `insert into integrations (user_id, provider, credentials_encrypted, public_id, mode, status, onboarding, currency, country)
       values ($1, 'stripe', $2, $3, 'test', 'ok', $4, $5, 'US')`,
      [priya.id, seal(key, { accountId }, `stripe:${priya.id}:${accountId}`), accountId, onboarding, currency]);
  }

  const input = (o: { startAt?: Date; kind?: "payment" | "deposit"; price?: number } = {}) => ({
    eventTypeId, startAt: o.startAt ?? nextStart(), idempotencyKey: `stc-${slot}-${Math.random()}`, invitee: guest,
    priceMinor: o.price ?? 4_500, kind: o.kind ?? "payment" as const, productName: "Coaching with Priya",
    urls: (b: { id: string }) => ({ successUrl: `https://hh.test/priya/coaching/booked/${b.id}?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `https://hh.test/priya/coaching/booked/${b.id}` }),
  });
  const start = (o: Parameters<typeof input>[0] = {}, now = new Date()) => startStripeBooking({ pool, store, api: deps.api, host: host() }, input(o), now);
  const bookingRow = async (id: string) => (await pool.query("select status, hold_expires_at from bookings where id = $1", [id])).rows[0];
  const paymentRow = async (id: string) => (await pool.query("select * from payments where booking_id = $1", [id])).rows[0];
  const notifications = async (id: string) => Number((await pool.query("select count(*) from notifications where booking_id = $1", [id])).rows[0].count);
  /** A booking whose guest has paid in Checkout and which is confirmed. */
  async function confirmed(o: Parameters<typeof input>[0] = {}) {
    const r = await start(o);
    const session = fake.pay(r.payment!.url.split("/").pop()!);
    expect(await settleStripeSession(deps, session.id, new Date())).toBe("confirmed");
    return { r, session };
  }
  const event = (type: string, object: Record<string, unknown>, account = accountId, id = `evt_${randomUUID()}`) => ({ id, type, account, livemode: false, data: { object } });

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_stc`;
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

  beforeEach(async () => {
    fake = fakeStripe();
    accountId = fake.activeAccount("US").id;
    deps = { pool, api: api(), accountFor: async (hostId) => (hostId === priya.id ? (await pool.query("select 1 from integrations where user_id = $1 and provider = 'stripe' and status = 'ok'", [hostId])).rowCount ? host() : null : null) };
    await connect();
  });

  describe("starting a payment", () => {
    it("holds the slot and opens one Checkout Session on the host's own account, nothing confirmed or emailed yet", async () => {
      const now = new Date();
      const r = await start({}, now);
      expect(r.booking.status).toBe("pending_payment");
      expect(r.payment).toMatchObject({ provider: "stripe", amount: 4_500, currency: "USD" });
      expect(r.payment!.url).toMatch(/^https:\/\/checkout\.stripe\.fake\//);
      const req = fake.state.requests.find((q) => q.path === "/v1/checkout/sessions")!;
      // A direct charge: made as the connected account, on the pinned API version, with an idempotency key per booking.
      expect(req.headers).toMatchObject({ "stripe-account": accountId, "stripe-version": STRIPE_API_VERSION, "idempotency-key": `hh-booking-${r.booking.id}` });
      const session = [...fake.state.sessions.values()][0];
      expect(session.params).toMatchObject({
        mode: "payment", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": "4500", customer_email: "sam@example.com",
        "metadata[hourhand_ref]": `booking:${r.booking.id}`, "payment_intent_data[metadata][hourhand_ref]": `booking:${r.booking.id}`,
      });
      expect(session.params.success_url).toContain("session_id={CHECKOUT_SESSION_ID}");
      // No application fee while the constant is 0, and never payment_method_types (Stripe picks methods from the Dashboard).
      expect(Object.keys(session.params).some((k) => k.includes("application_fee") || k.includes("payment_method_types"))).toBe(false);
      // The session dies before the hold does, so nobody can pay for a slot that has been released.
      expect(session.expires_at * 1000).toBeLessThan(r.booking.holdExpiresAt!.getTime());
      expect(session.expires_at * 1000 - now.getTime()).toBeGreaterThanOrEqual(30 * 60_000);
      expect(r.booking.holdExpiresAt!.getTime() - now.getTime()).toBe(STRIPE_HOLD_MINUTES * 60_000);
      expect(await paymentRow(r.booking.id)).toMatchObject({ provider: "stripe", status: "pending", amount_minor: 4_500, currency: "USD", provider_order_id: session.id, application_fee_minor: 0 });
      expect(await notifications(r.booking.id)).toBe(0);
    });

    it("a repeated request returns the same session, never a second one", async () => {
      const req = input();
      const a = await startStripeBooking({ pool, store, api: deps.api, host: host() }, req, new Date());
      const b = await startStripeBooking({ pool, store, api: deps.api, host: host() }, req, new Date(Date.now() + 5_000));
      expect(b.booking.id).toBe(a.booking.id);
      expect(b.payment!.url).toBe(a.payment!.url);
      expect(fake.state.sessions.size).toBe(1);
    });

    it("when Checkout can't start, the slot is released at once", async () => {
      fake.state.failSessions = true;
      const req = input();
      const err = await startStripeBooking({ pool, store, api: deps.api, host: host() }, req, new Date()).catch((e) => e);
      expect(err).toBeInstanceOf(PaymentStartError);
      expect(err.retryable).toBe(true);
      const b = (await store.listBookings(priya.id)).find((x) => x.idempotencyKey === req.idempotencyKey)!;
      expect((await bookingRow(b.id)).status).toBe("cancelled");
    });
  });

  describe("confirmation only from Stripe's own record", () => {
    it("coming back from Checkout without paying confirms nothing", async () => {
      const r = await start();
      const sessionId = [...fake.state.sessions.keys()][0];
      expect(await settleStripeSession(deps, sessionId, new Date())).toBe("open");
      expect((await bookingRow(r.booking.id)).status).toBe("pending_payment");
      expect(await notifications(r.booking.id)).toBe(0);
    });

    it("a paid session confirms the booking once, queues its emails, and records the PaymentIntent", async () => {
      const { r, session } = await confirmed();
      expect((await bookingRow(r.booking.id)).status).toBe("confirmed");
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "paid", provider_payment_id: session.payment_intent });
      expect(await notifications(r.booking.id)).toBeGreaterThan(0);
      const sent = await notifications(r.booking.id);
      expect(await settleStripeSession(deps, session.id, new Date())).toBe("already");
      expect(await notifications(r.booking.id)).toBe(sent);
    });

    it("a session whose amount or reference doesn't match our row is refused", async () => {
      const r = await start();
      const s = fake.pay([...fake.state.sessions.keys()][0]);
      s.amount_total = 100; // paid less than the price
      expect(await settleStripeSession(deps, s.id, new Date())).toBe("mismatch");
      s.amount_total = 4_500;
      s.metadata.hourhand_ref = "booking:00000000-0000-0000-0000-000000000000"; // a session made for another booking
      expect(await settleStripeSession(deps, s.id, new Date())).toBe("mismatch");
      expect((await bookingRow(r.booking.id)).status).toBe("pending_payment");
    });

    it("a webhook naming another account can't settle this host's session", async () => {
      const r = await start();
      const s = fake.pay([...fake.state.sessions.keys()][0]);
      const other = fake.activeAccount("GB").id;
      expect(await handleConnectEvent({ stripe: deps, connect: stripeConnectApi({ secretKey: "sk_test_platform", baseUrl: "https://stripe.fake", fetchImpl: fake.fetchImpl }), key },
        event("checkout.session.completed", { id: s.id, payment_status: "paid" }, other))).toBe("ignored");
      expect((await bookingRow(r.booking.id)).status).toBe("pending_payment");
    });

    it("the webhook body is never trusted: it says paid, Stripe says unpaid, nothing changes", async () => {
      const r = await start();
      const id = [...fake.state.sessions.keys()][0];
      const wh = { stripe: deps, connect: stripeConnectApi({ secretKey: "sk_test_platform", baseUrl: "https://stripe.fake", fetchImpl: fake.fetchImpl }), key };
      await handleConnectEvent(wh, event("checkout.session.completed", { id, payment_status: "paid", status: "complete", amount_total: 4_500 }));
      expect((await bookingRow(r.booking.id)).status).toBe("pending_payment");
    });
  });

  describe("Connect webhook", () => {
    const wh = () => ({ stripe: deps, connect: stripeConnectApi({ secretKey: "sk_test_platform", baseUrl: "https://stripe.fake", fetchImpl: fake.fetchImpl }), key });

    it("confirms from a verified checkout.session.completed, and a redelivery is a duplicate that does nothing", async () => {
      const r = await start();
      const s = fake.pay([...fake.state.sessions.keys()][0]);
      const e = event("checkout.session.completed", { id: s.id });
      expect(await handleConnectEvent(wh(), e)).toBe("processed");
      expect((await bookingRow(r.booking.id)).status).toBe("confirmed");
      const sent = await notifications(r.booking.id);
      const reads = fake.state.requests.length;
      expect(await handleConnectEvent(wh(), e)).toBe("duplicate");
      expect(fake.state.requests.length).toBe(reads);
      expect(await notifications(r.booking.id)).toBe(sent);
    });

    it("a failure is recorded and retried: Stripe's next delivery of the same event processes it", async () => {
      const r = await start();
      const s = fake.pay([...fake.state.sessions.keys()][0]);
      const e = event("checkout.session.async_payment_succeeded", { id: s.id });
      fake.state.failGetSession = true;
      await expect(handleConnectEvent(wh(), e)).rejects.toThrow();
      const { rows: [logged] } = await pool.query("select processed_at, error from webhook_events where provider = 'stripe_connect' and external_id = $1", [e.id]);
      expect(logged.processed_at).toBeNull();
      expect(logged.error).toMatch(/sessions down/);
      fake.state.failGetSession = false;
      expect(await handleConnectEvent(wh(), e)).toBe("processed");
      expect((await bookingRow(r.booking.id)).status).toBe("confirmed");
    });

    it("an expired session releases the held slot", async () => {
      const r = await start();
      fake.expire([...fake.state.sessions.keys()][0]);
      expect(await handleConnectEvent(wh(), event("checkout.session.expired", { id: [...fake.state.sessions.keys()][0] }))).toBe("processed");
      expect((await bookingRow(r.booking.id)).status).toBe("cancelled");
      expect((await paymentRow(r.booking.id)).status).toBe("failed");
    });

    it("account.updated re-reads the account; account.application.deauthorized stops new payments", async () => {
      await connect("pending");
      expect(await handleConnectEvent(wh(), event("account.updated", { id: accountId }))).toBe("processed");
      expect((await pool.query("select onboarding, currency from integrations where user_id = $1 and provider = 'stripe'", [priya.id])).rows[0]).toEqual({ onboarding: "active", currency: "USD" });
      expect(await handleConnectEvent(wh(), event("account.application.deauthorized", { id: "ca_x" }))).toBe("processed");
      expect((await pool.query("select status from integrations where user_id = $1 and provider = 'stripe'", [priya.id])).rows[0].status).toBe("disconnected");
    });

    it("events for unknown accounts or sessions, and other event types, are acknowledged and ignored", async () => {
      expect(await handleConnectEvent(wh(), event("checkout.session.completed", { id: "cs_test_unknownsession1" }))).toBe("ignored");
      expect(await handleConnectEvent(wh(), event("payout.paid", { id: "po_1" }))).toBe("ignored");
      expect(await handleConnectEvent(wh(), event("account.updated", { id: "acct_nobody123" }, "acct_nobody123"))).toBe("ignored");
    });
  });

  describe("reconciler", () => {
    it("confirms a paid session the webhook never delivered", async () => {
      const r = await start({}, new Date(Date.now() - 2 * 60_000));
      await pool.query("update payments set created_at = now() - interval '2 minutes' where booking_id = $1", [r.booking.id]);
      fake.pay([...fake.state.sessions.keys()][0]);
      expect(await reconcileStripePayments(deps, new Date())).toMatchObject({ confirmed: 1 });
      expect((await bookingRow(r.booking.id)).status).toBe("confirmed");
    });

    it("a hold that lapsed with its session still open is closed in Stripe and released", async () => {
      const r = await start({}, new Date(Date.now() - 40 * 60_000));
      await pool.query("update payments set created_at = now() - interval '40 minutes' where booking_id = $1", [r.booking.id]);
      expect(await reconcileStripePayments(deps, new Date())).toMatchObject({ expired: 1 });
      expect((await bookingRow(r.booking.id)).status).toBe("cancelled");
      expect([...fake.state.sessions.values()][0].status).toBe("expired");
    });

    it("a payment that lands after the slot was released is refunded, never revives the slot", async () => {
      const r = await start();
      await pool.query("update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', hold_expires_at = null where id = $1", [r.booking.id]);
      const s = fake.pay([...fake.state.sessions.keys()][0]);
      expect(await settleStripeSession(deps, s.id, new Date())).toBe("refund_pending");
      expect((await bookingRow(r.booking.id)).status).toBe("cancelled");
      expect(await processStripeRefunds(deps, new Date())).toMatchObject({ refunded: 1 });
      expect(fake.state.refunds).toEqual([expect.objectContaining({ payment_intent: s.payment_intent, amount: 4_500, account: accountId })]);
    });
  });

  describe("refunds", () => {
    it("cancelling a paid booking refunds the guest in full, once, on the host's account", async () => {
      const { r, session } = await confirmed();
      await store.cancelBooking(priya.id, r.booking.id, "host");
      expect((await paymentRow(r.booking.id)).status).toBe("refund_pending");
      expect(await processStripeRefunds(deps, new Date())).toMatchObject({ claimed: 1, refunded: 1 });
      const refundCall = fake.state.requests.find((q) => q.method === "POST" && q.path === "/v1/refunds")!;
      expect(refundCall.headers).toMatchObject({ "stripe-account": accountId, "idempotency-key": `hh-refund-${(await paymentRow(r.booking.id)).id}` });
      expect(refundCall.body).not.toContain("refund_application_fee"); // no fee was taken, so none to return
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "refunded", refunded_minor: 4_500, refund_id: fake.state.refunds[0].id });
      expect(fake.state.refunds.filter((x) => x.payment_intent === session.payment_intent)).toHaveLength(1);
      expect(await processStripeRefunds(deps, new Date(Date.now() + 10 * 60_000))).toMatchObject({ claimed: 0 });
    });

    it("a refund that went through before we could record it is found, not made twice", async () => {
      const { r, session } = await confirmed();
      await store.cancelBooking(priya.id, r.booking.id, "guest");
      fake.state.refunds.push({ id: "re_earlier", account: accountId, payment_intent: session.payment_intent!, amount: 4_500, status: "pending", idempotencyKey: null });
      expect(await processStripeRefunds(deps, new Date())).toMatchObject({ refunded: 1 });
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "refunded", refund_id: "re_earlier" });
      expect(fake.state.requests.filter((q) => q.method === "POST" && q.path === "/v1/refunds")).toHaveLength(0);
    });

    it("a Stripe outage leaves the refund pending with the error, and it goes through on a later round", async () => {
      const { r } = await confirmed();
      await store.cancelBooking(priya.id, r.booking.id, "host");
      fake.state.failRefunds = true;
      expect(await processStripeRefunds(deps, new Date())).toMatchObject({ errors: 1, refunded: 0 });
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "refund_pending", last_error: expect.stringMatching(/refunds down/) });
      fake.state.failRefunds = false;
      expect(await processStripeRefunds(deps, new Date(Date.now() + 6 * 60_000))).toMatchObject({ refunded: 1 });
    });

    it("a deposit is refunded a day after the session unless the host marks a no-show", async () => {
      const past = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 3_600_000);
      const { r } = await confirmed({ startAt: past, kind: "deposit", price: 2_000 });
      expect(await paymentRow(r.booking.id)).toMatchObject({ kind: "deposit", status: "paid" });
      await releaseDeposits(pool, new Date());
      expect((await paymentRow(r.booking.id)).status).toBe("refund_pending");
      expect(await processStripeRefunds(deps, new Date())).toMatchObject({ refunded: 1 });
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "refunded", refunded_minor: 2_000 });
    });
  });

  describe("a paid weekly series", () => {
    /** A confirmed 4-week series paid in one Checkout Session: $180 for 4 weeks at $45. */
    async function paidSeries() {
      const startAt = new Date(Date.UTC(2035, 0, 2, 0, 0) + slot++ * 3 * 3_600_000);
      const r = await startStripeBooking({ pool, store, api: deps.api, host: host() }, { ...input({ startAt, price: 18_000 }), weeks: 4 }, new Date());
      const session = fake.pay(r.payment!.url.split("/").pop()!);
      expect(await settleStripeSession(deps, session.id, new Date())).toBe("confirmed");
      const { rows: weeks } = await pool.query("select id, status from bookings where series_id = $1 order by series_index", [r.booking.id]);
      return { r, session, weeks: weeks as { id: string; status: string }[] };
    }
    const refundsOn = (pi: string | null) => fake.state.refunds.filter((x) => x.payment_intent === pi);

    it("one Checkout Session pays every week; settling it confirms them all", async () => {
      const { r, session, weeks } = await paidSeries();
      expect(session.amount_total).toBe(18_000);
      expect(weeks.map((w) => w.status)).toEqual(["confirmed", "confirmed", "confirmed", "confirmed"]);
      expect(await paymentRow(r.booking.id)).toMatchObject({ provider: "stripe", amount_minor: 18_000, sessions: 4, status: "paid" });
    });

    it("cancelling one week refunds its $45 share on the host's account, once; cancelling the rest refunds what's left", async () => {
      const { r, session, weeks } = await paidSeries();
      await store.cancelBooking(priya.id, weeks[1].id, "guest");
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "paid", refund_due_minor: 4_500 });
      expect(await processStripeRefunds(deps, new Date())).toMatchObject({ refunded: 1, errors: 0 });
      const first = fake.state.requests.filter((q) => q.method === "POST" && q.path === "/v1/refunds");
      expect(first).toHaveLength(1);
      expect(first[0].body).toContain("amount=4500");
      expect(first[0].headers["idempotency-key"]).toBe(`hh-refund-${(await paymentRow(r.booking.id)).id}-4500`);
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "paid", refunded_minor: 4_500, refund_due_minor: 0 });
      expect(await processStripeRefunds(deps, new Date(Date.now() + 10 * 60_000))).toMatchObject({ claimed: 0 });

      await store.cancelBooking(priya.id, weeks[0].id, "guest", undefined, { laterWeeks: true });
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "refund_pending" });
      await processStripeRefunds(deps, new Date());
      expect(refundsOn(session.payment_intent).map((x) => x.amount)).toEqual([4_500, 13_500]);
      expect(await paymentRow(r.booking.id)).toMatchObject({ status: "refunded", refunded_minor: 18_000, refund_due_minor: 0 });
    });

    it("a partial refund that went through before we recorded it is found, not made twice", async () => {
      const { r, weeks } = await paidSeries();
      await store.cancelBooking(priya.id, weeks[2].id, "guest");
      // The refund lands at Stripe, but recording it fails: the next round finds it instead of refunding again.
      await pool.query("update payments set checked_at = null where booking_id = $1", [r.booking.id]);
      const pi = (await paymentRow(r.booking.id)).provider_payment_id as string;
      await deps.api.refund(accountId, pi, { refundApplicationFee: false, ref: `booking:${r.booking.id}`, amountMinor: 4_500 }, "outside");
      await processStripeRefunds(deps, new Date());
      expect(refundsOn(pi)).toHaveLength(1);
      expect(await paymentRow(r.booking.id)).toMatchObject({ refunded_minor: 4_500, refund_due_minor: 0 });
    });

    it("when Checkout can't start, every week of the series is released at once", async () => {
      fake.state.failSessions = true;
      const startAt = new Date(Date.UTC(2035, 6, 2, 0, 0) + slot++ * 3 * 3_600_000);
      const req = { ...input({ startAt, price: 9_000 }), weeks: 2 };
      await expect(startStripeBooking({ pool, store, api: deps.api, host: host() }, req, new Date())).rejects.toThrow(/Payment could not start/);
      const { rows } = await pool.query("select status from bookings where idempotency_key like $1", [`${req.idempotencyKey}%`]);
      expect(rows.map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
    });
  });

  describe("booking route, packages and the switching guard", () => {
    const setPrice = async (minor: number | null, currency: string | null) =>
      pool.query("update event_types set price_minor = $2, currency = $3, deposit_minor = null where id = $1", [eventTypeId, minor, currency]);
    const paymentDeps = (o: { plan?: "free" | "solo" } = {}): PaymentDeps => ({
      pool, authFor: async () => null, ordersFor: () => { throw new Error("no Razorpay"); }, planFor: async () => o.plan ?? "solo",
      stripe: { deps, baseUrl: "https://hh.test" },
    });
    async function request() {
      const et = (await store.listEventTypes(priya.id)).find((e) => e.id === eventTypeId)!;
      const s = (await freeSlots(store, priya, et, new Date(), new Date(Date.now() + 14 * 86_400_000), new Date()))[0];
      const questions = await store.listCustomQuestions(priya.id, eventTypeId);
      const answers = Object.fromEntries(questions.filter((q) => q.required).map((q) => [q.id, "yes"]));
      return { slug: "priya", event: et.slug, start: s.toISOString(), name: "Sam", email: "sam@example.com", timezone: "Europe/London", answers, idempotencyKey: randomUUID(), locale: "en" };
    }
    afterAll(() => setPrice(null, null));

    it("a USD-priced event on a ready Stripe host returns the Checkout page; the success URL comes back to the booked page", async () => {
      await setPrice(4_500, "USD");
      const res = await handleCreateBooking(store, await request(), new Date(), undefined, paymentDeps());
      expect(res.status).toBe(201);
      const body = res.body as { bookingId: string; payment: { provider: string; url: string } };
      expect(body.payment.provider).toBe("stripe");
      const session = [...fake.state.sessions.values()][0];
      expect(session.params.success_url).toBe(`https://hh.test/priya/${(await store.getEventType(priya.id, eventTypeId))!.slug}/booked/${body.bookingId}?session_id={CHECKOUT_SESSION_ID}&lang=en`);
    });

    it("refuses when the price is in another currency, onboarding isn't finished, or the host is on Free", async () => {
      await setPrice(4_500, "INR"); // priced before the host switched from Razorpay
      expect(await handleCreateBooking(store, await request(), new Date(), undefined, paymentDeps())).toEqual({ status: 409, body: { error: "payments_unavailable" } });
      await setPrice(4_500, "USD");
      expect(await handleCreateBooking(store, await request(), new Date(), undefined, paymentDeps({ plan: "free" }))).toEqual({ status: 409, body: { error: "payments_unavailable" } });
      await connect("pending");
      const pendingDeps: PaymentDeps = { ...paymentDeps(), stripe: { deps: { ...deps, accountFor: async () => ({ ...host(), onboarding: "pending" }) }, baseUrl: "https://hh.test" } };
      expect(await handleCreateBooking(store, await request(), new Date(), undefined, pendingDeps)).toEqual({ status: 409, body: { error: "payments_unavailable" } });
      expect(fake.state.sessions.size).toBe(0);
    });

    it("a package sold through Stripe is paid from the verified session, with no GST invoice", async () => {
      await saveTaxProfile(pool, priya.id, { legalName: "Priya", address: "Bengaluru", stateCode: "29", gstin: "29ABCDE1234F1Z5", sac: "999293", rateBp: 1800, invoicePrefix: "PR" });
      const pkg = await createPackage(pool, priya.id, { eventTypeId, name: "Five sessions", sessions: 5, priceMinor: 20_000, validDays: 90, currency: "USD" });
      const res = await handleStartPurchase(paymentDeps(), pkg.id, { name: "Sam", email: "sam@example.com", idempotencyKey: randomUUID() });
      expect(res.status).toBe(200);
      const body = res.body as { token: string; payment: { provider: string; url: string; currency: string } };
      expect(body.payment).toMatchObject({ provider: "stripe", currency: "USD", amount: 20_000 });
      const s = [...fake.state.sessions.values()].find((x) => x.metadata.hourhand_ref.startsWith("purchase:"))!;
      expect(s.params["line_items[0][price_data][currency]"]).toBe("usd");
      expect(await reconcileStripePurchases(deps, new Date())).toMatchObject({ claimed: 0 }); // too new to poll
      fake.pay(s.id);
      expect(await settleStripeSession(deps, s.id, new Date())).toBe("paid");
      const { rows: [p] } = await pool.query("select id, status, provider, provider_payment_id from package_purchases where token = $1", [body.token]);
      expect(p).toMatchObject({ status: "paid", provider: "stripe", provider_payment_id: s.payment_intent });
      expect(Number((await pool.query("select count(*) from invoices where package_purchase_id = $1", [p.id])).rows[0].count)).toBe(0);
      await pool.query("delete from tax_profiles where user_id = $1", [priya.id]);
    });

    it("Indian GST invoices are only for rupee payments", async () => {
      await saveTaxProfile(pool, priya.id, { legalName: "Priya", address: "Bengaluru", stateCode: "29", gstin: "29ABCDE1234F1Z5", sac: "999293", rateBp: 1800, invoicePrefix: "PR" });
      const { r } = await confirmed();
      const { id } = await paymentRow(r.booking.id);
      expect(await invoiceForPayment(pool, id, new Date())).toBeNull();
      expect(Number((await pool.query("select count(*) from invoices where payment_id = $1", [id])).rows[0].count)).toBe(0);
      await pool.query("delete from tax_profiles where user_id = $1", [priya.id]);
    });

    it("switching guard: Stripe can't be disconnected while a guest's payment is pending, then can once it settles", async () => {
      // Only this test's payment is in flight.
      await pool.query("update payments set status = 'failed' where status in ('pending', 'refund_pending')");
      const r = await start();
      await expect(disconnectStripe(pool, priya.id)).rejects.toMatchObject({ code: "busy" });
      fake.pay([...fake.state.sessions.keys()][0]);
      await settleStripeSession(deps, [...fake.state.sessions.keys()][0], new Date());
      expect((await paymentRow(r.booking.id)).status).toBe("paid");
      await disconnectStripe(pool, priya.id);
      expect((await pool.query("select 1 from integrations where user_id = $1 and provider = 'stripe'", [priya.id])).rowCount).toBe(0);
    });
  });
});
