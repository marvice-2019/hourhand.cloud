import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:https";
import type pg from "pg";
import { seal, tokenKey, unseal } from "../crypto/seal";
import { NotFoundError } from "../data/types";
import { BOOKING_PAYLOAD_COLUMNS, BOOKING_PAYLOAD_FROM, bookingPayload } from "../api/booking-payload";
import { checkUrl, checkUrlShape, guardedLookup, type LookupAll } from "./guard";

// Outgoing booking webhooks (db/migrations/0069_booking_webhooks.sql). A host adds up to 5 HTTPS URLs on the
// Integrations page and picks which booking events each gets. Each change queues one delivery per endpoint inside the
// booking's own transaction; the job runner sends them, signed with the endpoint's key, with retries.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN = 60_000;

export const WEBHOOK_EVENTS = ["booking.created", "booking.cancelled", "booking.rescheduled", "question.received", "question.answered", "product.sold"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const MAX_ENDPOINTS = 5;
/** Waits after each failed attempt; after the last one the delivery is marked failed. */
export const RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360, 720, 1440] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;
export const TIMEOUT_MS = 10_000;
const BATCH = 20;
const LEASE_MINUTES = 2;

export interface WebhookEndpoint { id: string; url: string; events: WebhookEvent[]; active: boolean; lastStatus: number | null; lastError: string | null; lastDeliveryAt: Date | null; createdAt: Date }

const aad = (endpointId: string) => `webhook:${endpointId}`;

/** `Hourhand-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the scheme Stripe uses. */
export function signature(key: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
}

export async function listEndpoints(db: Db, hostId: string): Promise<WebhookEndpoint[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(
    "select id, url, events, active, last_status, last_error, last_delivery_at, created_at from webhook_endpoints where user_id = $1 order by created_at", [hostId]);
  return rows.map((r) => ({ id: r.id, url: r.url, events: r.events, active: r.active, lastStatus: r.last_status, lastError: r.last_error, lastDeliveryAt: r.last_delivery_at, createdAt: r.created_at }));
}

/** The signing key, for the host who owns the endpoint only. */
export async function endpointKey(db: Db, hostId: string, endpointId: string, key = tokenKey()): Promise<string> {
  if (!UUID.test(hostId) || !UUID.test(endpointId)) throw new NotFoundError("Webhook");
  const { rows: [r] } = await db.query("select secret_sealed from webhook_endpoints where id = $1 and user_id = $2", [endpointId, hostId]);
  if (!r) throw new NotFoundError("Webhook");
  return unseal<string>(key, r.secret_sealed, aad(endpointId));
}

export type AddResult = { ok: true; id: string } | { ok: false; error: "not_https" | "bad_url" | "private_address" | "no_events" | "too_many" };

export async function addEndpoint(db: Db, hostId: string, rawUrl: string, events: string[], opts: { key?: Buffer; lookup?: LookupAll } = {}): Promise<AddResult> {
  if (!UUID.test(hostId)) throw new NotFoundError("Host");
  const picked = WEBHOOK_EVENTS.filter((e) => events.includes(e));
  if (!picked.length) return { ok: false, error: "no_events" };
  const checked = await checkUrl(rawUrl, opts.lookup);
  if (!checked.ok) return { ok: false, error: checked.problem };
  const id = randomUUID();
  const signingKey = `whsec_${randomBytes(24).toString("hex")}`;
  const { rowCount } = await db.query(
    `insert into webhook_endpoints (id, user_id, url, secret_sealed, events)
     select $1, $2, $3, $4, $5 where (select count(*) from webhook_endpoints where user_id = $2) < ${MAX_ENDPOINTS}`,
    [id, hostId, checked.url, seal(opts.key ?? tokenKey(), signingKey, aad(id)), picked]);
  return rowCount ? { ok: true, id } : { ok: false, error: "too_many" };
}

export async function deleteEndpoint(db: Db, hostId: string, endpointId: string): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(endpointId)) throw new NotFoundError("Webhook");
  const { rowCount } = await db.query("delete from webhook_endpoints where id = $1 and user_id = $2", [endpointId, hostId]);
  if (!rowCount) throw new NotFoundError("Webhook");
}

/** A `ping` to one endpoint, sent at once by the runner, so the host can check their side. */
export async function queuePing(db: Db, hostId: string, endpointId: string, now: Date): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(endpointId)) throw new NotFoundError("Webhook");
  const id = randomUUID();
  const { rowCount } = await db.query(
    `insert into webhook_deliveries (id, endpoint_id, event, payload, dedupe_key, next_at)
     select $1::uuid, e.id, 'ping', $3, 'ping:' || $1::text, $4 from webhook_endpoints e where e.id = $2 and e.user_id = $5`,
    [id, endpointId, { event: "ping", id, created_at: now.toISOString(), data: { message: "Hourhand test delivery" } }, now, hostId]);
  if (!rowCount) throw new NotFoundError("Webhook");
}

const EVENT_FOR = { booked: "booking.created", cancelled: "booking.cancelled", rescheduled: "booking.rescheduled" } as const;

/**
 * Queues this booking change for each of the host's endpoints that wants it. Runs inside the booking's transaction (from
 * queueBookingNotifications). The payload is fixed now: a later edit to the booking doesn't change what was sent.
 */
