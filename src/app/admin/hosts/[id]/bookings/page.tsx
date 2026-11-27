import { CUSTOMER_PAGE, hostBookings } from "@/lib/admin/customer-data";
import { store } from "@/lib/data";
import { formatDate, formatTime } from "@/lib/format";
import { CustomerFrame, db, openCustomerPage, Pager, pageNumber, SearchBox } from "../customer-page";

export const dynamic = "force-dynamic";

export default async function AdminHostBookingsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const { id } = await params;
  const { q = "", page: raw } = await searchParams;
  const page = pageNumber(raw);
  const host = await openCustomerPage(id, "bookings", { q: q || undefined, pageNo: page });
  const { bookings, total } = await hostBookings(db(), store, host.id, { q, page });
  const tz = "Asia/Kolkata";
  return (
    <CustomerFrame host={host} title="Bookings and answers">
      <SearchBox q={q} label="Guest name or email" />
      <p className="mt-4 text-sm text-text-muted">{total} {total === 1 ? "booking" : "bookings"}{q ? ` matching "${q}"` : ""}. Times in India time.</p>
      <ul className="mt-3 divide-y divide-border">
        {bookings.map((b) => (
          <li key={b.id} className="py-3 text-sm text-text">
            <p className="font-semibold">{formatDate(b.start, tz)}, {formatTime(b.start, tz)} · {b.event} · {b.status}{b.payment ? ` · payment ${b.payment}` : ""}</p>
            <p>{b.guestName} · {b.guestEmail}{b.guestPhone ? ` · ${b.guestPhone}` : ""}{b.guests.length ? ` · with ${b.guests.join(", ")}` : ""}</p>
            {b.answers.length > 0 && (
              <dl className="mt-1 grid gap-1">
                {b.answers.map((a, i) => <div key={i}><dt className="text-text-muted">{a.question}</dt><dd className="whitespace-pre-wrap">{a.answer || "–"}</dd></div>)}
              </dl>
            )}
            {b.note && <p className="mt-1 whitespace-pre-wrap"><span className="text-text-muted">Host&apos;s private note: </span>{b.note}</p>}
          </li>
        ))}
      </ul>
      <Pager page={page} total={total} size={CUSTOMER_PAGE} href={(p) => `/admin/hosts/${host.id}/bookings?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`} />
    </CustomerFrame>
  );
}
