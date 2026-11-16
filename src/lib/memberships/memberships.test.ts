// Memberships against real Postgres and a fake Razorpay Subscriptions API (only with TEST_DATABASE_URL; uses its own
// database <name>_mbr, dropped and recreated on every run). The parts that need no database run always.
import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { LIMITS, type Plan } from "../billing/plans";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { processDueNotifications } from "../jobs/worker";
import type { Mail } from "../mail/mailer";
import { handleCancel } from "../manage";
import { keyPairAuth } from "../payments/host-razorpay";
import { handleCancelMembership, handleJoin, membershipsAllowed, type MembershipDeps } from "./handlers";
import {
  createMembershipPlan, creditsLeft, membershipByToken, startMembership, validatePlanForm, type MembershipPlan, type PlanInput,
} from "./memberships";
import { parseRazorpayMembershipEvent, razorpayMembershipProvider } from "./provider";
import { handleMembershipWebhook, webhookSecret } from "./webhook";

const BASE = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;
const auth = keyPairAuth("rzp_test_abcdefgh12", "k");

/** Razorpay's plans and subscriptions endpoints, recording every call. */
function fakeRazorpay() {
  const state = { plans: [] as Record<string, unknown>[], subs: new Map<string, Record<string, unknown>>(), cancels: [] as { id: string; atCycleEnd: boolean }[], fail: false };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (state.fail) return json({ error: { code: "SERVER_ERROR", description: "down" } }, 503);
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method === "POST" && path === "/v1/plans") {
      const plan = { id: `plan_${state.plans.length + 1}${Math.random().toString(36).slice(2, 8)}`, ...body };
      state.plans.push(plan);
      return json(plan);
    }
    if (init.method === "POST" && path === "/v1/subscriptions") {
      const id = `sub_${state.subs.size + 1}${Math.random().toString(36).slice(2, 8)}`;
      const sub = { id, status: "created", short_url: `https://rzp.io/i/${id}`, ...body };
      state.subs.set(id, sub);
      return json(sub);
    }
    const c = /^\/v1\/subscriptions\/([^/]+)\/cancel$/.exec(path);
    if (c && init.method === "POST") {
      const sub = state.subs.get(decodeURIComponent(c[1]));
      if (!sub) return json({ error: { code: "BAD_REQUEST_ERROR", description: "no such subscription" } }, 400);
      state.cancels.push({ id: sub.id as string, atCycleEnd: body.cancel_at_cycle_end === true });
      if (!body.cancel_at_cycle_end) sub.status = "cancelled";
      return json(sub);
    }
    return json({ error: { code: "BAD_REQUEST_ERROR", description: `unexpected ${init.method} ${path}` } }, 400);
  }) as unknown as typeof fetch;
  return { state, provider: razorpayMembershipProvider(auth, { baseUrl: "https://rp.fake", fetchImpl }) };
}

describe("membership form", () => {
  const form = { name: "Coaching Plus", sessions: "4", price: "6000", rollover: "capped", rolloverCap: "4", eventTypeIds: ["6f1c2d3e-0000-4000-8000-000000000001"] };
  it("takes sessions, a monthly price in rupees, a rollover rule and event types", () => {
    expect(validatePlanForm(form)).toEqual({ ok: true, value: { name: "Coaching Plus", sessions: 4, priceMinor: 600_000, rollover: "capped", rolloverCap: 4, eventTypeIds: form.eventTypeIds } });
    expect(validatePlanForm({ ...form, rollover: "none", rolloverCap: "" })).toMatchObject({ ok: true, value: { rollover: "none", rolloverCap: null } });
    expect(validatePlanForm({ ...form, sessions: "0" })).toMatchObject({ ok: false, errors: { sessions: expect.any(String) } });
    expect(validatePlanForm({ ...form, rolloverCap: "" })).toMatchObject({ ok: false, errors: { rolloverCap: expect.any(String) } });
    expect(validatePlanForm({ ...form, rollover: "sometimes" })).toMatchObject({ ok: false, errors: { rollover: expect.any(String) } });
    expect(validatePlanForm({ ...form, eventTypeIds: [] })).toMatchObject({ ok: false, errors: { eventTypeIds: expect.any(String) } });
  });

  it("is a Solo and Duo feature", () => {
    expect(membershipsAllowed("free")).toBe(false);
    expect(membershipsAllowed("solo")).toBe(true);
    expect(membershipsAllowed("duo")).toBe(true);
    expect(LIMITS.free.memberships).toBe(false);
  });
});

