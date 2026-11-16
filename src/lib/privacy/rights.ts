import { randomUUID } from "node:crypto";
import type pg from "pg";
import { unseal } from "../crypto/seal";
import { listConsents, PRIVACY_NOTICE_VERSION, type ConsentRecord } from "./consent";
import { bookingNoteAad, clientNoteAad } from "./notes";

// A client's rights, for the host who is their data fiduciary (DPDP Act 2023, ss.11 to 13; Hourhand is the host's
// processor, s.8(2)). The host can export everything Hourhand holds about one client, or erase it; a guest can ask
// their host for either from their booking's manage link. Everything here filters by the host's own id and the
// client's email: nothing of another host or another client can come back. Working draft: review with a lawyer.

type Q = Pick<pg.Pool | pg.PoolClient, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

/**
 * Days a host has to act on a guest's request. DPDP Rules 2025, Rule 14(3): grievances answered within a reasonable
 * period of at most 90 days (in force from about 13 May 2027). No shorter limit is set for access or erasure requests,
 * so the dashboard counts down from 90 and asks hosts to act well before.
 */
export const RESPONSE_DAYS = 90;

/**
 * CGST Rules 2017, Rule 46(e) and (f): an unregistered buyer's name and address are required particulars only when the
 * value of the supply is ₹50,000 or more (or the buyer asked). Below that an erased client's name comes off the
 * invoice; at or above it the name stays for the CGST Act s.36 period (72 months from the annual return's due date).
 */
export const INVOICE_NAME_THRESHOLD_MINOR = 5_000_000;

export const ERASED_NAME = "Erased client";
const ERASED_DOMAIN = "erased.invalid";
export const isErasedEmail = (email: string) => email.toLowerCase().endsWith(`@${ERASED_DOMAIN}`);

// ---------------------------------------------------------------------------------------------------------------- export

export interface ClientExport {
  format: "hourhand-client-export";
  version: 1;
  exportedAt: string;
  privacyNoticeVersion: string;
  host: { name: string; email: string };
  client: { email: string; names: string[]; phones: string[] };
  includesPrivateNotes: boolean;
  clientNote: string | null;
  bookings: {
    id: string; eventType: string; startAt: string; endAt: string; status: string; cancelledAt: string | null; cancelledBy: string | null;
    cancelReason: string | null; bookedAt: string; name: string; email: string; phone: string | null; timezone: string; locale: string;
    answers: { question: string; answer: string }[]; extraGuests: string[]; whatsappUpdates: boolean; noShowAt: string | null;
    runningLateMinutes: number | null; sessionNote: string | null;
    /** What the guest said in the follow-up after this session (2.6), if they answered. */
    feedback: { rating: number; comment: string | null; leftAt: string } | null;
  }[];
  /** When they asked this host for no more follow-up emails, if they did. */
  followUpOptOutAt: string | null;
  payments: { bookingId: string; kind: string; amountMinor: number; currency: string; status: string; refundedMinor: number; paidAt: string | null; providerPaymentId: string | null }[];
  packagePurchases: { id: string; package: string; sessions: number; priceMinor: number; currency: string; status: string; paidAt: string | null; expiresAt: string | null; name: string; email: string; phone: string | null }[];
  invoices: { number: string; kind: string; issuedAt: string; buyerName: string; buyerEmail: string; description: string; placeOfSupply: string; totalMinor: number; taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number }[];
  consentLog: (Omit<ConsentRecord, "recordedAt"> & { recordedAt: string })[];
  waitlist: { eventType: string; day: string; joinedAt: string; name: string }[];
  dataRequests: { kind: string; status: string; requestedAt: string; dueAt: string; resolvedAt: string | null }[];
}

const iso = (d: unknown) => (d ? new Date(d as Date).toISOString() : null);

/**
 * Everything Hourhand holds about one client of `hostId` (by email, any case), or null when they are not this host's
 * client. Private notes are decrypted into it only with `includeNotes` (the owner's own copy); `key` opens them.
 */
