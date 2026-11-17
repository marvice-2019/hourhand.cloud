import { randomBytes } from "node:crypto";
import type pg from "pg";
import { verifyRazorpaySignature } from "../billing/webhooks";
import { seal, unseal } from "../crypto/seal";
import { receiveMembershipEvent } from "./memberships";
import { parseRazorpayMembershipEvent } from "./provider";

// Each host's Razorpay sends subscription events for their members to /api/webhooks/memberships/<host id>, signed with
// a secret Hourhand generated for that host (the host pastes it into Razorpay → Settings → Webhooks). The signature is
// the only thing that makes an event count: credits are never granted from a browser redirect.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const aad = (userId: string) => `membership-webhook:${userId}`;

/** The Razorpay events to tick when adding the webhook. */
export const WEBHOOK_EVENTS = [
  "subscription.authenticated", "subscription.activated", "subscription.charged", "subscription.pending",
  "subscription.halted", "subscription.cancelled", "subscription.completed", "subscription.paused", "subscription.resumed",
  // A discounted first month is paid upfront when the client authenticates; its paid invoice is how that payment arrives.
  "invoice.paid",
] as const;

export const webhookPath = (hostId: string) => `/api/webhooks/memberships/${hostId}`;

/** The host's webhook secret, made on first use. */
export async function webhookSecret(db: Db, key: Buffer, hostId: string): Promise<string> {
  const fresh = randomBytes(24).toString("hex");
  await db.query("insert into membership_webhook_secrets (user_id, secret_encrypted) values ($1, $2) on conflict (user_id) do nothing",
    [hostId, seal(key, fresh, aad(hostId))]);
  const { rows: [r] } = await db.query("select secret_encrypted from membership_webhook_secrets where user_id = $1", [hostId]);
  return unseal<string>(key, r.secret_encrypted, aad(hostId));
}

async function storedSecret(db: Db, key: Buffer, hostId: string): Promise<string | null> {
  const { rows: [r] } = await db.query("select secret_encrypted from membership_webhook_secrets where user_id = $1", [hostId]);
  return r ? unseal<string>(key, r.secret_encrypted, aad(hostId)) : null;
}

/** Whether the host's webhook has delivered anything yet: the dashboard's "connected" check. */
export async function webhookLastSeen(db: Db, hostId: string): Promise<Date | null> {
  const { rows: [r] } = await db.query("select max(received_at) as at from membership_events where host_id = $1", [hostId]);
  return (r?.at as Date | null) ?? null;
}

/**
 * POST /api/webhooks/memberships/[hostId]. 200 once handled (or ignored), 400 for a bad signature or body, 404 for a
 * host with no webhook secret, and 500 when applying fails so Razorpay delivers it again.
 */
export async function handleMembershipWebhook(
  pool: pg.Pool, key: Buffer, hostId: string, raw: string, headers: Headers, now: Date,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!UUID.test(hostId)) return { status: 404, body: { error: "not_found" } };
  const secret = await storedSecret(pool, key, hostId);
  if (!secret) return { status: 404, body: { error: "not_found" } };
  if (!verifyRazorpaySignature(raw, headers.get("x-razorpay-signature"), secret)) return { status: 400, body: { error: "bad_signature" } };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "bad_body" } };
  }
  const event = parseRazorpayMembershipEvent(body, headers.get("x-razorpay-event-id"), now);
  if (!event) return { status: 400, body: { error: "bad_body" } };
  try {
    const outcome = await receiveMembershipEvent(pool, hostId, event, String(body.event), now);
    return { status: 200, body: { ok: true, outcome } };
  } catch (error) {
    console.error(`[memberships] webhook ${event.eventId} (${String(body.event)}) for host ${hostId} failed; Razorpay will retry`, error);
    return { status: 500, body: { error: "apply_failed" } };
  }
}
