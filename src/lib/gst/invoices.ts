import type pg from "pg";
import { financialYear, GST_STATES, invoiceNumber, isValidGstin, placeOfSupply, splitInclusive, GST_RATES_BP } from "./gst";
import { offerForBooking, offerForMembership, offerForPurchase, type AppliedOffer } from "../offers/offers";

// GST invoices and credit notes. Issued inside the same transaction that records the money (a captured payment, a paid
// package, a refund), so an invoice exists exactly when the payment does. Hosts without a tax profile get none.

type Db = Pick<pg.PoolClient, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{48}$/;

export interface TaxProfile { legalName: string; address: string; stateCode: string; gstin: string; sac: string; rateBp: number; invoicePrefix: string }

export interface Invoice {
  id: string; hostId: string; kind: "invoice" | "credit_note"; number: string; token: string; issuedAt: Date;
  buyerName: string; buyerEmail: string; supplier: { legalName: string; address: string; gstin: string; stateCode: string };
  placeOfSupply: string; description: string; sac: string; rateBp: number;
  taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; totalMinor: number;
  /** For a credit note: the invoice it reverses. */
  originalNumber: string | null;
  /** A discounted price: the value before the discount and the discount, both excluding GST (gross - discount = taxable). */
  discount?: { grossMinor: number; discountMinor: number; label: string } | null;
}

export type TaxProfileErrors = Partial<Record<"legalName" | "address" | "gstin" | "sac" | "rate" | "invoicePrefix", string>>;

/** Checks the host's GST details form. The state comes from the GSTIN's first two digits. */
export function validateTaxProfile(form: { legalName: string; address: string; gstin: string; sac: string; rate: string; invoicePrefix: string }):
  { ok: true; value: TaxProfile } | { ok: false; errors: TaxProfileErrors } {
  const errors: TaxProfileErrors = {};
  const legalName = form.legalName.trim();
  const address = form.address.trim();
  const gstin = form.gstin.trim().toUpperCase();
  const sac = form.sac.trim();
  const rateBp = Math.round(Number(form.rate) * 100);
  const invoicePrefix = form.invoicePrefix.trim().toUpperCase();
  if (legalName.length < 1 || legalName.length > 200) errors.legalName = "Enter the legal name on your GST registration.";
  if (address.length < 5 || address.length > 500) errors.address = "Enter your registered business address.";
  if (!isValidGstin(gstin)) errors.gstin = "That isn't a valid GSTIN. Check it against your registration certificate.";
  if (!/^\d{4,8}$/.test(sac)) errors.sac = "Enter the SAC code for your service (4 to 8 digits), e.g. 999293 for coaching.";
  if (!(GST_RATES_BP as readonly number[]).includes(rateBp)) errors.rate = "Pick your GST rate.";
  if (!/^[A-Z0-9]{1,4}$/.test(invoicePrefix)) errors.invoicePrefix = "Use 1 to 4 letters or digits.";
  // Credit notes are numbered CN…, so an invoice prefix starting CN could clash with one.
  else if (invoicePrefix.startsWith("CN")) errors.invoicePrefix = "Pick a prefix that doesn't start with CN: credit notes use that.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { legalName, address, stateCode: gstin.slice(0, 2), gstin, sac, rateBp, invoicePrefix } };
}

export async function getTaxProfile(db: Db, hostId: string): Promise<TaxProfile | null> {
  if (!UUID.test(hostId)) return null;
  const { rows: [r] } = await db.query("select legal_name, address, state_code, gstin, sac, rate_bp, invoice_prefix from tax_profiles where user_id = $1", [hostId]);
  return r ? { legalName: r.legal_name, address: r.address, stateCode: r.state_code, gstin: r.gstin, sac: r.sac, rateBp: r.rate_bp, invoicePrefix: r.invoice_prefix } : null;
}

