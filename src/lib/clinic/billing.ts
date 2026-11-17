import type pg from "pg";
import { getHostSubscription } from "../billing/account";
import { BillingApiError, type BillingProvider } from "../billing/providers";
import { syncSubscription } from "../billing/sync";
import { practitionerCount, requirePracticeRole } from "./practices";
import { clinicPriceId, isClinicCount } from "./pricing";

// The Clinic subscription: the practice owner's own, monthly, through Razorpay. Only the owner may start or change it
// (role "billing.manage"). As with every plan, Hourhand asks the provider first and then re-reads the subscription
// from it; the plan row only ever holds what Razorpay confirmed.

type Env = Record<string, string | undefined>;
type Db = Pick<pg.Pool, "query">;

export type ClinicBillingCode =
  | "invalid_count" | "places_in_use" | "already_subscribed" | "not_configured" | "no_subscription" | "not_razorpay" | "cannot_change" | "provider";

export class ClinicBillingError extends Error {
  constructor(readonly code: ClinicBillingCode, message: string) { super(message); this.name = "ClinicBillingError"; }
}

const holds = (s: Awaited<ReturnType<typeof getHostSubscription>>) => Boolean(s?.subscriptionId) && s!.plan !== "free" && s!.status !== "cancelled";

/** The number of places the owner's current Clinic subscription pays for, or null when they aren't on Clinic. */
export async function paidPlaces(db: Db, ownerId: string): Promise<number | null> {
  const { rows: [r] } = await db.query("select extra_seats from subscriptions where user_id = $1 and plan = 'clinic'", [ownerId]);
  return r ? Math.min(10, 3 + Number(r.extra_seats ?? 0)) : null;
}

async function checkPlaces(db: Db, ownerId: string, practitioners: number) {
  if (!isClinicCount(practitioners)) throw new ClinicBillingError("invalid_count", "Clinic covers 3 to 10 practitioners.");
  const ctx = await requirePracticeRole(db, ownerId, "billing.manage");
  const inUse = await practitionerCount(db, ctx.practice.id);
  if (inUse > practitioners) {
    throw new ClinicBillingError("places_in_use", `${inUse} practitioners are in the practice. Take someone off the page before paying for fewer places.`);
  }
  return ctx;
}

/**
 * Starts a Razorpay checkout for Clinic with `practitioners` places (3 to 10). The owner must have set up the practice
 * first, and must not already hold a subscription (switching from Solo or Duo uses changeClinicPlaces instead).
 */
export async function startClinicCheckout(db: Db, owner: { id: string; email: string }, practitioners: number, baseUrl: string,
  deps: { api: BillingProvider | null; env?: Env }, now = new Date()): Promise<string> {
  await checkPlaces(db, owner.id, practitioners);
  const current = await getHostSubscription(db, owner.id);
  if (holds(current)) throw new ClinicBillingError("already_subscribed", "This account already has a subscription. Switch it to Clinic instead.");
  const priceId = clinicPriceId(practitioners, deps.env);
  if (!deps.api || deps.api.provider !== "razorpay" || !priceId) throw new ClinicBillingError("not_configured", `Clinic for ${practitioners} isn't set up on this server.`);
  try {
    const { url } = await deps.api.startCheckout({
      priceId, interval: "month", userId: owner.id, email: owner.email, customerId: current?.customerId ?? null,
      successUrl: `${baseUrl}/dashboard/practice?done=subscribed`, cancelUrl: `${baseUrl}/dashboard/plan?checkout=cancelled`,
      idempotencyKey: `clinic-checkout:${owner.id}:${priceId}:${Math.floor(now.getTime() / 60_000)}`,
    });
    return url;
  } catch (error) {
    throw asError(error);
  }
}

function asError(error: unknown): ClinicBillingError {
  if (error instanceof ClinicBillingError) return error;
  console.error("[clinic billing] provider call failed", error);
  if (error instanceof BillingApiError && !error.retryable && error.status !== null && error.status >= 400 && error.status < 500) {
    return new ClinicBillingError("cannot_change",
      "Razorpay couldn't change this subscription. Subscriptions paid by UPI AutoPay or eMandate can't be changed: cancel it here, and subscribe to Clinic once it ends (your practice and everyone's data stay).");
  }
  return new ClinicBillingError("provider", "Razorpay didn't respond. Try again in a minute; nothing was changed.");
}

/**
 * Moves the owner's live Razorpay subscription to Clinic with `practitioners` places: from Solo or Duo (the upgrade;
 * the practice and everyone's data stay as they are), or from one Clinic size to another. Takes effect now.
 */
export async function changeClinicPlaces(pool: pg.Pool, owner: { id: string }, practitioners: number,
  deps: { api: BillingProvider | null; env?: Env }, now = new Date()): Promise<void> {
  await checkPlaces(pool, owner.id, practitioners);
  const s = await getHostSubscription(pool, owner.id);
  if (!holds(s) || !s!.subscriptionId) throw new ClinicBillingError("no_subscription", "There's no subscription to change. Start Clinic instead.");
  if (s!.provider !== "razorpay") {
    throw new ClinicBillingError("not_razorpay", "Clinic is billed in rupees through Razorpay. Cancel your current plan, then subscribe to Clinic when it ends.");
  }
  if (s!.status !== "active") throw new ClinicBillingError("cannot_change", "Only an active subscription can be changed. Resume it or update the card first.");
  const priceId = clinicPriceId(practitioners, deps.env);
  if (!deps.api?.changePlan || deps.api.provider !== "razorpay" || !priceId) throw new ClinicBillingError("not_configured", `Clinic for ${practitioners} isn't set up on this server.`);
  if (s!.plan === "clinic" && (await paidPlaces(pool, owner.id)) === practitioners) return;
  try {
    await deps.api.changePlan(s!.subscriptionId, priceId);
  } catch (error) {
    throw asError(error);
  }
  try {
    await syncSubscription(pool, deps.api, s!.subscriptionId, deps.env ?? process.env, now);
  } catch (error) {
    console.warn("[clinic billing] re-reading after the change failed; the webhook will catch up", error);
  }
}

