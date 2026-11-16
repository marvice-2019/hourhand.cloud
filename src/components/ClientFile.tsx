import Link from "next/link";
import { Card } from "@/components/ui/Card";
import type { LatestAnswer, MoneyLine } from "@/lib/client-file";
import { formatDate } from "@/lib/format";

/** Any three-letter currency, as payments now can be in the Stripe account's own. */
const money_ = (minor: number, currency: string) => {
  const major = minor / 100;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, minimumFractionDigits: Number.isInteger(major) ? 0 : 2, maximumFractionDigits: 2 }).format(major);
};

const KIND: Record<MoneyLine["kind"], string> = { payment: "Session", deposit: "Deposit", package: "Package" };
const STATUS: Record<MoneyLine["status"], string> = { paid: "Paid", refund_pending: "Refund on its way", refunded: "Refunded" };

/** What the client told you when booking (latest answer to each question) and what they have paid you. */
export function ClientFile({ answers, money, tz }: { answers: LatestAnswer[]; money: { lines: MoneyLine[]; totals: { currency: string; paidMinor: number; refundedMinor: number }[] } | null; tz: string }) {
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <Card>
        <h2 className="font-semibold text-text">What they told you</h2>
        <p className="mt-1 text-sm text-text-muted">Their latest answer to each booking question.</p>
        {answers.length === 0 ? <p className="mt-3 text-sm text-text-muted">No answers yet. Add questions to an event type and they show here.</p> : (
          <dl className="mt-3 grid gap-3">
            {answers.map((a) => (
              <div key={a.label}>
                <dt className="text-sm text-text-muted">{a.label}</dt>
                <dd className="whitespace-pre-line text-text">{a.answer}</dd>
                <dd className="text-xs text-text-muted">
                  <Link href={`/dashboard/bookings/${a.bookingId}`} className="underline">{formatDate(a.at, tz)}</Link>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
      <Card>
        <h2 className="font-semibold text-text">Payments</h2>
        {money === null ? <p className="mt-3 text-sm text-text-muted">Payments show here once the database is connected.</p>
          : money.lines.length === 0 ? <p className="mt-3 text-sm text-text-muted">Nothing paid through Hourhand yet.</p> : (
            <>
              <p className="mt-1 text-sm text-text">
                {money.totals.map((t, i) => (
                  <span key={t.currency}>{i > 0 && " · "}{money_(t.paidMinor, t.currency)} paid{t.refundedMinor > 0 && <>, {money_(t.refundedMinor, t.currency)} refunded</>}</span>
                ))}
              </p>
              <ul className="mt-3 grid gap-2">
                {money.lines.map((l, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border pb-2 text-sm last:border-0">
                    <span className="text-text">
                      {formatDate(l.at, tz)} · {KIND[l.kind]}: {l.what}
                    </span>
                    <span className="text-text">
                      {money_(l.amountMinor, l.currency)} · <span className={l.status === "paid" ? "text-success" : "text-text-muted"}>{STATUS[l.status]}</span>
                      {l.invoiceToken && <> · <Link href={`/invoice/${l.invoiceToken}`} className="text-accent underline">Invoice</Link></>}
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