export async function saveTaxProfile(db: Db, hostId: string, p: TaxProfile): Promise<void> {
  await db.query(
    `insert into tax_profiles (user_id, legal_name, address, state_code, gstin, sac, rate_bp, invoice_prefix) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (user_id) do update set legal_name = $2, address = $3, state_code = $4, gstin = $5, sac = $6, rate_bp = $7, invoice_prefix = $8, updated_at = now()`,
    [hostId, p.legalName, p.address, p.stateCode, p.gstin, p.sac, p.rateBp, p.invoicePrefix]);
}

/** Stops issuing invoices; those already issued stay. */
export async function removeTaxProfile(db: Db, hostId: string): Promise<void> {
  await db.query("delete from tax_profiles where user_id = $1", [hostId]);
}

/** The next serial for a host's series in a financial year. Called inside the issuing transaction, so numbers never skip or repeat. */
async function nextSeq(db: Db, hostId: string, series: "invoice" | "credit_note", fy: string): Promise<number> {
  const { rows: [r] } = await db.query(
    `insert into invoice_counters (host_id, series, fy, last) values ($1, $2, $3, 1)
     on conflict (host_id, series, fy) do update set last = invoice_counters.last + 1 returning last`, [hostId, series, fy]);
  return r.last as number;
}

interface Sale { hostId: string; totalMinor: number; buyerName: string; buyerEmail: string; description: string; paymentId?: string; purchaseId?: string; membershipGrantId?: string; offer?: AppliedOffer | null }

/**
 * A discount given at the time of supply and shown on the invoice is left out of the value GST is charged on (CGST Act
 * s.15(3)(a)). Prices are GST-inclusive, so the value before the discount is the list price less its GST, and the discount
 * is that less the taxable value of what was paid: the two always add back to the taxable value. Only when the offer's
 * charge is what was actually paid; a sliding-scale pick is the price itself, not a discount.
 */
export function discountLine(offer: AppliedOffer | null | undefined, totalMinor: number, taxableMinor: number, rateBp: number): NonNullable<Invoice["discount"]> | null {
  if (!offer || offer.discountMinor <= 0 || offer.chargeMinor !== totalMinor) return null;
  const grossMinor = Math.round((offer.listMinor * 10_000) / (10_000 + rateBp));
  const discountMinor = grossMinor - taxableMinor;
  return discountMinor > 0 ? { grossMinor, discountMinor, label: offer.label } : null;
}

async function issue(db: Db, sale: Sale, now: Date): Promise<string | null> {
  const profile = await getTaxProfile(db, sale.hostId);
  if (!profile) return null;
  const fy = financialYear(now);
  const seq = await nextSeq(db, sale.hostId, "invoice", fy);
  const pos = placeOfSupply(profile.stateCode, null);
  const split = splitInclusive(sale.totalMinor, profile.rateBp, pos !== profile.stateCode);
  const discount = discountLine(sale.offer, sale.totalMinor, split.taxableMinor, profile.rateBp);
  const { rows: [r] } = await db.query(
    `insert into invoices (host_id, kind, number, fy, seq, issued_at, payment_id, package_purchase_id, buyer_name, buyer_email, supplier, place_of_supply,
       description, sac, rate_bp, taxable_minor, cgst_minor, sgst_minor, igst_minor, total_minor, membership_grant_id, gross_minor, discount_minor, discount_label)
     values ($1, 'invoice', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) returning id`,
    [sale.hostId, invoiceNumber(profile.invoicePrefix, fy, seq), fy, seq, now, sale.paymentId ?? null, sale.purchaseId ?? null, sale.buyerName, sale.buyerEmail,
      JSON.stringify({ legalName: profile.legalName, address: profile.address, gstin: profile.gstin, stateCode: profile.stateCode }), pos,
      sale.description, profile.sac, profile.rateBp, split.taxableMinor, split.cgstMinor, split.sgstMinor, split.igstMinor, split.totalMinor, sale.membershipGrantId ?? null,
      discount?.grossMinor ?? null, discount?.discountMinor ?? null, discount?.label ?? null]);
  await queueInvoiceEmail(db, sale.hostId, r.id, sale.buyerEmail, now);
  return r.id as string;
}

