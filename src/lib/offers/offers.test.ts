// Offers: the pure arithmetic always, and coupons, first-session discounts, campaigns and sliding scales against real
// Postgres (only with TEST_DATABASE_URL; uses its own database <name>_offers, dropped and recreated on every run).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { freeSlots, handleCreateBooking, type PaymentDeps } from "../booking";
import { LIMITS, type Plan } from "../billing/plans";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { splitInclusive } from "../gst/gst";
import { discountLine, invoiceById, saveTaxProfile } from "../gst/invoices";
import { handleStartPurchase } from "../packages/handlers";
import { applyPurchasePayment, createPackage, type Package } from "../packages/packages";
import { applyCapturedPayment, HOLD_MINUTES, reconcilePayments, processRefunds } from "../payments/booking-payments";
import { keyPairAuth } from "../payments/host-razorpay";
import { razorpayOrders } from "../payments/razorpay-orders";
import { createRateLimiter } from "../rate-limit";
import { createCampaign, createCoupon, endOfDay, saveFirstSession, saveSlidingScale, setCouponActive, validateCouponForm } from "./manage";
import { applicationState, campaignBanner, couponUses, offerForBooking, pagePricing, resolvePrice, type ResolvePriceInput } from "./offers";
import { renderBookingMail, type BookingMailContext } from "../mail/templates";
import { handleQuote } from "./quote";
import { appliesTo, campaignLive, discountAmount, pickBest, slidingCharge, usableIn, type Candidate } from "./pricing";

const BASE = process.env.TEST_DATABASE_URL;
const MIN = 60_000;
const DAY = 86_400_000;

