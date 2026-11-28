import type pg from "pg";
import type { HandlerResult, PaymentDeps } from "../booking";
import { isNamedError } from "../data/types";
import { BOOKING_LIMITS, CONFIRM_PAYMENT_LIMIT, type createRateLimiter } from "../rate-limit";
import {
  confirmQuestion, publicOffer, questionPaymentRow, startQuestion,
  type QuestionInputError, type QuestionStartError, type QuestionVerifyError,
} from "./questions";

type Limiter = Pick<ReturnType<typeof createRateLimiter>, "take">;

/** POST /api/questions/[slug] with { name, email, question, idempotencyKey }: the question, and its Razorpay order if paid. */
export async function handleStartQuestion(
  pool: pg.Pool | null, payments: PaymentDeps | null, slug: string, input: unknown, now: Date, limit?: { clientKey: string; limiter: Limiter },
): Promise<HandlerResult> {
  if (!pool) return { status: 404, body: { error: "not_found" } };
  const found = await publicOffer(pool, slug);
  if (!found) return { status: 404, body: { error: "not_found" } };
  const email = typeof (input as Record<string, unknown>)?.email === "string" ? ((input as Record<string, string>).email).trim().toLowerCase() : "";
  if (limit && (!limit.limiter.take(`question-ip:${limit.clientKey}`, BOOKING_LIMITS.perIp) || (email && !limit.limiter.take(`question-email:${email}`, BOOKING_LIMITS.perEmail)))) {
    return { status: 429, body: { error: "too_many_requests" } };
  }
  // A paid question needs a paid plan and an account that can take the money (the host's, or Hourhand's under B18).
  let auth = null;
  if (found.offer.priceMinor > 0) {
    if (!payments || (await payments.planFor(found.host.id)) === "free") return { status: 409, body: { error: "payments_unavailable" } };
    auth = await (payments.collectFor ?? payments.authFor)(found.host.id);
    if (!auth) return { status: 409, body: { error: "payments_unavailable" } };
  }
  try {
    const r = await startQuestion({ pool, auth, orders: auth && payments ? payments.ordersFor(auth) : null }, found, input, now);
    return { status: 200, body: { token: r.token, status: r.status, payment: r.payment && { provider: "razorpay", ...r.payment } } };
  } catch (err) {
    if (isNamedError<QuestionInputError>(err, "QuestionInputError")) return { status: 400, body: { error: "invalid_request", fields: err.fields } };
    if (isNamedError<QuestionStartError>(err, "QuestionStartError")) return err.message === "payments_unavailable"
      ? { status: 409, body: { error: "payments_unavailable" } } : { status: 502, body: { error: "payment_unavailable" } };
    throw err;
  }
}

/** POST /api/questions/pay with { token, paymentId, signature } from Checkout: checked with Razorpay, then the question opens. */
export async function handleConfirmQuestion(payments: PaymentDeps | null, input: unknown, now: Date, limit?: { clientKey: string; limiter: Limiter }): Promise<HandlerResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200;
  const bad = ["token", "paymentId", "signature"].filter((k) => !ok(body[k]));
  if (bad.length > 0) return { status: 400, body: { error: "invalid_request", fields: Object.fromEntries(bad.map((k) => [k, "Required."])) } };
  if (limit && !limit.limiter.take(`confirm-question:${limit.clientKey}`, CONFIRM_PAYMENT_LIMIT)) return { status: 429, body: { error: "too_many_requests" } };
  if (!payments) return { status: 409, body: { error: "payments_unavailable" } };
  const row = await questionPaymentRow(payments.pool, body.token as string);
  if (!row) return { status: 404, body: { error: "not_found" } };
  // The account the order was made on: Hourhand's when it collected for the host (B18), else the host's own.
  const auth = row.collected_via === "platform" ? await (payments.platformAuth?.() ?? null) : await payments.authFor(row.host_id);
  if (!auth) return { status: 409, body: { error: "payments_unavailable" } };
  try {
    const status = await confirmQuestion({ pool: payments.pool, auth, orders: payments.ordersFor(auth) },
      { token: body.token as string, paymentId: body.paymentId as string, signature: body.signature as string }, now);
    return { status: 200, body: { status } };
  } catch (err) {
    if (isNamedError<QuestionVerifyError>(err, "QuestionVerifyError")) return { status: 400, body: { error: err.reason } };
    throw err;
  }
}
