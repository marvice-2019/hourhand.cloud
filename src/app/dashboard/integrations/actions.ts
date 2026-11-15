"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { requireUser } from "@/lib/auth/session";
import { tokenKey } from "@/lib/crypto/seal";
import { getPool } from "@/lib/data/pg-store";
import { disconnectRazorpay, RazorpayKeyError, razorpayVerifier, saveRazorpayKeys } from "@/lib/payments/host-razorpay";
import { disconnectStripe, startStripeConnect, StripeConnectError, stripeConnectFromEnv } from "@/lib/payments/stripe-connect";

// Each action checks the session itself and only touches the signed-in host's own keys. The key fields are never logged.

const pool = () => getPool(process.env.DATABASE_URL as string);
const text = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v.trim() : "");

/** Runs a change and sends the host back to the page with its outcome. redirect() must stay outside the try. */
async function run(change: () => Promise<void>, done: string): Promise<never> {
  let target = `/dashboard/integrations?${done}=1`;
  try {
    await change();
  } catch (error) {
    if (error instanceof RazorpayKeyError) target = `/dashboard/integrations?error=${error.code}`;
    else if (error instanceof StripeConnectError) target = `/dashboard/integrations?stripe_error=${error.code}`;
    else if (error instanceof Error && error.message.startsWith("TOKEN_ENCRYPTION_KEY")) target = "/dashboard/integrations?error=not_configured";
    else throw error;
  }
  revalidatePath("/dashboard/integrations");
  redirect(target);
}

export async function connectRazorpay(form: FormData): Promise<void> {
  const user = await requireUser();
  if (!authEnabled()) redirect("/dashboard/integrations?error=demo");
  const keyId = text(form.get("keyId"));
  const keyPassword = text(form.get("keySecret"));
  await run(() => saveRazorpayKeys(pool(), tokenKey(), user.id, keyId, keyPassword, razorpayVerifier()).then(() => undefined), "connected");
}

export async function disconnectRazorpayAction(): Promise<void> {
  const user = await requireUser();
  if (!authEnabled()) redirect("/dashboard/integrations?error=demo");
  await run(() => disconnectRazorpay(pool(), user.id), "disconnected");
}

/** This site's public address, for the URLs Stripe sends the host back to. */
async function siteBase(): Promise<string> {
  const configured = resolveBaseUrl();
  if (configured) return configured.replace(/\/+$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
}

/**
 * "Connect Stripe" and "Continue setup": creates the host's connected account on first use, then sends them to Stripe's
 * hosted onboarding. The link is single-use and only ever handed to the signed-in host's own browser.
 */
export async function connectStripe(form: FormData): Promise<void> {
  const user = await requireUser();
  if (!authEnabled()) redirect("/dashboard/integrations?stripe_error=demo");
  const stripe = stripeConnectFromEnv();
  if (!stripe) redirect("/dashboard/integrations?stripe_error=not_configured");
  const base = await siteBase();
  let target = "/dashboard/integrations?stripe_error=unreachable";
  try {
    target = await startStripeConnect(pool(), tokenKey(), stripe.api, user, text(form.get("country")) || null, {
      returnUrl: `${base}/api/payments/stripe/return`, refreshUrl: `${base}/api/payments/stripe/refresh`,
    });
  } catch (error) {
    if (error instanceof StripeConnectError) target = `/dashboard/integrations?stripe_error=${error.code}`;
    else if (error instanceof Error && error.message.startsWith("TOKEN_ENCRYPTION_KEY")) target = "/dashboard/integrations?stripe_error=not_configured";
    else throw error;
  }
  redirect(target);
}

export async function disconnectStripeAction(): Promise<void> {
  const user = await requireUser();
  if (!authEnabled()) redirect("/dashboard/integrations?stripe_error=demo");
  await run(() => disconnectStripe(pool(), user.id), "stripe_disconnected");
}
