// Referrals: codes, cookies and payment parsing as pure functions; attribution, rewards, credits and the billing
// webhook hook against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_ref, recreated each run).
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { hostPlan } from "../billing/account";
import type { BillingProvider, ProviderSubscription } from "../billing/providers";
import { BillingApiError } from "../billing/providers";
import { handleWebhook, saveSubscription } from "../billing/sync";
import { cookieFrom, DAY_MS, newReferralCode, normaliseEmail, parseReferralCookie, referralCookieValue, YEARLY_REWARD_CAP } from "./codes";
import { razorpayCredits, stripeCredits, type CreditProvider, type ScheduleResult } from "./credits";
import { renderReferralReward } from "./mail";
import { afterBillingWebhook, discountedRazorpayCharge, paymentFromWebhook, referralAccessPlan, type RewardDeps } from "./rewards";
import { onSessionCreated, onUserCreated } from "./signup";
import { attributeSignUp, getOrCreateCode, recordClick, referralSummary, rememberDevice } from "./store";

const env = {
  RAZORPAY_PLAN_SOLO_MONTH: "plan_solo_m", RAZORPAY_PLAN_DUO_MONTH: "plan_duo_m",
  STRIPE_PRICE_SOLO_MONTH: "price_solo_m", STRIPE_PRICE_DUO_YEAR: "price_duo_y",
};
const NOW = new Date("2031-06-01T10:00:00Z");
const DEV_A = "11111111-1111-4111-8111-111111111111";
const DEV_B = "22222222-2222-4222-8222-222222222222";

