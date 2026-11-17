import type pg from "pg";
import { clientKey, summarizeClients } from "./clients";
import type { BookingWithInvitee, DataStore } from "./data/types";
import type { NoteRevision } from "./privacy/note-history";
import { waLink, waNumber } from "./whatsapp";

// The client file: what a host needs before a session, on one screen. Sessions and the private note already live on
// the client page; this adds what the client told the host when booking and what they have paid. Everything is read
// from bookings, payments and package purchases, matched by email (any case), so nothing is copied and nothing can drift.
//
// The timeline (loadClientFile) pages the client's bookings and package purchases with their answers, payments, refunds
// and invoices. Private notes come only through its owner path: for a Duo second person (acting) the note methods are
// never called and nothing is decrypted. Postgres has the money; memory mode (local demo) has bookings only.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LatestAnswer { label: string; answer: string; at: Date; bookingId: string; eventName?: string }

/**
 * The client's most recent answer to each intake question, newest first. Questions are matched by their wording as the
 * client saw it (answers keep a copy of it), so an answer stays readable after the host rewords or removes the question.
 * Lapsed payment holds never happened and are left out; a cancelled booking's answers still count (what they told you).
 */
export function latestAnswers(bookings: Pick<BookingWithInvitee, "id" | "startAt" | "createdAt" | "status" | "cancelledBy" | "invitee">[]): LatestAnswer[] {
  const seen = new Map<string, LatestAnswer>();
  const newest = [...bookings]
    .filter((b) => b.status !== "pending_payment" && !(b.status === "cancelled" && b.cancelledBy === "system"))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const b of newest) {
    for (const a of b.invitee.answers) {
      const key = a.label.trim().toLowerCase();
      if (!a.answer.trim() || seen.has(key)) continue;
      seen.set(key, { label: a.label, answer: a.answer, at: b.createdAt, bookingId: b.id });
    }
  }
  return [...seen.values()];
}

export interface MoneyLine {
  at: Date;
  /** What it was for: the event type's name, or the package's. */
  what: string;
  kind: "payment" | "deposit" | "package";
  amountMinor: number;
  refundedMinor: number;
  /** Three letters (INR for Razorpay, the Stripe account's currency otherwise). */
  currency: string;
  status: "paid" | "refund_pending" | "refunded";
  /** The GST invoice for it, when the host issues them. */
  invoiceToken: string | null;
  bookingId: string | null;
}

/**
 * Everything the client has paid this host, newest first: session payments and deposits taken through the host's own
 * Razorpay or Stripe, and session packages bought. Only money that actually came in (paid, being refunded, or refunded).
 * Totals are per currency: a host paid in rupees and dollars sees both, never one number adding them up.
 */
export async function clientMoney(db: Db, hostId: string, email: string): Promise<{ lines: MoneyLine[]; totals: { currency: string; paidMinor: number; refundedMinor: number }[] }> {
  if (!UUID.test(hostId)) return { lines: [], totals: [] };
  const { rows } = await db.query(
    `select coalesce(p.paid_at, p.created_at) as at, e.name as what, p.kind, p.amount_minor, p.refunded_minor, p.status, p.booking_id, p.currency,
       (select v.token from invoices v where v.payment_id = p.id and v.kind = 'invoice' order by v.issued_at limit 1) as invoice_token
     from payments p join bookings b on b.id = p.booking_id join invitees i on i.booking_id = b.id join event_types e on e.id = b.event_type_id
     where p.host_id = $1 and i.email = $2::citext and p.status in ('paid', 'refund_pending', 'refunded')
     union all
     select k.paid_at, pk.name, 'package', k.price_minor, 0, 'paid', null, k.currency,
       (select v.token from invoices v where v.package_purchase_id = k.id and v.kind = 'invoice' order by v.issued_at limit 1)
     from package_purchases k join packages pk on pk.id = k.package_id
     where k.host_id = $1 and k.guest_email = $2::citext and k.status = 'paid'
     order by 1 desc`, [hostId, email.trim()]);
  const lines: MoneyLine[] = rows.map((r) => ({
    at: r.at as Date, what: r.what as string, kind: r.kind as MoneyLine["kind"], amountMinor: r.amount_minor as number,
    refundedMinor: r.status === "refunded" && !r.refunded_minor ? (r.amount_minor as number) : (r.refunded_minor as number),
    currency: r.currency as string, status: r.status as MoneyLine["status"], invoiceToken: (r.invoice_token as string | null) ?? null, bookingId: (r.booking_id as string | null) ?? null,
  }));
  const totals = new Map<string, { currency: string; paidMinor: number; refundedMinor: number }>();
  for (const l of lines) {
    const t = totals.get(l.currency) ?? { currency: l.currency, paidMinor: 0, refundedMinor: 0 };
    t.paidMinor += l.amountMinor;
    t.refundedMinor += l.refundedMinor;
    totals.set(l.currency, t);
  }
  return { lines, totals: [...totals.values()] };
}

