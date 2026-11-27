import type pg from "pg";
import { maskKeyId } from "../payments/host-razorpay";

// What a super admin sees of one host's customers (B17): clients, bookings with their answers and private notes, and
// payments. Read-only, and each page that shows it logs the visit. Gateway secrets are never read: a Razorpay key
// shows only its masked key id, from the column kept beside the sealed secret for exactly this.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CUSTOMER_PAGE = 50;

/** Private notes are sealed per host; the data store opens them with the app's own key. */
export interface NoteReader {
  getClientNote(hostId: string, email: string): Promise<string>;
  listBookingNotes(hostId: string, bookingIds: string[]): Promise<Record<string, string>>;
}

const pageOf = (page?: number) => Math.max(1, Math.floor(page ?? 1));
const likeOf = (q?: string) => {
  const t = (q ?? "").trim().slice(0, 100);
  return t ? `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
};

export interface ClientRow { email: string; name: string; phone: string | null; bookings: number; first: Date; last: Date; note: string }

/** A host's clients (everyone who booked them), most recent first, with the host's private note on each. */
export async function hostClients(db: Db, notes: NoteReader, hostId: string, opts: { q?: string; page?: number } = {}): Promise<{ clients: ClientRow[]; total: number }> {
  if (!UUID.test(hostId)) return { clients: [], total: 0 };
  const like = likeOf(opts.q);
  const where = "i.host_id = $1 and ($2::text is null or i.email::text ilike $2 or i.name ilike $2)";
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    db.query(
      `select i.email::text as email, (array_agg(i.name order by b.start_at desc))[1] as name,
         (array_agg(i.phone order by b.start_at desc) filter (where i.phone is not null))[1] as phone,
         count(distinct b.id)::int as bookings, min(b.start_at) as first, max(b.start_at) as last
       from invitees i join bookings b on b.id = i.booking_id where ${where}
       group by i.email order by max(b.start_at) desc limit $3 offset $4`,
      [hostId, like, CUSTOMER_PAGE, (pageOf(opts.page) - 1) * CUSTOMER_PAGE]),
    db.query(`select count(distinct i.email)::int as total from invitees i where ${where}`, [hostId, like]),
  ]);
  const clients = await Promise.all(rows.map(async (r) => ({
    email: r.email, name: r.name, phone: r.phone, bookings: r.bookings, first: r.first, last: r.last, note: await notes.getClientNote(hostId, r.email),
  })));
  return { clients, total };
}

export interface BookingRow {
  id: string; start: Date; status: string; event: string; guestName: string; guestEmail: string; guestPhone: string | null;
  guests: string[]; answers: { question: string; answer: string }[]; payment: string | null; note: string;
}

/** Answers are stored as { questionId, label, answer }; a multi-select's answer may be a list. */
function readAnswers(raw: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const answer = Array.isArray(o.answer) ? o.answer.join(", ") : String(o.answer ?? o.value ?? "");
    return { question: String(o.label ?? o.question ?? o.questionId ?? ""), answer };
  }).filter((a) => a.question || a.answer);
}

/** A host's bookings, newest first, with each guest's answers, extra guests, payment and the host's private note. */
export async function hostBookings(db: Db, notes: NoteReader, hostId: string, opts: { q?: string; page?: number } = {}): Promise<{ bookings: BookingRow[]; total: number }> {
  if (!UUID.test(hostId)) return { bookings: [], total: 0 };
  const like = likeOf(opts.q);
  const where = "b.host_id = $1 and ($2::text is null or exists (select 1 from invitees q where q.booking_id = b.id and (q.email::text ilike $2 or q.name ilike $2)))";
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    db.query(
      `select b.id, b.start_at, b.status, e.name as event, i.name as guest_name, i.email::text as guest_email, i.phone, i.guests::text[] as guests, i.answers,
         (select p.status || ' ' || p.amount_minor || ' ' || p.currency from payments p where p.booking_id = b.id order by p.created_at desc limit 1) as payment
       from bookings b join event_types e on e.id = b.event_type_id
       left join lateral (select * from invitees x where x.booking_id = b.id order by x.created_at limit 1) i on true
       where ${where} order by b.start_at desc limit $3 offset $4`,
      [hostId, like, CUSTOMER_PAGE, (pageOf(opts.page) - 1) * CUSTOMER_PAGE]),
    db.query(`select count(*)::int as total from bookings b where ${where}`, [hostId, like]),
  ]);
  const bookingNotes = rows.length ? await notes.listBookingNotes(hostId, rows.map((r) => r.id)) : {};
  return {
    total,
    bookings: rows.map((r) => ({
      id: r.id, start: r.start_at, status: r.status, event: r.event, guestName: r.guest_name ?? "", guestEmail: r.guest_email ?? "",
      guestPhone: r.phone ?? null, guests: Array.isArray(r.guests) ? r.guests : [], answers: readAnswers(r.answers), payment: r.payment ?? null, note: bookingNotes[r.id] ?? "",
    })),
  };
}

export interface PaymentRow { kind: "booking" | "package" | "membership"; at: Date; guestEmail: string; amountMinor: number; currency: string; status: string; provider: string; providerId: string | null; refundedMinor: number }

export interface GatewayRow { provider: string; status: string; mode: string | null; key: string | null; since: Date }

/** Money guests paid this host, newest first: bookings, packages and memberships, plus the gateways they connected. */
export async function hostPayments(db: Db, hostId: string, opts: { page?: number } = {}): Promise<{ payments: PaymentRow[]; total: number; gateways: GatewayRow[] }> {
  if (!UUID.test(hostId)) return { payments: [], total: 0, gateways: [] };
  const all = `
    select 'booking' as kind, p.created_at as at, coalesce((select i.email::text from invitees i where i.booking_id = p.booking_id order by i.created_at limit 1), '') as guest_email,
      p.amount_minor, p.currency, p.status, p.provider, p.provider_payment_id as provider_id, p.refunded_minor
      from payments p where p.host_id = $1
    union all
    select 'package', pp.created_at, pp.guest_email::text, pp.price_minor, pp.currency, pp.status, 'razorpay', pp.provider_payment_id, 0
      from package_purchases pp where pp.host_id = $1
    union all
    select 'membership', m.created_at, m.guest_email::text, m.price_minor, m.currency, m.status, m.provider, m.provider_subscription_id, 0
      from memberships m where m.host_id = $1`;
  const [{ rows }, { rows: [{ total }] }, { rows: gw }] = await Promise.all([
    db.query(`${all} order by at desc limit $2 offset $3`, [hostId, CUSTOMER_PAGE, (pageOf(opts.page) - 1) * CUSTOMER_PAGE]),
    db.query(`select count(*)::int as total from (${all}) x`, [hostId]),
    // Never credentials_encrypted: only the provider, its status, and the key id that sits beside it in the clear.
    db.query("select provider, status, mode, public_id, created_at from integrations where user_id = $1 and provider in ('razorpay', 'stripe') order by provider", [hostId]),
  ]);
  return {
    total,
    payments: rows.map((r) => ({
      kind: r.kind, at: r.at, guestEmail: r.guest_email, amountMinor: r.amount_minor, currency: r.currency, status: r.status,
      provider: r.provider, providerId: r.provider_id, refundedMinor: r.refunded_minor,
    })),
    gateways: gw.map((r) => ({
      provider: r.provider, status: r.status, mode: r.mode ?? null, since: r.created_at,
      key: r.public_id ? (r.provider === "razorpay" ? maskKeyId(r.public_id) : `••••${String(r.public_id).slice(-4)}`) : null,
    })),
  };
}
