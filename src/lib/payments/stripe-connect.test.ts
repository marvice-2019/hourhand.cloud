// Stripe Connect onboarding: the API calls against a fake Stripe, and the connect state machine, the one-provider rule and
// the disconnect guard against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_sc, recreated each run).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { seal } from "../crypto/seal";
import { createPgStore } from "../data/pg-store";
import type { User } from "../data/types";
import { fakeStripe } from "./fake-stripe";
import { RazorpayKeyError, saveRazorpayKeys } from "./host-razorpay";
import {
  APPLICATION_FEE_BP, applicationFeeMinor, disconnectStripe, hostForStripeAccount, loadHostStripe, maskAccountId, onboardingFromCapability,
  refreshStripeAccount, startStripeConnect, stripeStatus, STRIPE_API_VERSION, stripeConnectApi, stripeConnectFromEnv, StripeConnectError, stripeReady,
} from "./stripe-connect";

const urls = { returnUrl: "https://hh.test/api/payments/stripe/return", refreshUrl: "https://hh.test/api/payments/stripe/refresh" };
const api = (fake = fakeStripe()) => ({ fake, api: stripeConnectApi({ secretKey: "sk_test_platform", baseUrl: "https://stripe.fake", fetchImpl: fake.fetchImpl }) });

describe("Stripe Connect API calls (no database)", () => {
  it("creates a full-Dashboard account where Stripe collects fees and losses, on the pinned v2 API version", async () => {
    const { fake, api: s } = api();
    const a = await s.createAccount({ userId: "u1", email: "host@example.com", displayName: "Host", country: "GB", idempotencyKey: "k1" });
    const req = fake.state.requests[0];
    expect(req).toMatchObject({ method: "POST", path: "/v2/core/accounts" });
    expect(req.headers).toMatchObject({ "stripe-version": STRIPE_API_VERSION, "idempotency-key": "k1", authorization: "Bearer sk_test_platform" });
    expect(req.body).toMatchObject({
      dashboard: "full", identity: { country: "gb" }, contact_email: "host@example.com",
      defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    });
    // Accounts v2 sets no legacy type: the v2 dimensions describe a Standard-like account.
    expect(req.body).not.toHaveProperty("type");
    expect(a).toMatchObject({ currency: "GBP", country: "GB", onboarding: "pending", livemode: false });
  });

  it("asks for an onboarding link for the merchant configuration with both return URLs", async () => {
    const { fake, api: s } = api();
    const a = await s.createAccount({ userId: "u1", email: "h@example.com", displayName: "H", country: "US", idempotencyKey: "k" });
    const url = await s.onboardingLink(a.id, urls.returnUrl, urls.refreshUrl);
    expect(url).toMatch(/^https:\/\/connect\.stripe\.fake\//);
    expect(fake.state.requests[1].body).toEqual({
      account: a.id, use_case: { type: "account_onboarding", account_onboarding: { configurations: ["merchant"], return_url: urls.returnUrl, refresh_url: urls.refreshUrl } },
    });
  });

  it("maps card_payments to an onboarding state", () => {
    expect(onboardingFromCapability("active")).toBe("active");
    expect(onboardingFromCapability("pending")).toBe("pending");
    expect(onboardingFromCapability(undefined)).toBe("pending");
    expect(onboardingFromCapability("restricted")).toBe("restricted");
    expect(onboardingFromCapability("unsupported")).toBe("restricted");
  });

  it("is off unless both the platform key and the Connect webhook secret are set", () => {
    expect(stripeConnectFromEnv({ STRIPE_SECRET_KEY: "sk_test_x" })).toBeNull();
    expect(stripeConnectFromEnv({ STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_x" })).toBeNull();
    expect(stripeConnectFromEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_x" })).not.toBeNull();
  });

  it("takes no application fee for now", () => {
    expect(APPLICATION_FEE_BP).toBe(0);
    expect(applicationFeeMinor(12_345)).toBe(0);
  });

  it("masks the account id", () => {
    expect(maskAccountId("acct_1Nv0FGQ9RKHgCVdK")).toBe("acct_••••CVdK");
    expect(maskAccountId("nonsense")).toBe("••••");
  });
});

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("Stripe Connect state (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let priya: User;
  let arun: User;
  const key = randomBytes(32);
  const row = async (userId: string) => (await pool.query("select * from integrations where user_id = $1 and provider = 'stripe'", [userId])).rows[0];
  const verifyOk = async () => {};

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_sc`;
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
    const store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    arun = (await store.getUserBySlug("arun"))!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from payments");
    await pool.query("delete from integrations where provider in ('stripe', 'razorpay')");
  });

  it("connect: creates one account, stores it sealed as pending, and sends the host to Stripe", async () => {
    const { fake, api: s } = api();
    const link = await startStripeConnect(pool, key, s, priya, "gb", urls);
    expect(link).toMatch(/^https:\/\/connect\.stripe\.fake\/setup\/acct_/);
    const r = await row(priya.id);
    expect(r).toMatchObject({ onboarding: "pending", currency: "GBP", country: "GB", mode: "test", status: "ok" });
    expect(r.public_id).toMatch(/^acct_/);
    // The sealed value opens only for its owner and names the same account.
    expect((await loadHostStripe(pool, key, priya.id))!.accountId).toBe(r.public_id);
    expect(fake.state.requests[0].body).toMatchObject({ metadata: { hourhand_user_id: priya.id } });
    expect(await hostForStripeAccount(pool, r.public_id)).toBe(priya.id);
  });

  it("connect again (continue setup, double click, refresh_url) reuses the account: never a second one", async () => {
    const { fake, api: s } = api();
    await startStripeConnect(pool, key, s, priya, "US", urls);
    await startStripeConnect(pool, key, s, priya, "US", urls);
    await startStripeConnect(pool, key, s, priya, null, urls);
    expect(fake.state.creates).toBe(1);
    expect(fake.state.links).toHaveLength(3);
    expect(new Set(fake.state.links.map((l) => l.account)).size).toBe(1);
  });

  it("connect refuses an unknown country (and India, which uses Razorpay) before calling Stripe", async () => {
    const { fake, api: s } = api();
    for (const c of ["IN", "ZZ", "", null]) {
      const err = await startStripeConnect(pool, key, s, priya, c, urls).catch((e) => e);
      expect(err).toBeInstanceOf(StripeConnectError);
      expect(err.code).toBe("country");
    }
    expect(fake.state.requests).toHaveLength(0);
    expect(await row(priya.id)).toBeUndefined();
  });

  it("a Stripe outage while creating stores nothing", async () => {
    const { fake, api: s } = api();
    fake.state.failNext = 503;
    const err = await startStripeConnect(pool, key, s, priya, "US", urls).catch((e) => e);
    expect(err).toMatchObject({ code: "unreachable" });
    expect(await row(priya.id)).toBeUndefined();
  });

  it("state machine: pending -> restricted -> active, read back from Stripe on return", async () => {
    const { fake, api: s } = api();
    await startStripeConnect(pool, key, s, priya, "IE", urls);
    const id = (await row(priya.id)).public_id;
    expect(stripeReady(await loadHostStripe(pool, key, priya.id))).toBe(false);

    fake.state.accounts.get(id)!.cardPayments = "restricted";
    expect((await refreshStripeAccount(pool, key, s, priya.id))!.onboarding).toBe("restricted");
    expect(stripeReady(await loadHostStripe(pool, key, priya.id))).toBe(false);

    fake.state.accounts.get(id)!.cardPayments = "active";
    const host = await refreshStripeAccount(pool, key, s, priya.id);
    expect(host).toMatchObject({ onboarding: "active", currency: "EUR", country: "IE" });
    expect(stripeReady(host)).toBe(true);

    // Stripe can restrict a live account later (requirements due); the host stops taking payments until it's fixed.
    fake.state.accounts.get(id)!.cardPayments = "restricted";
    expect(stripeReady(await refreshStripeAccount(pool, key, s, priya.id))).toBe(false);
  });

  it("refresh with nothing connected is a no-op", async () => {
    const { fake, api: s } = api();
    expect(await refreshStripeAccount(pool, key, s, priya.id)).toBeNull();
    expect(fake.state.requests).toHaveLength(0);
  });

  it("a stored account moved onto another host fails to open", async () => {
    const { api: s } = api();
    await startStripeConnect(pool, key, s, priya, "US", urls);
    const r = await row(priya.id);
    await pool.query(
      "insert into integrations (user_id, provider, credentials_encrypted, public_id, mode, status, onboarding) values ($1, 'stripe', $2, $3, 'test', 'ok', 'active')",
      [arun.id, r.credentials_encrypted, "acct_moved1234"]);
    await expect(loadHostStripe(pool, key, arun.id)).rejects.toThrow();
    // Even a correctly sealed value naming a different account than the row is refused.
    await pool.query("update integrations set credentials_encrypted = $2 where user_id = $1 and provider = 'stripe'",
      [arun.id, seal(key, { accountId: r.public_id }, `stripe:${arun.id}:acct_moved1234`)]);
    await expect(loadHostStripe(pool, key, arun.id)).rejects.toThrow(/doesn't match/);
  });

  it("one provider at a time: Stripe is refused while Razorpay is connected, and the other way round", async () => {
    const { fake, api: s } = api();
    await saveRazorpayKeys(pool, key, priya.id, "rzp_test_AbCdEfGh1234", "secret", verifyOk);
    const err = await startStripeConnect(pool, key, s, priya, "US", urls).catch((e) => e);
    expect(err).toMatchObject({ code: "other_provider" });
    expect(fake.state.creates).toBe(0);

    await startStripeConnect(pool, key, s, arun, "US", urls);
    const rzp = await saveRazorpayKeys(pool, key, arun.id, "rzp_test_AbCdEfGh1234", "secret", verifyOk).catch((e) => e);
    expect(rzp).toBeInstanceOf(RazorpayKeyError);
    expect(rzp.code).toBe("other_provider");
  });

  it("the database itself refuses a second payment provider for one host", async () => {
    const { api: s } = api();
    await startStripeConnect(pool, key, s, priya, "US", urls);
    await expect(pool.query(
      "insert into integrations (user_id, provider, credentials_encrypted, public_id, mode, status) values ($1, 'razorpay', '\\x00', 'rzp_test_x', 'test', 'ok')", [priya.id],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("switching guard: disconnect is refused while a Stripe payment is pending or being refunded, then allowed", async () => {
    const { api: s } = api();
    await startStripeConnect(pool, key, s, priya, "US", urls);
    const { rows: [b] } = await pool.query("select id from bookings where host_id = $1 limit 1", [priya.id]);
    for (const status of ["pending", "refund_pending"]) {
      await pool.query("delete from payments");
      await pool.query("insert into payments (booking_id, host_id, provider, amount_minor, currency, status) values ($1, $2, 'stripe', 5000, 'USD', $3)", [b.id, priya.id, status]);
      const err = await disconnectStripe(pool, priya.id).catch((e) => e);
      expect(err).toMatchObject({ code: "busy" });
      expect(await row(priya.id)).toBeDefined();
    }
    // Settled payments (paid, refunded, failed) don't block it, and a pending Razorpay payment is another provider's.
    await pool.query("update payments set status = 'paid'");
    await pool.query("insert into payments (booking_id, host_id, provider, amount_minor, currency, status) values ($1, $2, 'razorpay', 5000, 'INR', 'pending')", [b.id, priya.id]);
    await disconnectStripe(pool, priya.id);
    expect(await row(priya.id)).toBeUndefined();
    // With Stripe gone, Razorpay can be connected.
    await saveRazorpayKeys(pool, key, priya.id, "rzp_test_AbCdEfGh1234", "secret", verifyOk);
  });

  it("an account whose owner removed Hourhand in Stripe still shows, can't take payments, and can be disconnected", async () => {
    const { api: s } = api();
    await startStripeConnect(pool, key, s, priya, "US", urls);
    await pool.query("update integrations set status = 'disconnected', onboarding = 'active' where user_id = $1 and provider = 'stripe'", [priya.id]);
    expect(await stripeStatus(pool, priya.id)).toMatchObject({ removed: true });
    expect(await loadHostStripe(pool, key, priya.id)).toBeNull();
    await disconnectStripe(pool, priya.id);
    expect(await row(priya.id)).toBeUndefined();
  });

  it("disconnect only ever removes the signed-in host's own account", async () => {
    const { api: s } = api();
    await startStripeConnect(pool, key, s, priya, "US", urls);
    await disconnectStripe(pool, arun.id);
    expect(await row(priya.id)).toBeDefined();
  });
});
