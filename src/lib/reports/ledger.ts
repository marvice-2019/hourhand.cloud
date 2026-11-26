import type pg from "pg";

// The one place reports read money, sessions and GST documents from. Read-only: nothing here writes. Each kind of money
// is one query in MONEY_SOURCES, so a new way of getting paid (Stripe, memberships, offers) is one more entry here and
// every report, total and export picks it up. Amounts stay in minor units and in their own currency.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isHostId = (id: string) => UUID.test(id);

/**
 * sale: a price paid (counted when paid). refund: a price paid back (counted when refunded). deposit_kept: a no-show's
 * deposit the host keeps (counted on the session's date, like the monthly email). deposit_held: a deposit paid and not
 * yet refunded or kept; not income. fee: the gateway's fee on money captured (counted when paid, whatever happened to the
 * money later, as a refund doesn't give it back).
 */
export type MoneyType = "sale" | "refund" | "deposit_kept" | "deposit_held" | "fee";
export type MoneySource = "booking" | "package" | "deposit" | "membership";

export interface MoneyEntry {
  type: MoneyType;
  source: MoneySource;
  currency: string;
  amountMinor: number;
  at: Date;
  /** Lower-cased email: how a client is recognised across bookings and packages. */
  clientKey: string;
  clientName: string;
  eventTypeId: string;
  eventName: string;
  /** On a sale or kept deposit, the gateway's fee on it as reported, or null while it isn't known (reports estimate it). */
  feeMinor: number | null;
  /** On a fee entry, the GST part of the fee (input tax for a registered host); null elsewhere. */
  feeTaxMinor: number | null;
}

interface MoneySourceQuery { type: MoneyType; source: MoneySource; sql: string }

// The first invitee of a booking (a group seat is its own booking, so there is one), never a row per guest.
const INVITEE = "left join lateral (select i.name, i.email, i.no_show_at from invitees i where i.booking_id = b.id order by i.created_at limit 1) i on true";
const WHO = "lower(coalesce(i.email, ''))::text as client_key, coalesce(i.name, '') as client_name, e.id as event_type_id, e.name as event_name";
const COLS = `${WHO}, p.fee_minor::bigint as fee_minor, null::bigint as fee_tax_minor`;