export async function queueBookingWebhooks(db: Pick<pg.PoolClient, "query">, bookingId: string, change: keyof typeof EVENT_FOR, now: Date): Promise<void> {
  const event = EVENT_FOR[change];
  const { rows: [b] } = await db.query(
    `select ${BOOKING_PAYLOAD_COLUMNS} from ${BOOKING_PAYLOAD_FROM}
     where b.id = $1 and exists (select 1 from webhook_endpoints w where w.user_id = b.host_id and w.active and $2 = any(w.events))`,
    [bookingId, event]);
  if (!b) return;
  const data = bookingPayload(b);
  await db.query(
    `insert into webhook_deliveries (endpoint_id, booking_id, event, payload, dedupe_key, next_at)
     select w.id, $1::uuid, $2::text, jsonb_build_object('event', $2::text, 'id', gen_random_uuid(), 'created_at', $4::text, 'data', $3::jsonb),
       $1::text || ':' || $2::text, $5
     from webhook_endpoints w where w.user_id = $6 and w.active and $2::text = any(w.events)
     on conflict (endpoint_id, dedupe_key) do nothing`,
    [bookingId, event, JSON.stringify(data), now.toISOString(), now, b.host_id]);
}

export interface SendResult { status: number | null; error: string | null }
export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<SendResult>;

/** POSTs over HTTPS with the address guard at connect time, a 10-second limit, and no redirects followed. */
export const httpsSender: Sender = (url, body, headers) => new Promise((resolve) => {
  const shape = checkUrlShape(url);
  if (!shape.ok) return resolve({ status: null, error: shape.problem });
  const req = request(shape.url, {
    method: "POST", lookup: guardedLookup as never, timeout: TIMEOUT_MS,
    headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "Hourhand-Webhooks/1" },
  }, (res) => {
    res.resume();
    res.on("end", () => resolve({ status: res.statusCode ?? null, error: null }));
  });
  req.on("timeout", () => req.destroy(new Error("timed out after 10 seconds")));
  req.on("error", (e) => resolve({ status: null, error: e.message.slice(0, 200) }));
  req.end(body);
});

/** Sends what is due. Each run claims a batch with a short lease, so several servers never send the same delivery twice at once. */
export async function processWebhookDeliveries(pool: pg.Pool, now: Date, send: Sender = httpsSender, key = tokenKey()): Promise<{ sent: number; failed: number; retrying: number }> {
  const { rows } = await pool.query(
    `update webhook_deliveries d set attempts = d.attempts + 1, next_at = $1::timestamptz + make_interval(mins => ${LEASE_MINUTES})
     where d.id in (select id from webhook_deliveries where status = 'queued' and next_at <= $1 order by next_at limit ${BATCH} for update skip locked)
     returning d.id, d.endpoint_id, d.event, d.payload, d.attempts`, [now]);
  const result = { sent: 0, failed: 0, retrying: 0 };
  for (const d of rows) {
    const { rows: [e] } = await pool.query("select url, secret_sealed, active from webhook_endpoints where id = $1", [d.endpoint_id]);
    if (!e || !e.active) {
      await pool.query("update webhook_deliveries set status = 'failed', last_error = 'webhook removed or switched off' where id = $1", [d.id]);
      result.failed++;
      continue;
    }
    const body = JSON.stringify(d.payload);
    const at = new Date();
    const r = await send(e.url, body, {
      "Hourhand-Signature": signature(unseal<string>(key, e.secret_sealed, aad(d.endpoint_id)), body, at),
      "Hourhand-Event": d.event, "Hourhand-Delivery": d.id,
    });
    const ok = r.status !== null && r.status >= 200 && r.status < 300;
    const error = ok ? null : r.error ?? `HTTP ${r.status}`;
    if (ok) {
      await pool.query("update webhook_deliveries set status = 'sent', last_status = $2, last_error = null where id = $1", [d.id, r.status]);
      result.sent++;
    } else if (d.attempts >= MAX_ATTEMPTS) {
      await pool.query("update webhook_deliveries set status = 'failed', last_status = $2, last_error = $3 where id = $1", [d.id, r.status, error]);
      result.failed++;
    } else {
      await pool.query("update webhook_deliveries set next_at = $2, last_status = $3, last_error = $4 where id = $1",
        [d.id, new Date(now.getTime() + RETRY_DELAYS_MINUTES[d.attempts - 1] * MIN), r.status, error]);
      result.retrying++;
    }
    await pool.query("update webhook_endpoints set last_status = $2, last_error = $3, last_delivery_at = $4 where id = $1", [d.endpoint_id, r.status, error, at]);
  }
  return result;
}

/** The non-booking events (B23): a paid or free question and a digital product sale. */
export type SaleWebhookEvent = "question.received" | "question.answered" | "product.sold";

/**
 * Queues a question or product event for each of the host's endpoints that wants it. Runs inside the transaction that
 * made the change, so nothing is sent for a change that rolled back; the dedupe key makes a repeat a no-op.
 */
export async function queueSaleWebhook(db: Pick<pg.PoolClient, "query">, hostId: string, event: SaleWebhookEvent, refId: string, data: Record<string, unknown>, now: Date): Promise<void> {
  await db.query(
    `insert into webhook_deliveries (endpoint_id, event, payload, dedupe_key, next_at)
     select w.id, $2::text, jsonb_build_object('event', $2::text, 'id', gen_random_uuid(), 'created_at', $4::text, 'data', $3::jsonb),
       $5::text || ':' || $2::text, $6
     from webhook_endpoints w where w.user_id = $1 and w.active and $2::text = any(w.events)
     on conflict (endpoint_id, dedupe_key) do nothing`,
    [hostId, event, JSON.stringify(data), now.toISOString(), refId, now]);
}