async function queueInvoiceEmail(db: Db, hostId: string, invoiceId: string, to: string, now: Date): Promise<void> {
  await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     values (null, $1, 'email', 'invoice_guest', $2, $3, $4) on conflict (dedupe_key) do nothing`, [hostId, to, now, `invoice:${invoiceId}`]);
}

/**
 * The invoice line for a booking: "Coaching (60 min), 12 Oct 2026", or for a paid weekly series the per-session price
 * times the count: "Coaching (60 min) × 4 weekly sessions at ₹1,000.00 each, from 12 Oct 2026".
 */
export function bookingLine(b: { eventName: string; minutes: number; startAt: Date; sessions: number; amountMinor: number }): string {
  const what = `${b.eventName} (${b.minutes} min)`;
  if (b.sessions <= 1) return `${what}, ${istDate(b.startAt)}`;
  const each = (b.amountMinor / b.sessions / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${what} × ${b.sessions} weekly sessions at ₹${each} each, from ${istDate(b.startAt)}`;
}

/** A paid series' offer is recorded per session; its invoice shows it for every week the payment covers. */
function seriesOffer(offer: AppliedOffer | null, sessions: number): AppliedOffer | null {
  if (!offer || sessions <= 1) return offer;
  return { ...offer, listMinor: offer.listMinor * sessions, discountMinor: offer.discountMinor * sessions, chargeMinor: offer.chargeMinor * sessions };
}

/**
 * The discount columns of a credit note for `total` of an invoice: the invoice's own for a full refund, its share of
 * them for a partial one (some weeks of a paid series), so the note shows the same discount the refunded weeks got.
 */
function creditDiscount(v: { total_minor: number; gross_minor: number | null; discount_minor: number | null; discount_label: string | null }, total: number): [number | null, number | null, string | null] {
  if (v.gross_minor == null || v.discount_minor == null) return [null, null, null];
  if (total === v.total_minor) return [v.gross_minor, v.discount_minor, v.discount_label];
  const share = total / v.total_minor;
  return [Math.round(v.gross_minor * share), Math.round(v.discount_minor * share), v.discount_label];
}

/** A tax invoice for a captured booking payment (not a deposit). At most one per payment. */
export async function invoiceForPayment(db: Db, paymentId: string, now: Date): Promise<string | null> {
  const { rows: [p] } = await db.query(
    `select p.host_id, p.booking_id, p.amount_minor, p.kind, p.sessions, p.currency, i.name, i.email, e.name as event_name, b.start_at, b.end_at,
       exists (select 1 from invoices v where v.payment_id = p.id and v.kind = 'invoice') as done
     from payments p join bookings b on b.id = p.booking_id join invitees i on i.booking_id = b.id join event_types e on e.id = b.event_type_id
     where p.id = $1`, [paymentId]);
  // Indian GST invoices are for rupee payments (Razorpay). Stripe sends its own receipts for other currencies.
  if (!p || p.kind !== "payment" || p.done || p.currency !== "INR") return null;
  return issue(db, {
    hostId: p.host_id, totalMinor: p.amount_minor, buyerName: p.name, buyerEmail: p.email, paymentId, offer: seriesOffer(await offerForBooking(db, p.booking_id), p.sessions),
    description: bookingLine({ eventName: p.event_name, minutes: Math.round((new Date(p.end_at).getTime() - new Date(p.start_at).getTime()) / 60_000), startAt: new Date(p.start_at), sessions: p.sessions, amountMinor: p.amount_minor }),
  }, now);
}

/** A tax invoice for a paid session package. At most one per purchase. */
export async function invoiceForPurchase(db: Db, purchaseId: string, now: Date): Promise<string | null> {
  const { rows: [p] } = await db.query(
    `select p.host_id, p.price_minor, p.currency, p.guest_name, p.guest_email, p.sessions, k.name as package_name, e.name as event_name,
       exists (select 1 from invoices v where v.package_purchase_id = p.id and v.kind = 'invoice') as done
     from package_purchases p join packages k on k.id = p.package_id join event_types e on e.id = p.event_type_id where p.id = $1`, [purchaseId]);
  if (!p || p.done || p.currency !== "INR") return null;
  return issue(db, {
    hostId: p.host_id, totalMinor: p.price_minor, buyerName: p.guest_name, buyerEmail: p.guest_email, purchaseId, offer: await offerForPurchase(db, purchaseId),
    description: `${p.package_name}: ${p.sessions} × ${p.event_name}`,
  }, now);
}