// ---- The timeline, notes and quick actions ----

const KEY = /^[0-9a-f]{20}$/;

export const TIMELINE_PAGE = 25;
const MAX_PAGE = 100;

export interface ClientHeader {
  key: string;
  name: string;
  email: string;
  phone: string | null;
  /** First confirmed session, and the latest one that has started. */
  firstAt: Date | null;
  lastAt: Date | null;
  nextAt: Date | null;
  /** Confirmed sessions, past and upcoming, no-shows included. */
  sessions: number;
  upcoming: number;
  noShows: number;
  cancelled: number;
  /** The event type of their latest booking: what "book again" offers first. */
  lastEventTypeId: string | null;
}

/** One intake answer as the guest saw the question then (the label is copied at booking). */
export interface AnswerView { label: string; answer: string }

export interface PaymentView {
  id: string; kind: "payment" | "deposit"; status: string; amountMinor: number; refundedMinor: number; currency: string;
  paidAt: Date | null; refundedAt: Date | null;
}

export interface InvoiceView { id: string; kind: "invoice" | "credit_note"; number: string; token: string; totalMinor: number; issuedAt: Date }

export interface BookingEntry {
  kind: "booking";
  id: string;
  at: Date;
  startAt: Date;
  endAt: Date;
  eventName: string;
  status: "confirmed" | "cancelled" | "pending_payment";
  cancelledBy: "host" | "guest" | "system" | null;
  cancelReason: string | null;
  noShowAt: Date | null;
  /** Booked with this package purchase (its id). */
  packagePurchaseId: string | null;
  answers: AnswerView[];
  payments: PaymentView[];
  invoices: InvoiceView[];
}

export interface PackageEntry {
  kind: "package";
  id: string;
  at: Date;
  name: string;
  sessions: number;
  used: number;
  /** Sessions left to book; 0 once it has expired. */
  remaining: number;
  status: "pending" | "paid";
  priceMinor: number;
  /** Three letters: INR for Razorpay, the Stripe account's currency otherwise. */
  currency: string;
  paidAt: Date | null;
  expiresAt: Date | null;
  invoices: InvoiceView[];
}

export type TimelineEntry = BookingEntry | PackageEntry;

/** The owner's notes for what is on the page. Absent (null) for anyone else. */
export interface ClientNotes {
  client: string;
  clientHistory: NoteRevision[];
  /** Session notes by booking id, for the bookings on this page. */
  sessions: Record<string, string>;
  sessionHistory: Record<string, NoteRevision[]>;
  keepVersions: boolean;
}

