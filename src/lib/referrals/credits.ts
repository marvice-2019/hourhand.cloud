import { PRICES, type Provider } from "../billing/plans";
import { BillingApiError, send, type Fetch } from "../billing/providers";

// Turning a free month into something the payment provider takes off the next renewal.
//
// Stripe: a negative customer balance transaction of one Solo month (USD). Stripe applies a customer's credit balance
//   to the next invoice it finalises, so the next renewal is reduced by that amount. It is never paid out.
// Razorpay: an Offer linked to the subscription with the Update Subscription API (offer_id). Razorpay applies an offer
//   linked to an active subscription "at the end of the current billing cycle", i.e. on the next renewal. The offer is
//   made once in the Razorpay Dashboard (Single Use, flat, one Solo month) and its id set as RAZORPAY_REFERRAL_OFFER_ID.
//   Razorpay can't update UPI AutoPay or eMandate subscriptions, so for those the free month becomes a month of Solo
//   after the paid plan ends (see rewards.ts). Only one offer can be linked at a time, so a second credit waits a cycle.

type Env = Record<string, string | undefined>;

/**
 * What a free month takes off a Razorpay renewal: the referral Offer's flat amount. Plans charge ₹399, and Razorpay
 * only applies an offer that leaves more than ₹1 to charge, so the Offer is ₹398 and the host pays ₹1 that month.
 * Keep this equal to the Offer set as RAZORPAY_REFERRAL_OFFER_ID.
 */
export const RAZORPAY_REFERRAL_DISCOUNT_INR = 39_800;

export type ScheduleResult =
  | { kind: "scheduled"; mechanism: "stripe_balance" | "razorpay_offer"; ref: string; stackable: boolean }
  | { kind: "extension"; reason: string };

export class CreditNotConfigured extends Error {
  constructor(message: string) { super(message); this.name = "CreditNotConfigured"; }
}

export interface CreditProvider {
  provider: Provider;
  /** Hands one free month to the provider for this subscription's next renewal. Idempotent per credit id. */
  schedule(sub: { id: string; customerId: string | null }, creditId: string): Promise<ScheduleResult>;
  /** A fingerprint of the card behind the subscription, where the provider gives one (Stripe); otherwise null. */
  paymentFingerprint(subscriptionId: string): Promise<string | null>;
}

/** Razorpay subscriptions it can't update (its docs: UPI-authorised and eMandate subscriptions). */
const RAZORPAY_NOT_UPDATABLE = new Set(["upi", "emandate", "nach"]);

export function razorpayCredits(opts: { keyId: string; keySecret: string; offerId: string | null; baseUrl?: string; fetchImpl?: Fetch }): CreditProvider {
  const base = (opts.baseUrl ?? "https://api.razorpay.com").replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString("base64")}`;
  const call = (method: string, path: string, body?: unknown) =>
    send(f, `${base}/v1${path}`, { method, headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }, "Razorpay");
  return {
    provider: "razorpay",
    async schedule(sub) {
      const s = await call("GET", `/subscriptions/${encodeURIComponent(sub.id)}`);
      const method = typeof s.payment_method === "string" ? s.payment_method.toLowerCase() : "";
      if (RAZORPAY_NOT_UPDATABLE.has(method)) return { kind: "extension", reason: `Razorpay can't apply an offer to a ${method} subscription` };
      if (!opts.offerId) throw new CreditNotConfigured("RAZORPAY_REFERRAL_OFFER_ID is not set");
      await call("PATCH", `/subscriptions/${encodeURIComponent(sub.id)}`, { offer_id: opts.offerId, schedule_change_at: "cycle_end", customer_notify: false });
      return { kind: "scheduled", mechanism: "razorpay_offer", ref: opts.offerId, stackable: false };
    },
    async paymentFingerprint() { return null; }, // Razorpay's payment and card entities carry no cross-customer fingerprint
  };
}

export function stripeCredits(opts: { secretKey: string; baseUrl?: string; fetchImpl?: Fetch }): CreditProvider {
  const base = (opts.baseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const headers = (key?: string) => ({ authorization: `Bearer ${opts.secretKey}`, "content-type": "application/x-www-form-urlencoded", ...(key ? { "idempotency-key": key } : {}) });
  return {
    provider: "stripe",
    async schedule(sub, creditId) {
      if (!sub.customerId) throw new BillingApiError("Stripe subscription has no customer", null, false);
      const amount = PRICES.solo.month.USD;
      const body = new URLSearchParams({ amount: String(-amount), currency: "usd", description: "Hourhand referral: one free month of Solo", "metadata[credit_id]": creditId });
      const tx = await send(f, `${base}/v1/customers/${encodeURIComponent(sub.customerId)}/balance_transactions`,
        { method: "POST", headers: headers(`referral-credit-${creditId}`), body: body.toString() }, "Stripe");
      return { kind: "scheduled", mechanism: "stripe_balance", ref: String(tx.id), stackable: true };
    },
    async paymentFingerprint(subscriptionId) {
      const s = await send(f, `${base}/v1/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=default_payment_method`,
        { method: "GET", headers: { authorization: `Bearer ${opts.secretKey}` } }, "Stripe");
      const pm = s.default_payment_method as { card?: { fingerprint?: string } } | null | undefined;
      return pm?.card?.fingerprint ?? null;
    },
  };
}

const fakeBase = (env: Env, name: string) => (env.NODE_ENV !== "production" || env.HOURHAND_E2E === "1" ? env[name] : undefined);

export function creditProviderFromEnv(provider: Provider, env: Env = process.env): CreditProvider | null {
  if (provider === "razorpay") {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
    return razorpayCredits({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, offerId: env.RAZORPAY_REFERRAL_OFFER_ID || null, baseUrl: fakeBase(env, "RAZORPAY_API_BASE_URL") });
  }
  if (!env.STRIPE_SECRET_KEY) return null;
  return stripeCredits({ secretKey: env.STRIPE_SECRET_KEY, baseUrl: fakeBase(env, "STRIPE_API_BASE_URL") });
}
