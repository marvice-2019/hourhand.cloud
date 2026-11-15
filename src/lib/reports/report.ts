import type pg from "pg";
import { gstDocuments, isHostId, moneyEntries, sessionRows, type GstDocument, type MoneyEntry, type SessionRow } from "./ledger";
import { localMonth, monthsBetween, monthStart, type Period } from "./period";

// How the business did over a period: money per currency (never summed across currencies), GST from the invoices,
// sessions, top clients, event types and a monthly trend. summarize() is pure so the arithmetic is tested without a
// database; businessReport() feeds it from the ledger.

type Db = Pick<pg.Pool, "query">;

/** Razorpay's standard domestic rate (2%, plus 18% GST on the fee), for an estimate when the provider's fee isn't recorded. */
export const RAZORPAY_FEE_BP = 200;
/** A guest's cancellation counts as late inside this many minutes of the start, or inside the event type's cut-off if longer. */
export const LATE_CANCEL_MINUTES = 24 * 60;
export const TOP_CLIENTS = 10;

export interface CurrencyTotals {
  currency: string;
  /** Prices paid for bookings. */
  bookingsMinor: number;
  /** Session packages paid. */
  packagesMinor: number;
  /** bookings + packages: what came in for sales. */
  grossMinor: number;
  /** Prices paid back. */
  refundsMinor: number;
  /** gross − refunds. For INR this is what the GST invoices less credit notes add up to. */
  netSalesMinor: number;
  /** Deposits kept for no-shows (not invoiced). */
  depositsKeptMinor: number;
  /** net sales + deposits kept. */
  netIncomeMinor: number;
  /** Deposits paid in the period and still held (owed back unless the guest doesn't show); not income. */
  depositsHeldMinor: number;
  /** Fees as the provider reported them, or null when none were recorded. */
  feesReportedMinor: number | null;
  /** Razorpay's standard fee on what came in, for INR when fees weren't reported. */
  feeEstimateMinor: number | null;
}

export interface GstSummary {
  invoices: number;
  creditNotes: number;
  /** Invoices less credit notes. */
  totalMinor: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  /** CGST + SGST + IGST: the output tax owed. */
  outputTaxMinor: number;
}

export interface SessionStats {
  delivered: number;
  upcoming: number;
  noShows: number;
  /** No-shows ÷ (delivered + no-shows); null with nothing to divide. */
  noShowRate: number | null;
  /** Cancelled by a guest or by the host; reschedules and unpaid holds the system released aren't cancellations. */
  cancelled: number;
  cancelledByGuest: number;
  cancelledByHost: number;
  /** Guest cancellations inside LATE_CANCEL_MINUTES (or the event type's cut-off) of the start. */
  lateCancellations: number;
}

export interface ClientLine { clientKey: string; name: string; currency: string; netMinor: number; sessions: number }
export interface EventTypeLine { eventTypeId: string; eventName: string; currency: string; bookingsMinor: number; packagesMinor: number; depositsKeptMinor: number; sessions: number }
export interface TrendPoint { month: string; currency: string; netSalesMinor: number; netIncomeMinor: number }

export interface BusinessReport {
  period: Period;
  /** INR first, then others alphabetically; a currency appears once it has any money. */
  currencies: CurrencyTotals[];
  gst: GstSummary;
  /** INR net sales minus what the invoices and credit notes add up to: 0 when every sale was invoiced. */
  uninvoicedMinor: number;
  sessions: SessionStats;
  topClients: ClientLine[];
  byEventType: EventTypeLine[];
  trend: TrendPoint[];
  trendMonths: string[];
}

const byCurrency = (a: string, b: string) => (a === b ? 0 : a === "INR" ? -1 : b === "INR" ? 1 : a.localeCompare(b));

