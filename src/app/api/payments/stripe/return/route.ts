import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, publicUrl } from "@/lib/auth/auth";
import { getSignedInUser } from "@/lib/auth/session";
import { tokenKey } from "@/lib/crypto/seal";
import { getPool } from "@/lib/data/pg-store";
import { refreshStripeAccount, StripeConnectError, stripeConnectFromEnv } from "@/lib/payments/stripe-connect";

export const dynamic = "force-dynamic";

/**
 * Stripe sends the host back here after onboarding. Coming back says nothing about whether onboarding finished (Stripe
 * passes no state), so the account is re-read from Stripe and the page shows what it found.
 */
export async function GET(request: NextRequest) {
  const user = await getSignedInUser();
  if (!user) return NextResponse.redirect(publicUrl("/sign-in", request));
  const back = (query: string) => NextResponse.redirect(publicUrl(`/dashboard/integrations?${query}`, request));
  const stripe = stripeConnectFromEnv();
  if (!authEnabled() || !stripe) return back("stripe_error=not_configured");
  try {
    const host = await refreshStripeAccount(getPool(process.env.DATABASE_URL as string), tokenKey(), stripe.api, user.id);
    if (!host) return back("stripe_error=not_connected");
    return back(`stripe=${host.onboarding}`);
  } catch (error) {
    if (error instanceof StripeConnectError) return back(`stripe_error=${error.code}`);
    throw error;
  }
}
