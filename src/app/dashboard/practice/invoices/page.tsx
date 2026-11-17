import Link from "next/link";
import { redirect } from "next/navigation";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { formatMoney } from "@/lib/billing/plans";
import { listPracticeInvoices } from "@/lib/clinic/invoices";
import { practiceContext } from "@/lib/clinic/practices";
import { allowed } from "@/lib/clinic/roles";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** The practice's one invoice series, for its owner and admins. The owner sets the GST details on their Invoices page. */
export default async function PracticeInvoicesPage() {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/practice");
  const db = getPool(process.env.DATABASE_URL as string);
  const ctx = await practiceContext(db, user.id);
  if (!ctx || !allowed(ctx.role, "invoices.view")) redirect("/dashboard/practice?error=forbidden");
  const invoices = await listPracticeInvoices(db, user.id);
  return (
    <div>
      <h1 className="font-display text-xl text-text">{ctx.practice.name}: invoices</h1>
      <p className="mt-2 max-w-2xl text-text-muted">
        Every practitioner&apos;s paid sessions and packages are invoiced in the practice&apos;s one series, under its GSTIN.
        {ctx.role === "owner" ? <> Set the GST details and download the CSV on <Link className={`underline ${focusRing}`} href="/dashboard/invoices">your Invoices page</Link>.</> : " The owner sets the GST details."}
      </p>
      {invoices.length === 0 ? <p className="mt-6 text-text-muted">No invoices yet.</p> : (
        <ul className="mt-4 grid gap-2">
          {invoices.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-card px-4 py-2">
              <Link href={`/invoice/${v.token}`} className={`inline-flex min-h-11 items-center font-semibold text-accent underline ${focusRing}`}>{v.number}</Link>
              <span className="text-text">{formatDate(v.issuedAt, user.timezone)}</span>
              <span className="text-text">{v.buyerName}</span>
              <span className="text-text-muted">{v.description}</span>
              <span className="text-text">{v.kind === "credit_note" ? "−" : ""}{formatMoney(v.totalMinor, "INR")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