export const MONEY_SOURCES: MoneySourceQuery[] = [
  {
    type: "sale", source: "booking",
    sql: `select p.currency, p.amount_minor::bigint as amount_minor, p.paid_at as at, ${COLS}
          from payments p join bookings b on b.id = p.booking_id join event_types e on e.id = b.event_type_id ${INVITEE}
          where p.host_id = $1 and p.kind = 'payment' and p.status in ('paid', 'refund_pending', 'refunded') and p.paid_at >= $2 and p.paid_at < $3`,
  },
  {
    // The refund that completes a payment, dated on the payment, less any weeks of a paid series refunded before it.
    type: "refund", source: "booking",
    sql: `select p.currency, (p.refunded_minor - coalesce((select sum(r.amount_minor) from payment_refunds r where r.payment_id = p.id), 0))::bigint as amount_minor, p.refunded_at as at, ${COLS}
          from payments p join bookings b on b.id = p.booking_id join event_types e on e.id = b.event_type_id ${INVITEE}
          where p.host_id = $1 and p.kind = 'payment' and p.status = 'refunded' and p.refunded_minor - coalesce((select sum(r.amount_minor) from payment_refunds r where r.payment_id = p.id), 0) > 0
            and p.refunded_at >= $2 and p.refunded_at < $3`,
  },
  {
    // Some weeks of a paid series refunded on their own, each in the month it was made. The fee stays on the sale.
    type: "refund", source: "booking",
    sql: `select p.currency, r.amount_minor::bigint as amount_minor, r.refunded_at as at, ${WHO}, null::bigint as fee_minor, null::bigint as fee_tax_minor
          from payment_refunds r join payments p on p.id = r.payment_id join bookings b on b.id = p.booking_id join event_types e on e.id = b.event_type_id ${INVITEE}
          where p.host_id = $1 and p.kind = 'payment' and r.refunded_at >= $2 and r.refunded_at < $3`,
  },
  {
    type: "sale", source: "package",
    sql: `select k.currency, k.price_minor::bigint as amount_minor, k.paid_at as at, lower(k.guest_email)::text as client_key, k.guest_name as client_name,
            e.id as event_type_id, e.name as event_name, k.fee_minor::bigint as fee_minor, null::bigint as fee_tax_minor
          from package_purchases k join event_types e on e.id = k.event_type_id
          where k.host_id = $1 and k.status = 'paid' and k.paid_at >= $2 and k.paid_at < $3`,
  },
  {
    // A month of a membership, counted when its charge is verified (the moment its invoice is issued). Its "event type"
    // is the membership plan, as a plan can cover several event types.
    type: "sale", source: "membership",
    sql: `select m.currency, g.amount_minor::bigint as amount_minor, g.granted_at as at, lower(m.guest_email)::text as client_key, m.guest_name as client_name,
            'plan:' || p.id::text as event_type_id, p.name as event_name, null::bigint as fee_minor, null::bigint as fee_tax_minor
          from membership_grants g join memberships m on m.id = g.membership_id join membership_plans p on p.id = m.plan_id
          where g.host_id = $1 and g.granted_at >= $2 and g.granted_at < $3`,
  },
  {
    type: "deposit_kept", source: "deposit",
    sql: `select p.currency, p.amount_minor::bigint as amount_minor, b.start_at as at, ${COLS}
          from payments p join bookings b on b.id = p.booking_id join event_types e on e.id = b.event_type_id ${INVITEE}
          where p.host_id = $1 and p.kind = 'deposit' and p.status = 'paid' and i.no_show_at is not null and b.start_at >= $2 and b.start_at < $3`,
  },
  {
    type: "deposit_held", source: "deposit",
    sql: `select p.currency, p.amount_minor::bigint as amount_minor, p.paid_at as at, ${COLS}
          from payments p join bookings b on b.id = p.booking_id join event_types e on e.id = b.event_type_id ${INVITEE}
          where p.host_id = $1 and p.kind = 'deposit' and p.status = 'paid' and i.no_show_at is null and p.paid_at >= $2 and p.paid_at < $3`,
  },
  {
    // Fees on every captured booking payment and deposit, refunded or not; the amount is the fee, not the payment.
    type: "fee", source: "booking",
    sql: `select p.currency, p.fee_minor::bigint as amount_minor, p.paid_at as at, ${WHO}, null::bigint as fee_minor, p.fee_tax_minor::bigint as fee_tax_minor
          from payments p join bookings b on b.id = p.booking_id join event_types e on e.id = b.event_type_id ${INVITEE}
          where p.host_id = $1 and p.fee_minor is not null and p.status in ('paid', 'refund_pending', 'refunded') and p.paid_at >= $2 and p.paid_at < $3`,
  },
  {
    type: "fee", source: "package",
    sql: `select k.currency, k.fee_minor::bigint as amount_minor, k.paid_at as at, lower(k.guest_email)::text as client_key, k.guest_name as client_name,
            e.id as event_type_id, e.name as event_name, null::bigint as fee_minor, k.fee_tax_minor::bigint as fee_tax_minor
          from package_purchases k join event_types e on e.id = k.event_type_id
          where k.host_id = $1 and k.status = 'paid' and k.fee_minor is not null and k.paid_at >= $2 and k.paid_at < $3`,
  },
];

/** Every money entry for a host within [from, to). */
export async function moneyEntries(db: Db, hostId: string, from: Date, to: Date): Promise<MoneyEntry[]> {
  if (!isHostId(hostId)) return [];
  const results = await Promise.all(MONEY_SOURCES.map((s) => db.query(s.sql, [hostId, from, to]).then((r) => ({ s, rows: r.rows }))));
  return results.flatMap(({ s, rows }) => rows.map((r): MoneyEntry => ({
    type: s.type, source: s.source, currency: String(r.currency).toUpperCase(), amountMinor: Number(r.amount_minor), at: new Date(r.at),
    clientKey: r.client_key, clientName: r.client_name, eventTypeId: r.event_type_id, eventName: r.event_name,
    feeMinor: r.fee_minor === null || r.fee_minor === undefined ? null : Number(r.fee_minor),
    feeTaxMinor: r.fee_tax_minor === null || r.fee_tax_minor === undefined ? null : Number(r.fee_tax_minor),
  })));
}