/** A tax invoice for one month of a membership, issued with the charge that paid for it. At most one per charge. */
export async function invoiceForMembershipGrant(db: Db, grantId: string, now: Date): Promise<string | null> {
  const { rows: [g] } = await db.query(
    `select g.host_id, g.amount_minor, g.credits, g.period_start, g.period_end, m.id as membership_id, m.guest_name, m.guest_email, p.name as plan_name,
       exists (select 1 from invoices v where v.membership_grant_id = g.id and v.kind = 'invoice') as done
     from membership_grants g join memberships m on m.id = g.membership_id join membership_plans p on p.id = m.plan_id where g.id = $1`, [grantId]);
  if (!g || g.done) return null;
  return issue(db, {
    hostId: g.host_id, totalMinor: g.amount_minor, buyerName: g.guest_name, buyerEmail: g.guest_email, membershipGrantId: grantId,
    // A membership's offer is on its first month only; discountLine leaves it off any charge of another amount (renewals).
    offer: await offerForMembership(db, g.membership_id),
    description: `${g.plan_name}: ${g.credits} sessions, ${istDate(new Date(g.period_start))} to ${istDate(new Date(g.period_end))}`,
  }, now);
}

/**
 * A credit note reversing a refunded payment's invoice (CGST Act s.34), numbered in its own series. Without `amountMinor`,
 * or for the whole invoice, it uses the invoice's own figures and supplier details, so it mirrors exactly what was
 * charged. A partial refund (some weeks of a paid series) gets a note for that amount, its tax split the same way the
 * invoice's was; the notes never add up to more than the invoice. None if the payment had no invoice.
 */
export async function creditNoteForRefund(db: Db, paymentId: string, now: Date, amountMinor?: number): Promise<string | null> {
  const { rows: [v] } = await db.query(
    `select v.*, coalesce((select sum(c.total_minor) from invoices c where c.original_invoice_id = v.id), 0)::int as credited
     from invoices v where v.payment_id = $1 and v.kind = 'invoice' for update of v`, [paymentId]);
  if (!v) return null;
  const left = v.total_minor - v.credited;
  const total = Math.min(amountMinor ?? left, left);
  if (total <= 0) return null;
  const split = total === v.total_minor
    ? { taxableMinor: v.taxable_minor, cgstMinor: v.cgst_minor, sgstMinor: v.sgst_minor, igstMinor: v.igst_minor, totalMinor: v.total_minor }
    : splitInclusive(total, v.rate_bp, v.igst_minor > 0);
  const fy = financialYear(now);
  const seq = await nextSeq(db, v.host_id, "credit_note", fy);
  const prefix = String(v.number).split("/")[0].slice(0, 2);
  const { rows: [c] } = await db.query(
    `insert into invoices (host_id, kind, number, fy, seq, issued_at, payment_id, original_invoice_id, buyer_name, buyer_email, supplier, place_of_supply,
       description, sac, rate_bp, taxable_minor, cgst_minor, sgst_minor, igst_minor, total_minor, gross_minor, discount_minor, discount_label)
     values ($1, 'credit_note', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) returning id`,
    [v.host_id, `CN${prefix}/${fy}/${String(seq).padStart(6, "0")}`, fy, seq, now, paymentId, v.id, v.buyer_name, v.buyer_email, JSON.stringify(v.supplier),
      v.place_of_supply, `${total === v.total_minor ? "Refund" : "Part refund"} of ${v.description}`, v.sac, v.rate_bp, split.taxableMinor, split.cgstMinor, split.sgstMinor, split.igstMinor, split.totalMinor,
      ...creditDiscount(v, total)]);
  await queueInvoiceEmail(db, v.host_id, c.id, v.buyer_email, now);
  return c.id as string;
}