export interface ClientFile {
  header: ClientHeader;
  entries: TimelineEntry[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
  notes: ClientNotes | null;
}

/** Who is looking: the signed-in person's own account (owner) or a Duo second person acting for it. */
export interface Viewer { owner: boolean }

type NoteStore = Pick<DataStore, "getClientNote" | "listBookingNotes" | "listNoteRevisions" | "getKeepNoteVersions">;
type FileStore = NoteStore & Pick<DataStore, "listBookings" | "listEventTypes">;

/** Cursor: the last entry's time, kind and id, so pages never skip or repeat even when times tie. */
export function encodeCursor(e: Pick<TimelineEntry, "at" | "kind" | "id">): string {
  return Buffer.from(`${e.at.toISOString()}|${e.kind}|${e.id}`).toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): { at: Date; kind: string; id: string } | null {
  if (!cursor || cursor.length > 200) return null;
  const [at, kind, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const d = new Date(at ?? "");
  if (Number.isNaN(d.getTime()) || (kind !== "booking" && kind !== "package") || !UUID.test(id ?? "")) return null;
  return { at: d, kind, id };
}

/**
 * Answers stored with a booking, shown as asked. Read defensively: the label is what the guest saw, and any answer
 * shape a new question kind stores (a list, yes/no, a number) is shown as text, so new kinds need no change here.
 */
export function answerViews(raw: unknown): AnswerView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a): AnswerView[] => {
    if (!a || typeof a !== "object") return [];
    const r = a as Record<string, unknown>;
    const label = typeof r.label === "string" && r.label.trim() ? r.label : typeof r.questionId === "string" ? r.questionId : "Question";
    const answer = showAnswer(r.answer);
    return answer === "" ? [] : [{ label, answer }];
  });
}

function showAnswer(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(showAnswer).filter(Boolean).join(", ");
  return JSON.stringify(v);
}

/** A booking counts in the file unless it is a live payment hold or a hold that lapsed (never a session). */
const inFile = (b: Pick<BookingWithInvitee, "status" | "cancelledBy">) => b.status !== "pending_payment" && !(b.status === "cancelled" && b.cancelledBy === "system");

/**
 * The client file for `key` (clientKey of their email) in `hostId`'s account, one timeline page at a time, newest
 * first. Null when no such client. Notes are read only when `viewer.owner`; otherwise the store's note methods are
 * never called and `notes` is null.
 */
export async function loadClientFile(
  db: Db | null, store: FileStore, hostId: string, key: string, viewer: Viewer,
  opts: { now: Date; cursor?: string | null; limit?: number },
): Promise<ClientFile | null> {
  if (!UUID.test(hostId) && db) return null;
  if (!KEY.test(key)) return null;
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? TIMELINE_PAGE)), MAX_PAGE);
  const cursor = decodeCursor(opts.cursor);
  const file = db ? await fromPostgres(db, hostId, key, opts.now, cursor, limit) : await fromMemory(store, hostId, key, opts.now, cursor, limit);
  if (!file) return null;
  if (!viewer.owner) return { ...file, notes: null };
  const bookingIds = file.entries.filter((e) => e.kind === "booking").map((e) => e.id);
  const [client, clientHistory, sessions, sessionRevs, keepVersions] = await Promise.all([
    store.getClientNote(hostId, file.header.email),
    store.listNoteRevisions(hostId, { email: file.header.email }),
    store.listBookingNotes(hostId, bookingIds),
    store.listNoteRevisions(hostId, { bookingIds }),
    store.getKeepNoteVersions(hostId),
  ]);
  const sessionHistory: Record<string, NoteRevision[]> = {};
  for (const r of sessionRevs) if (r.bookingId) (sessionHistory[r.bookingId] ??= []).push(r);
  return { ...file, notes: { client, clientHistory, sessions, sessionHistory, keepVersions } };
}

