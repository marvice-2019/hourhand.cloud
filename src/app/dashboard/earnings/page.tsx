import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";
import { reportAccess } from "@/lib/reports/access";
import { GST_NOTE } from "@/lib/reports/csv";
import { dayLabel, money, monthLabel, percent } from "@/lib/reports/format";
import { PERIOD_KINDS, PERIOD_LABELS, type Period } from "@/lib/reports/period";
import { businessReport, type CurrencyTotals } from "@/lib/reports/report";

export const dynamic = "force-dynamic";

type Search = { period?: string; from?: string; to?: string; month?: string };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The query string that asks for this exact period again (for export links). */
const periodQuery = (p: Period) => p.kind === "custom" || p.clamped ? `period=custom&from=${p.first}&to=${p.last}` : `period=${p.kind}`;

export default async function EarningsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireOwnAccount();
  const raw = await searchParams;
  const q: Search = { period: one(raw.period), from: one(raw.from), to: one(raw.to), month: one(raw.month) };
  const now = new Date();
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const plan = pool ? await hostPlan(pool, user.id) : "free";
  const { period, earliest, canExport } = reportAccess(q, user.timezone, plan, now);
  const r = pool ? await businessReport(pool, user.id, period, now, earliest) : null;
  const limited = earliest !== null;
  const select = `mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;

  const tile = (title: string, value: string, hint?: string) => (
    <Card key={title}><p className="text-sm text-text-muted">{title}</p><p className="mt-1 text-xl font-semibold text-text">{value}</p>{hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}</Card>
  );
  const moneyTiles = (c: CurrencyTotals) => {
    const m = (v: number) => money(v, c.currency);
    return [
      tile("Gross collected", m(c.grossMinor), "Session payments and packages"),
      tile("Refunds", m(c.refundsMinor)),
      tile("Net sales", m(c.netSalesMinor), "Gross − refunds"),
      tile("Packages", m(c.packagesMinor)),
      tile("Forfeited deposits", m(c.depositsKeptMinor), "Kept from no-shows; not invoiced"),
      tile("Net income", m(c.netIncomeMinor), "Net sales + forfeited deposits"),
      ...(c.currency === "INR" && r ? [tile("GST collected (output tax)", m(r.gst.outputTaxMinor), "From your invoices less credit notes; owed to the government")] : []),
      c.feesReportedMinor !== null
        ? tile("Gateway fees", m(c.feesReportedMinor + (c.feeEstimateMinor ?? 0)),
          [`As ${c.currency === "INR" ? "Razorpay" : "Stripe"} charged them, tax included${c.feeTaxReportedMinor ? ` (${m(c.feeTaxReportedMinor)} of it is tax${c.currency === "INR" ? ", claimable as input tax" : ""})` : ""}`,
            c.feeEstimateMinor !== null ? `; includes ≈ ${m(c.feeEstimateMinor)} estimated for payments whose fee isn't in yet` : ""].join(""))
        : c.feeEstimateMinor !== null ? tile("Gateway fees (estimate)", `≈ ${m(c.feeEstimateMinor)}`, "Razorpay's standard 2% + GST until Razorpay reports the real fee") : null,
    ];
  };
  const maxTrend = r ? Math.max(1, ...r.trend.map((t) => Math.abs(t.netIncomeMinor))) : 1;

  return (
    <div>
      <h1 className="font-display text-xl text-text">Earnings</h1>
      <form method="get" action="/dashboard/earnings" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="period" className="block text-sm font-semibold text-text">Period</label>
          <select id="period" name="period" defaultValue={period.kind} className={select}>
            {PERIOD_KINDS.filter((k) => !limited || k === "last_30" || k === "this_month" || k === "custom").map((k) => <option key={k} value={k}>{PERIOD_LABELS[k]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="block text-sm font-semibold text-text">From <span className="font-normal text-text-muted">(custom)</span></label>
          <input id="from" name="from" type="date" defaultValue={period.first} className={select} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm font-semibold text-text">To</label>
          <input id="to" name="to" type="date" defaultValue={period.last} className={select} />
        </div>
        <Button type="submit">Show</Button>
      </form>
      <p className="mt-3 text-sm text-text-muted">
        {dayLabel(period.first)} to {dayLabel(period.last)}, in your time zone ({period.timezone}). The year runs April to March.
      </p>
      {limited && (
        <p role="status" className="mt-2 max-w-3xl text-sm text-text">
          {period.clamped ? "Free shows the last 30 days, so this starts on " + dayLabel(period.first) + ". " : "Free shows the last 30 days. "}
          <Link href="/dashboard/plan" className="font-semibold text-accent underline">Solo or Duo</Link> shows every period and adds the GST and P&amp;L downloads.
        </p>
      )}

      {!r ? <p className="mt-6 text-text-muted">Earnings need payments, which this demo copy doesn&apos;t have.</p> : (
        <>
          {r.currencies.length === 0 && <p className="mt-6 text-text-muted">No money came in or went out in this period.</p>}
          {r.currencies.map((c) => (
            <section key={c.currency} aria-labelledby={`money-${c.currency}`} className="mt-6">
              <h2 id={`money-${c.currency}`} className="font-semibold text-text">Money{r.currencies.length > 1 ? ` in ${c.currency}` : ""}</h2>
              <div className="mt-2 grid max-w-3xl gap-3 sm:grid-cols-3">{moneyTiles(c)}</div>
              {c.depositsHeldMinor > 0 && <p className="mt-2 max-w-3xl text-sm text-text-muted">{money(c.depositsHeldMinor, c.currency)} in deposits is held until those sessions are done; it isn&apos;t income yet.</p>}
            </section>
          ))}
          {r.currencies.length > 1 && <p className="mt-2 max-w-3xl text-sm text-text-muted">Each currency is shown on its own; they&apos;re never added together.</p>}
          {(r.gst.invoices > 0 || r.gst.creditNotes > 0) && (
            <p className="mt-3 max-w-3xl text-sm text-text-muted">
              {r.uninvoicedMinor === 0
                ? `Net sales match your ${r.gst.invoices} invoice${r.gst.invoices === 1 ? "" : "s"} less ${r.gst.creditNotes} credit note${r.gst.creditNotes === 1 ? "" : "s"} for this period.`
                : `Your invoices less credit notes come to ${money(r.gst.totalMinor, "INR")}; ${money(r.uninvoicedMinor, "INR")} of net sales has no invoice (for example, paid before you added GST details, or a late payment refunded straight away).`}
            </p>
          )}

          <section aria-labelledby="sessions" className="mt-8">
            <h2 id="sessions" className="font-semibold text-text">Sessions</h2>
            <dl className="mt-2 flex flex-wrap gap-6">
              {([
                ["Delivered", r.sessions.delivered], ["Coming up", r.sessions.upcoming], ["No-shows", r.sessions.noShows], ["No-show rate", percent(r.sessions.noShowRate)],
                ["Cancellations", r.sessions.cancelled], ["Late cancellations", r.sessions.lateCancellations], ["By guests", r.sessions.cancelledByGuest], ["By you", r.sessions.cancelledByHost],
              ] as const).map(([k, v]) => <div key={k}><dt className="text-sm text-text-muted">{k}</dt><dd className="text-lg font-semibold text-text">{v}</dd></div>)}
            </dl>
            <p className="mt-2 text-xs text-text-muted">A guest&apos;s cancellation is late inside 24 hours of the start (or your cancellation cut-off, if longer). Reschedules aren&apos;t cancellations.</p>
          </section>

          {r.trend.length > 0 && (
            <section aria-labelledby="trend" className="mt-8">
              <h2 id="trend" className="font-semibold text-text">Month by month</h2>
              <table className="mt-2 w-full max-w-2xl text-left text-sm">
                <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">Month</th><th className="py-2 pr-4 font-medium">Net income</th><th className="w-1/2 py-2 font-medium"><span className="sr-only">Bar</span></th></tr></thead>
                <tbody>
                  {r.trend.map((t) => (
                    <tr key={`${t.currency}-${t.month}`} className="border-t border-border text-text">
                      <td className="py-2 pr-4">{monthLabel(t.month)}{r.currencies.length > 1 ? ` (${t.currency})` : ""}</td>
                      <td className="py-2 pr-4">{money(t.netIncomeMinor, t.currency)}</td>
                      <td className="py-2" aria-hidden="true"><div className={`h-3 rounded ${t.netIncomeMinor < 0 ? "bg-danger" : "bg-accent"}`} style={{ width: `${(Math.abs(t.netIncomeMinor) / maxTrend) * 100}%` }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {r.topClients.length > 0 && (
            <section aria-labelledby="clients" className="mt-8">
              <h2 id="clients" className="font-semibold text-text">Top clients</h2>
              <table className="mt-2 w-full max-w-2xl text-left text-sm">
                <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">Client</th><th className="py-2 pr-4 font-medium">Net</th><th className="py-2 font-medium">Sessions</th></tr></thead>
                <tbody>
                  {r.topClients.map((c) => (
                    <tr key={`${c.currency}-${c.clientKey}`} className="border-t border-border text-text">
                      <td className="py-2 pr-4">{c.name || c.clientKey}<span className="block text-xs text-text-muted">{c.clientKey}</span></td>
                      <td className="py-2 pr-4">{money(c.netMinor, c.currency)}</td><td className="py-2">{c.sessions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {r.byEventType.length > 0 && (
            <section aria-labelledby="by-type" className="mt-8">
              <h2 id="by-type" className="font-semibold text-text">By event type</h2>
              <table className="mt-2 w-full max-w-2xl text-left text-sm">
                <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">Event type</th><th className="py-2 pr-4 font-medium">Bookings</th><th className="py-2 pr-4 font-medium">Packages</th><th className="py-2 pr-4 font-medium">Deposits kept</th><th className="py-2 font-medium">Sessions</th></tr></thead>
                <tbody>
                  {r.byEventType.map((l) => (
                    <tr key={`${l.currency}-${l.eventTypeId}`} className="border-t border-border text-text">
                      <td className="py-2 pr-4">{l.eventName}</td><td className="py-2 pr-4">{money(l.bookingsMinor, l.currency)}</td>
                      <td className="py-2 pr-4">{money(l.packagesMinor, l.currency)}</td><td className="py-2 pr-4">{money(l.depositsKeptMinor, l.currency)}</td><td className="py-2">{l.sessions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section aria-labelledby="downloads" className="mt-8">
            <h2 id="downloads" className="font-semibold text-text">Downloads</h2>
            {canExport ? (
              <ul className="mt-2 space-y-1">
                <li><a href={`/dashboard/earnings/export?type=gst&${periodQuery(period)}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">GST register (CSV)</a> <span className="text-sm text-text-muted">{GST_NOTE}</span></li>
                <li><a href={`/dashboard/earnings/export?type=pnl&${periodQuery(period)}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Profit and loss (CSV)</a></li>
              </ul>
            ) : (
              <p className="mt-2 text-sm text-text-muted">The GST register and P&amp;L downloads are on <Link href="/dashboard/plan" className="font-semibold text-accent underline">Solo and Duo</Link>.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
