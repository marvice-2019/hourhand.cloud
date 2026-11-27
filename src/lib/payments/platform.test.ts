// B18: Hourhand's own Razorpay, commissions, Route splits and payouts, against real Postgres and a fake Razorpay
// (only with TEST_DATABASE_URL; uses its own database <name>_plat, dropped and recreated on every run).
import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import type { Actor } from "../admin/roles";
import { BillingApiError } from "../billing/providers";
import { createPgStore } from "../data/pg-store";
import type { DataStore, User } from "../data/types";
import { authForPayment, processRefunds, startPaidBooking } from "./booking-payments";
import { handleConfirmPayment } from "./confirm-handler";
import { keyPairAuth, type HostRazorpayAuth } from "./host-razorpay";
import {
  collectingAuth, collectionTerms, defaultCommissionBps, hostBalances, hostPaymentSettings, loadPlatformRazorpay, parsePercent, platformRazorpayStatus,
  recordPayout, removePlatformRazorpay, savePlatformRazorpay, setDefaultCommissionBps, setHostPaymentSettings, stripeApplicationFee,
} from "./platform";
import { razorpayOrders } from "./razorpay-orders";

const BASE = process.env.TEST_DATABASE_URL;
const PLATFORM_KEY = "rzp_test_PlatFormKey99";
const PLATFORM_SECRET = "platform-secret-value-123";
const sign = (order: string, payment: string) => createHmac("sha256", PLATFORM_SECRET).update(`${order}|${payment}`).digest("hex");

/** Razorpay's orders, payments and refunds, recording each request body. */
function fakeRazorpay(auth: HostRazorpayAuth) {
  const state = { orders: [] as Record<string, unknown>[], refunds: [] as Record<string, unknown>[], payments: new Map<string, Record<string, unknown>>() };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    if (method === "POST" && path === "/v1/orders") {
      const body = JSON.parse(String(init.body));
      state.orders.push(body);
      return json({ id: `order_${state.orders.length}${Math.random().toString(36).slice(2, 8)}`, amount: body.amount, currency: body.currency, status: "created" });
    }
    const rf = /^\/v1\/payments\/([^/]+)\/(refund|refunds)$/.exec(path);
    if (rf) {
      if (rf[2] === "refunds") return json({ items: [] });
      const body = JSON.parse(String(init.body));
      state.refunds.push(body);
      return json({ id: `rfnd_${state.refunds.length}`, status: "pending", amount: body.amount ?? 50_000 });
    }
    const m = /^\/v1\/payments\/([^/]+)(\/capture)?$/.exec(path);
    const p = m && state.payments.get(decodeURIComponent(m[1]));
    if (!p) return json({ error: { code: "BAD_REQUEST_ERROR", description: "no such payment" } }, 400);
    return json(p);
  }) as unknown as typeof fetch;
  return { state, orders: razorpayOrders(auth, { baseUrl: "https://rp.fake", fetchImpl }) };
}

describe("percentages", () => {
  it("reads per cent as basis points, empty as the default and anything else as invalid", () => {
    expect(parsePercent("10")).toBe(1000);
    expect(parsePercent("2.5%")).toBe(250);
    expect(parsePercent(" ")).toBeNull();
    expect(parsePercent("abc")).toBeNaN();
    expect(parsePercent("-1")).toBeNaN();
  });
});