async function fromPostgres(db: Db, hostId: string, key: string, now: Date, cursor: ReturnType<typeof decodeCursor>, limit: number): Promise<Omit<ClientFile, "notes"> | null> {
  // The client's email: the key is a hash of it, so find it among this host's own invitees.
  const { rows: [who] } = await db.query(
    `select i.email from invitees i where i.host_id = $1 and left(encode(sha256(convert_to(lower(btrim(i.email::text)), 'UTF8')), 'hex'), 20) = $2
     order by i.created_at desc limit 1`, [hostId, key]);
  if (!who) return null;
  const email = who.email as string;

  // Bookings and package purchases, merged and ordered by time, one page past the cursor (plus one to know if there's more).
  const FILE = `(b.status <> 'pending_payment' and not (b.status = 'cancelled' and b.cancelled_by is not distinct from 'system'))`;
  const page = await db.query(
    `select * from (
       select b.start_at as at, 'booking' as kind, b.id from invitees i join bookings b on b.id = i.booking_id
         where i.host_id = $1 and b.host_id = $1 and i.email = $2 and ${FILE}
       union all
       select coalesce(p.paid_at, p.created_at) as at, 'package' as kind, p.id from package_purchases p
         where p.host_id = $1 and p.guest_email = $2 and p.status in ('paid', 'pending')
     ) t
     where ($3::timestamptz is null or (t.at, t.kind, t.id) < ($3::timestamptz, $4::text, $5::uuid))
     order by t.at desc, t.kind desc, t.id desc limit $6`,
    [hostId, email, cursor?.at ?? null, cursor?.kind ?? null, cursor?.id ?? null, limit + 1]);
  const rows = page.rows.slice(0, limit);
  const bookingIds = rows.filter((r) => r.kind === "booking").map((r) => r.id as string);
  const purchaseIds = rows.filter((r) => r.kind === "package").map((r) => r.id as string);

  const [header, latest, bookings, payments, purchases] = await Promise.all([
    db.query(
      `select count(*) filter (where b.status = 'confirmed')::int as sessions,
              count(*) filter (where b.status = 'confirmed' and b.start_at > $3)::int as upcoming,
              count(*) filter (where b.status = 'confirmed' and i.no_show_at is not null)::int as no_shows,
              count(*) filter (where b.status = 'cancelled')::int as cancelled,
              min(b.start_at) filter (where b.status = 'confirmed') as first_at,
              max(b.start_at) filter (where b.status = 'confirmed' and b.start_at <= $3) as last_at,
              min(b.start_at) filter (where b.status = 'confirmed' and b.start_at > $3) as next_at
       from invitees i join bookings b on b.id = i.booking_id where i.host_id = $1 and b.host_id = $1 and i.email = $2 and ${FILE}`, [hostId, email, now]),
    // The latest booking's name (people fix typos), and the most recent phone given.
    db.query(
      `select (select i.name from invitees i join bookings b on b.id = i.booking_id where i.host_id = $1 and i.email = $2 order by b.created_at desc limit 1) as name,
              (select i.phone from invitees i join bookings b on b.id = i.booking_id where i.host_id = $1 and i.email = $2 and i.phone is not null order by b.start_at desc limit 1) as phone,
              (select b.event_type_id from invitees i join bookings b on b.id = i.booking_id where i.host_id = $1 and i.email = $2 order by b.start_at desc limit 1) as event_type_id`,
      [hostId, email]),
    db.query(
      `select b.id, b.start_at, b.end_at, b.status, b.cancelled_by, b.cancel_reason, b.package_purchase_id, e.name as event_name, i.answers, i.no_show_at
       from bookings b join invitees i on i.booking_id = b.id join event_types e on e.id = b.event_type_id
       where b.host_id = $1 and b.id = any($2::uuid[])`, [hostId, bookingIds]),
    db.query(
      `select id, booking_id, kind, status, amount_minor, refunded_minor, currency, paid_at, refunded_at from payments
       where host_id = $1 and booking_id = any($2::uuid[]) order by created_at`, [hostId, bookingIds]),
    db.query(
      `select p.id, p.sessions, p.price_minor, p.currency, p.status, p.paid_at, p.expires_at, k.name,
              (select count(*)::int from bookings b where b.package_purchase_id = p.id and b.status <> 'cancelled') as used
       from package_purchases p join packages k on k.id = p.package_id where p.host_id = $1 and p.id = any($2::uuid[])`, [hostId, purchaseIds]),
  ]);
  const paymentIds = payments.rows.map((p) => p.id as string);
  const { rows: invoiceRows } = await db.query(
    `select id, kind, number, token, total_minor, issued_at, payment_id, package_purchase_id from invoices
     where host_id = $1 and (payment_id = any($2::uuid[]) or package_purchase_id = any($3::uuid[])) order by issued_at`, [hostId, paymentIds, purchaseIds]);
  const toInvoice = (r: Record<string, unknown>): InvoiceView => ({
    id: r.id as string, kind: r.kind as InvoiceView["kind"], number: r.number as string, token: r.token as string, totalMinor: r.total_minor as number, issuedAt: r.issued_at as Date,
  });

  const h = header.rows[0];
  const head: ClientHeader = {
    key, name: (latest.rows[0]?.name as string | null) ?? email, email, phone: (latest.rows[0]?.phone as string | null) ?? null,
    firstAt: h.first_at, lastAt: h.last_at, nextAt: h.next_at, sessions: h.sessions, upcoming: h.upcoming, noShows: h.no_shows, cancelled: h.cancelled,
    lastEventTypeId: (latest.rows[0]?.event_type_id as string | null) ?? null,
  };
  const bookingById = new Map(bookings.rows.map((r) => [r.id as string, r]));
  const purchaseById = new Map(purchases.rows.map((r) => [r.id as string, r]));
  const entries: TimelineEntry[] = rows.flatMap((row): TimelineEntry[] => {
    if (row.kind === "booking") {
      const b = bookingById.get(row.id);
      if (!b) return [];
      const pays = payments.rows.filter((p) => p.booking_id === b.id);
      const payIds = new Set(pays.map((p) => p.id));
      return [{
        kind: "booking", id: b.id, at: row.at, startAt: b.start_at, endAt: b.end_at, eventName: b.event_name, status: b.status, cancelledBy: b.cancelled_by ?? null,
        cancelReason: b.cancel_reason ?? null, noShowAt: b.no_show_at ?? null, packagePurchaseId: b.package_purchase_id ?? null, answers: answerViews(b.answers),
        payments: pays.map((p) => ({
          id: p.id, kind: p.kind, status: p.status, amountMinor: p.amount_minor, refundedMinor: p.refunded_minor, currency: p.currency, paidAt: p.paid_at ?? null, refundedAt: p.refunded_at ?? null,
        })),
        invoices: invoiceRows.filter((v) => v.payment_id && payIds.has(v.payment_id)).map(toInvoice),
      }];
    }
    const p = purchaseById.get(row.id);
    if (!p) return [];
    const expired = p.expires_at !== null && (p.expires_at as Date) <= now;
    return [{
      kind: "package", id: p.id, at: row.at, name: p.name, sessions: p.sessions, used: p.used, remaining: p.status === "paid" && !expired ? Math.max(0, p.sessions - p.used) : 0,
      status: p.status, priceMinor: p.price_minor, currency: p.currency ?? "INR", paidAt: p.paid_at ?? null, expiresAt: p.expires_at ?? null,
      invoices: invoiceRows.filter((v) => v.package_purchase_id === p.id).map(toInvoice),
    }];
  });
  const last = rows.at(-1);
  return { header: head, entries, nextCursor: page.rows.length > limit && last ? encodeCursor({ at: last.at, kind: last.kind, id: last.id }) : null };
}

