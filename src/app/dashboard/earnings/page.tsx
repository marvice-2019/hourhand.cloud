import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { paymentAccount, priceCurrency } from "@/lib/payments/host-payments";
import { getPool } from "@/lib/data/pg-store";
import { monthlyEarnings, monthOf, monthRange } from "@/lib/earnings";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

const shift = (month: string, by: number) => { const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + by); return d.toISOString().slice(0, 7); };

export default async function EarningsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requireOwnAccount();
  const { t, month: monthName, money: amount } = await getHostI18n();
  const label = (m: string) => monthName(new Date(`${m}-01T00:00:00Z`));
  const now = new Date();
  const current = monthOf(now);
  const asked = (await searchParams).month;
  const month = asked && monthRange(asked) && asked <= current ? asked : current;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const e = pool ? await monthlyEarnings(pool, user.id, month, now, priceCurrency(await paymentAccount(pool, user.id))) : null;
  const money = (m: number) => amount(m, e?.currency);
  const tile = (title: string, value: string, hint?: string) => (
    <Card><p className="text-sm text-text-muted">{title}</p><p className="mt-1 text-xl font-semibold text-text">{value}</p>{hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}</Card>
  );
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("earnings.title")}</h1>
      <nav aria-label={t("earnings.monthNav")} className="mt-3 flex flex-wrap items-center gap-4">
        <Link href={`/dashboard/earnings?month=${shift(month, -1)}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">‹ {label(shift(month, -1))}</Link>
        <span className="font-semibold text-text">{label(month)}</span>
        {month < current && <Link href={`/dashboard/earnings?month=${shift(month, 1)}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{label(shift(month, 1))} ›</Link>}
      </nav>
      {!e ? <p className="mt-6 text-text-muted">{t("earnings.demo")}</p> : (
        <>
          <div className="mt-6 grid max-w-3xl gap-3 sm:grid-cols-3">
            {tile(t("earnings.net"), money(e.netMinor), t("earnings.netHint"))}
            {tile(t("earnings.bookings"), money(e.bookingsMinor))}
            {tile(t("earnings.packages"), money(e.packagesMinor))}
            {tile(t("earnings.refunds"), money(e.refundsMinor))}
            {tile(t("earnings.depositsKept"), money(e.depositsKeptMinor), t("earnings.depositsKeptHint"))}
            {e.currency === "INR" && tile(t("earnings.gst"), money(e.gstMinor), t("earnings.gstHint"))}
          </div>
          <p className="mt-3 max-w-3xl text-sm text-text-muted">
            {e.currency === "INR"
              ? t("earnings.feeNote", { fee: money(e.feeEstimateMinor) })
              : t("earnings.stripeNote", { currency: e.currency })}
            {e.depositsHeldMinor > 0 && ` ${t("earnings.depositsHeld", { amount: money(e.depositsHeldMinor) })}`}
          </p>

          <section aria-labelledby="sessions" className="mt-8">
            <h2 id="sessions" className="font-semibold text-text">{t("earnings.sessions")}</h2>
            <dl className="mt-2 flex flex-wrap gap-6">
              <div><dt className="text-sm text-text-muted">{t("earnings.held")}</dt><dd className="text-lg font-semibold text-text">{e.sessions.held}</dd></div>
              <div><dt className="text-sm text-text-muted">{t("earnings.upcoming")}</dt><dd className="text-lg font-semibold text-text">{e.sessions.upcoming}</dd></div>
              <div><dt className="text-sm text-text-muted">{t("earnings.noShows")}</dt><dd className="text-lg font-semibold text-text">{e.sessions.noShows}</dd></div>
              <div><dt className="text-sm text-text-muted">{t("earnings.cancelledByGuests")}</dt><dd className="text-lg font-semibold text-text">{e.sessions.cancelledByGuest}</dd></div>
              <div><dt className="text-sm text-text-muted">{t("earnings.cancelledByYou")}</dt><dd className="text-lg font-semibold text-text">{e.sessions.cancelledByHost}</dd></div>
            </dl>
          </section>

          {e.byEventType.length > 0 && (
            <section aria-labelledby="by-type" className="mt-8">
              <h2 id="by-type" className="font-semibold text-text">{t("earnings.byEventType")}</h2>
              <table className="mt-2 w-full max-w-xl text-left text-sm">
                <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">{t("earnings.eventType")}</th><th className="py-2 pr-4 font-medium">{t("earnings.bookings")}</th><th className="py-2 font-medium">{t("earnings.packages")}</th></tr></thead>
                <tbody>
                  {e.byEventType.map((l) => (
                    <tr key={l.eventTypeId} className="border-t border-border text-text"><td className="py-2 pr-4">{l.eventName}</td><td className="py-2 pr-4">{money(l.bookingsMinor)}</td><td className="py-2">{money(l.packagesMinor)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <a href={`/dashboard/earnings/export?month=${month}`} className="mt-8 inline-flex min-h-11 items-center font-semibold text-accent underline">{t("earnings.download", { month: label(month) })}</a>
        </>
      )}
    </div>
  );
}