interface Call { method: string; url: string; headers: Record<string, string>; body: string }
function fakeFetch(respond: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: String(init.body ?? "") };
    calls.push(c);
    const r = respond(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("codes, cookies and payments", () => {
  it("codes are random 10-character strings, not derived from the host", () => {
    const codes = new Set(Array.from({ length: 200 }, newReferralCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[a-z0-9]{10}$/);
  });

  it("the referral cookie counts for 30 days after the link was opened, then expires", () => {
    const opened = new Date("2031-05-01T00:00:00Z");
    const value = referralCookieValue("abcdefghij", opened);
    expect(parseReferralCookie(value, new Date(opened.getTime() + 29 * DAY_MS))).toBe("abcdefghij");
    expect(parseReferralCookie(value, new Date(opened.getTime() + 30 * DAY_MS))).toBe("abcdefghij");
    expect(parseReferralCookie(value, new Date(opened.getTime() + 30 * DAY_MS + 1))).toBeNull();
    expect(parseReferralCookie("abcdefghij", opened)).toBeNull();
    expect(parseReferralCookie(`abcdefghij.${opened.getTime() + DAY_MS}`, opened)).toBeNull(); // from the future
    expect(cookieFrom("a=1; hh_ref=x.1; b=2", "hh_ref")).toBe("x.1");
  });

  it("one mailbox however it is written; different people on one domain stay different", () => {
    expect(normaliseEmail(" Priya.Rao+test@GoogleMail.com")).toBe("priyarao@gmail.com");
    expect(normaliseEmail("p.rao+x@acme.in")).toBe("p.rao@acme.in");
    expect(normaliseEmail("p.rao@acme.in")).not.toBe(normaliseEmail("arun@acme.in"));
  });

  it("a charge is a captured Razorpay payment or a paid Stripe invoice; a $0 invoice is a renewal with nothing charged", () => {
    const rz = (amount: number, status = "captured") => ({ payload: { payment: { entity: { id: "pay_1", amount, status, created_at: 1_900_000_000 } } } });
    expect(paymentFromWebhook("razorpay", "subscription.charged", rz(47_082))).toMatchObject({ ref: "pay_1", amountMinor: 47_082 });
    expect(paymentFromWebhook("razorpay", "subscription.activated", rz(47_082))).toBeNull();
    expect(paymentFromWebhook("razorpay", "subscription.charged", rz(0))).toBeNull();
    expect(paymentFromWebhook("razorpay", "subscription.charged", rz(47_082, "failed"))).toBeNull();
    const st = (amount_paid: number) => ({ data: { object: { id: "in_1", amount_paid, status_transitions: { paid_at: 1_900_000_000 } } } });
    expect(paymentFromWebhook("stripe", "invoice.paid", st(700))).toMatchObject({ ref: "in_1" });
    expect(paymentFromWebhook("stripe", "invoice.paid", st(0))).toMatchObject({ ref: "in_1", amountMinor: 0 }); // a free month covered it
    expect(paymentFromWebhook("stripe", "invoice.payment_succeeded", st(700))).toBeNull(); // same invoice as invoice.paid
  });
});

describe("credit providers", () => {
  it("Razorpay: links the referral offer at the end of the cycle, without notifying the customer", async () => {
    const { f, calls } = fakeFetch((c) => ({ body: c.method === "GET" ? { id: "sub_r", payment_method: "card" } : { id: "sub_r" } }));
    const r = await razorpayCredits({ keyId: "k", keySecret: "s", offerId: "offer_ref", baseUrl: "https://rp.fake", fetchImpl: f }).schedule({ id: "sub_r", customerId: null }, "c1");
    expect(r).toEqual({ kind: "scheduled", mechanism: "razorpay_offer", ref: "offer_ref", stackable: false });
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "https://rp.fake/v1/subscriptions/sub_r" });
    expect(JSON.parse(calls[1].body)).toEqual({ offer_id: "offer_ref", schedule_change_at: "cycle_end", customer_notify: false });
  });

  it("Razorpay: a UPI AutoPay subscription can't take an offer, so the month becomes an extension", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { id: "sub_r", payment_method: "upi" } }));
    const r = await razorpayCredits({ keyId: "k", keySecret: "s", offerId: "offer_ref", fetchImpl: f }).schedule({ id: "sub_r", customerId: null }, "c1");
    expect(r.kind).toBe("extension");
    expect(calls).toHaveLength(1);
  });

  it("Razorpay: no offer configured is an error, not a silent fallback", async () => {
    const { f } = fakeFetch(() => ({ body: { id: "sub_r", payment_method: "card" } }));
    await expect(razorpayCredits({ keyId: "k", keySecret: "s", offerId: null, fetchImpl: f }).schedule({ id: "sub_r", customerId: null }, "c1"))
      .rejects.toThrow("RAZORPAY_REFERRAL_OFFER_ID");
  });

  it("Stripe: a negative balance of one Solo month, keyed so a retry can't add it twice; fingerprint from the default card", async () => {
    const { f, calls } = fakeFetch((c) => ({ body: c.method === "POST" ? { id: "cbtxn_1" } : { default_payment_method: { card: { fingerprint: "fp_1" } } } }));
    const sp = stripeCredits({ secretKey: "sk", baseUrl: "https://st.fake", fetchImpl: f });
    expect(await sp.schedule({ id: "sub_s", customerId: "cus_1" }, "c1")).toEqual({ kind: "scheduled", mechanism: "stripe_balance", ref: "cbtxn_1", stackable: true });
    expect(calls[0].url).toBe("https://st.fake/v1/customers/cus_1/balance_transactions");
    expect(calls[0].headers["idempotency-key"]).toBe("referral-credit-c1");
    expect(new URLSearchParams(calls[0].body).get("amount")).toBe("-700");
    expect(await sp.paymentFingerprint("sub_s")).toBe("fp_1");
    expect(calls[1].url).toContain("expand[]=default_payment_method");
  });
});

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("referrals (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let n = 0;

  const newHost = async (email?: string) => {
    n++;
    const { rows } = await pool.query<{ id: string; email: string }>(
      "insert into users (email, slug, name) values ($1, $2, $3) returning id, email", [email ?? `host${n}@example.in`, `host-${n}`, `Host ${n}`]);
    return rows[0];
  };

  /** A fake credit provider that records what it was asked to do. */
  function fakeCredits(provider: "razorpay" | "stripe", o: { result?: ScheduleResult; fingerprints?: Record<string, string>; error?: Error } = {}): CreditProvider & { scheduled: string[] } {
    const p = {
      provider, scheduled: [] as string[],
      async schedule(sub: { id: string }, creditId: string): Promise<ScheduleResult> {
        if (o.error) throw o.error;
        p.scheduled.push(`${sub.id}:${creditId}`);
        return o.result ?? (provider === "stripe"
          ? { kind: "scheduled", mechanism: "stripe_balance", ref: `cbtxn_${creditId}`, stackable: true }
          : { kind: "scheduled", mechanism: "razorpay_offer", ref: "offer_ref", stackable: false });
      },
      async paymentFingerprint(id: string) { return o.fingerprints?.[id] ?? null; },
    };
    return p;
  }
  const deps = (rp: CreditProvider | null, st: CreditProvider | null = null): RewardDeps => ({ credits: (p) => (p === "razorpay" ? rp : st) });

  const providerSub = (userId: string, o: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
    provider: "razorpay", id: `sub_${userId.slice(0, 8)}`, customerId: `cust_${userId.slice(0, 8)}`, userId, priceId: "plan_solo_m",
    providerStatus: "active", status: "active", currentPeriodEnd: new Date("2031-07-01T00:00:00Z"), cancelAtPeriodEnd: null, ...o,
  });
  const subscribe = async (userId: string, o: Partial<ProviderSubscription> = {}) => {
    const s = providerSub(userId, o);
    await saveSubscription(pool, s, env, NOW);
    return s;
  };
  /** A Razorpay renewal charge. 39,900 paise = Solo monthly at full price; 100 = ₹1, with the referral offer applied. */
  const charged = (subId: string, payId: string, at = NOW, amount = 39_900) => ({
    event: { provider: "razorpay" as const, eventId: `evt_${payId}`, type: "subscription.charged", subscriptionId: subId },
    body: { event: "subscription.charged", payload: { subscription: { entity: { id: subId } }, payment: { entity: { id: payId, amount, status: "captured", created_at: Math.floor(at.getTime() / 1000) } } } },
  });
  const pay = (subId: string, payId: string, d: RewardDeps, at = NOW, amount = 39_900) => {
    const c = charged(subId, payId, at, amount);
    return afterBillingWebhook(pool, c.event, c.body, d, at);
  };
  const referral = async (referredId: string) => (await pool.query("select * from referrals where referred_id = $1", [referredId])).rows[0];
  const credits = async (userId: string) => (await pool.query("select * from referral_credits where user_id = $1 order by created_at, id", [userId])).rows;

  /** A referrer and a host who signed up through their link from another browser. */
  const referredPair = async (referredEmail?: string) => {
    const referrer = await newHost();
    const code = await getOrCreateCode(pool, referrer.id);
    const referred = await newHost(referredEmail);
    const a = await attributeSignUp(pool, referred, { code, deviceId: DEV_B }, NOW);
    return { referrer, referred, code, a };
  };

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_ref`;
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
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query("delete from notifications");
    await pool.query("delete from webhook_events");
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  describe("attribution", () => {
    it("a sign-up through the link is attributed to the host, via the cookie the link set", async () => {
      const referrer = await newHost();
      const code = await getOrCreateCode(pool, referrer.id);
      expect(await getOrCreateCode(pool, referrer.id)).toBe(code); // one code per host
      const referred = await newHost();
      const cookie = `hh_ref=${referralCookieValue(code, new Date(NOW.getTime() - 5 * DAY_MS))}; hh_dev=${DEV_B}`;
      await onUserCreated(pool, referred, { headers: new Headers({ cookie }) }, NOW);
      expect(await referral(referred.id)).toMatchObject({ referrer_id: referrer.id, status: "signed_up" });
    });

    it("a cookie older than 30 days attributes nothing", async () => {
      const referrer = await newHost();
      const code = await getOrCreateCode(pool, referrer.id);
      const referred = await newHost();
      const cookie = `hh_ref=${referralCookieValue(code, new Date(NOW.getTime() - 31 * DAY_MS))}`;
      await onUserCreated(pool, referred, { headers: new Headers({ cookie }) }, NOW);
      expect(await referral(referred.id)).toBeUndefined();
    });

    it("an unknown code attributes nothing, and an account can only be referred once", async () => {
      const lone = await newHost();
      expect(await attributeSignUp(pool, lone, { code: "zzzzzzzzzz", deviceId: null }, NOW)).toMatchObject({ attributed: false, reason: "unknown_code" });
      const { referred } = await referredPair();
      const other = await newHost();
      const code2 = await getOrCreateCode(pool, other.id);
      expect(await attributeSignUp(pool, referred, { code: code2, deviceId: null }, NOW)).toMatchObject({ attributed: false, reason: "already_referred" });
      expect((await referral(referred.id)).referrer_id).not.toBe(other.id);
    });

    it("self-referral: the same mailbox is blocked, a colleague on the same domain is not", async () => {
      const referrer = await newHost("priya.rao@gmail.com");
      const code = await getOrCreateCode(pool, referrer.id);
      const again = await newHost("PriyaRao+second@googlemail.com");
      expect(await attributeSignUp(pool, again, { code, deviceId: null }, NOW)).toMatchObject({ attributed: false, reason: "same_email" });
      expect(await referral(again.id)).toMatchObject({ status: "blocked", blocked_reason: "same_email" });

      const boss = await newHost("boss@acme-studio.in");
      const bossCode = await getOrCreateCode(pool, boss.id);
      const colleague = await newHost("colleague@acme-studio.in");
      expect(await attributeSignUp(pool, colleague, { code: bossCode, deviceId: null }, NOW)).toMatchObject({ attributed: true });
    });

    it("self-referral: a browser the referrer used in the last 30 days is blocked; one from longer ago is not", async () => {
      const referrer = await newHost();
      const code = await getOrCreateCode(pool, referrer.id);
      await onSessionCreated(pool, referrer.id, { headers: new Headers({ cookie: `hh_dev=${DEV_A}` }) }, new Date(NOW.getTime() - 10 * DAY_MS));
      const sock = await newHost();
      expect(await attributeSignUp(pool, sock, { code, deviceId: DEV_A }, NOW)).toMatchObject({ attributed: false, reason: "same_device" });

      const referrer2 = await newHost();
      const code2 = await getOrCreateCode(pool, referrer2.id);
      const DEV_C = "33333333-3333-4333-8333-333333333333";
      await rememberDevice(pool, referrer2.id, DEV_C, new Date(NOW.getTime() - 31 * DAY_MS));
      const family = await newHost();
      expect(await attributeSignUp(pool, family, { code: code2, deviceId: DEV_C }, NOW)).toMatchObject({ attributed: true });
    });
  });

  describe("rewards", () => {
    it("nothing on sign-up or activation; both get a free month on the first verified payment, and only once", async () => {
      const { referrer, referred } = await referredPair();
      const s = await subscribe(referred.id);
      const rp = fakeCredits("razorpay");
      await afterBillingWebhook(pool, { provider: "razorpay", eventId: "e_act", type: "subscription.activated", subscriptionId: s.id }, {}, deps(rp), NOW);
      expect(await credits(referred.id)).toHaveLength(0);
      expect((await referral(referred.id)).status).toBe("signed_up");

      await pay(s.id, "pay_first", deps(rp));
      expect(await referral(referred.id)).toMatchObject({ status: "rewarded", payment_ref: "razorpay:pay_first" });
      expect(await credits(referred.id)).toMatchObject([{ role: "referred", status: "scheduled", mechanism: "razorpay_offer" }]);
      // The referrer is on Free: theirs waits for their first renewal on a paid plan.
      expect(await credits(referrer.id)).toMatchObject([{ role: "referrer", status: "pending" }]);
      const mails = (await pool.query("select user_id, kind, dedupe_key from notifications where kind = 'referral_reward_host' order by dedupe_key")).rows;
      expect(mails.map((m) => m.user_id).sort()).toEqual([referrer.id, referred.id].sort());

      // The next renewal: the referred host's offer is used; no second reward.
      await pay(s.id, "pay_second", deps(rp), new Date(NOW.getTime() + 31 * DAY_MS), 100);
      expect(await credits(referred.id)).toMatchObject([{ status: "used" }]);
      expect(await credits(referrer.id)).toHaveLength(1);
      expect((await pool.query("select count(*)::int as n from notifications where kind = 'referral_reward_host'")).rows[0].n).toBe(2);
    });

    it("both credits are handed to each host's own provider: Stripe balance for one, Razorpay offer for the other", async () => {
      const { referrer, referred } = await referredPair();
      await subscribe(referrer.id, { provider: "stripe", id: "sub_st_ref", priceId: "price_solo_m", customerId: "cus_ref" });
      const s = await subscribe(referred.id);
      const rp = fakeCredits("razorpay");
      const st = fakeCredits("stripe");
      await pay(s.id, "pay_both", deps(rp, st));
      expect(await credits(referred.id)).toMatchObject([{ status: "scheduled", mechanism: "razorpay_offer", provider_subscription_id: s.id }]);
      expect(await credits(referrer.id)).toMatchObject([{ status: "scheduled", mechanism: "stripe_balance", provider_subscription_id: "sub_st_ref" }]);
      expect(rp.scheduled).toHaveLength(1);
      expect(st.scheduled).toHaveLength(1);
      // The referrer's next renewal: the $7 credit covers Solo in full, so Stripe's invoice is paid with $0. That uses it.
      await afterBillingWebhook(pool, { provider: "stripe", eventId: "e_inv", type: "invoice.paid", subscriptionId: "sub_st_ref" },
        { data: { object: { id: "in_ref", amount_paid: 0 } } }, deps(rp, st), new Date(NOW.getTime() + 31 * DAY_MS));
      expect((await credits(referrer.id))[0].status).toBe("used");
    });

    it("Razorpay: a renewal charged in full means the offer wasn't applied; the month waits, is linked again, and the miss is kept", async () => {
      const { referred } = await referredPair();
      const s = await subscribe(referred.id);
      const rp = fakeCredits("razorpay");
      await pay(s.id, "pay_miss_first", deps(rp));
      expect(await credits(referred.id)).toMatchObject([{ status: "scheduled", missed_renewals: 0 }]);

      // The next renewal is charged the full ₹399: Razorpay didn't take the offer off.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await pay(s.id, "pay_miss_full", deps(rp), new Date(NOW.getTime() + 31 * DAY_MS), 39_900);
      spy.mockRestore();
      const [missed] = await credits(referred.id);
      expect(missed).toMatchObject({ status: "scheduled", missed_renewals: 1 }); // linked again in the same step
      expect(missed.error).toContain("₹399");
      expect(rp.scheduled).toHaveLength(2);
      const summary = await referralSummary(pool, referred.id);
      expect(summary.credits[0]).toMatchObject({ status: "scheduled", missedRenewals: 1 });

      // The renewal after that is ₹1: now it is used, and the miss stays on record for support.
      await pay(s.id, "pay_miss_one", deps(rp), new Date(NOW.getTime() + 62 * DAY_MS), 100);
      expect(await credits(referred.id)).toMatchObject([{ status: "used", missed_renewals: 1 }]);
    });

    it("the discounted Razorpay charge per plan: ₹1 for Solo monthly, the price less ₹398 otherwise", () => {
      expect(discountedRazorpayCharge("solo", "month")).toBe(100);
      expect(discountedRazorpayCharge("duo", "month")).toBe(59_900 - 39_800);
      expect(discountedRazorpayCharge("solo", "year")).toBe(399_000 - 39_800);
      expect(discountedRazorpayCharge("solo", null)).toBeNull();
    });

    it("a Stripe invoice paid with $0 is a renewal, but never pays out a referral", async () => {
      const { referrer, referred } = await referredPair();
      await subscribe(referred.id, { provider: "stripe", id: "sub_zero", priceId: "price_solo_m" });
      await afterBillingWebhook(pool, { provider: "stripe", eventId: "e_zero", type: "invoice.paid", subscriptionId: "sub_zero" },
        { data: { object: { id: "in_zero", amount_paid: 0 } } }, deps(null, fakeCredits("stripe")), NOW);
      expect((await referral(referred.id)).status).toBe("signed_up");
      expect(await credits(referrer.id)).toHaveLength(0);
    });

    it("a referrer on Free keeps theirs waiting, and it is scheduled on their first payment", async () => {
      const { referrer, referred } = await referredPair();
      const s = await subscribe(referred.id);
      const rp = fakeCredits("razorpay");
      await pay(s.id, "pay_r2", deps(rp));
      expect((await credits(referrer.id))[0].status).toBe("pending");
      const rs = await subscribe(referrer.id);
      await pay(rs.id, "pay_r2_own", deps(rp), new Date(NOW.getTime() + DAY_MS));
      expect((await credits(referrer.id))[0]).toMatchObject({ status: "scheduled", provider_subscription_id: rs.id });
    });

    it("the yearly cap: the 13th paying referral in 12 months gives the referrer nothing, the new host still gets theirs", async () => {
      const referrer = await newHost();
      const code = await getOrCreateCode(pool, referrer.id);
      const rp = fakeCredits("razorpay");
      for (let i = 0; i < YEARLY_REWARD_CAP + 1; i++) {
        const h = await newHost();
        await attributeSignUp(pool, h, { code, deviceId: null }, NOW);
        const s = await subscribe(h.id);
        await pay(s.id, `pay_cap_${i}`, deps(rp), new Date(NOW.getTime() + i * 1000));
        expect((await referral(h.id)).status).toBe(i < YEARLY_REWARD_CAP ? "rewarded" : "capped");
        expect(await credits(h.id)).toHaveLength(1);
      }
      expect(await credits(referrer.id)).toHaveLength(YEARLY_REWARD_CAP);
      // A year later the cap has room again.
      const later = await newHost();
      await attributeSignUp(pool, later, { code, deviceId: null }, NOW);
      const s = await subscribe(later.id);
      await pay(s.id, "pay_next_year", deps(rp), new Date(NOW.getTime() + 366 * DAY_MS));
      expect((await referral(later.id)).status).toBe("rewarded");
    });

    it("self-referral: the same card on both accounts (Stripe fingerprint) blocks the reward", async () => {
      const { referrer, referred } = await referredPair();
      await subscribe(referrer.id, { provider: "stripe", id: "sub_fp_ref", priceId: "price_solo_m" });
      await subscribe(referred.id, { provider: "stripe", id: "sub_fp_new", priceId: "price_solo_m" });
      const st = fakeCredits("stripe", { fingerprints: { sub_fp_ref: "fp_same", sub_fp_new: "fp_same" } });
      await afterBillingWebhook(pool, { provider: "stripe", eventId: "e_fp", type: "invoice.paid", subscriptionId: "sub_fp_new" },
        { data: { object: { id: "in_fp", amount_paid: 700 } } }, deps(null, st), NOW);
      expect(await referral(referred.id)).toMatchObject({ status: "blocked", blocked_reason: "same_payment_method" });
      expect(await credits(referred.id)).toHaveLength(0);
      expect(await credits(referrer.id)).toHaveLength(0);
    });

    it("self-referral: different cards are fine", async () => {
      const { referrer, referred } = await referredPair();
      await subscribe(referrer.id, { provider: "stripe", id: "sub_fp2_ref", priceId: "price_solo_m" });
      await subscribe(referred.id, { provider: "stripe", id: "sub_fp2_new", priceId: "price_solo_m" });
      const st = fakeCredits("stripe", { fingerprints: { sub_fp2_ref: "fp_a", sub_fp2_new: "fp_b" } });
      await afterBillingWebhook(pool, { provider: "stripe", eventId: "e_fp2", type: "invoice.paid", subscriptionId: "sub_fp2_new" },
        { data: { object: { id: "in_fp2", amount_paid: 700 } } }, deps(null, st), NOW);
      expect((await referral(referred.id)).status).toBe("rewarded");
    });

    it("two deliveries of one payment at once reward once", async () => {
      const { referrer, referred } = await referredPair();
      const s = await subscribe(referred.id);
      const rp = fakeCredits("razorpay");
      await Promise.all([pay(s.id, "pay_race", deps(rp)), pay(s.id, "pay_race", deps(rp)), pay(s.id, "pay_race", deps(rp))]);
      expect(await credits(referred.id)).toHaveLength(1);
      expect(await credits(referrer.id)).toHaveLength(1);
      expect(rp.scheduled).toHaveLength(1);
    });

    it("Razorpay takes one offer per cycle: a second free month waits for the next renewal", async () => {
      const referrer = await newHost();
      const code = await getOrCreateCode(pool, referrer.id);
      const rs = await subscribe(referrer.id);
      const rp = fakeCredits("razorpay");
      for (const i of [1, 2]) {
        const h = await newHost();
        await attributeSignUp(pool, h, { code, deviceId: null }, NOW);
        const s = await subscribe(h.id);
        await pay(s.id, `pay_two_${i}`, deps(rp), new Date(NOW.getTime() + i * 1000));
      }
      expect((await credits(referrer.id)).map((c) => c.status)).toEqual(["scheduled", "pending"]);
      await pay(rs.id, "pay_ref_1", deps(rp), new Date(NOW.getTime() + 31 * DAY_MS), 100);
      expect((await credits(referrer.id)).map((c) => c.status)).toEqual(["used", "scheduled"]);
      await pay(rs.id, "pay_ref_2", deps(rp), new Date(NOW.getTime() + 62 * DAY_MS), 100);
      expect((await credits(referrer.id)).map((c) => c.status)).toEqual(["used", "used"]);
    });

    it("UPI AutoPay: the month becomes Solo after the paid plan stops, and the host keeps Solo for that month", async () => {
      const { referred } = await referredPair();
      const s = await subscribe(referred.id);
      const rp = fakeCredits("razorpay", { result: { kind: "extension", reason: "Razorpay can't apply an offer to a upi subscription" } });
      await pay(s.id, "pay_upi", deps(rp));
      expect(await credits(referred.id)).toMatchObject([{ status: "extension", mechanism: "extension", access_from: null }]);
      expect(await referralAccessPlan(pool, referred.id, NOW)).toBeNull();

      const end = new Date("2031-07-01T00:00:00Z");
      await saveSubscription(pool, providerSub(referred.id, { status: "cancelled", providerStatus: "cancelled" }), env, end);
      await afterBillingWebhook(pool, { provider: "razorpay", eventId: "e_cancel", type: "subscription.cancelled", subscriptionId: s.id }, {}, deps(rp), end);
      const [c] = await credits(referred.id);
      expect(c.access_from.toISOString()).toBe(end.toISOString());
      expect(c.access_until.toISOString()).toBe("2031-08-01T00:00:00.000Z");
      expect(await referralAccessPlan(pool, referred.id, new Date("2031-07-15T00:00:00Z"))).toBe("solo");
      expect(await referralAccessPlan(pool, referred.id, new Date("2031-08-02T00:00:00Z"))).toBeNull();
      // hostPlan reads the real clock: an extension running now gives Solo.
      await pool.query("update referral_credits set access_from = now() - interval '1 day', access_until = now() + interval '1 day' where id = $1", [c.id]);
      expect(await hostPlan(pool, referred.id)).toBe("solo");
    });

    it("a provider outage leaves the free month waiting; a refusal marks it failed with the reason", async () => {
      const { referred } = await referredPair();
      const s = await subscribe(referred.id);
      await pay(s.id, "pay_outage", deps(fakeCredits("razorpay", { error: new BillingApiError("Razorpay 503", 503, true) })));
      expect(await credits(referred.id)).toMatchObject([{ status: "pending", error: "Razorpay 503" }]);
      expect((await referral(referred.id)).status).toBe("rewarded");

      const other = await referredPair();
      const s2 = await subscribe(other.referred.id);
      await pay(s2.id, "pay_refused", deps(fakeCredits("razorpay", { error: new BillingApiError("Razorpay 400 BAD_REQUEST_ERROR: offer expired", 400, false) })));
      expect(await credits(other.referred.id)).toMatchObject([{ status: "failed", error: expect.stringContaining("offer expired") }]);
    });
  });

  describe("billing webhook", () => {
    it("the webhook runs the referral step once per event: a duplicate delivery does nothing", async () => {
      const { referrer, referred } = await referredPair();
      const s = providerSub(referred.id, { id: "sub_wh" });
      const provider: BillingProvider = {
        provider: "razorpay", async startCheckout() { return { url: "" }; }, async getSubscription() { return s; },
        async cancelAtPeriodEnd() {}, async pause() {}, async resume() {},
      };
      // The referral step builds its Razorpay client from the environment; answer its calls here.
      const { f, calls } = fakeFetch((c) => ({ body: c.method === "GET" ? { id: "sub_wh", payment_method: "card" } : { id: "sub_wh" } }));
      vi.stubGlobal("fetch", f);
      const whEnv = { ...env, RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_API_BASE_URL: "https://rp.fake", RAZORPAY_REFERRAL_OFFER_ID: "offer_ref" };
      const { event, body } = charged("sub_wh", "pay_wh");
      expect(await handleWebhook(pool, provider, event, body, whEnv, NOW)).toBe("processed");
      expect(await handleWebhook(pool, provider, event, body, whEnv, NOW)).toBe("duplicate");
      expect((await referral(referred.id)).status).toBe("rewarded");
      expect(await credits(referred.id)).toMatchObject([{ status: "scheduled", mechanism: "razorpay_offer" }]);
      expect(await credits(referrer.id)).toHaveLength(1);
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    });
  });

  describe("dashboard", () => {
    it("counts invited, signed up, paid and credited; self-referrals and repeat clicks don't count", async () => {
      const referrer = await newHost();
      const code = await getOrCreateCode(pool, referrer.id);
      const devices = ["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442", "44444444-4444-4444-8444-444444444443"];
      for (const d of devices) await recordClick(pool, referrer.id, d, NOW);
      await recordClick(pool, referrer.id, devices[0], NOW); // same browser again
      const rp = fakeCredits("razorpay");
      const a = await newHost();
      const b = await newHost();
      await attributeSignUp(pool, a, { code, deviceId: devices[0] }, NOW);
      await attributeSignUp(pool, b, { code, deviceId: devices[1] }, NOW);
      const sock = await newHost(referrer.email.replace("@", "+alt@"));
      await attributeSignUp(pool, sock, { code, deviceId: null }, NOW);
      const s = await subscribe(a.id);
      await pay(s.id, "pay_dash", deps(rp));
      const summary = await referralSummary(pool, referrer.id);
      expect(summary.counts).toEqual({ invited: 3, signedUp: 2, paid: 1, credited: 1 });
      expect(summary.credits).toMatchObject([{ role: "referrer", status: "pending" }]);
    });

    it("the reward email names the other host and the value, for each side", async () => {
      const { referrer, referred } = await referredPair();
      const s = await subscribe(referred.id);
      await pay(s.id, "pay_mail", deps(fakeCredits("razorpay")));
      const rows = (await pool.query("select user_id, dedupe_key from notifications where kind = 'referral_reward_host'")).rows;
      const forReferrer = rows.find((r) => r.user_id === referrer.id)!;
      const mail = await renderReferralReward(pool, forReferrer, "https://hourhand.test");
      expect("subject" in mail && mail.subject).toBe("You earned a free month of Hourhand");
      expect("text" in mail && mail.text).toContain("₹398");
      expect("text" in mail && mail.text).toContain("can't be exchanged for cash");
      const forReferred = rows.find((r) => r.user_id === referred.id)!;
      const mail2 = await renderReferralReward(pool, forReferred, "https://hourhand.test");
      expect("text" in mail2 && mail2.text).toContain(`Host ${referrer.email.match(/\d+/)![0]}`);

      // Each host gets it in their own dashboard language.
      await pool.query("update users set host_locale = 'hi' where id = $1", [referrer.id]);
      const hindi = await renderReferralReward(pool, forReferrer, "https://hourhand.test");
      expect("subject" in hindi && hindi.subject).toBe("आपको Hourhand का एक महीना फ़्री मिला");
      expect("text" in hindi && hindi.text).toContain("398");
    });
  });
});
