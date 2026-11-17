// The Clinic plan's price, subscription, payment account and invoice series. Pricing runs everywhere; the rest needs
// Postgres (TEST_DATABASE_URL).
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostPlan } from "../billing/account";
import { planForPriceId, priceLine, PRICES, PLAN_NAMES } from "../billing/plans";
import type { BillingProvider, ProviderSubscription } from "../billing/providers";
import { BillingApiError } from "../billing/providers";
import { saveSubscription } from "../billing/sync";
import { creditNoteForRefund, invoiceById, invoiceForPayment, invoiceForPurchase, saveTaxProfile } from "../gst/invoices";
import { processRefunds } from "../payments/booking-payments";
import type { HostRazorpayAuth } from "../payments/host-razorpay";
import type { RazorpayOrders } from "../payments/razorpay-orders";
import { acceptSeat, canActFor, inviteSeat } from "../seats";
import { changeClinicPlaces, startClinicCheckout } from "./billing";
import { listPracticeInvoices } from "./invoices";
import { paymentAccountFor } from "./payments";
import { acceptPracticeInvite, createPractice, inviteMember, leavePractice, practiceBySlug, practiceContext, practitionerLimit } from "./practices";
import { clinicCountForPriceId, clinicExtraLine, clinicMonthlyMinor, clinicPriceId, clinicPriceLine } from "./pricing";
import { booking, eventType, freshDb, person, plan, type Person } from "./test-db";

const ENV: Record<string, string> = {
  ...Object.fromEntries([3, 4, 5, 6, 7, 8, 9, 10].map((n) => [`RAZORPAY_PLAN_CLINIC_${n}_MONTH`, `plan_clinic_${n}`])),
  RAZORPAY_PLAN_SOLO_MONTH: "plan_solo_m", RAZORPAY_PLAN_SOLO_YEAR: "plan_solo_y", RAZORPAY_PLAN_DUO_MONTH: "plan_duo_m", RAZORPAY_PLAN_DUO_YEAR: "plan_duo_y",
  STRIPE_PRICE_SOLO_MONTH: "price_solo_m",
};

describe("Clinic pricing", () => {
  it("is ₹1,499 + GST for up to 3 practitioners and ₹399 + GST for each extra, up to 10", () => {
    expect(clinicMonthlyMinor(3)).toBe(149_900);
    expect(clinicMonthlyMinor(4)).toBe(189_800);
    expect(clinicMonthlyMinor(10)).toBe(429_200);
    expect(() => clinicMonthlyMinor(2)).toThrow(RangeError);
    expect(() => clinicMonthlyMinor(11)).toThrow(RangeError);
    expect(() => clinicMonthlyMinor(3.5)).toThrow(RangeError);
    // Shown like the other plans: price before tax, 18% GST, and the total.
    expect(clinicPriceLine(3)).toBe("₹1,499 + 18% GST = ₹1,768.82 a month");
    expect(clinicPriceLine(5)).toBe("₹2,297 + 18% GST = ₹2,710.46 a month");
    expect(clinicPriceLine(10)).toBe("₹4,292 + 18% GST = ₹5,064.56 a month");
    expect(clinicExtraLine()).toBe("₹399 + 18% GST = ₹470.82 a month for each practitioner after 3");
  });

  it("maps one Razorpay Plan per practitioner count, and nothing else", () => {
    expect(clinicPriceId(4, ENV)).toBe("plan_clinic_4");
    expect(clinicPriceId(11, ENV)).toBeNull();
    expect(clinicCountForPriceId("razorpay", "plan_clinic_7", ENV)).toBe(7);
    expect(clinicCountForPriceId("stripe", "plan_clinic_7", ENV)).toBeNull();
    expect(planForPriceId("razorpay", "plan_clinic_6", ENV)).toEqual({ plan: "clinic", interval: "month", practitioners: 6 });
    expect(PLAN_NAMES.clinic).toBe("Clinic");
  });

  it("leaves Solo and Duo exactly as they were", () => {
    expect(PRICES).toEqual({
      solo: { month: { INR: 39_900, USD: 700 }, year: { INR: 399_000, USD: 7_000 } },
      duo: { month: { INR: 59_900, USD: 1_100 }, year: { INR: 599_000, USD: 11_000 } },
    });
    expect(priceLine("solo", "month", "INR")).toBe("₹399 + 18% GST = ₹470.82 a month");
    expect(priceLine("duo", "year", "INR")).toBe("₹5,990 + 18% GST = ₹7,068.20 a year");
    expect(planForPriceId("razorpay", "plan_solo_m", ENV)).toEqual({ plan: "solo", interval: "month" });
    expect(planForPriceId("razorpay", "plan_duo_y", ENV)).toEqual({ plan: "duo", interval: "year" });
    expect(planForPriceId("stripe", "price_solo_m", ENV)).toEqual({ plan: "solo", interval: "month" });
    expect(planForPriceId("razorpay", "plan_unknown", ENV)).toBeNull();
  });
});

