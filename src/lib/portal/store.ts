import type pg from "pg";
import { LINK_TTL_MS, parseLink, randomId, SESSION_TTL_MS, sha256, signLink, verifyLink } from "./tokens";

// Everything the client portal reads or writes in Postgres. Every query is filtered by BOTH the host id and the client's
// email (citext, so any case): a session for one host and email can never reach another client's or host's rows.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalEmail = (email: string) => email.trim().toLowerCase();
export const isEmail = (email: string) => EMAIL.test(email) && email.length <= 254;
const ok = (hostId: string, email: string) => UUID.test(hostId) && isEmail(email);

/** Whether this email has ever booked with, or bought a package from, this host. Lapsed payment holds don't count. */
export async function isClient(db: Db, hostId: string, email: string): Promise<boolean> {
  if (!ok(hostId, email)) return false;
  const { rows: [r] } = await db.query(
    `select exists (select 1 from invitees i join bookings b on b.id = i.booking_id
                    where i.host_id = $1 and b.host_id = $1 and i.email = $2 and b.status not in ('pending_payment', 'pending_approval') and coalesce(b.cancelled_by, '') <> 'system')
         or exists (select 1 from package_purchases p where p.host_id = $1 and p.guest_email = $2 and p.status = 'paid') as found`,
    [hostId, normalEmail(email)]);
  return r.found === true;
}

/** Stores a new single-use link for this host and email and returns its token. Old expired links are cleared on the way. */
export async function issueLink(db: Db, key: Buffer, hostId: string, email: string, now: Date): Promise<string> {
  const claims = { hostId, email: normalEmail(email), expiresAt: new Date(now.getTime() + LINK_TTL_MS) };
  const { token, nonceHash } = signLink(key, claims);
  await db.query("delete from portal_links where expires_at < $1", [new Date(now.getTime() - 86_400_000)]);
  await db.query("insert into portal_links (nonce_hash, host_id, email, expires_at) values ($1, $2, $3, $4)",
    [nonceHash, claims.hostId, claims.email, claims.expiresAt]);
  return token;
}

export type ConsumeResult = { ok: true; hostId: string; email: string } | { ok: false; reason: "malformed" | "unknown" | "bad_signature" | "expired" | "used" | "wrong_host" };

/**
 * Opens a link once. The signature is checked against what was stored, then one update marks it used: of two requests
 * racing with the same link, only one gets a row back. `hostId` is the portal the link was opened on; a link for
 * another host's portal is refused (and not used up).
 */
export async function consumeLink(db: Db, key: Buffer, token: unknown, hostId: string, now: Date): Promise<ConsumeResult> {
  const parsed = parseLink(token);
  if (!parsed) return { ok: false, reason: "malformed" };
  const nonceHash = sha256(parsed.nonce);
  const { rows: [row] } = await db.query("select host_id, email, expires_at, used_at from portal_links where nonce_hash = $1", [nonceHash]);
  if (!row) return { ok: false, reason: "unknown" };
  const claims = { hostId: row.host_id as string, email: String(row.email), expiresAt: row.expires_at as Date };
  if (!verifyLink(key, parsed.nonce, parsed.sig, claims)) return { ok: false, reason: "bad_signature" };
  if (claims.hostId !== hostId) return { ok: false, reason: "wrong_host" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (claims.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  const { rowCount } = await db.query(
    "update portal_links set used_at = $2 where nonce_hash = $1 and used_at is null and expires_at > $2", [nonceHash, now]);
  if (!rowCount) return { ok: false, reason: "used" };
  return { ok: true, hostId: claims.hostId, email: claims.email };
}

/** A 30-day session for this host and email. Returns the raw id for the cookie; only its hash is stored. */
export async function createSession(db: Db, hostId: string, email: string, now: Date): Promise<{ id: string; expiresAt: Date }> {
  const id = randomId();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.query("delete from portal_sessions where expires_at < $1", [now]);
  await db.query("insert into portal_sessions (id_hash, host_id, email, expires_at) values ($1, $2, $3, $4)", [sha256(id), hostId, normalEmail(email), expiresAt]);
  return { id, expiresAt };
}

/** The email a session cookie stands for on this host's portal; null when unknown, expired, or for another host. */
export async function readSession(db: Db, id: string | undefined, hostId: string, now: Date): Promise<{ email: string } | null> {
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id) || !UUID.test(hostId)) return null;
  const { rows: [r] } = await db.query("select email from portal_sessions where id_hash = $1 and host_id = $2 and expires_at > $3", [sha256(id), hostId, now]);
  return r ? { email: String(r.email) } : null;
}

