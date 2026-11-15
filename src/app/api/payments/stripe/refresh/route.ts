import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, publicUrl } from "@/lib/auth/auth";
import { getSignedInUser } from "@/lib/auth/session";
import { tokenKey } from "@/lib/crypto/seal";
import { getPool } from "@/lib/data/pg-store";
import { startStripeConnect, StripeConnectError, stripeConnectFromEnv } from "@/lib/payments/stripe-connect";

export const dynamic = "force-dynamic";

/**
 * Stripe's refresh_url: the onboarding link expired or was already used. Makes a fresh link for the signed-in host's
 * existing account and sends them straight back into Stripe. It never creates an account (no country is passed).
 */
export async function GET(request: NextRequest) {
  const user = await getSignedInUser();
  if (!user) return NextResponse.redirect(publicUrl("/sign-in", request));
  const back = (query: string) => NextResponse.redirect(publicUrl(`/dashboard/integrations?${query}`, request));
  const stripe = stripeConnectFromEnv();
  if (!authEnabled() || !stripe) return back("stripe_error=not_configured");
  try {
    const link = await startStripeConnect(getPool(process.env.DATABASE_URL as string), tokenKey(), stripe.api, user, null, {
      returnUrl: publicUrl("/api/payments/stripe/return", request).toString(), refreshUrl: publicUrl("/api/payments/stripe/refresh", request).toString(),
    });
    return NextResponse.redirect(link);
  } catch (error) {
    // No account on file: the country check fails, which here means "start again from the dashboard".
    if (error instanceof StripeConnectError) return back(`stripe_error=${error.code === "country" ? "not_connected" : error.code}`);
    throw error;
  }
}