describe.skipIf(!BASE)("platform payments (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let arun: User;
  let eventTypeId: string;
  let boss: Actor;
  let support: Actor;
  const key = randomBytes(32);
  const accept = async () => undefined;
  let slot = 0;
  const input = () => ({
    eventTypeId, startAt: new Date(Date.UTC(2034, 0, 3) + slot++ * 3 * 3_600_000), idempotencyKey: `plat-${slot}-${Math.random()}`,
    invitee: { name: "Asha", email: "asha@example.in", timezone: "Asia/Kolkata", phone: null, answers: [] }, priceMinor: 50_000,
  });
  const ownAuth = keyPairAuth("rzp_test_HostOwnKey11", "host-secret");
  const own = async () => ownAuth;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_plat`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const root = new URL(BASE!);
    root.pathname = "/postgres";
    const c = new pg.Client({ connectionString: root.toString() });
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
    arun = (await store.getUserBySlug("arun"))!;
    eventTypeId = (await store.listEventTypes(priya.id))[0].id;
    boss = { id: arun.id, email: arun.email, role: "super_admin" };
    support = { id: arun.id, email: arun.email, role: "admin" };
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stores Hourhand's key pair only once Razorpay accepts it, sealed, and shows only the masked key id", async () => {
    await expect(savePlatformRazorpay(pool, key, support, PLATFORM_KEY, PLATFORM_SECRET, accept)).rejects.toMatchObject({ code: "not_allowed" });
    await expect(savePlatformRazorpay(pool, key, boss, "sk_live_x", PLATFORM_SECRET, accept)).rejects.toMatchObject({ code: "format" });
    const refuse = async () => { throw new BillingApiError("Razorpay 401", 401, false); };
    await expect(savePlatformRazorpay(pool, key, boss, PLATFORM_KEY, PLATFORM_SECRET, refuse)).rejects.toMatchObject({ code: "rejected" });
    expect(await platformRazorpayStatus(pool)).toBeNull();

    expect(await savePlatformRazorpay(pool, key, boss, PLATFORM_KEY, PLATFORM_SECRET, accept)).toEqual({ mode: "test" });
    expect(await platformRazorpayStatus(pool)).toMatchObject({ key: "rzp_test_••••ey99", mode: "test" });
    const { rows: [stored] } = await pool.query("select credentials_encrypted from platform_gateways");
    expect(Buffer.from(stored.credentials_encrypted).toString("latin1")).not.toContain(PLATFORM_SECRET);
    const loaded = await loadPlatformRazorpay(pool, key);
    expect(loaded?.keyId).toBe(PLATFORM_KEY);
    expect(loaded?.verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"))).toBe(true);
    const { rows: logged } = await pool.query("select detail from admin_audit where action = 'payments.gateway.save'");
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain(PLATFORM_SECRET);
    expect(JSON.stringify(logged)).not.toContain(PLATFORM_KEY);
  });

  it("sets a host's mode and commission, audited; splitting needs a Route account", async () => {
    await expect(setHostPaymentSettings(pool, support, priya.id, { mode: "platform", commissionBps: null, routeAccount: null })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(setHostPaymentSettings(pool, boss, priya.id, { mode: "split", commissionBps: null, routeAccount: null })).rejects.toMatchObject({ code: "no_route_account" });
    await expect(setHostPaymentSettings(pool, boss, priya.id, { mode: "split", commissionBps: 9000, routeAccount: "acc_Host1234" })).rejects.toMatchObject({ code: "bad_commission" });
    await expect(setDefaultCommissionBps(pool, boss, Number.NaN)).rejects.toMatchObject({ code: "bad_commission" });
    await setDefaultCommissionBps(pool, boss, 1000);
    expect(await defaultCommissionBps(pool)).toBe(1000);

    // 'own' (the default) is the host's own account, untouched.
    expect(await collectingAuth(pool, key, priya.id, own)).toBe(ownAuth);
    await setHostPaymentSettings(pool, boss, priya.id, { mode: "split", commissionBps: null, routeAccount: "acc_Host1234" });
    expect(await hostPaymentSettings(pool, priya.id)).toEqual({ mode: "split", commissionBps: null, routeAccount: "acc_Host1234" });
    const split = await collectingAuth(pool, key, priya.id, own);
    expect(split?.keyId).toBe(PLATFORM_KEY);
    expect(split?.collection).toEqual({ mode: "split", commissionBps: 1000, routeAccount: "acc_Host1234" });
    const { rows } = await pool.query("select 1 from admin_audit where action = 'host.payments.update' and target_id = $1", [priya.id]);
    expect(rows).toHaveLength(1);
  });

  it("splits a booking's payment through Route, records who took it, and refunds it with the transfer reversed", async () => {
    await setHostPaymentSettings(pool, boss, priya.id, { mode: "split", commissionBps: 1500, routeAccount: "acc_Host1234" });
    const auth = (await collectingAuth(pool, key, priya.id, own))!;
    const fake = fakeRazorpay(auth);
    const r = await startPaidBooking({ pool, store, auth, orders: fake.orders }, input(), new Date());
    expect(r.payment?.keyId).toBe(PLATFORM_KEY);
    // 15% of ₹500 stays with Hourhand; ₹425 goes straight to the host's linked account.
    expect(fake.state.orders[0].transfers).toEqual([{ account: "acc_Host1234", amount: 42_500, currency: "INR", on_hold: false }]);
    const { rows: [row] } = await pool.query("select * from payments where booking_id = $1", [r.booking.id]);
    expect(row).toMatchObject({ collected_via: "platform", commission_minor: 7_500, transfer_account: "acc_Host1234" });

    // The guest pays and the host's mode changes afterwards: the payment still confirms on Hourhand's account.
    fake.state.payments.set("pay_split1", { id: "pay_split1", order_id: r.payment!.orderId, amount: 50_000, currency: "INR", status: "captured" });
    await setHostPaymentSettings(pool, boss, priya.id, { mode: "own", commissionBps: null, routeAccount: "acc_Host1234" });
    const deps = { pool, authFor: async () => ownAuth, platformAuth: () => loadPlatformRazorpay(pool, key), ordersFor: () => fake.orders };
    expect((await authForPayment(deps, row))?.keyId).toBe(PLATFORM_KEY);
    const confirmed = await handleConfirmPayment(store, deps, { manageToken: r.booking.invitee.manageToken, paymentId: "pay_split1", signature: sign(r.payment!.orderId, "pay_split1") }, new Date());
    expect(confirmed).toEqual({ status: 200, body: { status: "confirmed" } });

    await pool.query("update payments set status = 'refund_pending' where booking_id = $1", [r.booking.id]);
    const refunded = await processRefunds(deps, new Date());
    expect(refunded).toMatchObject({ refunded: 1, errors: 0 });
    expect(fake.state.refunds[0]).toMatchObject({ reverse_all: 1 });
  });

  it("collects in full for a host, owes them their share, and records payouts no larger than what's owed", async () => {
    await setHostPaymentSettings(pool, boss, priya.id, { mode: "platform", commissionBps: 1000, routeAccount: null });
    const auth = (await collectingAuth(pool, key, priya.id, own))!;
    expect(collectionTerms(auth, 50_000, "INR")).toEqual({ collectedVia: "platform", commissionMinor: 5_000, transferAccount: null });
    const fake = fakeRazorpay(auth);
    const r = await startPaidBooking({ pool, store, auth, orders: fake.orders }, input(), new Date());
    expect(fake.state.orders[0].transfers).toBeUndefined();
    await pool.query("update payments set status = 'paid', provider_payment_id = 'pay_full1', paid_at = now() where booking_id = $1", [r.booking.id]);

    // ₹500 less 10% commission: Hourhand owes the host ₹450 (the split payment above isn't owed: Route paid it).
    const owed = () => hostBalances(pool).then((all) => all.find((b) => b.hostId === priya.id));
    expect(await owed()).toMatchObject({ collectedMinor: 50_000, commissionMinor: 5_000, paidOutMinor: 0, owedMinor: 45_000 });
    await expect(recordPayout(pool, boss, priya.id, 45_001, "UTR123")).rejects.toMatchObject({ code: "bad_amount" });
    await expect(recordPayout(pool, support, priya.id, 100, "UTR123")).rejects.toMatchObject({ code: "not_allowed" });
    await recordPayout(pool, boss, priya.id, 40_000, "UTR123");
    expect(await owed()).toMatchObject({ paidOutMinor: 40_000, owedMinor: 5_000 });
    const { rows } = await pool.query("select detail from admin_audit where action = 'host.payout.record'");
    expect(rows[0].detail).toMatchObject({ amountMinor: 40_000, reference: "UTR123" });

    // Keys can't be removed while one of Hourhand's payments still needs refunding.
    await pool.query("update payments set status = 'refund_pending' where booking_id = $1", [r.booking.id]);
    await expect(removePlatformRazorpay(pool, boss)).rejects.toMatchObject({ code: "busy" });
    await pool.query("update payments set status = 'paid' where booking_id = $1", [r.booking.id]);
  });

  it("guests can't pay when Hourhand's keys are gone, rather than paying the host's account by mistake", async () => {
    await pool.query("update payments set status = 'paid' where collected_via = 'platform' and status <> 'paid'");
    await removePlatformRazorpay(pool, boss);
    expect(await collectingAuth(pool, key, priya.id, own)).toBeNull();
    await setHostPaymentSettings(pool, boss, priya.id, { mode: "own", commissionBps: null, routeAccount: null });
    expect(await collectingAuth(pool, key, priya.id, own)).toBe(ownAuth);
  });

  it("takes a Stripe host's commission as the application fee only when they're set to split", async () => {
    expect(await stripeApplicationFee(pool, priya.id, 10_000)).toBe(0);
    await setHostPaymentSettings(pool, boss, priya.id, { mode: "split", commissionBps: 500, routeAccount: "acc_Host1234" });
    expect(await stripeApplicationFee(pool, priya.id, 10_000)).toBe(500);
    await setHostPaymentSettings(pool, boss, priya.id, { mode: "own", commissionBps: null, routeAccount: null });
  });
});
