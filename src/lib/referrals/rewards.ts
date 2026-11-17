import type pg from "pg";
import { formatMoney, PRICES, type BillingInterval, type Plan, type Provider } from "../billing/plans";
import { BillingApiError } from "../billing/providers";
import type { WebhookEvent } from "../billing/webhooks";
import { DAY_MS, YEARLY_REWARD_CAP } from "./codes";
import { CreditNotConfigured, creditProviderFromEnv, RAZORPAY_REFERRAL_DISCOUNT_INR, type CreditProvider } from "./credits";

// Rewards: a referral pays out only when the referred host's own Solo or Duo subscription is charged, as reported by a
// signature-checked billing webhook. Everything here is safe to run twice for the same event.

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

export interface VerifiedPayment {
  /** The provider's payment (Razorpay) or invoice (Stripe) id. */
  ref: string;
  amountMinor: number;
  paidAt: Date;
}

/**
 * The charge a webhook reports, or null when it reports none: Razorpay subscription.charged with a captured payment,
 * or Stripe invoice.paid. A Stripe invoice can be paid with nothing charged (a free month's credit covered it):
 * amountMinor is then 0. That still counts as a renewal, but only real money (above zero) pays out a referral.
 * Stripe's invoice.payment_succeeded is not used: it fires for the same invoice as invoice.paid.
 */
export function paymentFromWebhook(provider: Provider, type: string, body: unknown, now = new Date()): VerifiedPayment | null {
  const b = obj(body);
  if (provider === "razorpay") {
    if (type !== "subscription.charged") return null;
    const p = obj(obj(obj(b.payload).payment).entity);
    if (typeof p.id !== "string" || typeof p.amount !== "number" || p.amount <= 0) return null;
    if (p.status !== undefined && p.status !== "captured") return null;
    return { ref: p.id, amountMinor: p.amount, paidAt: typeof p.created_at === "number" ? new Date(p.created_at * 1000) : now };
  }
  if (type !== "invoice.paid") return null;
  const o = obj(obj(b.data).object);
  if (typeof o.id !== "string" || typeof o.amount_paid !== "number" || o.amount_paid < 0) return null;
  const paidAt = obj(o.status_transitions).paid_at;
  return { ref: o.id, amountMinor: o.amount_paid, paidAt: typeof paidAt === "number" ? new Date(paidAt * 1000) : now };
}

interface PlanRow { user_id: string; plan: Plan; interval: BillingInterval | null; status: string; provider: Provider; provider_subscription_id: string; provider_customer_id: string | null }

const planRowFor = async (db: Pick<pg.Pool, "query">, provider: Provider, subscriptionId: string) =>
  (await db.query<PlanRow>(
    `select user_id, plan, interval, status, provider, provider_subscription_id, provider_customer_id from subscriptions
     where provider = $1 and provider_subscription_id = $2`, [provider, subscriptionId])).rows[0] ?? null;

export interface RewardDeps {
  credits: (provider: Provider) => CreditProvider | null;
}

export const envRewardDeps = (env: Env = process.env): RewardDeps => ({ credits: (p) => creditProviderFromEnv(p, env) });

/**
 * The billing webhook's referral step, run after the subscription has been saved. A charge on a host's plan
 * subscription marks free months already handed to the provider as used, rewards the host's referral if this is its
 * first payment, then hands any waiting free months to the provider. A plan that stopped (paused, unpaid, cancelled)
 * starts any month of Solo owed as an extension.
 */
