import { Card } from "@/components/ui/Card";
import { CUSTOMER_PAGE, hostPayments } from "@/lib/admin/customer-data";
import { formatDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { CustomerFrame, db, openCustomerPage, Pager, pageNumber } from "../customer-page";

export const dynamic = "force-dynamic";

const KINDS = { booking: "Booking", package: "Package", membership: "Membership" } as const;

export default async function AdminHostPaymentsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const { id } = await params;
  const { page: raw } = await searchParams;
  const page = pageNumber(raw);
  const host = await openCustomerPage(id, "payments", { pageNo: page });
  const { payments, total, gateways } = await hostPayments(db(), host.id, { page });
  const tz = "Asia/Kolkata";
  return (
    <CustomerFrame host={host} title="Payments and gateways">
      <Card className="mt-4">
        <h2 className="font-semibold text-text">Payment gateways</h2>
        {gateways.length === 0 ? <p className="mt-2 text-text-muted">None connected.</p> : (
          <ul className="mt-2 grid gap-1 text-text">
            {gateways.map((g) => <li key={g.provider}>{g.provider}: {g.status}{g.mode ? `, ${g.mode} mode` : ""}{g.key ? `, key ${g.key}` : ""}, since {formatDate(g.since, tz)}</li>)}
          </ul>
        )}
        <p className="mt-2 text-sm text-text-muted">Secrets stay encrypted and are never shown. Guests pay the host&apos;s own account directly.</p>
      </Card>
      <p className="mt-6 text-sm text-text-muted">{total} {total === 1 ? "payment" : "payments"}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr className="text-text-muted">
            <th className="py-2 pr-4 font-medium">Date</th><th className="py-2 pr-4 font-medium">For</th><th className="py-2 pr-4 font-medium">Guest</th>
            <th className="py-2 pr-4 font-medium">Amount</th><th className="py-2 pr-4 font-medium">Status</th><th className="py-2 font-medium">Gateway reference</th>
          </tr></thead>
          <tbody>
            {payments.map((p, i) => (
              <tr key={i} className="border-t border-border text-text">
                <td className="py-2 pr-4">{formatDate(p.at, tz)}</td>
                <td className="py-2 pr-4">{KINDS[p.kind]}</td>
                <td className="py-2 pr-4">{p.guestEmail || "–"}</td>
                <td className="py-2 pr-4 tabular-nums">{formatAmount(p.amountMinor, p.currency)}{p.refundedMinor > 0 ? ` (${formatAmount(p.refundedMinor, p.currency)} refunded)` : ""}</td>
                <td className="py-2 pr-4">{p.status}</td>
                <td className="py-2 font-mono text-xs">{p.provider}{p.providerId ? ` ${p.providerId}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={total} size={CUSTOMER_PAGE} href={(p) => `/admin/hosts/${host.id}/payments?page=${p}`} />
    </CustomerFrame>
  );
}
