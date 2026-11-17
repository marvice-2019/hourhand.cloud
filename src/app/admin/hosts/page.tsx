import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { HOSTS_PAGE, listHosts } from "@/lib/admin/queries";
import { requireStaff } from "@/lib/admin/session";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminHostsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireStaff("view_hosts");
  const { q = "", page: rawPage } = await searchParams;
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);
  const { hosts, total } = await listHosts(getPool(process.env.DATABASE_URL as string), { q, page });
  const pages = Math.max(1, Math.ceil(total / HOSTS_PAGE));
  const link = (p: number) => `/admin/hosts?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;
  return (
    <div>
      <h1 className="font-display text-xl text-text">Hosts</h1>
      <form className="mt-4 flex max-w-xl items-end gap-3" role="search">
        <div className="flex-1"><Label htmlFor="q">Name, email or page address</Label><Input id="q" name="q" defaultValue={q} maxLength={100} /></div>
        <Button type="submit">Search</Button>
      </form>
      <p className="mt-4 text-sm text-text-muted">{total} {total === 1 ? "host" : "hosts"}{q ? ` matching "${q}"` : ""}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full max-w-5xl text-left text-sm">
          <thead><tr className="text-text-muted">
            <th className="py-2 pr-4 font-medium">Host</th><th className="py-2 pr-4 font-medium">Page</th><th className="py-2 pr-4 font-medium">Plan</th>
            <th className="py-2 pr-4 font-medium">Razorpay</th><th className="py-2 pr-4 font-medium">Bookings</th><th className="py-2 font-medium">Joined</th>
          </tr></thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={h.id} className="border-t border-border text-text">
                <td className="py-2 pr-4"><Link href={`/admin/hosts/${h.id}`} className="font-semibold text-accent underline">{h.name || "(no name)"}</Link><br /><span className="text-text-muted">{h.email}</span></td>
                <td className="py-2 pr-4">/{h.slug}{h.closedAt && <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-text-muted">Closed</span>}</td>
                <td className="py-2 pr-4">{h.plan}{h.planStatus && h.plan !== "free" && h.planStatus !== "active" ? ` (${h.planStatus})` : ""}</td>
                <td className="py-2 pr-4">{h.razorpay ? "Connected" : "–"}</td>
                <td className="py-2 pr-4 tabular-nums">{h.bookings}</td>
                <td className="py-2">{formatDate(h.createdAt, "Asia/Kolkata")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav aria-label="Pages" className="mt-4 flex gap-4 text-sm">
          {page > 1 && <Link href={link(page - 1)} className="font-semibold text-accent underline">Previous</Link>}
          <span className="text-text-muted">Page {page} of {pages}</span>
          {page < pages && <Link href={link(page + 1)} className="font-semibold text-accent underline">Next</Link>}
        </nav>
      )}
    </div>
  );
}