export async function afterBillingWebhook(pool: pg.Pool, event: WebhookEvent, body: unknown, deps: RewardDeps = envRewardDeps(), now = new Date()): Promise<void> {
  if (!event.subscriptionId) return;
  const sub = await planRowFor(pool, event.provider, event.subscriptionId);
  if (!sub) return; // not a plan subscription (an add-on, or one that wasn't saved)
  const payment = paymentFromWebhook(event.provider, event.type, body, now);
  if (payment && sub.plan !== "free" && sub.status === "active") {
    await settleScheduledCredits(pool, sub, payment, now);
    // Only real money pays out a referral; a renewal a free month fully covered doesn't.
    const reward = payment.amountMinor > 0 ? await rewardReferral(pool, sub, payment, deps, now) : { outcome: "none" as const, referrerId: null };
    await applyPendingCredits(pool, sub.user_id, deps, now);
    // A referrer who already pays gets theirs onto their next renewal now, not one renewal later.
    if (reward.outcome === "rewarded" && reward.referrerId) await applyPendingCredits(pool, reward.referrerId, deps, now);
  }
  if (sub.status === "paused" || sub.status === "unpaid" || sub.status === "cancelled") await startExtensions(pool, sub.user_id, now);
}

/**
 * The most a Razorpay renewal costs when the referral offer was applied: the plan's price less the offer. For Solo
 * monthly that is ₹1. Null when the plan's price isn't known (then the renewal can't be checked).
 */
export function discountedRazorpayCharge(plan: Plan, interval: BillingInterval | null): number | null {
  // Clinic is priced per practitioner count (clinic/pricing.ts), so its renewal can't be checked from PRICES.
  if (plan === "free" || plan === "clinic" || !interval) return null;
  return PRICES[plan][interval].INR - RAZORPAY_REFERRAL_DISCOUNT_INR;
}

/**
 * A renewal was charged: free months handed to the provider before it are settled. A Stripe credit is always taken by
 * the next invoice, so it is used. A Razorpay offer is used only if the charge shows it was applied (₹1 for Solo
 * monthly). A renewal charged in full means Razorpay didn't apply it: the free month goes back to waiting, so it is
 * linked again for the next renewal, and the miss is counted and logged for support.
 */
async function settleScheduledCredits(pool: pg.Pool, sub: PlanRow, payment: VerifiedPayment, now: Date): Promise<void> {
  const { rows } = await pool.query<{ id: string; mechanism: string }>(
    `select id, mechanism from referral_credits where user_id = $1 and provider_subscription_id = $2
       and status = 'scheduled' and scheduled_at < $3 order by created_at, id`,
    [sub.user_id, sub.provider_subscription_id, payment.paidAt]);
  const ceiling = discountedRazorpayCharge(sub.plan, sub.interval);
  for (const c of rows) {
    const applied = c.mechanism !== "razorpay_offer" || (ceiling !== null && payment.amountMinor <= ceiling);
    if (applied) {
      await pool.query("update referral_credits set status = 'used', updated_at = $2 where id = $1", [c.id, now]);
      continue;
    }
    const message = `Renewal ${payment.ref} was charged ${formatMoney(payment.amountMinor, "INR")}, not the discounted ${ceiling === null ? "amount" : formatMoney(ceiling, "INR")}: Razorpay didn't apply the offer. Linked again for the next renewal.`;
    console.error(`[referrals] free month ${c.id} for ${sub.user_id}: ${message}`);
    await pool.query(
      `update referral_credits set status = 'pending', missed_renewals = missed_renewals + 1, error = $2, updated_at = $3 where id = $1`,
      [c.id, message.slice(0, 500), now]);
  }
}

export type RewardOutcome = "none" | "rewarded" | "capped" | "blocked";

