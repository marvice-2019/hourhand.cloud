import { resolveBaseUrl } from "../auth/auth";
import { calendarConfigError, calendarDeps } from "../calendar/env";
import { pushAddress } from "../calendar/push";
import { tokenKey } from "../crypto/seal";
import { getPool } from "../data/pg-store";
import { createMailer } from "../mail/mailer";
import type { PaymentCheckDeps } from "../payments/booking-payments";
import { loadHostRazorpay } from "../payments/host-razorpay";
import { razorpayOrders } from "../payments/razorpay-orders";
import { stripeCheckoutFromEnv, stripeDepsFor, type StripeDeps } from "../payments/stripe-checkout";
import { systemResolver } from "../domains/dns";
import { traefikFromEnv } from "../domains/traefik";
import { startJobRunner, type JobRunner } from "./runner";

const shared = globalThis as typeof globalThis & { __hourhandJobs?: JobRunner };

/** Starts the job runner once per server process, from the environment. Throws when email or the URL isn't configured. */
export function startJobsFromEnv(env: Record<string, string | undefined> = process.env): void {
  if (shared.__hourhandJobs) return;
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for the job runner");
  const mailer = createMailer(env);
  const baseUrl = (resolveBaseUrl(env) ?? "http://localhost:3000").replace(/\/+$/, "");
  // Calendars (Google, Microsoft) are optional; when one is configured, a missing or bad TOKEN_ENCRYPTION_KEY stops the server here.
  const configError = calendarConfigError(env);
  if (configError) throw new Error(configError);
  const deps = calendarDeps(env);
  const calendar = deps && { ...deps, pushAddress: pushAddress(baseUrl, env) };
  const pool = getPool(env.DATABASE_URL);
  // Hosts' Razorpay keys are sealed with TOKEN_ENCRYPTION_KEY; without it no paid booking can exist, so there's nothing to check.
  let payments: PaymentCheckDeps | null = null;
  let stripe: StripeDeps | null = null;
  try {
    const key = tokenKey();
    payments = { authFor: (hostId) => loadHostRazorpay(pool, key, hostId), ordersFor: (auth) => razorpayOrders(auth) };
    const stripeApi = stripeCheckoutFromEnv(env);
    stripe = stripeApi && stripeDepsFor(pool, key, stripeApi);
  } catch {
    payments = null;
  }
  const traefik = traefikFromEnv(env);
  if (!traefik.ok) console.info(`[jobs] ${traefik.reason} Hosts see that on the Custom domain page.`);
  shared.__hourhandJobs = startJobRunner({ pool, mailer, baseUrl, calendar, payments, stripe, domains: { resolver: systemResolver(), traefik } });
  console.info(`[jobs] runner started (${env.RESEND_API_KEY ? "Resend" : "log only"}, calendars ${calendar ? `${Object.keys(calendar.providers).join(" + ")} on${calendar.providers.google ? `, Google ${calendar.pushAddress ? "instant" : "polling"}` : ""}` : "off"}, booking payments ${payments ? "on" : "off"}, Stripe ${stripe ? "on" : "off"})`);
}
