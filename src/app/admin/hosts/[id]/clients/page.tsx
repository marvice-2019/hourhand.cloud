import { CUSTOMER_PAGE, hostClients } from "@/lib/admin/customer-data";
import { store } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { CustomerFrame, db, openCustomerPage, Pager, pageNumber, SearchBox } from "../customer-page";

export const dynamic = "force-dynamic";

export default async function AdminHostClientsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const { id } = await params;
  const { q = "", page: raw } = await searchParams;
  const page = pageNumber(raw);
  const host = await openCustomerPage(id, "clients", { q: q || undefined, pageNo: page });
  const { clients, total } = await hostClients(db(), store, host.id, { q, page });
  const tz = "Asia/Kolkata";
  return (
    <CustomerFrame host={host} title="Clients">
      <SearchBox q={q} label="Client name or email" />
      <p className="mt-4 text-sm text-text-muted">{total} {total === 1 ? "client" : "clients"}{q ? ` matching "${q}"` : ""}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr className="text-text-muted">
            <th className="py-2 pr-4 font-medium">Client</th><th className="py-2 pr-4 font-medium">Phone</th><th className="py-2 pr-4 font-medium">Bookings</th>
            <th className="py-2 pr-4 font-medium">First and last</th><th className="py-2 font-medium">Host&apos;s private note</th>
          </tr></thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.email} className="border-t border-border align-top text-text">
                <td className="py-2 pr-4"><span className="font-semibold">{c.name}</span><br /><span className="text-text-muted">{c.email}</span></td>
                <td className="py-2 pr-4">{c.phone ?? "–"}</td>
                <td className="py-2 pr-4 tabular-nums">{c.bookings}</td>
                <td className="py-2 pr-4">{formatDate(c.first, tz)}<br />{formatDate(c.last, tz)}</td>
                <td className="max-w-md whitespace-pre-wrap py-2">{c.note || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={total} size={CUSTOMER_PAGE} href={(p) => `/admin/hosts/${host.id}/clients?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`} />
    </CustomerFrame>
  );
}
