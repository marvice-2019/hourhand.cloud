import type pg from "pg";
import type { HandlerResult } from "../booking";
import { LIMITS, type Plan } from "../billing/plans";
import { isNamedError } from "../data/types";
import type { HostRazorpayAuth } from "../payments/host-razorpay";
import { parseOfferInput, type OfferRefusedError } from "../offers/offers";
import { BOOKING_LIMITS, type createRateLimiter } from "../rate-limit";
import { cancelMembership, publicMembershipPlan, startMembership, type MembershipProviderError } from "./memberships";
import type { MembershipProvider } from "./provider";

type Limiter = Pick<ReturnType<typeof createRateLimiter>, "take">;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How the membership routes reach a host's payment account. Razorpay today; a Stripe provider can sit behind providerFor. */
export interface MembershipDeps {
  pool: pg.Pool;
  authFor(hostId: string): Promise<HostRazorpayAuth | null>;
  providerFor(auth: HostRazorpayAuth): MembershipProvider;
  planFor(hostId: string): Promise<Plan>;
}

/** Whether the host's Hourhand plan includes memberships (Solo and Duo; not Free). */
export const membershipsAllowed = (plan: Plan) => LIMITS[plan].memberships;

/**
 * POST /api/memberships/[planId]/join with { name, email, phone?, idempotencyKey, couponCode? }: a membership and its
 * subscription. A code or campaign takes money off the first month only.
 */
export async function handleJoin(deps: MembershipDeps | null, planId: string, input: unknown, limit?: { clientKey: string; limiter: Limiter }): Promise<HandlerResult> {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const name = str("name"), email = str("email"), phone = str("phone"), idempotencyKey = str("idempotencyKey");
  const fields: Record<string, string> = {};
  if (name.length < 1 || name.length > 100) fields.name = "Enter your name (up to 100 characters).";
  if (!EMAIL.test(email) || email.length > 254) fields.email = "Enter a valid email address.";
  if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) fields.phone = "Enter a phone number with country code, like +91 98765 43210.";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 100) fields.idempotencyKey = "Missing request key.";
  if (Object.keys(fields).length > 0) return { status: 400, body: { error: "invalid_request", fields } };

  if (!deps) return { status: 409, body: { error: "payments_unavailable" } };
  const found = await publicMembershipPlan(deps.pool, planId);
  if (!found) return { status: 404, body: { error: "not_found" } };
  // New members need the host on a plan that includes memberships, and their payment account connected.
  const hostPlan = await deps.planFor(found.host.id);
  const auth = membershipsAllowed(hostPlan) ? await deps.authFor(found.host.id) : null;
  if (!auth) return { status: 409, body: { error: "payments_unavailable" } };
  if (limit && (!limit.limiter.take(`join-ip:${limit.clientKey}`, BOOKING_LIMITS.perIp) || !limit.limiter.take(`join-email:${email.toLowerCase()}`, BOOKING_LIMITS.perEmail))) {
    return { status: 429, body: { error: "too_many_requests" } };
  }
  try {
    const offers = { plan: hostPlan, couponCode: parseOfferInput(input).couponCode, now: new Date(), ...(limit ? { limit } : {}) };
    const r = await startMembership({ pool: deps.pool, provider: deps.providerFor(auth) }, { planId, name, email, phone: phone || null, idempotencyKey }, offers);
    return { status: 200, body: r };
  } catch (err) {
    if (isNamedError(err, "NotFoundError")) return { status: 404, body: { error: "not_found" } };
    if (isNamedError<MembershipProviderError>(err, "MembershipProviderError")) return { status: 502, body: { error: "payment_unavailable" } };
    if (isNamedError<OfferRefusedError>(err, "OfferRefusedError")) return { status: err.status, body: err.body };
    throw err;
  }
}

/** POST /api/memberships/cancel with { token }: stops renewal at the end of the paid month. Repeating it is fine. */
export async function handleCancelMembership(deps: MembershipDeps | null, input: unknown, now: Date): Promise<HandlerResult> {
  const token = (input as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.length > 100) return { status: 400, body: { error: "invalid_request", fields: { token: "Required." } } };
  if (!deps) return { status: 409, body: { error: "payments_unavailable" } };
  const { rows: [m] } = await deps.pool.query("select host_id from memberships where token = $1", [token]);
  if (!m) return { status: 404, body: { error: "not_found" } };
  // Cancelling never depends on the host's Hourhand plan: a client can always stop paying.
  const auth = await deps.authFor(m.host_id);
  if (!auth) return { status: 409, body: { error: "payments_unavailable" } };
  try {
    const status = await cancelMembership({ pool: deps.pool, provider: deps.providerFor(auth) }, token, now);
    return { status: 200, body: { status } };
  } catch (err) {
    if (isNamedError(err, "NotFoundError")) return { status: 404, body: { error: "not_found" } };
    if (isNamedError<MembershipProviderError>(err, "MembershipProviderError")) return { status: 502, body: { error: "provider_unavailable" } };
    throw err;
  }
}