/** Rewards the referral of the host who just paid, once. */
export async function rewardReferral(pool: pg.Pool, payer: PlanRow, payment: VerifiedPayment, deps: RewardDeps, now = new Date()): Promise<{ outcome: RewardOutcome; referrerId: string | null }> {
  const { rows: [pending] } = await pool.query<{ id: string; referrer_id: string }>(
    "select id, referrer_id from referrals where referred_id = $1 and status = 'signed_up'", [payer.user_id]);
  if (!pending) return { outcome: "none", referrerId: null };
  // Same card on both accounts (where the provider says): checked before the transaction, it calls the provider.
  const samePaymentMethod = await sharesPaymentMethod(pool, pending.referrer_id, payer, deps);

  const client = await pool.connect();
  try {
    await client.query("begin");
    // One reward decision at a time per referrer, so two payments at once can't both slip under the yearly cap.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`referrals:${pending.referrer_id}`]);
    const { rows: [r] } = await client.query<{ id: string; referrer_id: string }>(
      "select id, referrer_id from referrals where id = $1 and status = 'signed_up' for update", [pending.id]);
    if (!r) { await client.query("rollback"); return { outcome: "none", referrerId: null }; } // another delivery got here first
    let outcome: RewardOutcome;
    if (samePaymentMethod) outcome = "blocked";
    else {
      const { rows: [c] } = await client.query<{ n: number }>(
        "select count(*)::int as n from referrals where referrer_id = $1 and status = 'rewarded' and paid_at > $2",
        [r.referrer_id, new Date(now.getTime() - 365 * DAY_MS)]);
      outcome = c.n >= YEARLY_REWARD_CAP ? "capped" : "rewarded";
    }
    await client.query(
      "update referrals set status = $2, blocked_reason = $3, paid_at = $4, payment_ref = $5 where id = $1",
      [r.id, outcome, outcome === "blocked" ? "same_payment_method" : null, now, `${payer.provider}:${payment.ref}`]);
    const roles: { role: "referrer" | "referred"; userId: string }[] = [];
    if (outcome !== "blocked") roles.push({ role: "referred", userId: payer.user_id });
    if (outcome === "rewarded") roles.push({ role: "referrer", userId: r.referrer_id });
    for (const { role, userId } of roles) {
      const ins = await client.query(
        "insert into referral_credits (user_id, referral_id, role, created_at, updated_at) values ($1, $2, $3, $4, $4) on conflict (referral_id, role) do nothing",
        [userId, r.id, role, now]);
      if (!ins.rowCount) continue;
      await client.query(
        `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
         select null, u.id, 'email', 'referral_reward_host', u.email, $3, 'referral:' || $2::text || ':' || $4::text
           from users u where u.id = $1 and u.deleted_at is null
         on conflict (dedupe_key) do nothing`, [userId, r.id, now, role]);
    }
    await client.query("commit");
    if (outcome === "blocked") console.warn(`[referrals] referral ${r.id} blocked: both hosts pay with the same card`);
    return { outcome, referrerId: r.referrer_id };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** True when both hosts' plan subscriptions are with a provider that fingerprints cards, and the cards match. */
async function sharesPaymentMethod(pool: pg.Pool, referrerId: string, payer: PlanRow, deps: RewardDeps): Promise<boolean> {
  const { rows: [ref] } = await pool.query<{ provider: Provider; provider_subscription_id: string }>(
    "select provider, provider_subscription_id from subscriptions where user_id = $1 and provider_subscription_id is not null", [referrerId]);
  if (!ref || ref.provider !== payer.provider) return false;
  const cp = deps.credits(payer.provider);
  if (!cp) return false;
  const [a, b] = await Promise.all([cp.paymentFingerprint(payer.provider_subscription_id), cp.paymentFingerprint(ref.provider_subscription_id)]);
  return a !== null && a === b;
}

/**
 * Hands the host's waiting free months to their payment provider. Without a live paid plan they keep waiting (a
 * referrer on Free gets theirs on their first renewal after they subscribe). A retryable provider failure leaves the
 * credit waiting for the next charge; a refusal marks it failed with the provider's message.
 */
export async function applyPendingCredits(pool: pg.Pool, userId: string, deps: RewardDeps, now = new Date()): Promise<number> {
  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`referral-credits:${userId}`]);
    const { rows: [sub] } = await client.query<PlanRow>(
      "select user_id, plan, interval, status, provider, provider_subscription_id, provider_customer_id from subscriptions where user_id = $1", [userId]);
    if (!sub || sub.plan === "free" || sub.status !== "active" || !sub.provider_subscription_id) { await client.query("commit"); return 0; }
    const cp = deps.credits(sub.provider);
    const { rows: waiting } = await client.query<{ id: string }>(
      "select id from referral_credits where user_id = $1 and status = 'pending' order by created_at, id", [userId]);
    for (const credit of waiting) {
      if (!cp) { await noteError(client, credit.id, `${sub.provider} isn't set up on this server`, now); break; }
      if (sub.provider === "razorpay") {
        // One Razorpay offer per cycle: the next waits until this one has been used on a renewal.
        const { rowCount } = await client.query(
          "select 1 from referral_credits where user_id = $1 and provider_subscription_id = $2 and status = 'scheduled'", [userId, sub.provider_subscription_id]);
        if (rowCount) break;
      }
      try {
        const r = await cp.schedule({ id: sub.provider_subscription_id, customerId: sub.provider_customer_id }, credit.id);
        if (r.kind === "extension") {
          await client.query(
            "update referral_credits set status = 'extension', mechanism = 'extension', provider_subscription_id = $2, error = $3, updated_at = $4 where id = $1",
            [credit.id, sub.provider_subscription_id, r.reason, now]);
          continue;
        }
        await client.query(
          `update referral_credits set status = 'scheduled', mechanism = $2, provider_subscription_id = $3, provider_ref = $4, scheduled_at = $5,
             error = case when missed_renewals > 0 then error else null end, updated_at = $5 where id = $1`, [credit.id, r.mechanism, sub.provider_subscription_id, r.ref, now]);
        applied++;
        if (!r.stackable) break;
      } catch (error) {
        const message = String((error as Error).message).slice(0, 500);
        if (error instanceof CreditNotConfigured || (error instanceof BillingApiError && error.retryable)) {
          console.error(`[referrals] free month ${credit.id} for ${userId} is waiting: ${message}`);
          await noteError(client, credit.id, message, now);
          break;
        }
        if (!(error instanceof BillingApiError)) throw error;
        console.error(`[referrals] ${sub.provider} refused free month ${credit.id} for ${userId}: ${message}`);
        await client.query("update referral_credits set status = 'failed', error = $2, updated_at = $3 where id = $1", [credit.id, message, now]);
      }
    }
    await client.query("commit");
    return applied;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const noteError = (db: pg.PoolClient, id: string, message: string, now: Date) =>
  db.query("update referral_credits set error = $2, updated_at = $3 where id = $1", [id, message, now]);

/**
 * The paid plan stopped: each free month that couldn't be taken off a renewal becomes a month of Solo, one after the
 * other, starting now (or when the last one ends).
 */
export async function startExtensions(pool: pg.Pool, userId: string, now = new Date()): Promise<number> {
  const { rowCount } = await pool.query(
    `with waiting as (
       select id, row_number() over (order by created_at, id) as n from referral_credits
        where user_id = $1 and status = 'extension' and access_from is null),
     base as (
       select greatest($2::timestamptz, coalesce(max(access_until), $2::timestamptz)) as at from referral_credits
        where user_id = $1 and status = 'extension' and access_until is not null)
     update referral_credits c set access_from = base.at + (waiting.n - 1) * interval '1 month',
       access_until = base.at + waiting.n * interval '1 month', updated_at = $2
       from waiting, base where c.id = waiting.id`, [userId, now]);
  return rowCount ?? 0;
}

/** Solo while a free month given as an extension is running, otherwise null. */
export async function referralAccessPlan(db: Pick<pg.Pool, "query">, userId: string, now = new Date()): Promise<"solo" | null> {
  const { rowCount } = await db.query(
    "select 1 from referral_credits where user_id = $1 and status = 'extension' and access_from <= $2 and access_until > $2", [userId, now]);
  return rowCount ? "solo" : null;
}