export async function exportClient(db: Q, hostId: string, email: string, opts: { includeNotes: boolean; key: () => Buffer; now: Date }): Promise<ClientExport | null> {
  if (!UUID.test(hostId)) return null;
  const { rows: bookings } = await db.query(
    `select b.id, e.name as event_name, b.start_at, b.end_at, b.status, b.cancelled_at, b.cancelled_by, b.cancel_reason, b.created_at,
       i.name, i.email, i.phone, i.timezone, i.locale, i.answers, i.guests::text[] as guests, i.whatsapp_opt_in_at, i.no_show_at, i.running_late_minutes
     from invitees i join bookings b on b.id = i.booking_id join event_types e on e.id = b.event_type_id
     where i.host_id = $1 and b.host_id = $1 and i.email = $2 order by b.start_at`, [hostId, email]);
  const { rows: packages } = await db.query(
    `select k.id, p.name as package_name, k.sessions, k.price_minor, k.currency, k.status, k.paid_at, k.expires_at, k.guest_name, k.guest_email, k.guest_phone
     from package_purchases k join packages p on p.id = k.package_id where k.host_id = $1 and k.guest_email = $2 order by k.created_at`, [hostId, email]);
  const { rows: waitlist } = await db.query(
    `select e.name as event_name, w.day::text as day, w.created_at, w.name from waitlist w join event_types e on e.id = w.event_type_id
     where w.host_id = $1 and w.email = $2 order by w.created_at`, [hostId, email]);
  if (bookings.length === 0 && packages.length === 0 && waitlist.length === 0) return null;

  const bookingIds = bookings.map((b) => b.id as string);
  const [{ rows: [host] }, { rows: payments }, { rows: invoices }, { rows: requests }, consents, { rows: feedback }, { rows: [optOut] }] = await Promise.all([
    db.query("select coalesce(name, '') as name, email from users where id = $1", [hostId]),
    db.query(
      `select booking_id, kind, amount_minor, currency, status, refunded_minor, paid_at, provider_payment_id from payments
       where host_id = $1 and booking_id = any($2::uuid[]) order by created_at`, [hostId, bookingIds]),
    db.query(
      `select number, kind, issued_at, buyer_name, buyer_email, description, place_of_supply, total_minor, taxable_minor, cgst_minor, sgst_minor, igst_minor
       from invoices where host_id = $1 and buyer_email = $2 order by issued_at`, [hostId, email]),
    db.query("select kind, status, requested_at, due_at, resolved_at from data_requests where host_id = $1 and email = $2 order by requested_at", [hostId, email]),
    listConsents(db, hostId, email),
    db.query("select booking_id, rating, comment, created_at from booking_feedback where host_id = $1 and booking_id = any($2::uuid[])", [hostId, bookingIds]),
    db.query("select opted_out_at from follow_up_opt_outs where host_id = $1 and email = $2", [hostId, email]),
  ]);
  const feedbackFor = new Map(feedback.map((f) => [f.booking_id as string, { rating: f.rating as number, comment: (f.comment as string | null) ?? null, leftAt: iso(f.created_at)! }]));

  let clientNote: string | null = null;
  const sessionNotes = new Map<string, string>();
  if (opts.includeNotes) {
    const { rows: [n] } = await db.query("select note, note_sealed from client_notes where host_id = $1 and email = $2", [hostId, email]);
    if (n) clientNote = n.note_sealed ? unseal<string>(opts.key(), n.note_sealed, clientNoteAad(hostId, email)) : n.note;
    const { rows: notes } = await db.query("select booking_id, note_sealed from booking_notes where host_id = $1 and booking_id = any($2::uuid[])", [hostId, bookingIds]);
    for (const r of notes) sessionNotes.set(r.booking_id, unseal<string>(opts.key(), r.note_sealed, bookingNoteAad(r.booking_id)));
  }

  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  return {
    format: "hourhand-client-export", version: 1, exportedAt: opts.now.toISOString(), privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    host: { name: host.name, email: host.email },
    client: { email, names: uniq([...bookings.map((b) => b.name), ...packages.map((k) => k.guest_name), ...waitlist.map((w) => w.name)]), phones: uniq([...bookings.map((b) => b.phone), ...packages.map((k) => k.guest_phone)]) },
    includesPrivateNotes: opts.includeNotes,
    clientNote,
    bookings: bookings.map((b) => ({
      id: b.id, eventType: b.event_name, startAt: iso(b.start_at)!, endAt: iso(b.end_at)!, status: b.status, cancelledAt: iso(b.cancelled_at), cancelledBy: b.cancelled_by,
      cancelReason: b.cancel_reason, bookedAt: iso(b.created_at)!, name: b.name, email: b.email, phone: b.phone, timezone: b.timezone, locale: b.locale,
      answers: (b.answers as { label: string; answer: string }[]).map((a) => ({ question: a.label, answer: a.answer })), extraGuests: b.guests ?? [],
      whatsappUpdates: b.whatsapp_opt_in_at !== null, noShowAt: iso(b.no_show_at), runningLateMinutes: b.running_late_minutes,
      sessionNote: opts.includeNotes ? sessionNotes.get(b.id) ?? null : null,
      feedback: feedbackFor.get(b.id) ?? null,
    })),
    followUpOptOutAt: iso(optOut?.opted_out_at),
    payments: payments.map((p) => ({ bookingId: p.booking_id, kind: p.kind, amountMinor: p.amount_minor, currency: p.currency, status: p.status, refundedMinor: p.refunded_minor, paidAt: iso(p.paid_at), providerPaymentId: p.provider_payment_id })),
    packagePurchases: packages.map((k) => ({ id: k.id, package: k.package_name, sessions: k.sessions, priceMinor: k.price_minor, currency: k.currency, status: k.status, paidAt: iso(k.paid_at), expiresAt: iso(k.expires_at), name: k.guest_name, email: k.guest_email, phone: k.guest_phone })),
    invoices: invoices.map((v) => ({ number: v.number, kind: v.kind, issuedAt: iso(v.issued_at)!, buyerName: v.buyer_name, buyerEmail: v.buyer_email, description: v.description, placeOfSupply: v.place_of_supply, totalMinor: v.total_minor, taxableMinor: v.taxable_minor, cgstMinor: v.cgst_minor, sgstMinor: v.sgst_minor, igstMinor: v.igst_minor })),
    consentLog: consents.map((c) => ({ ...c, recordedAt: c.recordedAt.toISOString() })),
    waitlist: waitlist.map((w) => ({ eventType: w.event_name, day: w.day, joinedAt: iso(w.created_at)!, name: w.name })),
    dataRequests: requests.map((r) => ({ kind: r.kind, status: r.status, requestedAt: iso(r.requested_at)!, dueAt: iso(r.due_at)!, resolvedAt: iso(r.resolved_at) })),
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
const table = (head: string[], rows: unknown[][]) => rows.length === 0 ? "<p>None.</p>"
  : `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

/** The same export as a self-contained page, readable on screen and printable to PDF from the browser. */
export function exportHtml(x: ClientExport): string {
  const sections = [
    `<h2>Bookings</h2>${table(["When (UTC)", "Event", "Status", "Name", "Email", "Phone", "Answers", "Feedback", "Session note"],
      x.bookings.map((b) => [`${b.startAt} to ${b.endAt}`, b.eventType, b.status + (b.noShowAt ? " (no-show)" : ""), b.name, b.email, b.phone ?? "",
        b.answers.map((a) => `${a.question}: ${a.answer}`).join("\n"), b.feedback ? `${b.feedback.rating}/5${b.feedback.comment ? `: ${b.feedback.comment}` : ""}` : "", b.sessionNote ?? ""]))}
${x.followUpOptOutAt ? `<p>Asked for no more follow-up emails on ${esc(x.followUpOptOutAt)}.</p>` : ""}`,
    x.includesPrivateNotes ? `<h2>Private note</h2><p class="pre">${esc(x.clientNote ?? "None.")}</p>` : "",
    `<h2>Payments</h2>${table(["Booking", "Kind", "Amount", "Status", "Refunded", "Paid at"], x.payments.map((p) => [p.bookingId, p.kind, money(p.amountMinor, p.currency), p.status, money(p.refundedMinor, p.currency), p.paidAt ?? ""]))}`,
    `<h2>Session packages</h2>${table(["Package", "Sessions", "Price", "Status", "Paid at", "Valid until"], x.packagePurchases.map((k) => [k.package, k.sessions, money(k.priceMinor, k.currency), k.status, k.paidAt ?? "", k.expiresAt ?? ""]))}`,
    `<h2>GST invoices and credit notes</h2>${table(["Number", "Kind", "Issued", "Buyer", "Description", "Total"], x.invoices.map((v) => [v.number, v.kind, v.issuedAt, v.buyerName, v.description, money(v.totalMinor, "INR")]))}`,
    `<h2>Consent log</h2>${table(["Recorded (UTC)", "Purpose", "Agreed", "Words shown", "Notice version", "Channel", "Language"], x.consentLog.map((c) => [c.recordedAt, c.purpose, c.granted ? "yes" : "no", c.statement, c.noticeVersion, c.channel, c.locale]))}`,
    `<h2>Waitlist</h2>${table(["Event", "Day", "Joined"], x.waitlist.map((w) => [w.eventType, w.day, w.joinedAt]))}`,
    `<h2>Requests about this data</h2>${table(["Kind", "Status", "Requested", "Due", "Resolved"], x.dataRequests.map((r) => [r.kind, r.status, r.requestedAt, r.dueAt, r.resolvedAt ?? ""]))}`,
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Data held about ${esc(x.client.names[0] ?? x.client.email)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1c1917}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d6d3d1;padding:4px 6px;text-align:left;vertical-align:top;white-space:pre-line}.pre{white-space:pre-line}
.meta{color:#57534e}@media print{body{margin:0}a{color:inherit}}</style></head><body>
<h1>Data held about ${esc(x.client.names.join(", ") || x.client.email)}</h1>
<p class="meta">Exported ${esc(x.exportedAt)} by ${esc(x.host.name)} (${esc(x.host.email)}) from Hourhand. Email: ${esc(x.client.email)}${x.client.phones.length ? ` · Phone: ${esc(x.client.phones.join(", "))}` : ""}.
Privacy notice version ${esc(x.privacyNoticeVersion)}.${x.includesPrivateNotes ? " Includes the host's private notes." : " The host's private notes are left out."}</p>
${sections.join("\n")}
</body></html>`;
}

// --------------------------------------------------------------------------------------------------------------- erasure

export class ErasureBlockedError extends Error {
  readonly reason: "not_found" | "upcoming" | "payments_settling";
  constructor(reason: "not_found" | "upcoming" | "payments_settling") {
    super(`Can't erase this client: ${reason}`);
    this.name = "ErasureBlockedError";
    this.reason = reason;
  }
}

/**
 * Erases one client of `hostId`, irreversibly, in one transaction. Personal data comes out of every place Hourhand
 * keeps it for this host: booking details and answers, extra guests, notes, waitlist, queued and past message
 * recipients, package purchases, the consent log and requests. What the law requires stays (CGST Act ss.35 and 36):
 * bookings, payments and invoices keep their dates, amounts and numbers, and an invoice keeps the buyer's name only
 * at or above INVOICE_NAME_THRESHOLD_MINOR. Changed invoices are logged in invoice_redactions (CGST Rule 56(8)).
 * The erasure itself is logged with who and when, never whom. Refused while the client has an upcoming booking, a
 * payment hold, or a payment or refund still settling: cancel or let those finish first.
 */
export async function eraseClient(pool: Pick<pg.Pool, "connect">, hostId: string, actorId: string, email: string, now: Date): Promise<{ erasureId: string }> {
  if (!UUID.test(hostId)) throw new ErasureBlockedError("not_found");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: invitees } = await client.query(
      "select i.id, i.booking_id, i.phone from invitees i where i.host_id = $1 and i.email = $2 for update", [hostId, email]);
    const bookingIds = invitees.map((i) => i.booking_id as string);
    const { rows: [counts] } = await client.query(
      `select
         (select count(*) from package_purchases where host_id = $1 and guest_email = $2)::int as packages,
         (select count(*) from waitlist where host_id = $1 and email = $2)::int as waiting,
         (select count(*) from bookings where id = any($3::uuid[]) and ((status = 'confirmed' and end_at > $4) or status = 'pending_payment'))::int as live,
         (select count(*) from payments where booking_id = any($3::uuid[]) and status in ('pending', 'refund_pending'))::int
           + (select count(*) from package_purchases where host_id = $1 and guest_email = $2 and status = 'pending')::int as settling`,
      [hostId, email, bookingIds, now]);
    if (invitees.length === 0 && counts.packages === 0 && counts.waiting === 0) throw new ErasureBlockedError("not_found");
    if (counts.live > 0) throw new ErasureBlockedError("upcoming");
    if (counts.settling > 0) throw new ErasureBlockedError("payments_settling");

    const erasureId = randomUUID();
    const placeholder = `erased-${erasureId}@${ERASED_DOMAIN}`;
    const phones = invitees.map((i) => i.phone as string | null).filter((p): p is string => Boolean(p));
    await client.query("insert into client_erasures (id, host_id, actor_id, erased_at) values ($1, $2, $3, $4)", [erasureId, hostId, actorId, now]);

    // Bookings stay (the host's history, and what payments and invoices point at), with no one identifiable in them.
    await client.query(
      `update invitees set name = $3, email = $4, phone = null, answers = '[]', guests = '{}', utm = '{}', whatsapp_opt_in_at = null, sms_opt_in_at = null, sms_code = null,
         running_late_minutes = null, running_late_at = null, manage_token = encode(gen_random_bytes(24), 'hex'), updated_at = $5
       where host_id = $1 and email = $2`, [hostId, email, ERASED_NAME, placeholder, now]);
    await client.query("update bookings set cancel_reason = null, location_value = null where id = any($1::uuid[]) and host_id = $2", [bookingIds, hostId]);
    await client.query("delete from booking_guests where booking_id = any($1::uuid[])", [bookingIds]);
    await client.query("delete from booking_notes where host_id = $1 and booking_id = any($2::uuid[])", [hostId, bookingIds]);
    // Session prep (3.5): AI briefs were written from their answers and history, so they go too.
    await client.query("delete from session_briefs where host_id = $1 and booking_id = any($2::uuid[])", [hostId, bookingIds]);
    await client.query("delete from client_notes where host_id = $1 and email = $2", [hostId, email]);
    await client.query("delete from waitlist where host_id = $1 and email = $2", [hostId, email]);
    // Session follow-ups (2.6): the guest's own words go; the 1-5 rating stays on the now anonymous booking.
    await client.query("update booking_feedback set comment = null where host_id = $1 and booking_id = any($2::uuid[])", [hostId, bookingIds]);
    await client.query("delete from follow_up_opt_outs where host_id = $1 and email = $2", [hostId, email]);
    // The client portal (3.2): sign them out and void any emailed sign-in link.
    await client.query("delete from portal_sessions where host_id = $1 and email = $2", [hostId, email]);
    await client.query("delete from portal_links where host_id = $1 and email = $2", [hostId, email]);

    // Messages: anything still queued for them never goes; sent ones keep their status but not the address.
    await client.query(
      `delete from notifications where user_id = $1 and status = 'queued' and channel <> 'calendar'
         and (booking_id = any($2::uuid[]) or lower(recipient) = lower($3) or recipient = any($4::text[]))`, [hostId, bookingIds, email, phones]);
    await client.query(
      `update notifications set recipient = $5, updated_at = $6 where user_id = $1
         and (lower(recipient) = lower($3) or recipient = any($4::text[]) or (booking_id = any($2::uuid[]) and channel in ('email', 'whatsapp', 'sms') and kind like '%_guest'))`,
      [hostId, bookingIds, email, phones, placeholder, now]);

    await client.query(
      `update package_purchases set guest_name = $3, guest_email = $4, guest_phone = null, token = encode(gen_random_bytes(24), 'hex'), updated_at = $5
       where host_id = $1 and guest_email = $2`, [hostId, email, ERASED_NAME, placeholder, now]);

    // Invoices: the legally required particulars stay; the email always goes, the name below the threshold.
    const { rows: invoices } = await client.query(
      `update invoices set buyer_email = $3, token = encode(gen_random_bytes(24), 'hex'),
         buyer_name = case when taxable_minor >= $5 then buyer_name else $4 end
       where host_id = $1 and buyer_email = $2 returning id, taxable_minor >= $5 as kept_name`, [hostId, email, placeholder, ERASED_NAME, INVOICE_NAME_THRESHOLD_MINOR]);
    for (const v of invoices) {
      await client.query("insert into invoice_redactions (invoice_id, erasure_id, fields, redacted_at) values ($1, $2, $3, $4)",
        [v.id, erasureId, v.kept_name ? ["buyer_email", "token"] : ["buyer_name", "buyer_email", "token"], now]);
    }

    // The consent log keeps that consent was given (purpose, words, version, time), not who gave it.
    await client.query("update consent_records set email = $3 where host_id = $1 and email = $2", [hostId, email, placeholder]);
    await client.query(
      `update data_requests set email = $3, status = case when status = 'open' then 'done' else status end,
         resolved_at = coalesce(resolved_at, $4), resolved_by = coalesce(resolved_by, $5) where host_id = $1 and email = $2`,
      [hostId, email, placeholder, now, actorId]);
    await client.query("commit");
    return { erasureId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** The host's erasure log, newest first: when, and who did it. */
export async function listErasures(db: Q, hostId: string): Promise<{ id: string; erasedAt: Date; actorName: string | null }[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(
    "select e.id, e.erased_at, u.name from client_erasures e left join users u on u.id = e.actor_id where e.host_id = $1 order by e.erased_at desc", [hostId]);
  return rows.map((r) => ({ id: r.id, erasedAt: r.erased_at, actorName: r.name ?? null }));
}

// ------------------------------------------------------------------------------------------------------- guest requests

export type RequestKind = "access" | "erasure";

export interface DataRequest { id: string; bookingId: string | null; email: string; kind: RequestKind; requestedAt: Date; dueAt: Date; status: "open" | "done" | "declined"; resolvedAt: Date | null }

const toRequest = (r: Record<string, unknown>): DataRequest => ({
  id: r.id as string, bookingId: (r.booking_id as string | null) ?? null, email: r.email as string, kind: r.kind as RequestKind, requestedAt: r.requested_at as Date,
  dueAt: r.due_at as Date, status: r.status as DataRequest["status"], resolvedAt: (r.resolved_at as Date | null) ?? null,
});

export const dueDate = (requestedAt: Date) => new Date(requestedAt.getTime() + RESPONSE_DAYS * DAY);

/**
 * A guest asks, from their manage link, for a copy or deletion of what their host holds about them. The host is
 * emailed (without the guest's details) and has until dueAt. Asking again while one is open returns the open one.
 * Null when the token matches no booking or the host has closed their account.
 */
export async function requestFromGuest(db: Q, manageToken: string, kind: RequestKind, now: Date): Promise<{ request: DataRequest; created: boolean } | null> {
  if (manageToken.length < 10 || manageToken.length > 100) return null;
  const { rows: [b] } = await db.query(
    `select b.id, b.host_id, i.email, u.email as host_email from invitees i join bookings b on b.id = i.booking_id join users u on u.id = b.host_id
     where i.manage_token = $1 and u.deleted_at is null`, [manageToken]);
  if (!b || isErasedEmail(b.email)) return null;
  // The request and the host's email are one statement: neither exists without the other.
  const { rows: [created] } = await db.query(
    `with r as (
       insert into data_requests (host_id, booking_id, email, kind, requested_at, due_at) values ($1, $2, $3, $4, $5, $6)
       on conflict (host_id, email, kind) where status = 'open' do nothing returning *),
     n as (
       insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
       select null, r.host_id, 'email', 'data_request_host', $7, $5, 'data_request:' || r.id from r)
     select * from r`, [b.host_id, b.id, b.email, kind, now, dueDate(now), b.host_email]);
  if (created) return { request: toRequest(created), created: true };
  const { rows: [open] } = await db.query("select * from data_requests where host_id = $1 and email = $2 and kind = $3 and status = 'open'", [b.host_id, b.email, kind]);
  return open ? { request: toRequest(open), created: false } : null;
}

/** The open requests for one guest's booking, for their manage page. */
export async function openRequestsForToken(db: Q, manageToken: string): Promise<DataRequest[]> {
  const { rows } = await db.query(
    `select r.* from data_requests r join invitees i on i.host_id = r.host_id and i.email = r.email
     where i.manage_token = $1 and r.status = 'open' order by r.requested_at`, [manageToken]);
  return rows.map(toRequest);
}

/** A host's requests, open ones first by deadline, then the rest newest first. */
export async function listRequests(db: Q, hostId: string): Promise<DataRequest[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(
    "select * from data_requests where host_id = $1 order by (status = 'open') desc, case when status = 'open' then due_at end, requested_at desc limit 200", [hostId]);
  return rows.map(toRequest);
}

/** Marks one of the host's open requests done (they sent the copy) or declined. False when it isn't theirs or not open. */
export async function resolveRequest(db: Q, hostId: string, actorId: string, requestId: string, status: "done" | "declined", now: Date): Promise<boolean> {
  if (!UUID.test(hostId) || !UUID.test(requestId)) return false;
  const { rowCount } = await db.query(
    "update data_requests set status = $3, resolved_at = $4, resolved_by = $5 where id = $1 and host_id = $2 and status = 'open'", [requestId, hostId, status, now, actorId]);
  return rowCount === 1;
}

/** For the worker: the open request behind a data_request_host email, or null once it was dealt with. */
export async function requestForEmail(db: Q, requestId: string): Promise<{ kind: RequestKind; dueAt: Date; hostName: string } | null> {
  if (!UUID.test(requestId)) return null;
  const { rows: [r] } = await db.query(
    "select r.kind, r.due_at, coalesce(u.name, '') as host_name from data_requests r join users u on u.id = r.host_id where r.id = $1 and r.status = 'open'", [requestId]);
  return r ? { kind: r.kind, dueAt: r.due_at, hostName: r.host_name } : null;
}

