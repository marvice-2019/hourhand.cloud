import type { HandlerResult, PaymentDeps } from "../booking";
import type { DataStore } from "../data/types";
import { publicPackage } from "../packages/packages";
import type { createRateLimiter } from "../rate-limit";
import { parseOfferInput, resolvePrice } from "./offers";

type Limiter = Pick<ReturnType<typeof createRateLimiter>, "take">;

/**
 * POST /api/offers/quote with { slug, event } or { packageId }, plus couponCode and/or payMinor: the price the guest would
 * pay, for the booking page to show before they pay. Writes nothing. Coupon tries are rate-limited like real ones, and
 * the first-session discount is never quoted (it would tell anyone whether an email has booked this host before);
 * it is applied when the order is made.
 */
export async function handleQuote(store: DataStore, deps: PaymentDeps | null, input: unknown, now: Date, limit?: { clientKey: string; limiter: Limiter }): Promise<HandlerResult> {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim().slice(0, 100) : "");
  if (!deps) return { status: 409, body: { error: "payments_unavailable" } };
  let target: { hostId: string; item: { kind: "event_type" | "package"; id: string; listMinor: number } } | null = null;
  if (str("packageId")) {
    const found = await publicPackage(deps.pool, str("packageId"));
    if (found) target = { hostId: found.host.id, item: { kind: "package", id: found.pkg.id, listMinor: found.pkg.priceMinor } };
  } else if (str("slug") && str("event")) {
    const found = await store.getPublicEventType(str("slug"), str("event"));
    if (found?.eventType.priceMinor != null) target = { hostId: found.host.id, item: { kind: "event_type", id: found.eventType.id, listMinor: found.eventType.priceMinor } };
  }
  if (!target) return { status: 404, body: { error: "not_found" } };
  const r = await resolvePrice(deps.pool, {
    hostId: target.hostId, plan: await deps.planFor(target.hostId), item: target.item, email: "", ...parseOfferInput(input),
    idempotencyKey: "quote", now, limit, reserve: false,
  });
  if (!r.ok) return { status: r.status, body: r.body };
  return { status: 200, body: { listMinor: r.listMinor, chargeMinor: r.chargeMinor, offer: r.offer, ...(r.couponNotUsed ? { couponNotUsed: true } : {}) } };
}
