import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { markZoomDisconnected } from "./connection";

// Zoom's event notifications for the app: the endpoint URL check, and `app_deauthorized` when a host removes Hourhand
// from their Zoom account. Every request is signed with the app's secret token (ZOOM_WEBHOOK_SECRET).
// Docs (checked 2026-11-15): https://developers.zoom.us/docs/api/webhooks/ (signature and URL validation),
// https://developers.zoom.us/docs/api/marketplace/events/ (app_deauthorized payload).

/** Zoom requests older than this are refused, so a captured request can't be replayed later. */
const MAX_AGE_SECONDS = 300;

export type WebhookReply = { status: number; body: Record<string, unknown> };

const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

/** Checks `x-zm-signature` = "v0=" + HMAC-SHA256(secret, "v0:{x-zm-request-timestamp}:{body}"), and that it's recent. */
export function verifyZoomSignature(secret: string, body: string, timestamp: string | null, signature: string | null, now = new Date()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  // Zoom sends seconds; accept milliseconds too.
  const ts = Number(timestamp) > 1e12 ? Number(timestamp) / 1000 : Number(timestamp);
  if (Math.abs(now.getTime() / 1000 - ts) > MAX_AGE_SECONDS) return false;
  const expected = Buffer.from(`v0=${hmac(secret, `v0:${timestamp}:${body}`)}`);
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function handleZoomWebhook(
  db: Pick<pg.Pool, "query">, secret: string, body: string, headers: { timestamp: string | null; signature: string | null }, now = new Date(),
): Promise<WebhookReply> {
  if (!verifyZoomSignature(secret, body, headers.timestamp, headers.signature, now)) return { status: 401, body: { error: "bad_signature" } };
  let event: { event?: string; payload?: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "bad_json" } };
  }
  if (event.event === "endpoint.url_validation") {
    const plainToken = String(event.payload?.plainToken ?? "");
    return { status: 200, body: { plainToken, encryptedToken: hmac(secret, plainToken) } };
  }
  if (event.event !== "app_deauthorized") return { status: 200, body: { ignored: event.event ?? null } };

  const p = event.payload ?? {};
  const zoomUserId = typeof p.user_id === "string" ? p.user_id : null;
  if (!zoomUserId) return { status: 200, body: { ignored: "no user" } };
  // Zoom retries until it gets a 2xx; the per-deauthorization signature (or user + time) makes a retry a no-op.
  const externalId = String(p.signature ?? `${zoomUserId}:${p.deauthorization_time ?? ""}`);
  const fresh = await db.query(
    "insert into webhook_events (provider, external_id, payload, processed_at) values ('zoom', $1, $2, $3) on conflict (provider, external_id) do nothing",
    [externalId, JSON.stringify(event), now]);
  if (!fresh.rowCount) return { status: 200, body: { duplicate: true } };
  const { rows } = await db.query("select id from integrations where provider = 'zoom' and public_id = $1 and status = 'ok'", [zoomUserId]);
  for (const r of rows) await markZoomDisconnected(db, r.id, "Hourhand was removed from your Zoom account", now);
  return { status: 200, body: { disconnected: rows.length } };
}