const SELECT = `select v.id, v.host_id, v.kind, v.number, v.token, v.issued_at, v.buyer_name, v.buyer_email, v.supplier, v.place_of_supply, v.description,
  v.sac, v.rate_bp, v.taxable_minor, v.cgst_minor, v.sgst_minor, v.igst_minor, v.total_minor, v.gross_minor, v.discount_minor, v.discount_label,
  o.number as original_number
  from invoices v left join invoices o on o.id = v.original_invoice_id`;
const toInvoice = (r: Record<string, unknown>): Invoice => ({
  id: r.id as string, hostId: r.host_id as string, kind: r.kind as Invoice["kind"], number: r.number as string, token: r.token as string, issuedAt: r.issued_at as Date,
  buyerName: r.buyer_name as string, buyerEmail: r.buyer_email as string, supplier: r.supplier as Invoice["supplier"], placeOfSupply: r.place_of_supply as string,
  description: r.description as string, sac: r.sac as string, rateBp: r.rate_bp as number, taxableMinor: r.taxable_minor as number,
  cgstMinor: r.cgst_minor as number, sgstMinor: r.sgst_minor as number, igstMinor: r.igst_minor as number, totalMinor: r.total_minor as number,
  originalNumber: (r.original_number as string | null) ?? null,
  discount: r.gross_minor == null ? null : { grossMinor: r.gross_minor as number, discountMinor: r.discount_minor as number, label: r.discount_label as string },
});

export async function invoiceByToken(db: Db, token: string): Promise<Invoice | null> {
  if (!TOKEN.test(token)) return null;
  const { rows: [r] } = await db.query(`${SELECT} where v.token = $1`, [token]);
  return r ? toInvoice(r) : null;
}

export async function invoiceById(db: Db, id: string): Promise<Invoice | null> {
  if (!UUID.test(id)) return null;
  const { rows: [r] } = await db.query(`${SELECT} where v.id = $1`, [id]);
  return r ? toInvoice(r) : null;
}

/** A host's invoices and credit notes, newest first, optionally within [from, to). */
export async function listInvoices(db: Db, hostId: string, range?: { from: Date; to: Date }): Promise<Invoice[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = range
    ? await db.query(`${SELECT} where v.host_id = $1 and v.issued_at >= $2 and v.issued_at < $3 order by v.issued_at desc`, [hostId, range.from, range.to])
    : await db.query(`${SELECT} where v.host_id = $1 order by v.issued_at desc limit 500`, [hostId]);
  return rows.map(toInvoice);
}

/** "2027-04-01": the calendar date in India, which is what an Indian invoice and its financial year go by. */
const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** "29 Karnataka". */
export const stateLabel = (code: string) => `${code} ${GST_STATES[code] ?? ""}`.trim();

/** One CSV row per document, for the host's accountant (GSTR-1 preparation). Credit notes carry negative amounts. */
export function invoicesCsv(invoices: Invoice[]): string {
  const rupees = (minor: number, sign: number) => ((sign * minor) / 100).toFixed(2);
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  // Text a guest typed must never run as a spreadsheet formula when the accountant opens the file.
  const text = (v: string) => cell(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  const head = ["Type", "Number", "Date", "Original invoice", "Buyer", "Buyer email", "Place of supply", "SAC", "Rate %", "Taxable value", "CGST", "SGST", "IGST", "Total"];
  const rows = invoices.map((v) => {
    const sign = v.kind === "credit_note" ? -1 : 1;
    return [
      ...[v.kind === "invoice" ? "Invoice" : "Credit note", v.number, istDate(v.issuedAt), v.originalNumber ?? "", v.buyerName, v.buyerEmail, stateLabel(v.placeOfSupply), v.sac].map(text),
      ...[(v.rateBp / 100).toFixed(2), rupees(v.taxableMinor, sign), rupees(v.cgstMinor, sign), rupees(v.sgstMinor, sign), rupees(v.igstMinor, sign), rupees(v.totalMinor, sign)].map(cell),
    ];
  });
  return [head, ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}
