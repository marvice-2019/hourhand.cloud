import type pg from "pg";
import type { HandlerResult, PaymentDeps } from "../booking";
import { isNamedError } from "../data/types";
import { BOOKING_LIMITS, CONFIRM_PAYMENT_LIMIT, type createRateLimiter } from "../rate-limit";
import {
  confirmOrder, orderPaymentRow, publicProduct, startOrder,
  type OrderStartError, type OrderVerifyError, type ProductInputError,
} from "./products";

type Limiter = Pick<ReturnType<typeof createRateLimiter>, "take">;

/** POST /api/products/[slug]/[product] with { name, email, idempotencyKey }: the order, and its Razorpay order if paid. */
export async function handleStartOrder(
  pool: pg.Pool | null, payments: PaymentDeps | null, slug: string, productSlug: string, input: unknown, now: Date,
  limit?: { clientKey: string; limiter: Limiter },
): Promise<HandlerResult> {
  if (!pool) return { status: 404, body: { error: "not_found" } };
  const found = await publicProduct(pool, slug, productSlug);
  if (!found) return { status: 404, body: { error: "not_found" } };
  const email = typeof (input as Record<string, unknown>)?.email === "string" ? ((input as Record<string, string>).email).trim().toLowerCase() : "";
  if (limit && (!limit.limiter.take(`product-ip:${limit.clientKey}`, BOOKING_LIMITS.perIp) || (email && !limit.limiter.take(`product-email:${email}`, BOOKING_LIMITS.perEmail)))) {
    return { status: 429, body: { error: "too_many_requests" } };
  }
  // A paid product needs a paid plan and an account that can take the money (the host's, or Hourhand's under B18).
  let auth = null;
  if (found.product.priceMinor > 0) {
    if (!payments || (await payments.planFor(found.host.id)) === "free") return { status: 409, body: { error: "payments_unavailable" } };
    auth = await (payments.collectFor ?? payments.authFor)(found.host.id);
    if (!auth) return { status: 409, body: { error: "payments_unavailable" } };
  }
  try {
    const r = await startOrder({ pool, auth, orders: auth && payments ? payments.ordersFor(auth) : null }, found, input, now);
    return { status: 200, body: { token: r.token, status: r.status, payment: r.payment && { provider: "razorpay", ...r.payment } } };
  } catch (err) {
    if (isNamedError<ProductInputError>(err, "ProductInputError")) return { status: 400, body: { error: "invalid_request", fields: err.fields } };
    if (isNamedError<OrderStartError>(err, "OrderStartError")) return err.message === "payments_unavailable"
      ? { status: 409, body: { error: "payments_unavailable" } } : { status: 502, body: { error: "payment_unavailable" } };
    throw err;
  }
}

/** POST /api/products/pay with { token, paymentId, signature } from Checkout: checked with Razorpay, then the order is paid. */
export async function handleConfirmOrder(payments: PaymentDeps | null, input: unknown, now: Date, limit?: { clientKey: string; limiter: Limiter }): Promise<HandlerResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200;
  const bad = ["token", "paymentId", "signature"].filter((k) => !ok(body[k]));
  if (bad.length > 0) return { status: 400, body: { error: "invalid_request", fields: Object.fromEntries(bad.map((k) => [k, "Required."])) } };
  if (limit && !limit.limiter.take(`confirm-product:${limit.clientKey}`, CONFIRM_PAYMENT_LIMIT)) return { status: 429, body: { error: "too_many_requests" } };
  if (!payments) return { status: 409, body: { error: "payments_unavailable" } };
  const row = await orderPaymentRow(payments.pool, body.token as string);
  if (!row) return { status: 404, body: { error: "not_found" } };
  // The account the order was made on: Hourhand's when it collected for the host (B18), else the host's own.
  const auth = row.collected_via === "platform" ? await (payments.platformAuth?.() ?? null) : await payments.authFor(row.host_id);
  if (!auth) return { status: 409, body: { error: "payments_unavailable" } };
  try {
    const status = await confirmOrder({ pool: payments.pool, auth, orders: payments.ordersFor(auth) },
      { token: body.token as string, paymentId: body.paymentId as string, signature: body.signature as string }, now);
    return { status: 200, body: { status } };
  } catch (err) {
    if (isNamedError<OrderVerifyError>(err, "OrderVerifyError")) return { status: 400, body: { error: err.reason } };
    throw err;
  }
}
