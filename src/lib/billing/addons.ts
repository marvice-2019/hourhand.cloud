import type pg from "pg";
import { BillingActionError, hostPlan } from "./account";
import { billingFor } from "./env";
import { addonLive, addonPriceId, type Addon, type Provider, type SubscriptionStatus } from "./plans";
import { BillingApiError, type BillingProvider } from "./providers";
import { syncSubscription } from "./sync";

// Add-ons (the custom domain): bought, cancelled and checked like plans, on a subscription of their own. As with
// plans, every change goes to the provider first and the row only holds what the provider confirmed.

type Env = Record<string, string | undefined>;

/** The dashboard page each add-on is bought and managed from; checkout returns there. */
const ADDON_PAGES: Record<Addon, string> = { domain: "/dashboard/domain", voice: "/dashboard/voice" };
type Db = Pick<pg.Pool, "query">;

export interface AddonSubscription {
  addon: Addon;
  provider: Provider;
  subscriptionId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export async function getAddon(db: Db, userId: string, addon: Addon): Promise<AddonSubscription | null> {
  const { rows } = await db.query(
    `select addon, provider, provider_subscription_id, status, current_period_end, cancel_at_period_end
       from addon_subscriptions where user_id = $1 and addon = $2`, [userId, addon]);
  const r = rows[0];
  if (!r) return null;
  return { addon: r.addon, provider: r.provider, subscriptionId: r.provider_subscription_id, status: r.status, currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: r.cancel_at_period_end };
}

/**
 * Whether the host's custom domain may serve right now: the add-on is live AND the host is on a paid plan (their own,
 * or a Duo seat). Either lapsing stops it.
 */
export async function domainEntitled(db: Db, userId: string, now = new Date()): Promise<boolean> {
  if (!addonLive(await getAddon(db, userId, "domain"), now)) return false;
  return (await hostPlan(db, userId)) !== "free";
}

/** Starts a checkout for an add-on. Needs a paid plan, and refuses while the host already holds the add-on. */
export async function startAddonCheckout(db: Db, user: { id: string; email: string }, addon: Addon, baseUrl: string, env: Env = process.env, now = new Date(), api?: BillingProvider): Promise<string> {
  if ((await hostPlan(db, user.id)) === "free") throw new BillingActionError("needs_plan", "The add-on needs a paid plan.");
  const current = await getAddon(db, user.id, addon);
  if (current && current.status !== "cancelled") throw new BillingActionError("already_subscribed", "This account already has this add-on.");
  const billing = billingFor("razorpay", env);
  const priceId = addonPriceId(addon, env);
  if (!billing || !priceId) throw new BillingActionError("not_configured", `Razorpay isn't set up for the ${addon} add-on.`);
  try {
    const { url } = await (api ?? billing.api).startCheckout({
      priceId, interval: "month", userId: user.id, email: user.email, customerId: null,
      successUrl: `${baseUrl}${ADDON_PAGES[addon]}?checkout=done`, cancelUrl: `${baseUrl}${ADDON_PAGES[addon]}?checkout=cancelled`,
      idempotencyKey: `addon:${addon}:${user.id}:${priceId}:${Math.floor(now.getTime() / 60_000)}`,
    });
    return url;
  } catch (error) {
    throw providerError(error);
  }
}

/** Stops renewal; the add-on (and the domain) keeps working until the end of the paid month. */
export async function cancelAddon(pool: pg.Pool, userId: string, addon: Addon, env: Env = process.env, api?: BillingProvider): Promise<void> {
  const s = await getAddon(pool, userId, addon);
  if (!s || s.status === "cancelled") throw new BillingActionError("no_subscription", "There's no add-on to cancel.");
  const billing = billingFor(s.provider, env);
  if (!billing) throw new BillingActionError("not_configured", `${s.provider} isn't set up on this server.`);
  const client = api ?? billing.api;
  try {
    await client.cancelAtPeriodEnd(s.subscriptionId);
  } catch (error) {
    throw providerError(error);
  }
  // Razorpay doesn't report "cancels at period end" when re-read, so record it here.
  await pool.query("update addon_subscriptions set cancel_at_period_end = true, updated_at = now() where user_id = $1 and provider_subscription_id = $2", [userId, s.subscriptionId]);
  try {
    await syncSubscription(pool, client, s.subscriptionId, env);
  } catch (error) {
    console.warn(`[billing] re-reading add-on ${s.subscriptionId} after cancelling failed; the webhook will update it`, error);
  }
}

function providerError(error: unknown): BillingActionError {
  if (error instanceof BillingActionError) return error;
  console.error("[billing] add-on provider call failed", error);
  const retry = error instanceof BillingApiError && error.retryable;
  return new BillingActionError("provider", retry ? "The payment provider didn't respond. Try again in a minute." : "The payment provider refused that change.");
}
