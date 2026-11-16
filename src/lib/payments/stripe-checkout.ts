import type pg from "pg";
import { BillingApiError, formEncode, send, type Fetch } from "../billing/providers";
import type { BookingWithInvitee, CreateBookingInput, DataStore } from "../data/types";
import { creditNoteForRefund } from "../gst/invoices";
import { applyPurchasePayment } from "../packages/packages";
import { applyCapturedPayment, expireHold, PaymentStartError } from "./booking-payments";
import { recordRefund, REFUND_DUE_SQL, targetOf } from "./series";
import { applicationFeeMinor, loadHostStripe, STRIPE_API_VERSION, stripeApiBase, type HostStripe } from "./stripe-connect";

// Guests paying a Stripe-connected host. Each payment is a Stripe Checkout Session created on the host's own account
// (a direct charge: the Stripe-Account header), so the money lands in the host's balance and Stripe sends the receipt.
// Like Razorpay, a booking holds its slot as pending_payment and is confirmed only from Stripe's own word: a signed
// webhook or a session read back from Stripe as the host's account, checked against our row. The redirect back to
// Hourhand alone confirms nothing.
//
// Docs (read 2026-11-15): https://docs.stripe.com/connect/direct-charges.md?platform=web&ui=stripe-hosted,
// https://docs.stripe.com/api/checkout/sessions/create.md, https://docs.stripe.com/api/refunds/create.md,
// https://docs.stripe.com/connect/webhooks.md?accounts-namespace=v2.

type Env = Record<string, string | undefined>;

/**
 * How long a Stripe booking holds its slot. A Checkout Session lives at least 30 minutes, so the hold outlasts the
 * session: once Stripe has expired the session nobody can pay any more, and the slot is released after that.
 */
export const STRIPE_HOLD_MINUTES = 32;
const SESSION_MINUTES = 31;

/** Currencies with no minor unit: Hourhand stores prices in hundredths, so a host settling in one of these can't charge yet. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
export const chargeableCurrency = (c: string | null): c is string => c !== null && /^[A-Z]{3}$/.test(c) && !ZERO_DECIMAL.has(c) && c !== "INR";

export interface StripeSession {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  ref: string | null;
}

export interface StripeRefund { id: string; status: string; amount: number }

export interface StripeCheckoutApi {
  createSession(account: string, p: {
    ref: string; amountMinor: number; currency: string; productName: string; customerEmail: string; applicationFeeMinor: number;
    expiresAt: Date; successUrl: string; cancelUrl: string;
  }, idempotencyKey: string): Promise<StripeSession>;
  getSession(account: string, sessionId: string): Promise<StripeSession>;
  /** Closes an open session so nobody can pay on it any more. */
  expireSession(account: string, sessionId: string): Promise<void>;
  listRefunds(account: string, paymentIntentId: string): Promise<StripeRefund[]>;
  /**
   * A refund, in full unless `amountMinor` is given (some weeks of a paid series). The idempotency key makes a retried
   * request return the first refund instead of paying twice.
   */
  refund(account: string, paymentIntentId: string, o: { refundApplicationFee: boolean; ref: string; amountMinor?: number }, idempotencyKey: string): Promise<StripeRefund>;
}

const SESSION_ID = /^cs_[A-Za-z0-9_]{8,200}$/;
const PI_ID = /^pi_[A-Za-z0-9_]{8,200}$/;

function toSession(s: Record<string, unknown>): StripeSession {
  const meta = (s.metadata && typeof s.metadata === "object" ? s.metadata : {}) as Record<string, unknown>;
  const pi = s.payment_intent;
  const piId = typeof pi === "string" ? pi : pi && typeof pi === "object" ? (pi as { id?: unknown }).id : null;
  return {
    id: String(s.id ?? ""),
    url: typeof s.url === "string" ? s.url : null,
    status: s.status === "complete" || s.status === "expired" ? s.status : "open",
    paymentStatus: s.payment_status === "paid" || s.payment_status === "no_payment_required" ? s.payment_status : "unpaid",
    amountTotal: typeof s.amount_total === "number" ? s.amount_total : null,
    currency: typeof s.currency === "string" ? s.currency.toUpperCase() : null,
    paymentIntentId: typeof piId === "string" ? piId : null,
    ref: typeof meta.hourhand_ref === "string" ? meta.hourhand_ref : null,
  };
}

