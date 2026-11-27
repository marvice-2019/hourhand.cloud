import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { focusRing } from "@/components/ui/focus";
import { hostDetail } from "@/lib/admin/queries";
import { audit } from "@/lib/admin/roles";
import { requireStaff } from "@/lib/admin/session";
import { getPool } from "@/lib/data/pg-store";

// Shared by the three customer-data pages (B17): the permission check, the host, the audit row and the page frame.

export const db = () => getPool(process.env.DATABASE_URL as string);

/** Checks the permission, finds the host and logs this visit. Every customer-data view goes through here. */
export async function openCustomerPage(id: string, page: "clients" | "bookings" | "payments", detail: Record<string, unknown>) {
  const staff = await requireStaff("view_customer_data");
  const h = await hostDetail(db(), id, new Date());
  if (!h) notFound();
  await audit(db(), staff, "host.customer_data.view", "user", h.id, { page, ...detail });
  return h;
}

export function CustomerFrame({ host, title, children }: { host: { id: string; name: string | null; email: string }; title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-6xl">
      <Link href={`/admin/hosts/${host.id}`} className={`text-accent underline ${focusRing}`}>Back to {host.name || host.email}</Link>
      <h1 className="mt-2 font-display text-xl text-text">{title}</h1>
      <p className="mt-1 text-text-muted">{host.name || "(no name)"} · {host.email}</p>
      {children}
      <p className="mt-6 text-sm text-text-muted">Your visit to this page is in the audit log.</p>
    </div>
  );
}

export function SearchBox({ q, label }: { q: string; label: string }) {
  return (
    <form className="mt-4 flex max-w-xl items-end gap-3" role="search">
      <div className="flex-1"><Label htmlFor="q">{label}</Label><Input id="q" name="q" defaultValue={q} maxLength={100} /></div>
      <Button type="submit">Search</Button>
    </form>
  );
}

export function Pager({ page, total, size, href }: { page: number; total: number; size: number; href: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="mt-4 flex gap-4 text-sm">
      {page > 1 && <Link href={href(page - 1)} className={`font-semibold text-accent underline ${focusRing}`}>Previous</Link>}
      <span className="text-text-muted">Page {page} of {pages}</span>
      {page < pages && <Link href={href(page + 1)} className={`font-semibold text-accent underline ${focusRing}`}>Next</Link>}
    </nav>
  );
}

export const pageNumber = (raw?: string) => Math.max(1, Number.parseInt(raw ?? "1", 10) || 1);
