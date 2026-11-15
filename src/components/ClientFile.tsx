import Link from "next/link";
import { Card } from "@/components/ui/Card";
import type { LatestAnswer, MoneyLine } from "@/lib/client-file";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";

const KIND: Record<MoneyLine["kind"], HostKey> = { payment: "clients.kindSession", deposit: "clients.kindDeposit", package: "clients.kindPackage" };
const STATUS: Record<MoneyLine["status"], HostKey> = { paid: "clients.statusPaid", refund_pending: "clients.statusRefundPending", refunded: "clients.statusRefunded" };

/** What the client told you when booking (latest answer to each question) and what they have paid you. */
export async function ClientFile({ answers, money, tz }: { answers: LatestAnswer[]; money: { lines: MoneyLine[]; totals: { currency: string; paidMinor: number; refundedMinor: number }[] } | null; tz: string }) {
  // money() writes any three-letter currency, as payments now can be in the Stripe account's own.
  const { t, date, money: money_ } = await getHostI18n();
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <Card>
        <h2 className="font-semibold text-text">{t("clients.toldTitle")}</h2>
        <p className="mt-1 text-sm text-text-muted">{t("clients.toldIntro")}</p>
        {answers.length === 0 ? <p className="mt-3 text-sm text-text-muted">{t("clients.toldEmpty")}</p> : (
          <dl className="mt-3 grid gap-3">
            {answers.map((a) => (
              <div key={a.label}>
                <dt className="text-sm text-text-muted">{a.label}</dt>
                <dd className="whitespace-pre-line text-text">{a.answer}</dd>
                <dd className="text-xs text-text-muted">
                  <Link href={`/dashboard/bookings/${a.bookingId}`} className="underline">{date(a.at, tz)}</Link>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
      <Card>
        <h2 className="font-semibold text-text">{t("clients.paymentsTitle")}</h2>
        {money === null ? <p className="mt-3 text-sm text-text-muted">{t("clients.paymentsNoDb")}</p>
          : money.lines.length === 0 ? <p className="mt-3 text-sm text-text-muted">{t("clients.paymentsEmpty")}</p> : (
            <>
              <p className="mt-1 text-sm text-text">
                {money.totals.map((x, i) => (
                  <span key={x.currency}>{i > 0 && " · "}{x.refundedMinor > 0
                    ? t("clients.totalPaidRefunded", { amount: money_(x.paidMinor, x.currency), refunded: money_(x.refundedMinor, x.currency) })
                    : t("clients.totalPaid", { amount: money_(x.paidMinor, x.currency) })}</span>
                ))}
              </p>
              <ul className="mt-3 grid gap-2">
                {money.lines.map((l, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border pb-2 text-sm last:border-0">
                    <span className="text-text">
                      {t("clients.moneyLine", { date: date(l.at, tz), kind: t(KIND[l.kind]), what: l.what })}
                    </span>
                    <span className="text-text">
                      {money_(l.amountMinor, l.currency)} · <span className={l.status === "paid" ? "text-success" : "text-text-muted"}>{t(STATUS[l.status])}</span>
                      {l.invoiceToken && <> · <Link href={`/invoice/${l.invoiceToken}`} className="text-accent underline">{t("clients.invoice")}</Link></>}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
      </Card>
    </div>
  );
}
