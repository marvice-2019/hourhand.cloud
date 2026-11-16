import type pg from "pg";
import { razorpayStatus } from "./host-razorpay";
import { chargeableCurrency } from "./stripe-checkout";
import { stripeStatus } from "./stripe-connect";

/** How the host takes payments: their one provider, the currency guests pay in, and whether it can charge right now. */
export interface PaymentAccount { provider: "razorpay" | "stripe"; currency: string | null; ready: boolean }

export async function paymentAccount(db: Pick<pg.Pool, "query">, userId: string): Promise<PaymentAccount | null> {
  const [razorpay, stripe] = await Promise.all([razorpayStatus(db, userId), stripeStatus(db, userId)]);
  if (razorpay) return { provider: "razorpay", currency: "INR", ready: true };
  if (stripe) return { provider: "stripe", currency: stripe.currency, ready: !stripe.removed && stripe.onboarding === "active" && chargeableCurrency(stripe.currency) };
  return null;
}

/** The currency the host's prices are set in: their provider's, or rupees until one is connected. */
export const priceCurrency = (a: PaymentAccount | null): string => a?.currency ?? "INR";
