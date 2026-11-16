import { timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { SmsConfig } from "./config";

// MSG91 delivery reports ("Webhook (New)", event On Report Received; msg91.com/help, read 2026-11-15). MSG91 doesn't
// sign its webhooks; it can only send static custom headers. So the webhook is set up with a header
// x-hourhand-secret: <MSG91_WEBHOOK_SECRET> (or, if a header can't be added, ?secret= on the URL), compared in
// constant time. Anything without it is refused.

type Result = { status: number; body: Record<string, unknown> };

/** MSG91 report codes. 1 delivered; 2 failed; 9 NDNC; 16 and 25 rejected; 17 blocked number; 20 country blocked. */
const DELIVERED = 1;
/** The number's owner has blocked commercial texts: no more texts to it from any host. */
const OPT_OUT = new Set([9, 17]);
const FAILED = new Set([2, 9, 16, 17, 20, 25]);

export function checkSecret(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DeliveryReport { requestId: string; number: string | null; status: number; reason: string | null; at: Date | null }

/** The reports in one webhook body: one object or a list, with MSG91's field names. Anything unreadable is left out. */
export function parseReports(payload: unknown): DeliveryReport[] {
  const list = Array.isArray(payload) ? payload : [payload];
  const out: DeliveryReport[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const requestId = typeof r.requestId === "string" ? r.requestId : null;
    const status = Number(r.status);
    if (!requestId || !Number.isInteger(status)) continue;
    const at = typeof r.deliveryTime === "string" || typeof r.deliveryTime === "number" ? new Date(r.deliveryTime) : null;
    out.push({
      requestId, status,
      number: typeof r.telNum === "string" || typeof r.telNum === "number" ? String(r.telNum).replace(/\D/g, "") : null,
      reason: typeof r.failureReason === "string" && r.failureReason ? r.failureReason.slice(0, 200) : null,
      at: at && !Number.isNaN(at.getTime()) ? at : null,
    });
  }
  return out;
}

/** A delivery report: delivered stamps the row; a failure marks it failed; a DND/blocked number is opted out for good. */
export async function handleSmsWebhook(pool: pg.Pool, cfg: SmsConfig | null, raw: string, secret: string | null, now = new Date()): Promise<Result> {
  if (!cfg) return { status: 503, body: { error: "not_configured" } };
  if (!checkSecret(cfg.webhookSecret, secret)) return { status: 401, body: { error: "bad_secret" } };
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "bad_body" } };
  }
  const reports = parseReports((payload as { data?: unknown })?.data ?? payload);
  for (const r of reports) {
    if (r.status === DELIVERED) {
      await pool.query("update notifications set delivered_at = $2, updated_at = $3 where channel = 'sms' and provider_message_id = $1",
        [r.requestId, r.at ?? now, now]);
    } else if (FAILED.has(r.status)) {
      const { rows } = await pool.query(
        `update notifications set status = 'failed', last_error = $2, updated_at = $3 where channel = 'sms' and provider_message_id = $1
         returning recipient`, [r.requestId, `SMS delivery failed (MSG91 status ${r.status}${r.reason ? `: ${r.reason}` : ""})`.slice(0, 500), now]);
      const phone = rows[0]?.recipient ?? r.number;
      if (OPT_OUT.has(r.status) && phone) {
        await pool.query("insert into sms_opt_outs (phone, source) values ($1, 'dlt') on conflict (phone) do nothing", [phone]);
        await pool.query("update notifications set status = 'skipped', last_error = 'number is blocked for texts (DLT opt-out)', updated_at = $2 where channel = 'sms' and recipient = $1 and status = 'queued'", [phone, now]);
      }
    }
  }
  return { status: 200, body: { ok: true, reports: reports.length } };
}
