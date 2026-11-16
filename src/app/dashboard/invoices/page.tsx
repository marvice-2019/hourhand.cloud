import Link from "next/link";
import { TaxProfileForm } from "@/components/TaxProfileForm";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { dayKey } from "@/lib/format";
import { getTaxProfile, listInvoices } from "@/lib/gst/invoices";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  const user = await requireOwnAccount();
  const { t, date, inr } = await getHostI18n();
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [profile, invoices] = db ? await Promise.all([getTaxProfile(db, user.id), listInvoices(db, user.id)]) : [null, []];
  const month = dayKey(new Date(), "Asia/Kolkata").slice(0, 7); // this month in India

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("invoices.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("invoices.intro")}</p>
      <Card className="mt-6 max-w-xl"><h2 className="mb-4 font-semibold text-text">{t("invoices.detailsTitle")}</h2><TaxProfileForm saved={profile} /></Card>
      <p className="mt-3 max-w-xl text-sm text-text-muted">{t("invoices.checkNote")}</p>

      <section aria-labelledby="inv-list" className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="inv-list" className="font-semibold text-text">{t("invoices.issued")}</h2>
          {invoices.length > 0 && (
            <form action="/dashboard/invoices/export" className="flex items-center gap-2">
              <label htmlFor="inv-month" className="text-sm text-text-muted">{t("invoices.month")}</label>
              <input id="inv-month" type="month" name="month" defaultValue={month} className="h-11 rounded-md border border-border-input bg-card px-2 text-text" />
              <button type="submit" className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("invoices.downloadCsv")}</button>
            </form>
          )}
        </div>
        {invoices.length === 0 ? <p className="mt-2 text-text-muted">{t("invoices.none")}</p> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full max-w-3xl text-left text-sm">
              <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">{t("invoices.number")}</th><th className="py-2 pr-4 font-medium">{t("invoices.date")}</th><th className="py-2 pr-4 font-medium">{t("invoices.buyer")}</th><th className="py-2 font-medium">{t("invoices.total")}</th></tr></thead>
              <tbody>
                {invoices.map((v) => (
                  <tr key={v.id} className="border-t border-border text-text">
                    <td className="py-2 pr-4"><Link href={`/invoice/${v.token}`} className="font-semibold text-accent underline">{v.number}</Link>{v.kind === "credit_note" && <span className="ml-2 text-text-muted">{t("invoices.creditNote")}</span>}</td>
                    <td className="py-2 pr-4">{date(v.issuedAt, user.timezone)}</td>
                    <td className="py-2 pr-4">{v.buyerName}</td>
                    <td className="py-2">{v.kind === "credit_note" ? "−" : ""}{inr(v.totalMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
