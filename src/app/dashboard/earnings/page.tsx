import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { reportAccess } from "@/lib/reports/access";
import { percent } from "@/lib/reports/format";
import { PERIOD_KINDS, type Period, type PeriodKind } from "@/lib/reports/period";
import { businessReport, type CurrencyTotals } from "@/lib/reports/report";

export const dynamic = "force-dynamic";

type Search = { period?: string; from?: string; to?: string; month?: string };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const PERIOD_KEYS: Record<PeriodKind, HostKey> = {
  last_30: "earnings.periodLast30", this_month: "earnings.periodThisMonth", last_month: "earnings.periodLastMonth",
  this_quarter: "earnings.periodThisQuarter", last_quarter: "earnings.periodLastQuarter", this_fy: "earnings.periodThisFy",
  last_fy: "earnings.periodLastFy", custom: "earnings.periodCustom",
};

/** The query string that asks for this exact period again (for export links). */
const periodQuery = (p: Period) =>
  new URLSearchParams(p.kind === "custom" || p.clamped ? { period: "custom", from: p.first, to: p.last } : { period: p.kind }).toString();

export default async function EarningsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireOwnAccount();
  const { t, tNodes, money, month, dayDate } = await getHostI18n();
  const raw = await searchParams;
  const q: Search = { period: one(raw.period), from: one(raw.from), to: one(raw.to), month: one(raw.month) };
  const now = new Date();
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const plan = pool ? await hostPlan(pool, user.id) : "free";
  const { period, earliest, canExport } = reportAccess(q, user.timezone, plan, now);
  const r = pool ? await businessReport(pool, user.id, period, now, earliest) : null;
  const limited = earliest !== null;
  const select = `mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;
  const monthName = (m: string) => month(new Date(`${m}-01T00:00:00Z`));

  const tile = (title: string, value: string, hint?: string) => (
    <Card key={title}><p className="text-sm text-text-muted">{title}</p><p className="mt-1 text-xl font-semibold text-text">{value}</p>{hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}</Card>
  );
  const feeHint = (c: CurrencyTotals) => {
    const m = (v: number) => money(v, c.currency);
    return [
      t(c.currency === "INR" ? "earnings.feesRazorpay" : "earnings.feesStripe"),
      c.feeTaxReportedMinor ? t(c.currency === "INR" ? "earnings.feesTaxInr" : "earnings.feesTax", { tax: m(c.feeTaxReportedMinor) }) : "",
      c.feeEstimateMinor !== null ? t("earnings.feesPartEstimate", { amount: m(c.feeEstimateMinor) }) : "",
    ].filter(Boolean).join(" ");
  };
  const moneyTiles = (c: CurrencyTotals) => {
    const m = (v: number) => money(v, c.currency);
    return [
      tile(t("earnings.gross"), m(c.grossMinor), t("earnings.grossHint")),
      tile(t("earnings.refunds"), m(c.refundsMinor)),
      tile(t("earnings.netSales"), m(c.netSalesMinor), t("earnings.netSalesHint")),
      tile(t("earnings.packages"), m(c.packagesMinor)),
      ...(c.membershipsMinor !== 0 ? [tile(t("earnings.memberships"), m(c.membershipsMinor))] : []),
      tile(t("earnings.forfeited"), m(c.depositsKeptMinor), t("earnings.forfeitedHint")),
      tile(t("earnings.netIncome"), m(c.netIncomeMinor), t("earnings.netIncomeHint")),
      ...(c.currency === "INR" && r ? [tile(t("earnings.gst"), m(r.gst.outputTaxMinor), t("earnings.gstHint"))] : []),
      c.feesReportedMinor !== null
        ? tile(t("earnings.fees"), m(c.feesReportedMinor + (c.feeEstimateMinor ?? 0)), feeHint(c))
        : c.feeEstimateMinor !== null ? tile(t("earnings.feesEstimate"), `≈ ${m(c.feeEstimateMinor)}`, t("earnings.feesEstimateHint")) : null,
    ];
  };
  const maxTrend = r ? Math.max(1, ...r.trend.map((x) => Math.abs(x.netIncomeMinor))) : 1;
  const planLink = (key: HostKey) => <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t(key)}</Link>;

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("earnings.title")}</h1>
      <form method="get" action="/dashboard/earnings" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="period" className="block text-sm font-semibold text-text">{t("earnings.period")}</label>
          <select id="period" name="period" defaultValue={period.kind} className={select}>
            {PERIOD_KINDS.filter((k) => !limited || k === "last_30" || k === "this_month" || k === "custom").map((k) => <option key={k} value={k}>{t(PERIOD_KEYS[k])}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="block text-sm font-semibold text-text">{t("earnings.from")} <span className="font-normal text-text-muted">{t("earnings.fromCustom")}</span></label>
          <input id="from" name="from" type="date" defaultValue={period.first} className={select} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm font-semibold text-text">{t("earnings.to")}</label>
          <input id="to" name="to" type="date" defaultValue={period.last} className={select} />
        </div>
        <Button type="submit">{t("earnings.show")}</Button>
      </form>
      <p className="mt-3 text-sm text-text-muted">{t("earnings.range", { from: dayDate(period.first), to: dayDate(period.last), zone: period.timezone })}</p>
      {limited && (
        <p role="status" className="mt-2 max-w-3xl text-sm text-text">
          {period.clamped ? t("earnings.freeClamped", { date: dayDate(period.first) }) : t("earnings.freeWindow")}{" "}
          {tNodes("earnings.upgrade", { plans: planLink("earnings.soloOrDuo") })}
        </p>
      )}

      {!r ? <p className="mt-6 text-text-muted">{t("earnings.demo")}</p> : (
        <>
          {r.currencies.length === 0 && <p className="mt-6 text-text-muted">{t("earnings.noMoney")}</p>}
          {r.currencies.map((c) => (
            <section key={c.currency} aria-labelledby={`money-${c.currency}`} className="mt-6">
              <h2 id={`money-${c.currency}`} className="font-semibold text-text">{r.currencies.length > 1 ? t("earnings.moneyIn", { currency: c.currency }) : t("earnings.money")}</h2>
              <div className="mt-2 grid max-w-3xl gap-3 sm:grid-cols-3">{moneyTiles(c)}</div>
              {c.depositsHeldMinor > 0 && <p className="mt-2 max-w-3xl text-sm text-text-muted">{t("earnings.depositsHeld", { amount: money(c.depositsHeldMinor, c.currency) })}</p>}
            </section>
          ))}
          {r.currencies.length > 1 && <p className="mt-2 max-w-3xl text-sm text-text-muted">{t("earnings.neverAdded")}</p>}
          {(r.gst.invoices > 0 || r.gst.creditNotes > 0) && (
            <p className="mt-3 max-w-3xl text-sm text-text-muted">
              {r.uninvoicedMinor === 0
                ? t("earnings.reconciled")
                : t("earnings.uninvoiced", { invoiced: money(r.gst.totalMinor, "INR"), gap: money(r.uninvoicedMinor, "INR") })}
            </p>
          )}

          <section aria-labelledby="sessions" className="mt-8">
            <h2 id="sessions" className="font-semibold text-text">{t("earnings.sessions")}</h2>
            <dl className="mt-2 flex flex-wrap gap-6">
              {([
                ["earnings.delivered", r.sessions.delivered], ["earnings.upcoming", r.sessions.upcoming], ["earnings.noShows", r.sessions.noShows],
                ["earnings.noShowRate", percent(r.sessions.noShowRate)], ["earnings.cancellations", r.sessions.cancelled],
                ["earnings.lateCancellations", r.sessions.lateCancellations], ["earnings.byGuests", r.sessions.cancelledByGuest], ["earnings.byYou", r.sessions.cancelledByHost],
              ] as const).map(([k, v]) => <div key={k}><dt className="text-sm text-text-muted">{t(k)}</dt><dd className="text-lg font-semibold text-text">{v}</dd></div>)}
            </dl>
            <p className="mt-2 text-xs text-text-muted">{t("earnings.lateNote")}</p>
          </section>

          {r.trend.length > 0 && (
            <section aria-labelledby="trend" className="mt-8">
              <h2 id="trend" className="font-semibold text-text">{t("earnings.trend")}</h2>
              <table className="mt-2 w-full max-w-2xl text-left text-sm">
                <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">{t("earnings.month")}</th><th className="py-2 pr-4 font-medium">{t("earnings.netIncome")}</th><th className="w-1/2 py-2 font-medium"><span className="sr-only">{t("earnings.bar")}</span></th></tr></thead>
                <tbody>
                  {r.trend.map((x) => (
                    <tr key={`${x.currency}-${x.month}`} className="border-t border-border text-text">
                      <td className="py-2 pr-4">{monthName(x.month)}{r.currencies.length > 1 ? ` (${x.currency})` : ""}</td>
                      <td className="py-2 pr-4">{money(x.netIncomeMinor, x.currency)}</td>
                      <td className="py-2" aria-hidden="true"><div className={`h-3 rounded ${x.netIncomeMinor < 0 ? "bg-danger" : "bg-accent"}`} style={{ width: `${(Math.abs(x.netIncomeMinor) / maxTrend) * 100}%` }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {r.topClients.length > 0 && (
            <section aria-labelledby="clients" className="mt-8">
              <h2 id="clients" className="font-semibold text-text">{t("earnings.topClients")}</h2>
              <table className="mt-2 w-full max-w-2xl text-left text-sm">
                <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">{t("earnings.client")}</th><th className="py-2 pr-4 font-medium">{t("earnings.net")}</th><th className="py-2 font-medium">{t("earnings.sessions")}</th></tr></thead>
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
              <h2 id="by-type" className="font-semibold text-text">{t("earnings.byEventType")}</h2>
              <table className="mt-2 w-full max-w-2xl text-left text-sm">
                <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">{t("earnings.eventType")}</th><th className="py-2 pr-4 font-medium">{t("earnings.bookings")}</th><th className="py-2 pr-4 font-medium">{t("earnings.packages")}</th><th className="py-2 pr-4 font-medium">{t("earnings.memberships")}</th><th className="py-2 pr-4 font-medium">{t("earnings.depositsKept")}</th><th className="py-2 font-medium">{t("earnings.sessions")}</th></tr></thead>
                <tbody>
                  {r.byEventType.map((l) => (
                    <tr key={`${l.currency}-${l.eventTypeId}`} className="border-t border-border text-text">
                      <td className="py-2 pr-4">{l.eventName}</td><td className="py-2 pr-4">{money(l.bookingsMinor, l.currency)}</td>
                      <td className="py-2 pr-4">{money(l.packagesMinor, l.currency)}</td><td className="py-2 pr-4">{money(l.membershipsMinor, l.currency)}</td><td className="py-2 pr-4">{money(l.depositsKeptMinor, l.currency)}</td><td className="py-2">{l.sessions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section aria-labelledby="downloads" className="mt-8">
            <h2 id="downloads" className="font-semibold text-text">{t("earnings.downloads")}</h2>
            {canExport ? (
              <ul className="mt-2 space-y-1">
                <li><a href={`/dashboard/earnings/export?type=gst&${periodQuery(period)}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("earnings.gstRegister")}</a> <span className="text-sm text-text-muted">{t("earnings.gstNote")}</span></li>
                <li><a href={`/dashboard/earnings/export?type=pnl&${periodQuery(period)}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("earnings.pnl")}</a></li>
              </ul>
            ) : (
              <p className="mt-2 text-sm text-text-muted">{tNodes("earnings.downloadsPaid", { plans: planLink("earnings.soloAndDuo") })}</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