function totalsFor(currency: string, entries: MoneyEntry[]): CurrencyTotals {
  const sum = (f: (e: MoneyEntry) => boolean) => entries.reduce((s, e) => (f(e) ? s + e.amountMinor : s), 0);
  const bookingsMinor = sum((e) => e.type === "sale" && e.source === "booking");
  const packagesMinor = sum((e) => e.type === "sale" && e.source === "package");
  const refundsMinor = sum((e) => e.type === "refund");
  const depositsKeptMinor = sum((e) => e.type === "deposit_kept");
  const grossMinor = bookingsMinor + packagesMinor;
  const netSalesMinor = grossMinor - refundsMinor;
  const income = entries.filter((e) => e.type === "sale" || e.type === "deposit_kept");
  const reported = income.filter((e) => e.feeMinor !== null);
  const received = grossMinor + depositsKeptMinor;
  return {
    currency, bookingsMinor, packagesMinor, grossMinor, refundsMinor, netSalesMinor, depositsKeptMinor,
    netIncomeMinor: netSalesMinor + depositsKeptMinor, depositsHeldMinor: sum((e) => e.type === "deposit_held"),
    feesReportedMinor: reported.length ? reported.reduce((s, e) => s + (e.feeMinor ?? 0), 0) : null,
    feeEstimateMinor: currency === "INR" && reported.length < income.length ? Math.round((received * RAZORPAY_FEE_BP * 1.18) / 10_000) : null,
  };
}

export function gstSummary(docs: GstDocument[]): GstSummary {
  const g: GstSummary = { invoices: 0, creditNotes: 0, totalMinor: 0, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, outputTaxMinor: 0 };
  for (const d of docs) {
    const sign = d.kind === "credit_note" ? -1 : 1;
    if (d.kind === "credit_note") g.creditNotes += 1; else g.invoices += 1;
    g.totalMinor += sign * d.totalMinor;
    g.taxableMinor += sign * d.taxableMinor;
    g.cgstMinor += sign * d.cgstMinor;
    g.sgstMinor += sign * d.sgstMinor;
    g.igstMinor += sign * d.igstMinor;
  }
  g.outputTaxMinor = g.cgstMinor + g.sgstMinor + g.igstMinor;
  return g;
}

export function sessionStats(rows: SessionRow[], now: Date): SessionStats {
  const s: SessionStats = { delivered: 0, upcoming: 0, noShows: 0, noShowRate: null, cancelled: 0, cancelledByGuest: 0, cancelledByHost: 0, lateCancellations: 0 };
  for (const r of rows) {
    if (r.status === "confirmed") {
      if (r.startAt > now) s.upcoming += 1;
      else if (r.noShow) s.noShows += 1;
      else s.delivered += 1;
    } else if (r.status === "cancelled" && !r.rescheduled && (r.cancelledBy === "guest" || r.cancelledBy === "host")) {
      s.cancelled += 1;
      if (r.cancelledBy === "host") s.cancelledByHost += 1;
      else {
        s.cancelledByGuest += 1;
        const window = Math.max(LATE_CANCEL_MINUTES, r.cancelCutoffMinutes) * 60_000;
        if (r.cancelledAt && r.cancelledAt.getTime() > r.startAt.getTime() - window) s.lateCancellations += 1;
      }
    }
  }
  const attended = s.delivered + s.noShows;
  s.noShowRate = attended ? s.noShows / attended : null;
  return s;
}

export interface SummaryInput {
  period: Period;
  now: Date;
  /** Money entries from at least the start of the trend to the period's end. */
  money: MoneyEntry[];
  sessions: SessionRow[];
  documents: GstDocument[];
  trendFrom: Date;
}