const BASE = process.env.TEST_DATABASE_URL;
const now = new Date("2026-11-16T05:00:00Z");

/** A Razorpay stand-in: records calls, and reports whichever plan the subscription was last moved to. */
function fakeRazorpay(userId: string, startPlan: string) {
  const calls: { kind: string; arg: string }[] = [];
  let planId = startPlan;
  let refuse: BillingApiError | null = null;
  const api: BillingProvider = {
    provider: "razorpay",
    async startCheckout(p) { calls.push({ kind: "checkout", arg: p.priceId }); return { url: `https://rzp.io/i/${p.priceId}` }; },
    async getSubscription(id): Promise<ProviderSubscription> {
      return { provider: "razorpay", id, customerId: "cust_1", userId, priceId: planId, providerStatus: "active", status: "active",
        currentPeriodEnd: new Date("2026-12-16T05:00:00Z"), cancelAtPeriodEnd: null };
    },
    async cancelAtPeriodEnd() {}, async pause() {}, async resume() {},
    async changePlan(id, priceId) {
      if (refuse) throw refuse;
      calls.push({ kind: "change", arg: priceId });
      planId = priceId;
    },
  };
  return { api, calls, refuseNext: (e: BillingApiError) => { refuse = e; } };
}

describe.skipIf(!BASE)("Clinic subscription, payments and invoices (Postgres)", () => {
  let pool: pg.Pool;
  let owner: Person, asst: Person, dr2: Person, dr3: Person, solo: Person, duoOwner: Person, duoMember: Person;
  const deps = (f: ReturnType<typeof fakeRazorpay>) => ({ api: f.api, env: ENV });

  beforeAll(async () => {
    pool = await freshDb(BASE!, "clinic_c");
    owner = await person(pool, "owner@clinic.test", "Dr Meera", "dr-meera");
    asst = await person(pool, "asst@clinic.test", "Ravi", "ravi-asst");
    dr2 = await person(pool, "dr2@clinic.test", "Dr Arjun", "dr-arjun");
    dr3 = await person(pool, "dr3@clinic.test", "Dr Kavya", "dr-kavya");
    solo = await person(pool, "solo@coach.test", "Solo Coach", "solo-coach");
    duoOwner = await person(pool, "duo@coach.test", "Duo Owner", "duo-owner");
    duoMember = await person(pool, "duo2@coach.test", "Duo Second", "duo-second");
    await plan(pool, solo.id, "solo");
    await plan(pool, duoOwner.id, "duo");
    await inviteSeat(pool, duoOwner, duoMember.email, now);
    await acceptSeat(pool, duoMember);
  });
  afterAll(async () => { await pool?.end(); });

  it("a Duo owner upgrades to Clinic on the same subscription and keeps everything", async () => {
    await pool.query("update subscriptions set provider = 'razorpay', provider_subscription_id = 'sub_owner', interval = 'month' where user_id = $1", [owner.id]).catch(() => undefined);
    await pool.query(
      `insert into subscriptions (user_id, plan, status, interval, provider, provider_subscription_id) values ($1, 'duo', 'active', 'month', 'razorpay', 'sub_owner')`, [owner.id]);
    await inviteSeat(pool, owner, asst.email, now);
    await acceptSeat(pool, asst);
    const et = await eventType(pool, owner.id, "Therapy", "therapy", { price: 150_000 });
    await booking(pool, owner.id, et, new Date("2026-11-25T05:00:00Z"), { name: "Client", email: "c@client.test" });
    await pool.query("insert into client_notes (host_id, email, note) values ($1, 'c@client.test', 'kept')", [owner.id]);

    const f = fakeRazorpay(owner.id, "plan_duo_m");
    // Billing needs a practice first, and only its owner can touch it.
    await expect(changeClinicPlaces(pool, owner, 4, deps(f))).rejects.toMatchObject({ name: "ClinicAccessError" });
    await createPractice(pool, owner, { name: "MindCare", slug: "mindcare", about: "" }, { bringSeat: "practitioner" });
    await expect(startClinicCheckout(pool, owner, 4, "https://hh.test", deps(f))).rejects.toMatchObject({ code: "already_subscribed" });
    await changeClinicPlaces(pool, owner, 4, deps(f), now);
    expect(f.calls).toEqual([{ kind: "change", arg: "plan_clinic_4" }]);

    const s = (await pool.query("select plan, extra_seats, provider_subscription_id from subscriptions where user_id = $1", [owner.id])).rows[0];
    expect(s).toEqual({ plan: "clinic", extra_seats: 1, provider_subscription_id: "sub_owner" });
    expect(await practitionerLimit(pool, (await practiceContext(pool, owner.id))!.practice.id)).toBe(4);
    expect((await practiceBySlug(pool, "mindcare"))?.live).toBe(true);
    // Data stays: event types, bookings, notes, and the second person, now a practitioner on Clinic.
    expect((await pool.query("select count(*)::int as n from event_types where user_id = $1", [owner.id])).rows[0].n).toBe(1);
    expect((await pool.query("select count(*)::int as n from bookings where host_id = $1", [owner.id])).rows[0].n).toBe(1);
    expect((await pool.query("select note from client_notes where host_id = $1", [owner.id])).rows[0].note).toBe("kept");
    expect((await practiceContext(pool, asst.id))?.role).toBe("practitioner");
    expect(await hostPlan(pool, owner.id)).toBe("clinic");
    expect(await hostPlan(pool, asst.id)).toBe("clinic");
  });

  it("only the owner changes billing, never below the places in use, and explains what Razorpay refuses", async () => {
    await inviteMember(pool, owner.id, dr2.email, "practitioner", now);
    await inviteMember(pool, owner.id, dr3.email, "practitioner", now);
    expect(await acceptPracticeInvite(pool, dr2)).toBe(true);
    expect(await acceptPracticeInvite(pool, dr3)).toBe(true);
    const f = fakeRazorpay(owner.id, "plan_clinic_4");
    for (const p of [asst, dr2]) {
      await expect(changeClinicPlaces(pool, p, 10, deps(f))).rejects.toMatchObject({ name: "ClinicAccessError" });
      await expect(startClinicCheckout(pool, p, 10, "https://hh.test", deps(f))).rejects.toMatchObject({ name: "ClinicAccessError" });
    }
    await expect(changeClinicPlaces(pool, owner, 3, deps(f))).rejects.toMatchObject({ code: "places_in_use" }); // 4 practise
    await expect(changeClinicPlaces(pool, owner, 11, deps(f))).rejects.toMatchObject({ code: "invalid_count" });
    f.refuseNext(new BillingApiError("Razorpay 400 BAD_REQUEST_ERROR: subscriptions cannot be updated when payment mode is UPI", 400, false));
    await expect(changeClinicPlaces(pool, owner, 5, deps(f))).rejects.toMatchObject({ code: "cannot_change" });
    expect(f.calls).toEqual([]);
  });

  it("a fresh checkout picks the Razorpay Plan for the chosen count", async () => {
    const fresh = await person(pool, "fresh@clinic2.test", "Fresh Owner", "fresh-owner");
    await createPractice(pool, fresh, { name: "Fresh Clinic", slug: "fresh-clinic", about: "" });
    const f = fakeRazorpay(fresh.id, "");
    expect(await startClinicCheckout(pool, fresh, 6, "https://hh.test", deps(f), now)).toBe("https://rzp.io/i/plan_clinic_6");
    // A webhook for that subscription saves Clinic with 6 places.
    expect(await saveSubscription(pool, { provider: "razorpay", id: "sub_fresh", customerId: null, userId: fresh.id, priceId: "plan_clinic_6",
      providerStatus: "active", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: null }, ENV, now)).toEqual({ saved: true, userId: fresh.id });
    expect(await practitionerLimit(pool, (await practiceContext(pool, fresh.id))!.practice.id)).toBe(6);
  });

  it("Solo and Duo hosts outside a practice are untouched", async () => {
    expect(await hostPlan(pool, solo.id)).toBe("solo");
    expect(await hostPlan(pool, duoOwner.id)).toBe("duo");
    expect(await hostPlan(pool, duoMember.id)).toBe("duo");
    expect(await canActFor(pool, duoMember.id, duoOwner.id)).toBe(true);
    expect(await paymentAccountFor(pool, solo.id)).toBe(solo.id);
  });

  it("collects every practitioner's payments on the practice's account, and refunds on the account that collected", async () => {
    expect(await paymentAccountFor(pool, dr2.id)).toBe(owner.id);
    const et2 = await eventType(pool, dr2.id, "Counselling", "counselling", { price: 118_000 });
    const b = await booking(pool, dr2.id, et2, new Date("2026-11-26T05:00:00Z"), { name: "Asha", email: "asha@client.test" });
    const { rows: [p] } = await pool.query(
      "insert into payments (booking_id, host_id, provider, provider_payment_id, provider_order_id, amount_minor, currency, status) values ($1, $2, 'razorpay', 'pay_1', 'order_1', 118000, 'INR', 'paid') returning id, collected_by",
      [b, dr2.id]);
    expect(p.collected_by).toBe(owner.id);

    // Dr Arjun leaves; the refund still goes to the practice's account, not his own.
    await leavePractice(pool, dr2);
    expect(await paymentAccountFor(pool, dr2.id)).toBe(dr2.id);
    await pool.query("update payments set status = 'refund_pending' where id = $1", [p.id]);
    const asked: string[] = [];
    const auth = { keyId: "rzp_test_x", headers: () => ({}), verifyPaymentSignature: () => true } as HostRazorpayAuth;
    const orders = { listRefunds: async () => [], refund: async () => ({ id: "rfnd_1", amount: 118_000, status: "processed" }) } as unknown as RazorpayOrders;
    const r = await processRefunds({ pool, authFor: async (id) => { asked.push(`host:${id}`); return auth; },
      accountAuth: async (id) => { asked.push(`account:${id}`); return auth; }, ordersFor: () => orders }, now);
    expect(r.refunded).toBe(1);
    expect(asked).toEqual([`account:${owner.id}`]);
  });

  it("invoices every practitioner in the practice's one series, under its GSTIN; a host outside keeps their own", async () => {
    await saveTaxProfile(pool, owner.id, { legalName: "MindCare Wellness LLP", address: "12 CMH Road, Bengaluru", stateCode: "29", gstin: "29ABCDE1234F1Z5", sac: "999312", rateBp: 1800, invoicePrefix: "MC" });
    await saveTaxProfile(pool, dr3.id, { legalName: "Kavya Rao", address: "4 MG Road, Bengaluru", stateCode: "29", gstin: "29AAAAA1111A1Z1", sac: "999312", rateBp: 1800, invoicePrefix: "KR" });
    const pay = async (host: Person, slug: string, email: string) => {
      const e = await eventType(pool, host.id, "Session", slug, { price: 118_000 });
      const bk = await booking(pool, host.id, e, new Date("2026-11-27T05:00:00Z"), { name: email, email });
      return (await pool.query(
        "insert into payments (booking_id, host_id, provider, provider_payment_id, provider_order_id, amount_minor, currency, status) values ($1, $2, 'razorpay', $3, $3, 118000, 'INR', 'paid') returning id",
        [bk, host.id, `pay_${slug}`])).rows[0].id as string;
    };
    const i1 = (await invoiceById(pool, (await invoiceForPayment(pool, await pay(dr3, "s-kavya", "k1@c.test"), now))!))!;
    const i2 = (await invoiceById(pool, (await invoiceForPayment(pool, await pay(owner, "s-meera", "m1@c.test"), now))!))!;
    const i3 = (await invoiceById(pool, (await invoiceForPayment(pool, await pay(asst, "s-ravi", "r1@c.test"), now))!))!;
    expect([i1.number, i2.number, i3.number]).toEqual(["MC/2627/000001", "MC/2627/000002", "MC/2627/000003"]);
    expect(new Set([i1.hostId, i2.hostId, i3.hostId])).toEqual(new Set([owner.id]));
    expect(i1.supplier.gstin).toBe("29ABCDE1234F1Z5");
    expect(i1.description).toContain("with Dr Kavya");

    // Dr Arjun left: his new sales are his own. (No tax profile of his own, so no invoice.)
    expect(await invoiceForPayment(pool, await pay(dr2, "s-arjun", "a1@c.test"), now)).toBeNull();
    // A refund reverses the practice's invoice in the practice's credit-note series.
    const cn = (await invoiceById(pool, (await creditNoteForRefund(pool, (await pool.query("select payment_id from invoices where id = $1", [i1.id])).rows[0].payment_id, now))!))!;
    expect(cn.number).toBe("CNMC/2627/000001");
    expect(cn.hostId).toBe(owner.id);

    // A package Dr Kavya sells is collected and invoiced by the practice too, and stays so after she leaves.
    const ek = await eventType(pool, dr3.id, "Course", "course-kavya", { price: 100_000 });
    const { rows: [pk] } = await pool.query(
      "insert into packages (user_id, event_type_id, name, sessions, price_minor, valid_days) values ($1, $2, 'Five sessions', 5, 450000, 90) returning id", [dr3.id, ek]);
    const { rows: [pp] } = await pool.query(
      `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, idempotency_key)
       values ($1, $2, $3, 5, 450000, 90, 'Pkg Buyer', 'pkg@c.test', 'pkg-key-1') returning id, collected_by`, [pk.id, dr3.id, ek]);
    expect(pp.collected_by).toBe(owner.id);
    await leavePractice(pool, dr3);
    const ip = (await invoiceById(pool, (await invoiceForPurchase(pool, pp.id, now))!))!;
    expect(ip.number).toBe("MC/2627/000004");
    expect(ip.description).toContain("with Dr Kavya");

    // Admins (here the owner) see the series; practitioners don't.
    expect((await listPracticeInvoices(pool, owner.id)).map((v) => v.number).sort()).toEqual(["CNMC/2627/000001", "MC/2627/000001", "MC/2627/000002", "MC/2627/000003", "MC/2627/000004"]);
    await expect(listPracticeInvoices(pool, dr2.id)).rejects.toMatchObject({ name: "ClinicAccessError" });
    await expect(listPracticeInvoices(pool, asst.id)).rejects.toMatchObject({ name: "ClinicAccessError" });
  });
});