/** Memory mode (local demo): bookings and answers only; there are no payments, packages or invoices without Postgres. */
async function fromMemory(store: FileStore, hostId: string, key: string, now: Date, cursor: ReturnType<typeof decodeCursor>, limit: number): Promise<Omit<ClientFile, "notes"> | null> {
  const [all, eventTypes] = await Promise.all([store.listBookings(hostId), store.listEventTypes(hostId)]);
  const names = new Map(eventTypes.map((e) => [e.id, e.name]));
  const c = summarizeClients(all, now).find((x) => x.key === key);
  if (!c) return null;
  const mine = all.filter((b) => b.hostId === hostId && clientKey(b.invitee.email) === key && inFile(b));
  const sorted = mine.map((b) => ({ b, at: b.startAt, kind: "booking" as const, id: b.id }))
    .sort((x, y) => y.at.getTime() - x.at.getTime() || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
  // Same order and cursor as Postgres: (at, kind, id) descending; every entry here is a booking.
  const before = (e: { at: Date; id: string }, c: NonNullable<typeof cursor>) =>
    e.at < c.at || (e.at.getTime() === c.at.getTime() && ("booking" < c.kind || ("booking" === c.kind && e.id < c.id)));
  const after = cursor ? sorted.filter((e) => before(e, cursor)) : sorted;
  const rows = after.slice(0, limit);
  const last = rows.at(-1);
  return {
    header: {
      key, name: c.name, email: c.email, phone: c.phone, firstAt: mine.filter((b) => b.status === "confirmed").map((b) => b.startAt).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
      lastAt: c.lastAt, nextAt: c.nextAt, sessions: c.sessions, upcoming: c.upcoming, noShows: c.noShows, cancelled: c.cancelled,
      lastEventTypeId: sorted[0]?.b.eventTypeId ?? null,
    },
    entries: rows.map(({ b, at }) => ({
      kind: "booking", id: b.id, at, startAt: b.startAt, endAt: b.endAt, eventName: names.get(b.eventTypeId) ?? "", status: b.status, cancelledBy: b.cancelledBy, cancelReason: b.cancelReason,
      noShowAt: b.invitee.noShowAt, packagePurchaseId: null, answers: answerViews(b.invitee.answers), payments: [], invoices: [],
    })),
    nextCursor: after.length > limit && last ? encodeCursor(last) : null,
  };
}

/**
 * The links behind the file's quick actions, the client's last event type first. "Book for them" (`book`) opens the
 * host's own booking page prefilled and marked onbehalf=1, so the consent log records it as the host's booking; paid
 * event types are left out there, since the host would be the one paying. The rebook link is for the client to use
 * themselves, so it offers any active event type and carries no onbehalf.
 */
export function quickActions(opts: {
  baseUrl: string; host: { slug: string; name: string }; client: Pick<ClientHeader, "name" | "email" | "phone" | "lastEventTypeId">;
  eventTypes: { id: string; slug: string; name: string; paid: boolean }[];
}): { book: { name: string; path: string }[]; rebookUrl: string | null; mailto: string | null; whatsapp: string | null } {
  const prefill = `name=${encodeURIComponent(opts.client.name)}&email=${encodeURIComponent(opts.client.email)}`;
  const ordered = [...opts.eventTypes].sort((a, b) => Number(b.id === opts.client.lastEventTypeId) - Number(a.id === opts.client.lastEventTypeId));
  const book = ordered.filter((e) => !e.paid).map((e) => ({ name: e.name, path: `/${opts.host.slug}/${e.slug}?${prefill}&onbehalf=1` }));
  if (ordered.length === 0) return { book, rebookUrl: null, mailto: null, whatsapp: null };
  const rebookUrl = `${opts.baseUrl.replace(/\/$/, "")}/${opts.host.slug}/${ordered[0].slug}?${prefill}`;
  const first = opts.client.name.trim().split(/\s+/)[0] || opts.client.name;
  const text = `Hi ${first}, here's a link to book your next session with ${opts.host.name}: ${rebookUrl}`;
  const mailto = `mailto:${encodeURIComponent(opts.client.email)}?subject=${encodeURIComponent(`Book your next session with ${opts.host.name}`)}&body=${encodeURIComponent(text)}`;
  const wa = waNumber(opts.client.phone);
  return { book, rebookUrl, mailto, whatsapp: wa ? waLink(wa, text) : null };
}
