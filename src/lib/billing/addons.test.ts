// The custom-domain add-on against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_addon,
// dropped and recreated on every run): webhook transitions, checkout and cancel, and the domain switching off on lapse.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { lookupDomainRoute, recordCheck, setDomain, getDomain } from "../domains/store";
import { BillingActionError } from "./account";
import { cancelAddon, domainEntitled, getAddon, startAddonCheckout } from "./addons";
import type { BillingProvider, ProviderSubscription } from "./providers";
import { handleWebhook } from "./sync";

const BASE = process.env.TEST_DATABASE_URL;
const env = {
  RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w",
  RAZORPAY_PLAN_SOLO_MONTH: "plan_solo_m", RAZORPAY_PLAN_DOMAIN_MONTH: "plan_dom",
};
const END = new Date("2026-12-15T00:00:00Z");
const NOW = new Date("2026-11-20T00:00:00Z");

describe.skipIf(!BASE)("custom domain add-on (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let priya: string;
  /** What the fake Razorpay returns for each subscription id. */
  const subs = new Map<string, ProviderSubscription>();
  const cancelled: string[] = [];
  const provider: BillingProvider = {
    provider: "razorpay",
    startCheckout: async (p) => ({ url: `https://rzp.io/i/${p.priceId}` }),
    getSubscription: async (id) => {
      const s = subs.get(id);
      if (!s) throw new Error(`no ${id}`);
      return s;
    },
    cancelAtPeriodEnd: async (id) => { cancelled.push(id); },
    pause: async () => {},
    resume: async () => {},
  };
  const sub = (o: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
    provider: "razorpay", id: "sub_dom", customerId: "cust_1", userId: priya, priceId: "plan_dom", providerStatus: "active", status: "active",
    currentPeriodEnd: END, cancelAtPeriodEnd: null, ...o,
  });
  let n = 0;
  /** Delivers a webhook for a subscription in the given state, as Razorpay would. */
  const deliver = (s: ProviderSubscription) => {
    subs.set(s.id, s);
    return handleWebhook(pool, provider, { provider: "razorpay", eventId: `evt_${++n}`, type: `subscription.${s.providerStatus}`, subscriptionId: s.id }, {}, env, NOW);
  };
  const serving = (now = NOW) => lookupDomainRoute(pool, "book.priya.in", now).then((r) => r?.serving);

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_addon`;
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
    priya = (await pool.query("insert into users (email, name, slug) values ('priya@example.in', 'Priya', 'priya') returning id")).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    for (const t of ["custom_domains", "addon_subscriptions", "subscriptions", "webhook_events"]) await pool.query(`delete from ${t}`);
    subs.clear();
    cancelled.length = 0;
    // Priya is on Solo and has a verified domain; only the add-on decides whether it serves.
    await pool.query(
      "insert into subscriptions (user_id, plan, interval, provider, provider_subscription_id, status, current_period_end) values ($1, 'solo', 'month', 'razorpay', 'sub_plan', 'active', $2)",
      [priya, END]);
    await setDomain(pool, priya, "book.priya.in");
    await recordCheck(pool, (await getDomain(pool, priya))!, { ok: true, via: "cname" });
  });

  it("a verified domain doesn't serve without the add-on", async () => {
    expect(await serving()).toBe(false);
  });

  it("webhooks: created (unpaid) grants nothing; active switches the domain on; the plan row is untouched", async () => {
    expect(await deliver(sub({ status: null, providerStatus: "created" }))).toBe("ignored");
    expect(await getAddon(pool, priya, "domain")).toBeNull();
    expect(await deliver(sub())).toBe("processed");
    expect(await getAddon(pool, priya, "domain")).toMatchObject({ status: "active", subscriptionId: "sub_dom", cancelAtPeriodEnd: false });
    expect(await serving()).toBe(true);
    const plan = (await pool.query("select plan, provider_subscription_id, status from subscriptions where user_id = $1", [priya])).rows[0];
    expect(plan).toEqual({ plan: "solo", provider_subscription_id: "sub_plan", status: "active" });
  });

  it("webhooks: a retried payment keeps it on; halted (unpaid) and paused switch it off", async () => {
    await deliver(sub());
    await deliver(sub({ providerStatus: "pending", status: "past_due" }));
    expect(await serving()).toBe(true);
    await deliver(sub({ providerStatus: "halted", status: "unpaid" }));
    expect(await serving()).toBe(false);
    await deliver(sub({ providerStatus: "active", status: "active" }));
    expect(await serving()).toBe(true);
    await deliver(sub({ providerStatus: "paused", status: "paused" }));
    expect(await serving()).toBe(false);
  });

  it("cancelling keeps the domain until the end of the paid month, then it stops even before the provider's event", async () => {
    await deliver(sub());
    await cancelAddon(pool, priya, "domain", env, provider);
    expect(cancelled).toEqual(["sub_dom"]);
    expect(await getAddon(pool, priya, "domain")).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    expect(await serving(new Date("2026-12-14T23:00:00Z"))).toBe(true);
    expect(await serving(END)).toBe(false);
    // Razorpay's "cancelled" at period end makes it final.
    await deliver(sub({ providerStatus: "cancelled", status: "cancelled" }));
    expect(await getAddon(pool, priya, "domain")).toMatchObject({ status: "cancelled", cancelAtPeriodEnd: false });
    expect(await serving(new Date("2026-12-01T00:00:00Z"))).toBe(false);
  });

  it("the domain stops when the plan lapses, even with the add-on paid", async () => {
    await deliver(sub());
    expect(await domainEntitled(pool, priya, NOW)).toBe(true);
    await pool.query("update subscriptions set status = 'cancelled' where user_id = $1", [priya]);
    expect(await domainEntitled(pool, priya, NOW)).toBe(false);
    expect(await serving()).toBe(false);
  });

  it("a late cancellation of an old add-on subscription doesn't switch off a newer one", async () => {
    await deliver(sub({ id: "sub_dom_old" }));
    await deliver(sub({ id: "sub_dom_old", providerStatus: "cancelled", status: "cancelled" }));
    await deliver(sub({ id: "sub_dom_new" }));
    expect(await deliver(sub({ id: "sub_dom_old", providerStatus: "cancelled", status: "cancelled" }))).toBe("ignored");
    expect(await getAddon(pool, priya, "domain")).toMatchObject({ subscriptionId: "sub_dom_new", status: "active" });
    expect(await serving()).toBe(true);
  });

  it("a duplicate delivery is acknowledged without being applied twice", async () => {
    subs.set("sub_dom", sub());
    const event = { provider: "razorpay" as const, eventId: "evt_same", type: "subscription.activated", subscriptionId: "sub_dom" };
    expect(await handleWebhook(pool, provider, event, {}, env, NOW)).toBe("processed");
    expect(await handleWebhook(pool, provider, event, {}, env, NOW)).toBe("duplicate");
  });

  describe("checkout", () => {
    const user = () => ({ id: priya, email: "priya@example.in" });
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof BillingActionError ? e.code : String(e)));

    it("needs a paid plan", async () => {
      await pool.query("delete from subscriptions");
      expect(await code(startAddonCheckout(pool, user(), "domain", "https://hourhand.cloud", env, NOW, provider))).toBe("needs_plan");
    });

    it("isn't offered without RAZORPAY_PLAN_DOMAIN_MONTH", async () => {
      const { RAZORPAY_PLAN_DOMAIN_MONTH: _unused, ...rest } = env;
      void _unused;
      expect(await code(startAddonCheckout(pool, user(), "domain", "https://hourhand.cloud", rest, NOW, provider))).toBe("not_configured");
    });

    it("refuses a second add-on while one is held, and allows a new one after it ended", async () => {
      await deliver(sub());
      expect(await code(startAddonCheckout(pool, user(), "domain", "https://hourhand.cloud", env, NOW, provider))).toBe("already_subscribed");
      await deliver(sub({ providerStatus: "cancelled", status: "cancelled" }));
      expect(await code(startAddonCheckout(pool, user(), "domain", "https://hourhand.cloud", env, NOW, provider))).toBe("ok");
    });
  });
});
