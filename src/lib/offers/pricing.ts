// Offer arithmetic. Pure functions only: the database side is in offers.ts. Prices on Hourhand are GST-inclusive and in
// paise; a discount comes off that price and GST is then worked out on what is left (see gst/invoices.ts).

import { dayKey } from "../format";
import { fillTemplate } from "../i18n/host/lib-messages";

export type DiscountKind = "percent" | "fixed";

/** percent: a whole percent (1 to 90). fixed: paise off. */
export interface Discount { kind: DiscountKind; value: number }

export type AdjustmentKind = "coupon" | "first_session" | "campaign" | "sliding_scale";

/**
 * Fixed amounts (codes, campaigns, the first-session discount) are set in rupees, so they only apply to an INR price.
 * A percent works on a price in any currency.
 */
export const FIXED_CURRENCY = "INR";
export const usableIn = (d: Discount, currency: string): boolean => d.kind === "percent" || currency === FIXED_CURRENCY;

/** Razorpay's smallest order is ₹1 (and Stripe's is about that in USD, GBP or EUR), so no offer takes a price below 100 minor units. */
export const MIN_CHARGE_MINOR = 100;
export const MAX_PERCENT = 90;

/** What a discount takes off a price, never leaving less than ₹1 to pay. */
export function discountAmount(listMinor: number, d: Discount): number {
  const raw = d.kind === "percent" ? Math.round((listMinor * d.value) / 100) : d.value;
  return Math.max(0, Math.min(raw, listMinor - MIN_CHARGE_MINOR));
}

export interface Candidate {
  kind: Exclude<AdjustmentKind, "sliding_scale">;
  label: string;
  discount: Discount;
  couponId?: string;
  campaignId?: string;
  code?: string;
}

/**
 * The one adjustment a booking gets: whichever takes the most off. On a tie a campaign or first-session discount wins
 * over a coupon, so the client's code isn't used up for nothing.
 */
export function pickBest(listMinor: number, candidates: Candidate[], currency: string = FIXED_CURRENCY): { candidate: Candidate; discountMinor: number } | null {
  const rank: Record<Candidate["kind"], number> = { campaign: 0, first_session: 1, coupon: 2 };
  let best: { candidate: Candidate; discountMinor: number } | null = null;
  for (const candidate of candidates) {
    if (!usableIn(candidate.discount, currency)) continue;
    const discountMinor = discountAmount(listMinor, candidate.discount);
    if (discountMinor <= 0) continue;
    if (!best || discountMinor > best.discountMinor || (discountMinor === best.discountMinor && rank[candidate.kind] < rank[best.candidate.kind])) {
      best = { candidate, discountMinor };
    }
  }
  return best;
}

export interface SlidingScale { minMinor: number; suggestedMinor: number; maxMinor: number; note: string | null }

/** The amount a client picked on a sliding scale; nothing picked means the suggested amount. Outside the range is refused. */
export function slidingCharge(scale: SlidingScale, payMinor: number | null): number | null {
  const pick = payMinor ?? scale.suggestedMinor;
  if (!Number.isInteger(pick) || pick < scale.minMinor || pick > scale.maxMinor) return null;
  return pick;
}

/** Whether a dated offer is on at `now`: its first to last day, inclusive, as calendar dates in the host's time zone. */
export function campaignLive(c: { startsOn: string; endsOn: string }, now: Date, timezone: string): boolean {
  const today = dayKey(now, timezone);
  return c.startsOn <= today && today <= c.endsOn;
}

/** Empty lists mean every paid event type and package; otherwise only the ones listed. */
export function appliesTo(target: { eventTypeIds: string[]; packageIds: string[] }, item: { kind: "event_type" | "package"; id: string }): boolean {
  if (target.eventTypeIds.length === 0 && target.packageIds.length === 0) return true;
  return (item.kind === "event_type" ? target.eventTypeIds : target.packageIds).includes(item.id);
}

/** describeDiscount's wording, as code -> English template (the dashboard shows the host's language). */
export const DISCOUNT_MESSAGES = { percent: "{n}% off", fixed: "₹{amount} off" } as const;

/** "20% off" or "₹200 off" (English; host-facing and invoice text). */
export function describeDiscount(d: Discount): string {
  return d.kind === "percent"
    ? fillTemplate(DISCOUNT_MESSAGES.percent, { n: d.value })
    : fillTemplate(DISCOUNT_MESSAGES.fixed, { amount: (d.value / 100).toFixed(d.value % 100 ? 2 : 0) });
}

/** Codes are case-insensitive: stored and compared upper-case. */
export const normaliseCode = (raw: string) => raw.trim().toUpperCase();
export const CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;