describe("offer arithmetic", () => {
  it("takes a percent or a fixed amount off, never leaving less than ₹1", () => {
    expect(discountAmount(118_000, { kind: "percent", value: 20 })).toBe(23_600);
    expect(discountAmount(118_000, { kind: "fixed", value: 20_000 })).toBe(20_000);
    expect(discountAmount(50_000, { kind: "fixed", value: 90_000 })).toBe(49_900);
    expect(discountAmount(99_999, { kind: "percent", value: 15 })).toBe(15_000); // rounded to the paisa
  });

  it("picks the single best adjustment, never adding them up", () => {
    const coupon: Candidate = { kind: "coupon", label: "Code SAVE20", discount: { kind: "percent", value: 20 }, couponId: "c" };
    const campaign: Candidate = { kind: "campaign", label: "Diwali", discount: { kind: "percent", value: 10 }, campaignId: "k" };
    const first: Candidate = { kind: "first_session", label: "First", discount: { kind: "fixed", value: 15_000 } };
    expect(pickBest(100_000, [campaign, coupon, first])).toEqual({ candidate: coupon, discountMinor: 20_000 });
    expect(pickBest(100_000, [campaign, first])).toEqual({ candidate: first, discountMinor: 15_000 });
    expect(pickBest(100_000, [])).toBeNull();
  });

  it("on a tie keeps the client's coupon unused", () => {
    const coupon: Candidate = { kind: "coupon", label: "Code TEN", discount: { kind: "percent", value: 10 }, couponId: "c" };
    const campaign: Candidate = { kind: "campaign", label: "Diwali", discount: { kind: "fixed", value: 10_000 }, campaignId: "k" };
    expect(pickBest(100_000, [coupon, campaign])!.candidate.kind).toBe("campaign");
  });

  it("rupee amounts apply only to INR prices; percents apply in any currency", () => {
    expect(usableIn({ kind: "fixed", value: 20_000 }, "INR")).toBe(true);
    expect(usableIn({ kind: "fixed", value: 20_000 }, "USD")).toBe(false);
    expect(usableIn({ kind: "percent", value: 20 }, "GBP")).toBe(true);
    const fixed: Candidate = { kind: "coupon", label: "Code FLAT", discount: { kind: "fixed", value: 5_000 }, couponId: "c" };
    const pct: Candidate = { kind: "campaign", label: "Ten", discount: { kind: "percent", value: 10 }, campaignId: "k" };
    // On ₹100 the ₹50 code wins; on $100 it doesn't count at all, so the 10% campaign applies.
    expect(pickBest(10_000, [fixed, pct], "INR")!.candidate.kind).toBe("coupon");
    expect(pickBest(10_000, [fixed, pct], "USD")).toEqual({ candidate: pct, discountMinor: 1_000 });
    expect(pickBest(10_000, [fixed], "EUR")).toBeNull();
  });

  it("keeps a sliding-scale pick inside the host's range, defaulting to the suggestion", () => {
    const scale = { minMinor: 50_000, suggestedMinor: 120_000, maxMinor: 200_000, note: null };
    expect(slidingCharge(scale, null)).toBe(120_000);
    expect(slidingCharge(scale, 50_000)).toBe(50_000);
    expect(slidingCharge(scale, 200_000)).toBe(200_000);
    expect(slidingCharge(scale, 49_999)).toBeNull();
    expect(slidingCharge(scale, 200_001)).toBeNull();
    expect(slidingCharge(scale, 100_000.5)).toBeNull();
  });

  it("turns a campaign on and off by the calendar date in the host's time zone", () => {
    const diwali = { startsOn: "2026-11-01", endsOn: "2026-11-05" };
    // 31 Oct 19:00 UTC is already 1 Nov (00:30) in India, still 31 Oct in New York.
    expect(campaignLive(diwali, new Date("2026-10-31T19:00:00Z"), "Asia/Kolkata")).toBe(true);
    expect(campaignLive(diwali, new Date("2026-10-31T19:00:00Z"), "America/New_York")).toBe(false);
    // 5 Nov 19:00 UTC is 6 Nov (00:30) in India, 5 Nov in New York.
    expect(campaignLive(diwali, new Date("2026-11-05T19:00:00Z"), "Asia/Kolkata")).toBe(false);
    expect(campaignLive(diwali, new Date("2026-11-05T19:00:00Z"), "America/New_York")).toBe(true);
    expect(campaignLive(diwali, new Date("2026-11-05T18:29:00Z"), "Asia/Kolkata")).toBe(true); // 23:59 IST on the last day
  });

  it("a coupon's expiry date runs to midnight at the end of that day in the host's zone", () => {
    expect(endOfDay("2026-11-05", "Asia/Kolkata").toISOString()).toBe("2026-11-05T18:30:00.000Z");
    expect(endOfDay("2026-11-05", "Europe/London").toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });

  it("limits to the chosen event types and packages, or all when none are chosen", () => {
    expect(appliesTo({ eventTypeIds: [], packageIds: [] }, { kind: "package", id: "p" })).toBe(true);
    expect(appliesTo({ eventTypeIds: ["e"], packageIds: [] }, { kind: "event_type", id: "e" })).toBe(true);
    expect(appliesTo({ eventTypeIds: ["e"], packageIds: [] }, { kind: "package", id: "e" })).toBe(false);
    expect(appliesTo({ eventTypeIds: [], packageIds: ["p"] }, { kind: "event_type", id: "x" })).toBe(false);
  });

  it("charges GST on the discounted value and shows the discount on the invoice", () => {
    // ₹1,180 incl. 18% GST, 20% off: ₹944 paid. Value ₹1,000 less discount ₹200 = taxable ₹800, GST ₹144.
    const split = splitInclusive(94_400, 1800, false);
    expect(split).toEqual({ totalMinor: 94_400, taxableMinor: 80_000, cgstMinor: 7_200, sgstMinor: 7_200, igstMinor: 0 });
    const offer = { kind: "coupon" as const, label: "Code DIWALI20", code: "DIWALI20", listMinor: 118_000, discountMinor: 23_600, chargeMinor: 94_400 };
    expect(discountLine(offer, 94_400, split.taxableMinor, 1800)).toEqual({ grossMinor: 100_000, discountMinor: 20_000, label: "Code DIWALI20" });
    // Odd amounts still add back exactly: gross - discount = taxable.
    const odd = splitInclusive(83_317, 1200, true);
    const line = discountLine({ ...offer, listMinor: 99_999, discountMinor: 16_682, chargeMinor: 83_317 }, 83_317, odd.taxableMinor, 1200)!;
    expect(line.grossMinor - line.discountMinor).toBe(odd.taxableMinor);
    // No line for a sliding-scale pick, no discount, or a charge that isn't what was paid.
    expect(discountLine({ ...offer, kind: "sliding_scale", discountMinor: 0, listMinor: 94_400 }, 94_400, split.taxableMinor, 1800)).toBeNull();
    expect(discountLine(offer, 118_000, 100_000, 1800)).toBeNull();
  });

  it("is off on Free and on for Solo and Duo", () => {
    expect([LIMITS.free.offers, LIMITS.solo.offers, LIMITS.duo.offers]).toEqual([false, true, true]);
  });

  it("the confirmation email explains the discount next to what was paid", () => {
    const c: BookingMailContext = {
      bookingId: "b1", eventName: "Coaching", hostName: "Priya", hostEmail: "priya@example.in", hostTimezone: "Asia/Kolkata", hostTimeFormat: "12h",
      guestName: "Asha", guestEmail: "asha@example.in", guestTimezone: "Asia/Kolkata", startAt: new Date("2026-11-20T04:30:00Z"), endAt: new Date("2026-11-20T05:15:00Z"),
      location: null, joinUrl: null, answers: [], cancelledBy: null, cancelReason: null, previousStartAt: null, issuedAt: new Date("2026-11-15T00:00:00Z"),
      manageUrl: "https://hourhand.test/b/t", dashboardUrl: "https://hourhand.test/dashboard/bookings/b1",
      paidMinor: 94_400, offer: { kind: "coupon", label: "Code DIWALI20", code: "DIWALI20", listMinor: 118_000, discountMinor: 23_600 },
    };
    expect(renderBookingMail("booked_guest", c).text).toContain("₹944 (₹1,180 less ₹236, code DIWALI20)");
    expect(renderBookingMail("booked_host", c).text).toContain("₹944 (₹1,180 less ₹236, code DIWALI20) to your Razorpay account");
    expect(renderBookingMail("booked_guest", { ...c, offer: null }).text).not.toContain("less");
  });

  it("checks the host's coupon form", () => {
    const form = { code: " diwali20 ", kind: "percent", value: "20", expiresOn: "", maxUses: "100", maxUsesPerEmail: "1", eventTypeIds: [], packageIds: [] };
    expect(validateCouponForm(form, "2026-11-15")).toMatchObject({ ok: true, value: { code: "DIWALI20", discount: { kind: "percent", value: 20 }, maxUses: 100, maxUsesPerEmail: 1 } });
    expect(validateCouponForm({ ...form, value: "95" }, "2026-11-15")).toMatchObject({ ok: false, errors: { value: expect.any(String) } });
    expect(validateCouponForm({ ...form, code: "a b" }, "2026-11-15")).toMatchObject({ ok: false, errors: { code: expect.any(String) } });
    expect(validateCouponForm({ ...form, expiresOn: "2026-11-14" }, "2026-11-15")).toMatchObject({ ok: false, errors: { expiresOn: expect.any(String) } });
    expect(validateCouponForm({ ...form, kind: "fixed", value: "250" }, "2026-11-15")).toMatchObject({ ok: true, value: { discount: { kind: "fixed", value: 25_000 } } });
  });
});

const auth = keyPairAuth("rzp_test_abcdefgh12", "k");

/** Razorpay orders: enough to start bookings and purchases and let the reconciler see no payment. */
function fakeRazorpay() {
  let creates = 0;
  const amounts: number[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if ((init.method ?? "GET") === "POST" && path === "/v1/orders") {
      creates += 1;
      const body = JSON.parse(String(init.body));
      amounts.push(body.amount);
      return json({ id: `order_of_${creates}_${Math.random().toString(36).slice(2, 8)}`, amount: body.amount, currency: body.currency, status: "created" });
    }
    if (/^\/v1\/orders\/[^/]+\/payments$/.test(path)) return json({ items: [] });
    if (/^\/v1\/payments\/[^/]+\/refunds$/.test(path)) return json({ items: [] });
    if (/^\/v1\/payments\/[^/]+\/refund$/.test(path)) return json({ id: `rfnd_${Math.random().toString(36).slice(2, 8)}`, status: "processed", amount: JSON.parse(String(init.body)).amount ?? 0 });
    return json({ error: { code: "BAD_REQUEST_ERROR", description: "not faked" } }, 400);
  }) as unknown as typeof fetch;
  return { amounts, orders: razorpayOrders(auth, { baseUrl: "https://rp.fake", fetchImpl }) };
}