export async function endSession(db: Db, id: string | undefined): Promise<void> {
  if (id) await db.query("delete from portal_sessions where id_hash = $1", [sha256(id)]);
}

export interface PortalBooking {
  id: string;
  startAt: Date;
  endAt: Date;
  status: "confirmed" | "cancelled";
  cancelledBy: "host" | "guest" | "system" | null;
  manageToken: string;
  timezone: string;
  locale: string;
  joinUrl: string | null;
  classKey: string | null;
  createdAt: Date;
  noShow: boolean;
  eventType: { id: string; name: string; slug: string; durationMinutes: number; cancelCutoffMinutes: number; active: boolean; kind: string };
}

/** The client's bookings with this host, newest first. Payment holds that never became bookings are left out. */
export async function clientBookings(db: Db, hostId: string, email: string): Promise<PortalBooking[]> {
  if (!ok(hostId, email)) return [];
  const { rows } = await db.query(
    `select b.id, b.start_at, b.end_at, b.status, b.cancelled_by, b.join_url, b.class_key, i.manage_token, i.timezone, i.locale, i.created_at, i.no_show_at,
       e.id as event_id, e.name as event_name, e.slug as event_slug, e.duration_minutes, e.cancel_cutoff_minutes, e.active, e.kind
     from bookings b join invitees i on i.booking_id = b.id join event_types e on e.id = b.event_type_id
     where b.host_id = $1 and i.host_id = $1 and e.user_id = $1 and i.email = $2
       and b.status not in ('pending_payment', 'pending_approval') and coalesce(b.cancelled_by, '') <> 'system'
     order by b.start_at desc limit 500`, [hostId, normalEmail(email)]);
  return rows.map((r) => ({
    id: r.id, startAt: r.start_at, endAt: r.end_at, status: r.status, cancelledBy: r.cancelled_by ?? null, manageToken: r.manage_token,
    timezone: r.timezone, locale: r.locale, joinUrl: r.join_url ?? null, classKey: r.class_key ?? null, createdAt: r.created_at, noShow: r.no_show_at !== null,
    eventType: { id: r.event_id, name: r.event_name, slug: r.event_slug, durationMinutes: r.duration_minutes, cancelCutoffMinutes: r.cancel_cutoff_minutes, active: r.active, kind: r.kind },
  }));
}

export interface PortalPurchase {
  id: string; token: string; packageId: string; name: string; eventName: string; sessions: number; used: number;
  paidAt: Date | null; expiresAt: Date | null;
  /** The same package is still on sale, so the client can buy it again. */
  onSale: boolean;
}

/** The client's paid packages from this host, newest first, with how many sessions each has used. */
export async function clientPurchases(db: Db, hostId: string, email: string): Promise<PortalPurchase[]> {
  if (!ok(hostId, email)) return [];
  const { rows } = await db.query(
    `select p.id, p.token, p.package_id, k.name, e.name as event_name, p.sessions, p.paid_at, p.expires_at,
       (select count(*)::int from bookings b where b.package_purchase_id = p.id and b.status <> 'cancelled') as used,
       (k.active and e.active and e.kind = 'one_on_one') as on_sale
     from package_purchases p join packages k on k.id = p.package_id join event_types e on e.id = p.event_type_id
     where p.host_id = $1 and k.user_id = $1 and p.guest_email = $2 and p.status = 'paid'
     order by p.paid_at desc limit 100`, [hostId, normalEmail(email)]);
  return rows.map((r) => ({
    id: r.id, token: r.token, packageId: r.package_id, name: r.name, eventName: r.event_name, sessions: r.sessions, used: r.used,
    paidAt: r.paid_at ?? null, expiresAt: r.expires_at ?? null, onSale: r.on_sale === true,
  }));
}

export interface PortalInvoice { id: string; kind: "invoice" | "credit_note"; number: string; token: string; issuedAt: Date; description: string; totalMinor: number }

/** The GST invoices and credit notes this host issued to this email, newest first. */
export async function clientInvoices(db: Db, hostId: string, email: string): Promise<PortalInvoice[]> {
  if (!ok(hostId, email)) return [];
  const { rows } = await db.query(
    `select id, kind, number, token, issued_at, description, total_minor from invoices
     where host_id = $1 and buyer_email = $2 order by issued_at desc limit 200`, [hostId, normalEmail(email)]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, number: r.number, token: r.token, issuedAt: r.issued_at, description: r.description, totalMinor: r.total_minor }));
}