const toRefund = (r: Record<string, unknown>): StripeRefund => ({ id: String(r.id), status: String(r.status), amount: Number(r.amount) });

export function stripeCheckoutApi(opts: { secretKey: string; baseUrl?: string; fetchImpl?: Fetch }): StripeCheckoutApi {
  const base = (opts.baseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const call = (account: string, method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string) => {
    if (!/^acct_[A-Za-z0-9]{6,64}$/.test(account)) throw new BillingApiError("Not a Stripe account id", null, false);
    const query = method === "GET" && params ? `?${formEncode(params)}` : "";
    return send(f, `${base}/v1${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
        // Direct charges: every call acts as the host's own account.
        "stripe-account": account,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: method === "POST" ? formEncode(params ?? {}) : undefined,
    }, "Stripe");
  };
  const sessionPath = (id: string) => {
    if (!SESSION_ID.test(id)) throw new BillingApiError("Not a Checkout Session id", null, false);
    return `/checkout/sessions/${id}`;
  };
  return {
    async createSession(account, p, idempotencyKey) {
      const s = toSession(await call(account, "POST", "/checkout/sessions", {
        mode: "payment",
        line_items: { 0: { quantity: 1, price_data: { currency: p.currency.toLowerCase(), unit_amount: p.amountMinor, product_data: { name: p.productName.slice(0, 250) } } } },
        customer_email: p.customerEmail,
        client_reference_id: p.ref.replace(/[^A-Za-z0-9_-]/g, "_"),
        metadata: { hourhand_ref: p.ref },
        payment_intent_data: {
          metadata: { hourhand_ref: p.ref },
          ...(p.applicationFeeMinor > 0 ? { application_fee_amount: p.applicationFeeMinor } : {}),
        },
        expires_at: Math.floor(p.expiresAt.getTime() / 1000),
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
      }, idempotencyKey));
      if (!SESSION_ID.test(s.id) || !s.url) throw new BillingApiError("Stripe returned no Checkout page", null, false);
      return s;
    },
    async getSession(account, sessionId) {
      return toSession(await call(account, "GET", sessionPath(sessionId)));
    },
    async expireSession(account, sessionId) {
      await call(account, "POST", `${sessionPath(sessionId)}/expire`);
    },
    async listRefunds(account, paymentIntentId) {
      if (!PI_ID.test(paymentIntentId)) throw new BillingApiError("Not a PaymentIntent id", null, false);
      const r = await call(account, "GET", "/refunds", { payment_intent: paymentIntentId, limit: 100 });
      return ((r.data as Record<string, unknown>[] | undefined) ?? []).map(toRefund);
    },
    async refund(account, paymentIntentId, o, idempotencyKey) {
      if (!PI_ID.test(paymentIntentId)) throw new BillingApiError("Not a PaymentIntent id", null, false);
      return toRefund(await call(account, "POST", "/refunds", {
        payment_intent: paymentIntentId, metadata: { hourhand_ref: o.ref }, ...(o.refundApplicationFee ? { refund_application_fee: "true" } : {}),
        ...(o.amountMinor !== undefined ? { amount: String(o.amountMinor) } : {}),
      }, idempotencyKey));
    },
  };
}

export function stripeCheckoutFromEnv(env: Env = process.env): StripeCheckoutApi | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_CONNECT_WEBHOOK_SECRET) return null;
  return stripeCheckoutApi({ secretKey: env.STRIPE_SECRET_KEY, baseUrl: stripeApiBase(env) });
}

/** How the booking routes, the job runner and the webhook reach hosts' Stripe accounts. Injected so tests can use fakes. */
export interface StripeDeps {
  pool: pg.Pool;
  api: StripeCheckoutApi;
  /** The host's connected account even when Stripe has restricted it: refunds and late payments still need it. */
  accountFor(hostId: string): Promise<HostStripe | null>;
}

export function stripeDepsFor(pool: pg.Pool, key: Buffer, api: StripeCheckoutApi): StripeDeps {
  return { pool, api, accountFor: (hostId) => loadHostStripe(pool, key, hostId) };
}

async function inTx<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** What the browser needs: the Checkout page to send the guest to. */
export interface StripeCheckout { provider: "stripe"; url: string; amount: number; currency: string; holdExpiresAt: Date }

interface StripeRow { provider_order_id: string; checkout_url: string; amount_minor: number; currency: string }

const stripeRowFor = async (db: Pick<pg.Pool, "query">, bookingId: string): Promise<StripeRow | null> =>
  (await db.query("select provider_order_id, checkout_url, amount_minor, currency from payments where booking_id = $1 and provider = 'stripe'", [bookingId])).rows[0] ?? null;

const bookingRef = (id: string) => `booking:${id}`;
const purchaseRef = (id: string) => `purchase:${id}`;

/**
 * Holds the slot as pending_payment and opens a Checkout Session for it on the host's account. A repeat of the request
 * returns the same session (the session's parameters are fixed by the booking, so Stripe's idempotency key holds).
 */
export async function startStripeBooking(
  deps: { pool: pg.Pool; store: Pick<DataStore, "createBooking">; api: StripeCheckoutApi; host: HostStripe & { currency: string } },
  input: CreateBookingInput & { priceMinor: number; kind: "payment" | "deposit"; productName: string; urls: (b: BookingWithInvitee) => { successUrl: string; cancelUrl: string } },
  now: Date,
): Promise<{ booking: BookingWithInvitee; payment: StripeCheckout | null }> {
  const { pool, store, api, host } = deps;
  const { priceMinor, kind, productName, urls, ...bookingInput } = input;
  const booking = await store.createBooking({ ...bookingInput, holdUntil: new Date(now.getTime() + STRIPE_HOLD_MINUTES * 60_000) });
  if (booking.status !== "pending_payment" || !booking.holdExpiresAt) return { booking, payment: null };
  const checkout = (row: StripeRow): StripeCheckout =>
    ({ provider: "stripe", url: row.checkout_url, amount: row.amount_minor, currency: row.currency, holdExpiresAt: booking.holdExpiresAt! });
  const existing = await stripeRowFor(pool, booking.id);
  if (existing) return { booking, payment: checkout(existing) };

  const fee = applicationFeeMinor(priceMinor);
  let session: StripeSession;
  try {
    session = await api.createSession(host.accountId, {
      ref: bookingRef(booking.id), amountMinor: priceMinor, currency: host.currency, productName, customerEmail: booking.invitee.email,
      applicationFeeMinor: fee, ...urls(booking),
      // Fixed by the booking (not by this request), so a repeated request sends identical parameters.
      expiresAt: new Date(booking.holdExpiresAt.getTime() - (STRIPE_HOLD_MINUTES - SESSION_MINUTES) * 60_000),
    }, `hh-booking-${booking.id}`);
  } catch (error) {
    await pool.query(
      `update bookings set status = 'cancelled', cancelled_at = $2, cancelled_by = 'system', cancel_reason = 'Payment could not start', hold_expires_at = null
       where (id = $1 or series_id = $1) and status = 'pending_payment' and not exists (select 1 from payments where booking_id = $1)`, [booking.id, now]);
    throw new PaymentStartError(`Payment could not start: ${(error as Error).message}`, error instanceof BillingApiError && error.retryable);
  }
  const row = await inTx(pool, async (client) => {
    await client.query("select id from bookings where id = $1 for update", [booking.id]);
    const raced = await stripeRowFor(client, booking.id);
    if (raced) return raced;
    await client.query(
      `insert into payments (booking_id, host_id, provider, provider_order_id, checkout_url, amount_minor, currency, status, kind, application_fee_minor, sessions)
       values ($1, $2, 'stripe', $3, $4, $5, $6, 'pending', $7, $8, $9)`,
      [booking.id, booking.hostId, session.id, session.url, priceMinor, host.currency, kind, fee, bookingInput.weeks ?? 1]);
    return { provider_order_id: session.id, checkout_url: session.url!, amount_minor: priceMinor, currency: host.currency };
  });
  return { booking, payment: checkout(row) };
}

/** A pending package purchase on Stripe: the same row as a Razorpay one, with a Checkout Session instead of an order. */
export async function startStripePurchase(
  deps: { pool: pg.Pool; api: StripeCheckoutApi; host: HostStripe & { currency: string } },
  input: { purchaseId: string; amountMinor: number; currency: string; productName: string; customerEmail: string; successUrl: string; cancelUrl: string },
  now: Date,
): Promise<{ url: string; amount: number; currency: string }> {
  const { pool, api, host } = deps;
  if (input.currency !== host.currency) throw new PaymentStartError("The package is priced in another currency than the host's Stripe account", false);
  const fee = applicationFeeMinor(input.amountMinor);
  return inTx(pool, async (client) => {
    const { rows: [locked] } = await client.query("select provider_order_id, checkout_url, created_at from package_purchases where id = $1 for update", [input.purchaseId]);
    if (locked.provider_order_id) return { url: locked.checkout_url as string, amount: input.amountMinor, currency: input.currency };
    let session: StripeSession;
    try {
      session = await api.createSession(host.accountId, {
        ref: purchaseRef(input.purchaseId), amountMinor: input.amountMinor, currency: input.currency, productName: input.productName,
        customerEmail: input.customerEmail, applicationFeeMinor: fee, successUrl: input.successUrl, cancelUrl: input.cancelUrl,
        expiresAt: new Date(new Date(locked.created_at).getTime() + Math.max(SESSION_MINUTES * 60_000, now.getTime() - new Date(locked.created_at).getTime() + SESSION_MINUTES * 60_000)),
      }, `hh-purchase-${input.purchaseId}`);
    } catch (error) {
      throw new PaymentStartError(`Payment could not start: ${(error as Error).message}`, error instanceof BillingApiError && error.retryable);
    }
    await client.query(
      "update package_purchases set provider = 'stripe', provider_order_id = $2, checkout_url = $3, application_fee_minor = $4, updated_at = $5 where id = $1",
      [input.purchaseId, session.id, session.url, fee, now]);
    return { url: session.url!, amount: input.amountMinor, currency: input.currency };
  });
}

export type SettleOutcome = "confirmed" | "already" | "refund_pending" | "paid" | "open" | "expired" | "unknown" | "mismatch" | "no_account";

interface Target {
  kind: "booking" | "purchase"; id: string; hostId: string; amount: number; currency: string; ref: string;
}

async function targetForSession(db: Pick<pg.Pool, "query">, sessionId: string): Promise<Target | null> {
  const { rows: [p] } = await db.query(
    "select booking_id, host_id, amount_minor, currency from payments where provider = 'stripe' and provider_order_id = $1", [sessionId]);
  if (p) return { kind: "booking", id: p.booking_id, hostId: p.host_id, amount: p.amount_minor, currency: p.currency, ref: bookingRef(p.booking_id) };
  const { rows: [k] } = await db.query(
    "select id, host_id, price_minor, currency from package_purchases where provider = 'stripe' and provider_order_id = $1", [sessionId]);
  if (k) return { kind: "purchase", id: k.id, hostId: k.host_id, amount: k.price_minor, currency: k.currency, ref: purchaseRef(k.id) };
  return null;
}

/**
 * Settles one Checkout Session from Stripe's own record of it. The session is read back from Stripe as the host's
 * account and must match our row (same reference, amount and currency) before anything is confirmed: what a browser or
 * a webhook body says is never taken on trust. `fromAccount` is the account a webhook named; a session that belongs to
 * a different host than the account claims is ignored.
 */
export async function settleStripeSession(deps: StripeDeps, sessionId: string, now: Date, fromAccount?: string): Promise<SettleOutcome> {
  if (!SESSION_ID.test(sessionId)) return "unknown";
  const target = await targetForSession(deps.pool, sessionId);
  if (!target) return "unknown";
  const host = await deps.accountFor(target.hostId);
  if (!host) return "no_account";
  if (fromAccount !== undefined && fromAccount !== host.accountId) return "unknown";
  const s = await deps.api.getSession(host.accountId, sessionId);
  if (s.id !== sessionId || s.ref !== target.ref || s.amountTotal !== target.amount || s.currency !== target.currency) {
    console.error(`[payments] Stripe session ${sessionId} doesn't match ${target.ref}; not applied`);
    return "mismatch";
  }
  if (s.status === "complete" && s.paymentStatus === "paid") {
    if (!s.paymentIntentId) return "mismatch";
    return target.kind === "booking"
      ? applyCapturedPayment(deps.pool, target.id, s.paymentIntentId, now)
      : applyPurchasePayment(deps.pool, target.id, s.paymentIntentId, now);
  }
  if (s.status === "expired") {
    // Nobody can pay on an expired session: release the slot (if still held) and close the attempt.
    if (target.kind === "booking") {
      await expireHold(deps.pool, target.id, now);
      await deps.pool.query("update payments set status = 'failed', updated_at = $2 where booking_id = $1 and provider = 'stripe' and status = 'pending'", [target.id, now]);
    } else {
      await deps.pool.query("update package_purchases set status = 'failed', updated_at = $2 where id = $1 and status = 'pending'", [target.id, now]);
    }
    return "expired";
  }
  return "open";
}

export interface StripeReconcileResult { claimed: number; confirmed: number; expired: number; errors: number }

// Same pacing as Razorpay: checked once a minute old, at most once a minute.
const RECHECK_MS = 60_000;
// A delayed payment method (bank debit) can succeed days after Checkout; past this the attempt is marked failed, and a
// payment that still arrives is caught by the webhook and refunded.
const LATE_PAYMENT_MS = 3 * 24 * 60 * 60_000;

/**
 * Settles pending Stripe payments the webhook hasn't (guest closed the tab, webhook delayed or lost): paid sessions are
 * applied, expired ones release their slot, and a hold that lapsed with its session still open is closed in Stripe.
 */
export async function reconcileStripePayments(deps: StripeDeps, now: Date, limit = 20): Promise<StripeReconcileResult> {
  const { pool } = deps;
  const { rows } = await pool.query(
    `with due as (
       select p.id from payments p join bookings b on b.id = p.booking_id
       where p.provider = 'stripe' and p.status = 'pending' and p.created_at < $1::timestamptz - $3 * interval '1 millisecond'
         and (p.checked_at is null or p.checked_at < $1::timestamptz - $3 * interval '1 millisecond')
       order by p.checked_at nulls first, p.created_at limit $2 for update of p skip locked)
     update payments p set checked_at = $1 from due, bookings b where p.id = due.id and b.id = p.booking_id
     returning p.booking_id, p.host_id, p.provider_order_id, p.created_at, b.status as booking_status, b.hold_expires_at`, [now, limit, RECHECK_MS]);
  const result: StripeReconcileResult = { claimed: rows.length, confirmed: 0, expired: 0, errors: 0 };
  for (const row of rows) {
    try {
      const outcome = await settleStripeSession(deps, row.provider_order_id, now);
      if (outcome === "confirmed") result.confirmed += 1;
      else if (outcome === "expired") result.expired += 1;
      else if (outcome === "open" || outcome === "no_account") {
        const lapsed = row.booking_status === "pending_payment" && row.hold_expires_at && new Date(row.hold_expires_at) <= now;
        if (lapsed) {
          const host = outcome === "open" ? await deps.accountFor(row.host_id) : null;
          if (host) await deps.api.expireSession(host.accountId, row.provider_order_id).catch(() => undefined);
          if (await expireHold(pool, row.booking_id, now)) result.expired += 1;
        }
        if (now.getTime() - new Date(row.created_at).getTime() > LATE_PAYMENT_MS) {
          await pool.query("update payments set status = 'failed', updated_at = $2 where booking_id = $1 and status = 'pending'", [row.booking_id, now]);
        }
        if (outcome === "no_account") await pool.query("update payments set last_error = 'Stripe disconnected', updated_at = $2 where booking_id = $1 and status = 'pending'", [row.booking_id, now]);
      }
    } catch (error) {
      result.errors += 1;
      await pool.query("update payments set last_error = $2, updated_at = $3 where booking_id = $1 and status = 'pending'",
        [row.booking_id, ((error as Error).message ?? String(error)).slice(0, 500), now]).catch(() => undefined);
    }
  }
  return result;
}

/** Pending Stripe package purchases: paid ones are applied, expired sessions fail the purchase. */
export async function reconcileStripePurchases(deps: StripeDeps, now: Date, limit = 20): Promise<{ claimed: number; paid: number; failed: number; errors: number }> {
  const { pool } = deps;
  const { rows } = await pool.query(
    `with due as (
       select id from package_purchases
       where provider = 'stripe' and status = 'pending' and provider_order_id is not null and created_at < $1::timestamptz - $3 * interval '1 millisecond'
         and (checked_at is null or checked_at < $1::timestamptz - $3 * interval '1 millisecond')
       order by checked_at nulls first, created_at limit $2 for update skip locked)
     update package_purchases p set checked_at = $1 from due where p.id = due.id returning p.id, p.provider_order_id`, [now, limit, RECHECK_MS]);
  const result = { claimed: rows.length, paid: 0, failed: 0, errors: 0 };
  for (const r of rows) {
    try {
      const outcome = await settleStripeSession(deps, r.provider_order_id, now);
      if (outcome === "paid") result.paid += 1;
      if (outcome === "expired") result.failed += 1;
    } catch (error) {
      result.errors += 1;
      await pool.query("update package_purchases set last_error = $2, updated_at = $3 where id = $1", [r.id, ((error as Error).message ?? String(error)).slice(0, 500), now]).catch(() => undefined);
    }
  }
  return result;
}

// A refund that failed is retried at most every five minutes.
const REFUND_RETRY_MS = 5 * 60_000;

/**
 * Refunds what Stripe payments owe back, on the host's own account: in full for those marked refund_pending (a
 * cancelled paid booking, a released deposit, a payment that landed after the slot was released, every remaining week
 * of a paid series), and the queued share of a series payment some of whose weeks were cancelled. Never twice: refunds
 * already on the payment are counted first, and the idempotency key is fixed by the total being refunded up to.
 */
export async function processStripeRefunds(deps: StripeDeps, now: Date, limit = 10): Promise<{ claimed: number; refunded: number; errors: number }> {
  const { pool } = deps;
  const { rows } = await pool.query(
    `with due as (
       select id from payments where provider = 'stripe' and ${REFUND_DUE_SQL}
         and (checked_at is null or checked_at < $1::timestamptz - $3 * interval '1 millisecond')
       order by checked_at nulls first, updated_at limit $2 for update skip locked)
     update payments p set checked_at = $1 from due where p.id = due.id
     returning p.id, p.booking_id, p.host_id, p.provider_payment_id, p.application_fee_minor, p.status, p.amount_minor, p.refunded_minor, p.refund_due_minor`,
    [now, limit, REFUND_RETRY_MS]);
  const result = { claimed: rows.length, refunded: 0, errors: 0 };
  const setError = (id: string, message: string) =>
    pool.query(`update payments set last_error = $2, updated_at = $3 where id = $1 and ${REFUND_DUE_SQL}`, [id, message.slice(0, 500), now]);
  for (const row of rows) {
    try {
      const host = await deps.accountFor(row.host_id);
      if (!host) {
        await setError(row.id, "Stripe disconnected");
        continue;
      }
      const target = targetOf(row);
      const earlier = (await deps.api.listRefunds(host.accountId, row.provider_payment_id)).filter((r) => r.status !== "failed" && r.status !== "canceled");
      const done = earlier.reduce((sum, r) => sum + r.amount, 0);
      let refundId: string;
      let total: number;
      if (earlier.length && done >= target) {
        refundId = earlier[0].id;
        total = done;
      } else {
        // A first refund of the whole payment keeps the original request (no amount, key per payment); anything else
        // names its amount, keyed by the running total it brings the payment up to.
        const whole = done === 0 && target === row.amount_minor;
        const refund = await deps.api.refund(host.accountId, row.provider_payment_id,
          { refundApplicationFee: row.application_fee_minor > 0, ref: bookingRef(row.booking_id), ...(whole ? {} : { amountMinor: target - done }) },
          whole ? `hh-refund-${row.id}` : `hh-refund-${row.id}-${target}`);
        refundId = refund.id;
        // A full refund (no amount asked) returns everything left on the payment, whatever figure comes back with it.
        total = whole ? target : done + refund.amount;
      }
      await inTx(pool, async (client) => {
        const delta = await recordRefund(client, row, refundId, total, now);
        // Only INR payments are ever invoiced, so this finds nothing for Stripe today; kept so the rule lives in one place.
        if (delta > 0) await creditNoteForRefund(client, row.id, now, delta);
      });
      result.refunded += 1;
    } catch (error) {
      result.errors += 1;
      await setError(row.id, (error as Error).message ?? String(error)).catch(() => undefined);
    }
  }
  return result;
}
