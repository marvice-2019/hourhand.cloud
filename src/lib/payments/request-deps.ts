import { authEnabled, resolveBaseUrl } from "../auth/auth";
import { hostPlan } from "../billing/account";
import { tokenKey } from "../crypto/seal";
import type { PaymentDeps } from "../booking";
import { getPool } from "../data/pg-store";
import { loadHostRazorpay } from "./host-razorpay";
import { collectingAuth, loadPlatformRazorpay } from "./platform";
import { paymentAccountFor } from "../clinic/payments";
import { razorpayOrders } from "./razorpay-orders";
import { stripeCheckoutFromEnv, stripeDepsFor } from "./stripe-checkout";

/** What the booking routes use to reach hosts' Razorpay, or null when this server can't take payments (no Postgres or no TOKEN_ENCRYPTION_KEY). */
export function requestPaymentDeps(): PaymentDeps | null {
  if (!authEnabled()) return null;
  let key: Buffer;
  try {
    key = tokenKey();
  } catch {
    return null;
  }
  const pool = getPool(process.env.DATABASE_URL!);
  const stripeApi = stripeCheckoutFromEnv();
  return {
    pool,
    // New payments go to the account collecting for the host now: a Clinic practice's owner, or the host's own.
    authFor: async (hostId) => loadHostRazorpay(pool, key, await paymentAccountFor(pool, hostId)),
    // B18: a host whose guests pay Hourhand gets Hourhand's account here; everyone else their own, as above.
    collectFor: (hostId) => collectingAuth(pool, key, hostId, async () => loadHostRazorpay(pool, key, await paymentAccountFor(pool, hostId))),
    platformAuth: () => loadPlatformRazorpay(pool, key),
    ordersFor: (auth) => razorpayOrders(auth),
    planFor: (hostId) => hostPlan(pool, hostId),
    // Checkout's return URLs must be the public address; without BETTER_AUTH_URL (local dev only) localhost is used.
    stripe: stripeApi && { deps: stripeDepsFor(pool, key, stripeApi), baseUrl: resolveBaseUrl() ?? "http://localhost:3000" },
  };
}