describe("Razorpay subscription events", () => {
  it("reads a charge: subscription, period and payment", () => {
    const e = parseRazorpayMembershipEvent({
      event: "subscription.charged", created_at: 1_800_000_000,
      payload: { subscription: { entity: { id: "sub_1", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000 } },
        payment: { entity: { id: "pay_1", amount: 600_000, currency: "INR", status: "captured" } } },
    }, "evt_1", new Date());
    expect(e).toMatchObject({ eventId: "evt_1", type: "charged", subscriptionId: "sub_1", status: "active", payment: { id: "pay_1", amount: 600_000, status: "captured" } });
    expect(e!.currentEnd!.getTime()).toBe(1_802_592_000_000);
  });

  it("keeps a stable id without the event-id header, and ignores events it doesn't use", () => {
    const body = { event: "payment.captured", created_at: 5, payload: { payment: { entity: { id: "pay_9" } } } };
    expect(parseRazorpayMembershipEvent(body, null, new Date())).toMatchObject({ type: "other", subscriptionId: null, eventId: "payment.captured:none:pay_9:5" });
    expect(parseRazorpayMembershipEvent({}, null, new Date())).toBeNull();
  });
});

describe.skipIf(!BASE)("memberships (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let coaching: EventType;
  let intro: EventType;
  const key = randomBytes(32);
  let secret: string;
  let n = 0;
  let hostPlan: Plan = "solo";

  const deps = (fake: ReturnType<typeof fakeRazorpay>): MembershipDeps => ({
    pool, authFor: async () => auth, providerFor: () => fake.provider, planFor: async () => hostPlan,
  });
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({ name: "Coaching Plus", sessions: 4, priceMinor: 600_000, rollover: "none", rolloverCap: null, eventTypeIds: [coaching.id, intro.id], ...over });
  const person = () => ({ name: "Kavya", email: `kavya${++n}@example.in`, phone: null, idempotencyKey: `mb-key-${n}-${Math.random()}` });

  /** Delivers a webhook body to the host's endpoint, signed with their secret unless told otherwise. */
  async function deliver(body: Record<string, unknown>, opts: { eventId?: string; signWith?: string; now?: Date } = {}) {
    const raw = JSON.stringify(body);
    const sig = createHmac("sha256", opts.signWith ?? secret).update(raw).digest("hex");
    const headers = new Headers({ "x-razorpay-signature": sig, "x-razorpay-event-id": opts.eventId ?? `evt_${Math.random().toString(36).slice(2)}` });
    return handleMembershipWebhook(pool, key, priya.id, raw, headers, opts.now ?? new Date());
  }
  const unix = (d: Date) => Math.floor(d.getTime() / 1000);
  const subEvent = (event: string, subId: string, status: string, start: Date, at = new Date(), payment?: Record<string, unknown>) => ({
    entity: "event", event, created_at: unix(at),
    payload: {
      subscription: { entity: { id: subId, status, current_start: unix(start), current_end: unix(new Date(start.getTime() + 30 * DAY)) } },
      ...(payment ? { payment: { entity: payment } } : {}),
    },
  });
  const charge = (subId: string, start: Date, amount = 600_000, at = new Date()) =>
    subEvent("subscription.charged", subId, "active", start, at, { id: `pay_${Math.random().toString(36).slice(2, 10)}`, amount, currency: "INR", status: "captured" });

  /** A membership joined and its subscription created (no charge yet). */
  async function joined(plan: MembershipPlan, fake = fakeRazorpay()) {
    const r = await startMembership({ pool, provider: fake.provider }, { planId: plan.id, ...person() });
    return { token: r.token, subId: r.checkout!.subscriptionId, fake };
  }

  // Three hours apart, ~20 days out at 1am IST: inside the first month, clear of the demo bookings.
  let slot = 0;
  const startIn = (days: number) => new Date(Math.floor(Date.now() / DAY) * DAY + days * DAY + 19.5 * 3_600_000 + (slot++ % 7) * 3 * 3_600_000);
  const bookWith = (token: string, startAt = startIn(20), eventType = coaching, weeks?: number) =>
    store.createBooking({ eventTypeId: eventType.id, startAt, idempotencyKey: `mb-book-${Math.random()}`, packageToken: token,
      invitee: { name: "Kavya", email: "kavya@example.in", timezone: "Asia/Kolkata", phone: null, answers: [] }, ...(weeks ? { weeks } : {}) });
  const left = async (token: string, now = new Date()) => creditsLeft(pool, (await membershipByToken(pool, token))!, now);

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_mbr`;
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
    const ets = await store.listEventTypes(priya.id);
    coaching = ets.find((e) => e.slug === "coaching")!;
    intro = ets.find((e) => e.slug === "intro")!; // cancel cutoff: 2 hours
    secret = await webhookSecret(pool, key, priya.id);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates a monthly plan on the host's Razorpay, only for their own bookable event types", async () => {
    const fake = fakeRazorpay();
    const plan = await createMembershipPlan({ pool, provider: fake.provider }, priya.id, input());
    expect(fake.state.plans).toEqual([expect.objectContaining({ period: "monthly", interval: 1, item: { name: "Coaching Plus", amount: 600_000, currency: "INR" } })]);
    expect(plan).toMatchObject({ providerPlanId: fake.state.plans[0].id, sessions: 4, rollover: "none", active: true });
    expect(plan.eventTypeIds.sort()).toEqual([coaching.id, intro.id].sort());
    const { rows: [other] } = await pool.query("select id from users where id <> $1 and deleted_at is null limit 1", [priya.id]);
    await expect(createMembershipPlan({ pool, provider: fake.provider }, other.id, input())).rejects.toMatchObject({ name: "NotFoundError" });
    expect(fake.state.plans).toHaveLength(1); // nothing made at Razorpay for a refused plan
  });

  it("joining makes one subscription per request key, and is refused on Free", async () => {
    const fake = fakeRazorpay();
    const plan = await createMembershipPlan({ pool, provider: fake.provider }, priya.id, input());
    const body = { name: "Kavya", email: "kavya-join@example.in", idempotencyKey: "join-key-123456" };
    const a = await handleJoin(deps(fake), plan.id, body);
    const b = await handleJoin(deps(fake), plan.id, body);
    expect(a).toMatchObject({ status: 200, body: { status: "created", checkout: { provider: "razorpay", publicKey: auth.keyId } } });
    expect((b.body as { checkout: { subscriptionId: string } }).checkout.subscriptionId).toBe((a.body as { checkout: { subscriptionId: string } }).checkout.subscriptionId);
    expect(fake.state.subs.size).toBe(1);
    expect([...fake.state.subs.values()][0]).toMatchObject({ plan_id: plan.providerPlanId, total_count: 120, quantity: 1 });
    hostPlan = "free";
    try {
      expect(await handleJoin(deps(fake), plan.id, { ...body, idempotencyKey: "join-key-free-1" })).toMatchObject({ status: 409, body: { error: "payments_unavailable" } });
    } finally {
      hostPlan = "solo";
    }
  });

  it("grants credits only on a signed charge, once per event and once per payment", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input());
    const { token, subId } = await joined(plan);
    // Checkout finishing in the browser, or the authenticated event, adds nothing.
    expect((await deliver(subEvent("subscription.authenticated", subId, "authenticated", new Date()))).status).toBe(200);
    expect(await left(token)).toBe(0);
    expect((await membershipByToken(pool, token))!.status).toBe("authenticated");
    // A forged event is refused.
    const forged = charge(subId, new Date());
    expect(await deliver(forged, { signWith: "not-the-secret" })).toMatchObject({ status: 400, body: { error: "bad_signature" } });
    expect(await left(token)).toBe(0);
    // The real one grants 4; the same delivery again does nothing; the same payment in another event does nothing.
    expect(await deliver(forged, { eventId: "evt_charge_1" })).toMatchObject({ status: 200, body: { outcome: "granted" } });
    expect(await deliver(forged, { eventId: "evt_charge_1" })).toMatchObject({ status: 200, body: { outcome: "duplicate" } });
    expect(await deliver(forged, { eventId: "evt_charge_1b" })).toMatchObject({ status: 200, body: { outcome: "already_granted" } });
    expect(await left(token)).toBe(4);
    expect(await membershipByToken(pool, token)).toMatchObject({ status: "active", charges: 1 });
    // A charge of the wrong amount never buys credits.
    expect(await deliver(charge(subId, new Date(), 100))).toMatchObject({ body: { outcome: "rejected" } });
    expect(await left(token)).toBe(4);
    const { rows: mails } = await pool.query("select kind, recipient from notifications where dedupe_key like $1 order by kind", [`membership:%:joined:%`]);
    expect(mails).toEqual(expect.arrayContaining([{ kind: "membership_guest", recipient: (await membershipByToken(pool, token))!.guestEmail }, { kind: "membership_host", recipient: priya.email }]));
  });

  it("a booking spends a credit; a cancel in time gives it back, a late cancel is refused", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input({ sessions: 2 }));
    const { token, subId } = await joined(plan);
    await expect(bookWith(token)).rejects.toMatchObject({ name: "PackageUnavailableError", reason: "unpaid" });
    await deliver(charge(subId, new Date()));
    const first = await bookWith(token);
    expect(await left(token)).toBe(1);
    const { rows: [b] } = await pool.query("select membership_grant_id from bookings where id = $1", [first.id]);
    expect(b.membership_grant_id).not.toBeNull();
    await bookWith(token, startIn(21), intro);
    expect(await left(token)).toBe(0);
    await expect(bookWith(token)).rejects.toMatchObject({ reason: "used_up" });
    // In policy (coaching has no cutoff): the credit comes back.
    expect(await handleCancel(store, first.invitee.manageToken, undefined, new Date())).toMatchObject({ status: 200 });
    expect(await left(token)).toBe(1);
    // Inside intro's 2-hour cutoff: refused, so the credit stays spent.
    const late = await bookWith(token, startIn(22), intro);
    expect(await handleCancel(store, late.invitee.manageToken, undefined, new Date(late.startAt.getTime() - 60 * 60_000))).toMatchObject({ status: 409, body: { error: "past_cutoff" } });
    expect(await left(token)).toBe(0);
  });

  it("refuses event types the membership doesn't cover and unknown links", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input({ eventTypeIds: [coaching.id] }));
    const { token, subId } = await joined(plan);
    await deliver(charge(subId, new Date()));
    await expect(bookWith(token, startIn(20), intro)).rejects.toMatchObject({ reason: "wrong_event" });
    await expect(bookWith(`m${"0".repeat(48)}`)).rejects.toMatchObject({ reason: "not_found" });
  });

  it("rollover none: last month's unused credits lapse at its end", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input({ sessions: 2, rollover: "none" }));
    const { token, subId } = await joined(plan);
    const m1 = new Date(Date.now() - 40 * DAY);
    await deliver(charge(subId, m1, 600_000, m1), { now: m1 });
    await deliver(charge(subId, new Date(m1.getTime() + 30 * DAY)));
    expect(await left(token)).toBe(2); // month 1's two are gone
  });

  it("rollover capped: keeps at most the cap from earlier months", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input({ sessions: 4, rollover: "capped", rolloverCap: 1 }));
    const { token, subId } = await joined(plan);
    const m1 = new Date(Date.now() - 31 * DAY);
    await deliver(charge(subId, m1, 600_000, m1), { now: m1 });
    await bookWith(token, startIn(20)); // 3 unused from month 1
    await deliver(charge(subId, new Date(m1.getTime() + 30 * DAY)));
    expect(await left(token)).toBe(1 + 4);
  });

  it("rollover unlimited: unused credits add up", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input({ sessions: 3, rollover: "unlimited" }));
    const { token, subId } = await joined(plan);
    const m1 = new Date(Date.now() - 31 * DAY);
    await deliver(charge(subId, m1, 600_000, m1), { now: m1 });
    await deliver(charge(subId, new Date(m1.getTime() + 30 * DAY)));
    expect(await left(token)).toBe(6);
  });

  it("a failed renewal emails both sides; once halted, credits work only until the paid month ends", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input({ sessions: 4, rollover: "unlimited" }));
    const { token, subId } = await joined(plan);
    const start = new Date(Date.now() - 5 * DAY); // paid through 25 days from now
    await deliver(charge(subId, start, 600_000, start), { now: start });
    expect(await deliver(subEvent("subscription.pending", subId, "pending", start))).toMatchObject({ body: { outcome: "updated" } });
    expect(await membershipByToken(pool, token)).toMatchObject({ status: "pending", failedPayments: 1 });
    expect(await deliver(subEvent("subscription.halted", subId, "halted", start))).toMatchObject({ body: { outcome: "updated" } });
    const m = (await membershipByToken(pool, token))!;
    expect(m.status).toBe("halted");
    const { rows } = await pool.query("select kind from notifications where dedupe_key like $1 order by kind", [`membership:${m.id}:halted:%`]);
    expect(rows.map((r) => r.kind)).toEqual(["membership_guest", "membership_host"]);
    expect(await left(token)).toBe(4); // still usable this month
    await bookWith(token, startIn(20));
    await expect(bookWith(token, startIn(27))).rejects.toMatchObject({ reason: "expired" }); // past the paid month
    // An older event arriving late doesn't undo the halt.
    await deliver(subEvent("subscription.activated", subId, "active", start, new Date(start.getTime() + 1000)));
    expect((await membershipByToken(pool, token))!.status).toBe("halted");
  });

  it("the client cancels from their link: at period end, credits usable until then, then it ends", async () => {
    const fake = fakeRazorpay();
    const plan = await createMembershipPlan({ pool, provider: fake.provider }, priya.id, input({ sessions: 4, rollover: "unlimited" }));
    const { token, subId } = await joined(plan, fake);
    const start = new Date(Date.now() - 5 * DAY);
    await deliver(charge(subId, start, 600_000, start), { now: start });
    expect(await handleCancelMembership(deps(fake), { token }, new Date())).toMatchObject({ status: 200, body: { status: "cancelling" } });
    expect(await handleCancelMembership(deps(fake), { token }, new Date())).toMatchObject({ status: 200, body: { status: "already" } });
    expect(fake.state.cancels).toEqual([{ id: subId, atCycleEnd: true }]);
    expect(await membershipByToken(pool, token)).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    await bookWith(token, startIn(20));
    await expect(bookWith(token, startIn(27))).rejects.toMatchObject({ reason: "expired" });
    await deliver(subEvent("subscription.cancelled", subId, "cancelled", start));
    const ended = (await membershipByToken(pool, token))!;
    expect(ended.status).toBe("cancelled");
    expect(await left(token, new Date(ended.paidThrough!.getTime() + 1000))).toBe(0);
  });

  it("cancelling before the first charge ends it now", async () => {
    const fake = fakeRazorpay();
    const plan = await createMembershipPlan({ pool, provider: fake.provider }, priya.id, input());
    const { token, subId } = await joined(plan, fake);
    await deliver(subEvent("subscription.authenticated", subId, "authenticated", new Date()));
    expect(await handleCancelMembership(deps(fake), { token }, new Date())).toMatchObject({ body: { status: "cancelled" } });
    expect(fake.state.cancels).toEqual([{ id: subId, atCycleEnd: false }]);
  });

  it("moving a membership session keeps its credit, but not past a lapsing month", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input({ sessions: 2, rollover: "none" }));
    const { token, subId } = await joined(plan);
    await deliver(charge(subId, new Date(Date.now() - DAY)));
    const a = await bookWith(token, startIn(20));
    await store.rescheduleBooking(priya.id, a.id, startIn(21), `mb-move-${Math.random()}`);
    expect(await left(token)).toBe(1);
    await expect(store.rescheduleBooking(priya.id, (await bookWith(token, startIn(22))).id, startIn(40), `mb-move-late-${Math.random()}`)).rejects.toMatchObject({ reason: "expired" });
  });

  it("issues a GST invoice for every charge when the host is GST-registered", async () => {
    await pool.query(
      `insert into tax_profiles (user_id, legal_name, address, state_code, gstin, sac, rate_bp, invoice_prefix)
       values ($1, 'Priya Raman Coaching', '12 MG Road, Bengaluru', '29', '29ABCDE1234F1Z5', '999293', 1800, 'PR') on conflict (user_id) do nothing`, [priya.id]);
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input({ rollover: "unlimited" }));
    const { token, subId } = await joined(plan);
    const m1 = new Date(Date.now() - 31 * DAY);
    await deliver(charge(subId, m1, 600_000, m1), { now: m1 });
    await deliver(charge(subId, new Date(m1.getTime() + 30 * DAY)));
    const m = (await membershipByToken(pool, token))!;
    const { rows } = await pool.query(
      `select v.total_minor, v.cgst_minor + v.sgst_minor + v.igst_minor as tax, v.description from invoices v join membership_grants g on g.id = v.membership_grant_id
       where g.membership_id = $1 and v.kind = 'invoice'`, [m.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ total_minor: 600_000, tax: 91_525 }); // 18% inside ₹6,000
    expect(rows[0].description).toMatch(/^Coaching Plus: 4 sessions, /);
    await pool.query("delete from tax_profiles where user_id = $1", [priya.id]);
  });

  it("sends the membership emails through the queue", async () => {
    const plan = await createMembershipPlan({ pool, provider: fakeRazorpay().provider }, priya.id, input());
    const { token, subId } = await joined(plan);
    await deliver(charge(subId, new Date()));
    const sent: Mail[] = [];
    const mailer = { async send(mail: Mail) { sent.push(mail); return { id: `m${sent.length}` }; } };
    while ((await processDueNotifications(pool, mailer, { baseUrl: "https://hourhand.test" })).claimed > 0) { /* drain */ }
    const m = (await membershipByToken(pool, token))!;
    const toMember = sent.find((x) => x.to === m.guestEmail && x.subject.startsWith("Your Coaching Plus membership"))!;
    expect(toMember.text).toContain(`https://hourhand.test/member/${token}`);
    const toHost = sent.find((x) => x.to === priya.email && x.subject === `New member: ${m.guestName}, Coaching Plus`)!;
    expect(toHost.text).not.toContain(token); // the member's link is theirs alone
  });

  it("an unknown host or one with no secret gets 404, and another host's subscription is ignored", async () => {
    const headers = new Headers({ "x-razorpay-signature": "00" });
    expect(await handleMembershipWebhook(pool, key, "6f1c2d3e-0000-4000-8000-000000000001", "{}", headers, new Date())).toMatchObject({ status: 404 });
    expect(await deliver(charge("sub_not_ours", new Date()))).toMatchObject({ status: 200, body: { outcome: "ignored" } });
  });
});