export function summarize({ period, now, money, sessions, documents, trendFrom }: SummaryInput): BusinessReport {
  const tz = period.timezone;
  const inPeriod = money.filter((e) => e.at >= period.from && e.at < period.to);
  const currencies = [...new Set(inPeriod.map((e) => e.currency))].sort(byCurrency).map((c) => totalsFor(c, inPeriod.filter((e) => e.currency === c)));
  const gst = gstSummary(documents);
  const inr = currencies.find((c) => c.currency === "INR");
  const stats = sessionStats(sessions, now);

  // Clients: net of refunds, plus deposits they forfeited; sessions they actually had.
  const delivered = new Map<string, number>();
  const types = new Map<string, number>();
  for (const r of sessions) {
    if (r.status === "confirmed" && r.startAt <= now && !r.noShow) {
      delivered.set(r.clientKey, (delivered.get(r.clientKey) ?? 0) + 1);
      types.set(r.eventTypeId, (types.get(r.eventTypeId) ?? 0) + 1);
    }
  }
  const clients = new Map<string, ClientLine>();
  const lines = new Map<string, EventTypeLine>();
  for (const e of [...inPeriod].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (e.type === "deposit_held") continue;
    const sign = e.type === "refund" ? -1 : 1;
    if (e.clientKey) {
      const ck = `${e.currency}|${e.clientKey}`;
      const c = clients.get(ck) ?? clients.set(ck, { clientKey: e.clientKey, name: e.clientName, currency: e.currency, netMinor: 0, sessions: delivered.get(e.clientKey) ?? 0 }).get(ck)!;
      c.netMinor += sign * e.amountMinor;
      if (e.clientName) c.name = e.clientName;
    }
    const lk = `${e.currency}|${e.eventTypeId}`;
    const l = lines.get(lk) ?? lines.set(lk, { eventTypeId: e.eventTypeId, eventName: e.eventName, currency: e.currency, bookingsMinor: 0, packagesMinor: 0, depositsKeptMinor: 0, sessions: types.get(e.eventTypeId) ?? 0 }).get(lk)!;
    if (e.type === "deposit_kept") l.depositsKeptMinor += e.amountMinor;
    else if (e.source === "package") l.packagesMinor += sign * e.amountMinor;
    else l.bookingsMinor += sign * e.amountMinor;
  }
  const shown = new Map<string, number>();
  const topClients = [...clients.values()].filter((c) => c.netMinor > 0)
    .sort((a, b) => byCurrency(a.currency, b.currency) || b.netMinor - a.netMinor || a.name.localeCompare(b.name))
    .filter((c) => { const n = shown.get(c.currency) ?? 0; shown.set(c.currency, n + 1); return n < TOP_CLIENTS; });
  const lineTotal = (l: EventTypeLine) => l.bookingsMinor + l.packagesMinor + l.depositsKeptMinor;
  const byEventType = [...lines.values()].sort((a, b) => byCurrency(a.currency, b.currency) || lineTotal(b) - lineTotal(a) || a.eventName.localeCompare(b.eventName));

  const trendMonths = monthsBetween(trendFrom, period.to, tz);
  const trendEntries = money.filter((e) => e.at >= trendFrom && e.at < period.to);
  const trend: TrendPoint[] = [];
  for (const c of [...new Set(trendEntries.map((e) => e.currency))].sort(byCurrency)) {
    for (const month of trendMonths) {
      const t = totalsFor(c, trendEntries.filter((e) => e.currency === c && localMonth(e.at, tz) === month));
      trend.push({ month, currency: c, netSalesMinor: t.netSalesMinor, netIncomeMinor: t.netIncomeMinor });
    }
  }
  return { period, currencies, gst, uninvoicedMinor: (inr?.netSalesMinor ?? 0) - gst.totalMinor, sessions: stats, topClients, byEventType, trend, trendMonths };
}

/**
 * The report for a host's period. The trend covers up to 12 months ending with the period's last month, never earlier
 * than `earliest` (the plan's window).
 */
export async function businessReport(db: Db, hostId: string, period: Period, now: Date, earliest: Date | null = null): Promise<BusinessReport | null> {
  if (!isHostId(hostId)) return null;
  const year = monthStart(new Date(period.to.getTime() - 1), period.timezone, 11);
  let trendFrom = year < period.from ? year : period.from;
  if (earliest && trendFrom < earliest) trendFrom = earliest > period.from ? period.from : earliest;
  const [money, sessions, documents] = await Promise.all([
    moneyEntries(db, hostId, trendFrom, period.to),
    sessionRows(db, hostId, period.from, period.to),
    gstDocuments(db, hostId, period.from, period.to),
  ]);
  return summarize({ period, now, money, sessions, documents, trendFrom });
}