describe.skipIf(!BASE)("offers (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let et: EventType;
  let other: EventType;
  let pkg: Package;
  const fake = fakeRazorpay();
  const deps = (plan: Plan = "solo"): PaymentDeps => ({ pool, authFor: async () => auth, ordersFor: () => fake.orders, planFor: async () => plan });
  let n = 0;
  const email = () => `client${++n}-${Math.random().toString(36).slice(2, 6)}@example.in`;

  /** A booking request for the next time the engine offers. */
  async function request(o: { email?: string; couponCode?: string; payMinor?: number; key?: string } = {}) {
    const start = (await freeSlots(store, priya, et, new Date(), new Date(Date.now() + 30 * DAY), new Date()))[0];
    const questions = await store.listCustomQuestions(priya.id, et.id);
    const answers = Object.fromEntries(questions.filter((q) => q.required).map((q) => [q.id, "yes"]));
    return {
      slug: "priya", event: et.slug, start: start.toISOString(), name: "Asha", email: o.email ?? email(), timezone: "Asia/Kolkata", answers, idempotencyKey: o.key ?? randomUUID(),
      ...(o.couponCode ? { couponCode: o.couponCode } : {}), ...(o.payMinor !== undefined ? { payMinor: o.payMinor } : {}),
    };
  }
  type Created = { bookingId: string; payment: { amount: number; holdExpiresAt: string }; offer?: { kind: string; label: string; discountMinor: number; chargeMinor: number } };
  const book = async (o: Parameters<typeof request>[0] = {}, plan: Plan = "solo", now = new Date()) => handleCreateBooking(store, await request(o), now, undefined, deps(plan));
  const booked = async (o: Parameters<typeof request>[0] = {}) => {
    const r = await book(o);
    expect(r.status).toBe(201);
    return r.body as Created;
  };
  const appFor = async (bookingId: string) =>
    (await pool.query("select a.id from offer_applications a join bookings b on b.idempotency_key = a.idempotency_key where b.id = $1", [bookingId])).rows[0]?.id as string | undefined;
  const coupon = (code: string, o: Partial<Parameters<typeof createCoupon>[3]> = {}) =>
    createCoupon(pool, priya.id, "Asia/Kolkata", { code, discount: { kind: "percent", value: 20 }, expiresOn: null, maxUses: null, maxUsesPerEmail: null, eventTypeIds: [], packageIds: [], ...o });
  const today = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY + 330 * MIN).toISOString().slice(0, 10);

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_offers`;
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
    const types = await store.listEventTypes(priya.id);
    await pool.query("update event_types set price_minor = 118000, currency = 'INR' where id = any($1::uuid[])", [types.map((t) => t.id)]);
    et = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
    other = (await store.listEventTypes(priya.id)).find((e) => e.id !== et.id && e.priceMinor !== null)!;
    pkg = await createPackage(pool, priya.id, { eventTypeId: et.id, name: "3 sessions", sessions: 3, priceMinor: 300_000, validDays: 60 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // Each test sets up its own offers.
    await pool.query("update offer_coupons set active = false");
    await pool.query("update offer_campaigns set active = false");
    await pool.query("delete from offer_first_session");
    await pool.query("delete from offer_sliding_scales");
  });

  it("a booking with no offers pays the list price and records nothing", async () => {
    const r = await booked();
    expect(r.payment.amount).toBe(118_000);
    expect(r.offer).toBeUndefined();
    expect(await appFor(r.bookingId)).toBeUndefined();
  });

  it("a percent coupon comes off the price charged, held while checkout is open and counted once paid", async () => {
    const id = await coupon("SAVE20");
    const r = await booked({ couponCode: "save20" });
    expect(r.payment.amount).toBe(94_400);
    expect(r.offer).toMatchObject({ kind: "coupon", label: "Code SAVE20", discountMinor: 23_600, chargeMinor: 94_400 });
    expect((await pool.query("select amount_minor from payments where booking_id = $1", [r.bookingId])).rows[0].amount_minor).toBe(94_400);
    const app = (await appFor(r.bookingId))!;
    expect(await applicationState(pool, app, new Date())).toBe("reserved");
    expect(await couponUses(pool, id, new Date())).toMatchObject({ used: 0, reserved: 1 });
    await applyCapturedPayment(pool, r.bookingId, `pay_${randomUUID()}`, new Date());
    expect(await applicationState(pool, app, new Date())).toBe("used");
    // Used for good: still counted after the hold would have run out.
    expect(await couponUses(pool, id, new Date(Date.now() + DAY))).toMatchObject({ used: 1, reserved: 0 });
  });

  it("an abandoned checkout releases its coupon use when the hold runs out", async () => {
    const id = await coupon("LAPSE", { maxUses: 1 });
    const r = await booked({ couponCode: "LAPSE" });
    const app = (await appFor(r.bookingId))!;
    // The only use is held: a second client is refused while the first is paying.
    expect(await book({ couponCode: "LAPSE" })).toMatchObject({ status: 400, body: { error: "coupon_invalid" } });
    const later = new Date(Date.now() + (HOLD_MINUTES + 1) * MIN);
    expect(await applicationState(pool, app, later)).toBe("released");
    // The reconciler releases the slot too; the use stays released.
    await reconcilePayments({ pool, authFor: async () => auth, ordersFor: () => fake.orders }, later);
    expect((await pool.query("select status from bookings where id = $1", [r.bookingId])).rows[0].status).toBe("cancelled");
    expect(await couponUses(pool, id, later)).toMatchObject({ used: 0, reserved: 0 });
    expect(await resolvePrice(pool, { hostId: priya.id, plan: "solo", item: { kind: "event_type", id: et.id, listMinor: 118_000 }, email: email(), couponCode: "LAPSE", payMinor: null, idempotencyKey: randomUUID(), now: later, reserve: true }))
      .toMatchObject({ ok: true, offer: { kind: "coupon" } });
  });

  it("a refused order (slot taken, payment couldn't start) holds the use only briefly", async () => {
    const id = await coupon("BRIEF", { maxUses: 1 });
    const now = new Date();
    const r = await resolvePrice(pool, { hostId: priya.id, plan: "solo", item: { kind: "event_type", id: et.id, listMinor: 118_000 }, email: email(), couponCode: "BRIEF", payMinor: null, idempotencyKey: randomUUID(), now, reserve: true });
    expect(r).toMatchObject({ ok: true, chargeMinor: 94_400 });
    expect(await couponUses(pool, id, now)).toMatchObject({ reserved: 1 });
    expect(await couponUses(pool, id, new Date(now.getTime() + 3 * MIN))).toMatchObject({ used: 0, reserved: 0 });
  });

  it("enforces total and per-client limits, expiry, the chosen event types and switching off", async () => {
    await coupon("ONCE", { maxUsesPerEmail: 1 });
    const asha = email();
    const r = await booked({ email: asha, couponCode: "ONCE" });
    await applyCapturedPayment(pool, r.bookingId, `pay_${randomUUID()}`, new Date());
    expect(await book({ email: asha, couponCode: "ONCE" })).toMatchObject({ status: 400, body: { fields: { couponCode: expect.any(String) } } });
    expect(await book({ email: asha.toUpperCase(), couponCode: "ONCE" })).toMatchObject({ status: 400 }); // emails compare case-insensitively
    expect((await book({ couponCode: "ONCE" })).status).toBe(201);

    await pool.query("insert into offer_coupons (user_id, code, discount_kind, discount_value, expires_at) values ($1, 'OLD', 'percent', 10, now() - interval '1 minute')", [priya.id]);
    expect(await book({ couponCode: "OLD" })).toMatchObject({ status: 400, body: { error: "coupon_invalid" } });

    await coupon("OTHERONLY", { eventTypeIds: [other.id] });
    expect(await book({ couponCode: "OTHERONLY" })).toMatchObject({ status: 400, body: { error: "coupon_invalid" } });

    const off = await coupon("PAUSED");
    await setCouponActive(pool, priya.id, off, false);
    expect(await book({ couponCode: "PAUSED" })).toMatchObject({ status: 400 });
    expect(await book({ couponCode: "NOSUCHCODE" })).toMatchObject({ status: 400, body: { error: "coupon_invalid" } });
  });

  it("two clients racing for a coupon's last use: exactly one gets it", async () => {
    const id = await coupon("LAST1", { maxUses: 1 });
    const now = new Date();
    const go = () => resolvePrice(pool, { hostId: priya.id, plan: "solo", item: { kind: "event_type", id: et.id, listMinor: 118_000 }, email: email(), couponCode: "LAST1", payMinor: null, idempotencyKey: randomUUID(), now, reserve: true });
    const results = await Promise.all([go(), go(), go()]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(await couponUses(pool, id, now)).toMatchObject({ reserved: 1 });
  });

  it("a repeat of the same request gets the same price, even if the coupon was switched off meanwhile", async () => {
    const id = await coupon("REPEAT");
    const req = await request({ couponCode: "REPEAT" });
    const a = (await handleCreateBooking(store, req, new Date(), undefined, deps())).body as Created;
    await setCouponActive(pool, priya.id, id, false);
    const b = await handleCreateBooking(store, req, new Date(), undefined, deps());
    expect(b.status).toBe(200);
    expect((b.body as Created).payment.amount).toBe(a.payment.amount);
    expect((b.body as Created).payment.amount).toBe(94_400);
  });

  it("first-session discount: automatic for a new client, not once they've paid for a session", async () => {
    await saveFirstSession(pool, priya.id, { kind: "fixed", value: 18_000 }, true);
    const newbie = email();
    const r = await booked({ email: newbie });
    expect(r.offer).toMatchObject({ kind: "first_session", discountMinor: 18_000 });
    expect(r.payment.amount).toBe(100_000);
    // A second checkout while the first is still open doesn't get a second first session.
    expect((await booked({ email: newbie })).payment.amount).toBe(118_000);
    await applyCapturedPayment(pool, r.bookingId, `pay_${randomUUID()}`, new Date());
    expect((await booked({ email: newbie })).payment.amount).toBe(118_000);
    // A client who bought a package has paid for sessions too.
    const buyer = email();
    await pool.query(
      `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, idempotency_key, status, paid_at, expires_at, provider_payment_id)
       values ($1, $2, $3, 3, 300000, 60, 'B', $4, $5, 'paid', now(), now() + interval '60 days', 'pay_pkg_first')`, [pkg.id, priya.id, et.id, buyer, randomUUID()]);
    expect((await booked({ email: buyer })).payment.amount).toBe(118_000);
    // Switched off: nobody gets it.
    await saveFirstSession(pool, priya.id, { kind: "fixed", value: 18_000 }, false);
    expect((await booked()).payment.amount).toBe(118_000);
  });

  it("with several lengths, offers come off the chosen length's own price, on the booking and in the quote", async () => {
    // Coaching also offered at a longer length with its own price: ₹1,180 at its own length, ₹2,000 at the longer one.
    const longer = et.durationMinutes + 30;
    await pool.query("update event_types set duration_options = $2, duration_prices = '{NULL,200000}' where id = $1", [et.id, [et.durationMinutes, longer]]);
    et = (await store.listEventTypes(priya.id)).find((e) => e.id === et.id)!;
    try {
      await createCampaign(pool, priya.id, { name: "Diwali offer", banner: "10% off", discount: { kind: "percent", value: 10 }, startsOn: today(-1), endsOn: today(1), eventTypeIds: [], packageIds: [] });
      const start = (await freeSlots(store, priya, { ...et, durationMinutes: longer }, new Date(), new Date(Date.now() + 30 * DAY), new Date()))[0];
      const r = await handleCreateBooking(store, { ...(await request()), start: start.toISOString(), duration: longer }, new Date(), undefined, deps());
      expect(r.status).toBe(201);
      const body = r.body as Created;
      expect(body.payment.amount).toBe(180_000); // 10% off ₹2,000, not off ₹1,180
      expect(await offerForBooking(pool, body.bookingId)).toMatchObject({ kind: "campaign", listMinor: 200_000, chargeMinor: 180_000 });
      // The booking page's coupon preview quotes the same length.
      expect(await handleQuote(store, deps(), { slug: "priya", event: et.slug, duration: longer }, new Date())).toMatchObject({ status: 200, body: { listMinor: 200_000, chargeMinor: 180_000 } });
      expect(await handleQuote(store, deps(), { slug: "priya", event: et.slug }, new Date())).toMatchObject({ status: 200, body: { listMinor: 118_000 } });
      expect(await handleQuote(store, deps(), { slug: "priya", event: et.slug, duration: longer + 5 }, new Date())).not.toMatchObject({ status: 200 });
      // The booking page works out each length's campaign price from the same rules.
      expect((await pagePricing(pool, priya.id, "solo", { kind: "event_type", id: et.id, listMinor: 200_000, currency: "INR" }, new Date())).campaign?.chargeMinor).toBe(180_000);
    } finally {
      await pool.query("update event_types set duration_options = '{}', duration_prices = '{}' where id = $1", [et.id]);
      et = (await store.listEventTypes(priya.id)).find((e) => e.id === et.id)!;
    }
  });

  it("a paid weekly series: a campaign comes off every week, a first-session discount doesn't apply", async () => {
    await pool.query("update event_types set max_repeats = 3 where id = $1", [et.id]);
    et = (await store.listEventTypes(priya.id)).find((e) => e.id === et.id)!;
    try {
      const open = await freeSlots(store, priya, et, new Date(), new Date(Date.now() + 50 * DAY), new Date());
      const set = new Set(open.map((d) => d.getTime()));
      const seriesStart = () => open.find((d) => set.has(d.getTime() + 7 * DAY) && set.has(d.getTime() + 14 * DAY) && set.delete(d.getTime()))!;
      // A first-session discount alone: a new client's single booking gets it, their series doesn't.
      await saveFirstSession(pool, priya.id, { kind: "percent", value: 10 }, true);
      const plain = await handleCreateBooking(store, { ...(await request()), start: seriesStart().toISOString(), weeks: 3 }, new Date(), undefined, deps());
      expect(plain.status).toBe(201);
      expect((plain.body as Created).payment.amount).toBe(3 * 118_000);
      // A campaign: 10% off each of the three weeks.
      await createCampaign(pool, priya.id, { name: "Diwali offer", banner: "10% off", discount: { kind: "percent", value: 10 }, startsOn: today(-1), endsOn: today(1), eventTypeIds: [], packageIds: [] });
      const r = await handleCreateBooking(store, { ...(await request()), start: seriesStart().toISOString(), weeks: 3 }, new Date(), undefined, deps());
      expect(r.status).toBe(201);
      expect((r.body as Created).payment.amount).toBe(3 * 106_200);
      expect((await pool.query("select sessions, amount_minor from payments where booking_id = $1", [(r.body as Created).bookingId])).rows[0]).toEqual({ sessions: 3, amount_minor: 318_600 });
    } finally {
      await pool.query("update event_types set max_repeats = 1 where id = $1", [et.id]);
      et = (await store.listEventTypes(priya.id)).find((e) => e.id === et.id)!;
    }
  });

  it("only one adjustment: the best of coupon, first session and campaign, never stacked", async () => {
    await saveFirstSession(pool, priya.id, { kind: "percent", value: 10 }, true);
    await createCampaign(pool, priya.id, { name: "Diwali offer", banner: "20% off till 5 Nov", discount: { kind: "percent", value: 15 }, startsOn: today(-1), endsOn: today(1), eventTypeIds: [], packageIds: [] });
    await coupon("BIG25", { discount: { kind: "percent", value: 25 } });
    await coupon("SMALL5", { discount: { kind: "percent", value: 5 } });
    // 25% coupon beats 15% campaign and 10% first session; not 50% together.
    const big = await booked({ couponCode: "BIG25" });
    expect(big.offer).toMatchObject({ kind: "coupon", discountMinor: 29_500 });
    expect(big.payment.amount).toBe(88_500);
    // A weaker coupon loses to the campaign, and isn't used up.
    const small = await booked({ couponCode: "SMALL5" });
    expect(small.offer).toMatchObject({ kind: "campaign", label: "Diwali offer", discountMinor: 17_700 });
    const smallId = (await pool.query("select id from offer_coupons where code = 'SMALL5'")).rows[0].id;
    expect(await couponUses(pool, smallId, new Date())).toMatchObject({ used: 0, reserved: 0 });
    const quote = await resolvePrice(pool, { hostId: priya.id, plan: "solo", item: { kind: "event_type", id: et.id, listMinor: 118_000 }, email: "", couponCode: "SMALL5", payMinor: null, idempotencyKey: "q", now: new Date(), reserve: false });
    expect(quote).toMatchObject({ ok: true, couponNotUsed: true, offer: { kind: "campaign" } });
    // The booking page explains it, and the record matches what was charged.
    expect(await offerForBooking(pool, small.bookingId)).toMatchObject({ kind: "campaign", listMinor: 118_000, discountMinor: 17_700, chargeMinor: 100_300 });
  });

  it("campaigns go live and end by date in the host's time zone, with a banner on their page", async () => {
    const live = await createCampaign(pool, priya.id, { name: "Live", banner: "On now", discount: { kind: "percent", value: 10 }, startsOn: today(), endsOn: today(), eventTypeIds: [], packageIds: [] });
    await createCampaign(pool, priya.id, { name: "Later", banner: "Soon", discount: { kind: "percent", value: 50 }, startsOn: today(3), endsOn: today(5), eventTypeIds: [], packageIds: [] });
    const now = new Date();
    expect(await campaignBanner(pool, priya.id, "solo", now)).toMatchObject({ name: "Live", banner: "On now" });
    expect(await campaignBanner(pool, priya.id, "free", now)).toBeNull();
    expect((await pagePricing(pool, priya.id, "solo", { kind: "event_type", id: et.id, listMinor: 118_000 }, now)).campaign).toMatchObject({ name: "Live", chargeMinor: 106_200 });
    // Three days on: today's campaign is over and the later one is on.
    const inThree = new Date(now.getTime() + 3 * DAY);
    expect(await campaignBanner(pool, priya.id, "solo", inThree)).toMatchObject({ name: "Later" });
    expect(live).toBeTruthy();
  });

  it("sliding scale: the client's pick within the range is the price, and no coupon goes with it", async () => {
    await saveSlidingScale(pool, priya.id, et.id, { minMinor: 50_000, suggestedMinor: 120_000, maxMinor: 200_000, note: "Pay what fits your budget." });
    await coupon("NOPE");
    await createCampaign(pool, priya.id, { name: "Ignored", banner: "x", discount: { kind: "percent", value: 30 }, startsOn: today(-1), endsOn: today(1), eventTypeIds: [], packageIds: [] });
    const r = await booked({ payMinor: 60_000 });
    expect(r.payment.amount).toBe(60_000);
    expect(r.offer).toMatchObject({ kind: "sliding_scale", discountMinor: 0, chargeMinor: 60_000 });
    expect((await booked()).payment.amount).toBe(120_000);
    expect(await book({ payMinor: 49_999 })).toMatchObject({ status: 400, body: { fields: { payMinor: expect.any(String) } } });
    expect(await book({ payMinor: 200_100 })).toMatchObject({ status: 400 });
    expect(await book({ payMinor: 60_000, couponCode: "NOPE" })).toMatchObject({ status: 400, body: { error: "coupon_invalid" } });
    // Only on the host's own priced event types.
    const { rows: [stranger] } = await pool.query("select id from users where id <> $1 limit 1", [priya.id]);
    await expect(saveSlidingScale(pool, stranger.id, et.id, { minMinor: 100, suggestedMinor: 100, maxMinor: 100, note: null })).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("the tax invoice shows original value, discount, taxable value and GST on the discounted price; a refund's credit note mirrors it", async () => {
    await saveTaxProfile(pool, priya.id, { legalName: "Priya Raman Coaching", address: "12 MG Road, Bengaluru", stateCode: "29", gstin: "29ABCDE1234F1Z5", sac: "999293", rateBp: 1800, invoicePrefix: "PR" });
    await coupon("INV20");
    const r = await booked({ couponCode: "INV20" });
    await applyCapturedPayment(pool, r.bookingId, `pay_${randomUUID()}`, new Date());
    const { rows: [row] } = await pool.query("select v.id from invoices v join payments p on p.id = v.payment_id where p.booking_id = $1", [r.bookingId]);
    const v = (await invoiceById(pool, row.id))!;
    expect(v).toMatchObject({ totalMinor: 94_400, taxableMinor: 80_000, cgstMinor: 7_200, sgstMinor: 7_200, discount: { grossMinor: 100_000, discountMinor: 20_000, label: "Code INV20" } });
    // Refunded: the credit note carries the same lines.
    await pool.query("update payments set status = 'refund_pending' where booking_id = $1", [r.bookingId]);
    await pool.query("update payments set provider_payment_id = 'pay_inv20' where booking_id = $1", [r.bookingId]);
    await processRefunds({ pool, authFor: async () => auth, ordersFor: () => fake.orders }, new Date());
    const { rows: [cn] } = await pool.query("select id from invoices where original_invoice_id = $1", [v.id]);
    expect(await invoiceById(pool, cn.id)).toMatchObject({ kind: "credit_note", totalMinor: 94_400, discount: { grossMinor: 100_000, discountMinor: 20_000 } });
    await pool.query("delete from tax_profiles where user_id = $1", [priya.id]);
  });

  it("packages: a coupon limited to the package comes off its price and its invoice; a pending purchase holds the use for a while", async () => {
    await saveTaxProfile(pool, priya.id, { legalName: "Priya Raman Coaching", address: "12 MG Road, Bengaluru", stateCode: "29", gstin: "29ABCDE1234F1Z5", sac: "999293", rateBp: 1800, invoicePrefix: "PR" });
    const id = await coupon("PKG500", { discount: { kind: "fixed", value: 50_000 }, packageIds: [pkg.id], maxUses: 5 });
    const buyer = email();
    const r = await handleStartPurchase(deps(), pkg.id, { name: "Kavya", email: buyer, idempotencyKey: randomUUID(), couponCode: "PKG500" });
    expect(r.status).toBe(200);
    const body = r.body as { token: string; payment: { amount: number }; offer: { kind: string } };
    expect(body.payment.amount).toBe(250_000);
    expect(body.offer).toMatchObject({ kind: "coupon" });
    expect(await couponUses(pool, id, new Date())).toMatchObject({ reserved: 1 });
    expect(await couponUses(pool, id, new Date(Date.now() + 25 * MIN))).toMatchObject({ reserved: 0 });
    const { rows: [p] } = await pool.query("select id, price_minor from package_purchases where token = $1", [body.token]);
    expect(p.price_minor).toBe(250_000);
    await applyPurchasePayment(pool, p.id, `pay_${randomUUID()}`, new Date());
    expect(await couponUses(pool, id, new Date(Date.now() + DAY))).toMatchObject({ used: 1 });
    const { rows: [inv] } = await pool.query("select taxable_minor, gross_minor, discount_minor, discount_label, total_minor from invoices where package_purchase_id = $1", [p.id]);
    expect(inv).toEqual({ taxable_minor: 211_864, gross_minor: 254_237, discount_minor: 42_373, discount_label: "Code PKG500", total_minor: 250_000 });
    // The same code on an event type it isn't for is refused.
    expect(await book({ couponCode: "PKG500" })).toMatchObject({ status: 400 });
    // First session is for sessions, not packages.
    await saveFirstSession(pool, priya.id, { kind: "percent", value: 50 }, true);
    const plain = await handleStartPurchase(deps(), pkg.id, { name: "New", email: email(), idempotencyKey: randomUUID() });
    expect((plain.body as { payment: { amount: number } }).payment.amount).toBe(300_000);
    await pool.query("delete from tax_profiles where user_id = $1", [priya.id]);
  });

  it("the booking page's quote shows a code's price without holding a use, and never quotes the first-session discount", async () => {
    const id = await coupon("QUOTE15", { discount: { kind: "percent", value: 15 } });
    await saveFirstSession(pool, priya.id, { kind: "percent", value: 50 }, true);
    const r = await handleQuote(store, deps(), { slug: "priya", event: et.slug, couponCode: "quote15" }, new Date());
    expect(r).toEqual({ status: 200, body: { listMinor: 118_000, chargeMinor: 100_300, offer: expect.objectContaining({ kind: "coupon", code: "QUOTE15", discountMinor: 17_700 }) } });
    expect(await couponUses(pool, id, new Date())).toMatchObject({ used: 0, reserved: 0 });
    expect(await handleQuote(store, deps(), { slug: "priya", event: et.slug }, new Date())).toMatchObject({ status: 200, body: { chargeMinor: 118_000, offer: null } });
    expect(await handleQuote(store, deps(), { slug: "priya", event: et.slug, couponCode: "WRONG" }, new Date())).toMatchObject({ status: 400, body: { error: "coupon_invalid" } });
    expect(await handleQuote(store, deps(), { packageId: pkg.id, couponCode: "QUOTE15" }, new Date())).toMatchObject({ status: 200, body: { chargeMinor: 255_000 } });
    expect(await handleQuote(store, deps(), { slug: "priya", event: "nope" }, new Date())).toMatchObject({ status: 404 });
    expect(await handleQuote(store, null, { slug: "priya", event: et.slug }, new Date())).toMatchObject({ status: 409 });
  });

  it("on a price in another currency: percent codes and campaigns apply, rupee amounts and the sliding scale don't", async () => {
    await coupon("PCT10", { discount: { kind: "percent", value: 10 } });
    await coupon("FLAT200", { discount: { kind: "fixed", value: 20_000 } });
    await createCampaign(pool, priya.id, { name: "Flat campaign", banner: "x", discount: { kind: "fixed", value: 50_000 }, startsOn: today(-1), endsOn: today(1), eventTypeIds: [], packageIds: [] });
    await saveFirstSession(pool, priya.id, { kind: "fixed", value: 30_000 }, true);
    const usd = { kind: "event_type" as const, id: et.id, listMinor: 10_000, currency: "usd" };
    const go = (couponCode: string | null, item = usd) => resolvePrice(pool, { hostId: priya.id, plan: "solo", item, email: email(), couponCode, payMinor: null, idempotencyKey: randomUUID(), now: new Date(), reserve: true });
    // No usable offer on $100: the fixed campaign and fixed first-session discount are skipped.
    expect(await go(null)).toEqual({ ok: true, listMinor: 10_000, chargeMinor: 10_000, offer: null });
    expect(await go("PCT10")).toMatchObject({ ok: true, chargeMinor: 9_000, offer: { kind: "coupon", code: "PCT10" } });
    expect(await go("FLAT200")).toMatchObject({ ok: false, status: 400, body: { error: "coupon_invalid" } });
    // The same fixed campaign still applies to an INR price.
    expect(await go(null, { ...usd, listMinor: 118_000, currency: "INR" })).toMatchObject({ ok: true, offer: { kind: "campaign" } });
    // A sliding scale is set in rupees: a USD price ignores it and charges its list price.
    await saveSlidingScale(pool, priya.id, et.id, { minMinor: 50_000, suggestedMinor: 120_000, maxMinor: 200_000, note: null });
    expect(await resolvePrice(pool, { hostId: priya.id, plan: "solo", item: usd, email: email(), couponCode: null, payMinor: 60_000, idempotencyKey: randomUUID(), now: new Date(), reserve: false }))
      .toMatchObject({ ok: true, chargeMinor: 10_000, offer: null });
    expect(await pagePricing(pool, priya.id, "solo", usd, new Date())).toMatchObject({ sliding: null, campaign: null, firstSession: null, coupons: true });
  });

  it("rate-limits coupon tries per client address and per event type", async () => {
    const limiter = createRateLimiter();
    const base: ResolvePriceInput = { hostId: priya.id, plan: "solo", item: { kind: "event_type", id: et.id, listMinor: 118_000 }, email: "", couponCode: "GUESS1", payMinor: null, idempotencyKey: "q", now: new Date(), reserve: false };
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await resolvePrice(pool, { ...base, couponCode: `GUESS${i}`, limit: { clientKey: "203.0.113.9", limiter } });
      statuses.push(r.ok ? 200 : r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Many addresses on one event type: stopped at the per-event-type limit.
    let blocked = 0;
    for (let i = 0; i < 40; i++) {
      const r = await resolvePrice(pool, { ...base, limit: { clientKey: `198.51.100.${i}`, limiter } });
      if (!r.ok && r.status === 429) blocked += 1;
    }
    expect(blocked).toBe(10); // the first address used 10 of the 40 per-event-type tries (its 11th stopped at the address limit)
    // A quote without a code isn't limited.
    expect(await resolvePrice(pool, { ...base, couponCode: null, limit: { clientKey: "203.0.113.9", limiter } })).toMatchObject({ ok: true });
    // The booking route answers 429 too.
    const res = await handleCreateBooking(store, await request({ couponCode: "GUESS99" }), new Date(), { clientKey: "203.0.113.9", limiter }, deps());
    expect(res).toEqual({ status: 429, body: { error: "too_many_requests" } });
  });

  it("is off on the Free plan: no campaign, no first session, codes refused", async () => {
    await saveFirstSession(pool, priya.id, { kind: "percent", value: 50 }, true);
    await createCampaign(pool, priya.id, { name: "Free plan", banner: "x", discount: { kind: "percent", value: 30 }, startsOn: today(-1), endsOn: today(1), eventTypeIds: [], packageIds: [] });
    await coupon("FREEPLAN");
    const item = { kind: "event_type" as const, id: et.id, listMinor: 118_000 };
    expect(await resolvePrice(pool, { hostId: priya.id, plan: "free", item, email: email(), couponCode: null, payMinor: null, idempotencyKey: randomUUID(), now: new Date(), reserve: true }))
      .toEqual({ ok: true, listMinor: 118_000, chargeMinor: 118_000, offer: null });
    expect(await resolvePrice(pool, { hostId: priya.id, plan: "free", item, email: email(), couponCode: "FREEPLAN", payMinor: null, idempotencyKey: randomUUID(), now: new Date(), reserve: true }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await pagePricing(pool, priya.id, "free", item, new Date())).toMatchObject({ campaign: null, firstSession: null, coupons: false });
  });

  it("a coupon can only name the host's own priced event types and packages", async () => {
    const { rows: [stranger] } = await pool.query("select id from users where id <> $1 limit 1", [priya.id]);
    await expect(createCoupon(pool, stranger.id, "Asia/Kolkata", { code: "STEAL", discount: { kind: "percent", value: 10 }, expiresOn: null, maxUses: null, maxUsesPerEmail: null, eventTypeIds: [et.id], packageIds: [] }))
      .rejects.toMatchObject({ name: "NotFoundError" });
    // A code the host already has (even switched off) can't be made again.
    await expect(coupon("SAVE20")).rejects.toMatchObject({ name: "DuplicateCodeError" });
  });
});