export interface SessionRow {
  startAt: Date;
  status: "confirmed" | "cancelled" | "pending_payment" | "pending_approval";
  cancelledBy: "host" | "guest" | "system" | null;
  cancelledAt: Date | null;
  rescheduled: boolean;
  noShow: boolean;
  cancelCutoffMinutes: number;
  clientKey: string;
  eventTypeId: string;
  eventName: string;
}

/** Bookings starting within [from, to), one row per guest's booking. */
export async function sessionRows(db: Db, hostId: string, from: Date, to: Date): Promise<SessionRow[]> {
  if (!isHostId(hostId)) return [];
  const { rows } = await db.query(
    `select b.start_at, b.status, b.cancelled_by, b.cancelled_at, coalesce(b.cancel_reason, '') = 'Rescheduled' as rescheduled, i.no_show_at is not null as no_show,
       e.cancel_cutoff_minutes, lower(coalesce(i.email, ''))::text as client_key, e.id as event_type_id, e.name as event_name
     from bookings b join event_types e on e.id = b.event_type_id ${INVITEE}
     where b.host_id = $1 and b.start_at >= $2 and b.start_at < $3`, [hostId, from, to]);
  return rows.map((r) => ({
    startAt: new Date(r.start_at), status: r.status, cancelledBy: r.cancelled_by, cancelledAt: r.cancelled_at ? new Date(r.cancelled_at) : null,
    rescheduled: r.rescheduled, noShow: r.no_show, cancelCutoffMinutes: Number(r.cancel_cutoff_minutes), clientKey: r.client_key,
    eventTypeId: r.event_type_id, eventName: r.event_name,
  }));
}

export interface GstDocument {
  kind: "invoice" | "credit_note";
  number: string;
  issuedAt: Date;
  buyerName: string;
  /** Hourhand doesn't record guests' GSTINs yet, so this is empty (a B2C supply) until it does. */
  buyerGstin: string;
  supplierState: string;
  placeOfSupply: string;
  sac: string;
  rateBp: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
  /** For a credit note, the invoice it reverses; for an invoice, the credit notes that reverse it (whenever issued). */
  references: string[];
}

/** A host's invoices and credit notes issued within [from, to), oldest first. Amounts are as issued (positive). */
export async function gstDocuments(db: Db, hostId: string, from: Date, to: Date): Promise<GstDocument[]> {
  if (!isHostId(hostId)) return [];
  const { rows } = await db.query(
    `select v.kind, v.number, v.issued_at, v.buyer_name, v.supplier->>'stateCode' as supplier_state, v.place_of_supply, v.sac, v.rate_bp,
       v.taxable_minor, v.cgst_minor, v.sgst_minor, v.igst_minor, v.total_minor,
       case when v.kind = 'credit_note' then array[o.number]
            else array(select c.number from invoices c where c.original_invoice_id = v.id order by c.issued_at) end as refs
     from invoices v left join invoices o on o.id = v.original_invoice_id
     where v.host_id = $1 and v.issued_at >= $2 and v.issued_at < $3 order by v.issued_at, v.kind desc, v.number`, [hostId, from, to]);
  return rows.map((r) => ({
    kind: r.kind, number: r.number, issuedAt: new Date(r.issued_at), buyerName: r.buyer_name, buyerGstin: "", supplierState: r.supplier_state ?? "",
    placeOfSupply: r.place_of_supply, sac: r.sac, rateBp: r.rate_bp, taxableMinor: r.taxable_minor, cgstMinor: r.cgst_minor, sgstMinor: r.sgst_minor,
    igstMinor: r.igst_minor, totalMinor: r.total_minor, references: (r.refs as (string | null)[]).filter((x): x is string => !!x),
  }));
}
