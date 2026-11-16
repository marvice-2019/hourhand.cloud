import type pg from "pg";
import { BillingApiError } from "../billing/providers";
import { verifyStripeSignature } from "../billing/webhooks";
import { settleStripeSession, type StripeDeps } from "./stripe-checkout";
import { hostForStripeAccount, refreshStripeAccount, type StripeConnectApi } from "./stripe-connect";

// The "Connected accounts" webhook endpoint: events from hosts' own Stripe accounts (their Checkout Sessions, their
// account changes). Each delivery is checked against this endpoint's own signing secret, recorded once by event id,
// and never trusted for state: the session or account is read back from Stripe as that account before anything changes.
// https://docs.stripe.com/connect/webhooks.md?accounts-namespace=v2 (direct-charge events use the Connected accounts scope)

const PROVIDER = "stripe_connect";

export type ConnectEventOutcome = "processed" | "duplicate" | "ignored";

const SESSION_EVENTS = new Set([
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired",
]);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

export interface ConnectWebhookDeps { stripe: StripeDeps; connect: StripeConnectApi; key: Buffer }

/** Acts on one verified event. Errors propagate so the route answers 500 and Stripe retries. */
async function act(deps: ConnectWebhookDeps, type: string, account: string, object: Json, now: Date): Promise<boolean> {
  if (SESSION_EVENTS.has(type)) {
    const outcome = await settleStripeSession(deps.stripe, String(object.id ?? ""), now, account);
    return outcome !== "unknown";
  }
  if (type === "account.updated") {
    const hostId = await hostForStripeAccount(deps.stripe.pool, account);
    if (!hostId) return false;
    await refreshStripeAccount(deps.stripe.pool, deps.key, deps.connect, hostId);
    return true;
  }
  if (type === "account.application.deauthorized") {
    // The host removed Hourhand from their Stripe account. Mark it so no new payment starts; refunds already due will
    // record "Stripe disconnected" and the host settles them in their own Dashboard.
    const { rowCount } = await deps.stripe.pool.query(
      "update integrations set status = 'disconnected', updated_at = $2 where provider = 'stripe' and public_id = $1", [account, now]);
    return Boolean(rowCount);
  }
  return false;
}

export async function handleConnectEvent(deps: ConnectWebhookDeps, body: Json, now = new Date()): Promise<ConnectEventOutcome> {
  const pool: pg.Pool = deps.stripe.pool;
  const eventId = typeof body.id === "string" ? body.id : "";
  const type = typeof body.type === "string" ? body.type : "";
  const account = typeof body.account === "string" ? body.account : "";
  const ins = await pool.query<{ processed_at: Date | null }>(
    `insert into webhook_events (provider, external_id, payload) values ($1, $2, $3)
     on conflict (provider, external_id) do update set provider = excluded.provider returning processed_at`,
    [PROVIDER, eventId, JSON.stringify(body)]);
  if (ins.rows[0]?.processed_at) return "duplicate";
  const done = (error: string | null) =>
    pool.query("update webhook_events set processed_at = $3, error = $4 where provider = $1 and external_id = $2", [PROVIDER, eventId, now, error]);
  try {
    // Only events from a connected account concern this endpoint.
    const acted = account ? await act(deps, type, account, obj(obj(body.data).object), now) : false;
    await done(null);
    return acted ? "processed" : "ignored";
  } catch (error) {
    const message = String((error as Error).message).slice(0, 500);
    if (error instanceof BillingApiError && !error.retryable && error.status !== null && error.status >= 400 && error.status < 500) {
      // Retrying can't help (say, a test-mode event reaching a live key): keep the error, stop the retries.
      await done(message);
      console.warn(`[payments] Stripe Connect event ${eventId} (${type}) dropped: ${message}`);
      return "ignored";
    }
    await pool.query("update webhook_events set error = $3 where provider = $1 and external_id = $2", [PROVIDER, eventId, message]);
    throw error;
  }
}

/** The raw-body part of the route: signature first, then a minimal shape check. */
export function parseConnectDelivery(raw: string, signature: string | null, secret: string, now = new Date()):
  { ok: true; body: Json } | { ok: false; status: 400; error: "bad_signature" | "bad_body" } {
  if (!verifyStripeSignature(raw, signature, secret, now)) return { ok: false, status: 400, error: "bad_signature" };
  let body: Json;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "bad_body" };
  }
  if (typeof body.id !== "string" || !body.id || typeof body.type !== "string") return { ok: false, status: 400, error: "bad_body" };
  return { ok: true, body };
}
