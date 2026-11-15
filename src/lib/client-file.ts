import type pg from "pg";
import type { BookingWithInvitee } from "./data/types";

// The client file: what a host needs before a session, on one screen. Sessions and the private note already live on
// the client page; this adds what the client told the host when booking and what they have paid. Everything is read
// from bookings, payments and package purchases, matched by email (any case), so nothing is copied and nothing can drift.

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
  status: "paid" | "refund_pending" | "refunded";
  /** The GST invoice for it, when the host issues them. */
  invoiceToken: string | null;
  bookingId: string | null;
}

/**
 * Everything the client has paid this host, newest first: session payments and deposits taken through the host's own
 * Razorpay, and session packages bought. Only money that actually came in (paid, being refunded, or refunded).
 */
export async function clientMoney(db: Db, hostId: string, email: string): Promise<{ lines: MoneyLine[]; paidMinor: number; refundedMinor: number }> {
  if (!UUID.test(hostId)) return { lines: [], paidMinor: 0, refundedMinor: 0 };
  const { rows } = await db.query(
    `select coalesce(p.paid_at, p.created_at) as at, e.name as what, p.kind, p.amount_minor, p.refunded_minor, p.status, p.booking_id,
       (select v.token from invoices v where v.payment_id = p.id and v.kind = 'invoice' order by v.issued_at limit 1) as invoice_token
     from payments p join bookings b on b.id = p.booking_id join invitees i on i.booking_id = b.id join event_types e on e.id = b.event_type_id
     where p.host_id = $1 and i.email = $2::citext and p.status in ('paid', 'refund_pending', 'refunded')
     union all
     select k.paid_at, pk.name, 'package', k.price_minor, 0, 'paid', null,
       (select v.token from invoices v where v.package_purchase_id = k.id and v.kind = 'invoice' order by v.issued_at limit 1)
     from package_purchases k join packages pk on pk.id = k.package_id
     where k.host_id = $1 and k.guest_email = $2::citext and k.status = 'paid'
     order by 1 desc`, [hostId, email.trim()]);
  const lines: MoneyLine[] = rows.map((r) => ({
    at: r.at as Date, what: r.what as string, kind: r.kind as MoneyLine["kind"], amountMinor: r.amount_minor as number,
    refundedMinor: r.status === "refunded" && !r.refunded_minor ? (r.amount_minor as number) : (r.refunded_minor as number),
    status: r.status as MoneyLine["status"], invoiceToken: (r.invoice_token as string | null) ?? null, bookingId: (r.booking_id as string | null) ?? null,
  }));
  return {
    lines,
    paidMinor: lines.reduce((s, l) => s + l.amountMinor, 0),
    refundedMinor: lines.reduce((s, l) => s + l.refundedMinor, 0),
  };
}
