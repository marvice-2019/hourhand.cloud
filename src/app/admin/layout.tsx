import Link from "next/link";
import { connection } from "next/server";
import { focusRing } from "@/components/ui/focus";
import { Button } from "@/components/ui/Button";
import { signOut } from "@/lib/auth/actions";
import { can, ROLE_NAMES } from "@/lib/admin/roles";
import { requireStaff } from "@/lib/admin/session";

export const metadata = { title: "Hourhand admin", robots: { index: false, follow: false } };

/** Hourhand staff only. Each page checks its own permission too; this is never the only check. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const staff = await requireStaff("view_overview");
  const links = [
    { href: "/admin", label: "Overview" },
    { href: "/admin/hosts", label: "Hosts" },
    ...(can(staff.role, "manage_staff") ? [{ href: "/admin/staff", label: "Staff" }] : []),
    ...(can(staff.role, "view_audit") ? [{ href: "/admin/audit", label: "Audit log" }] : []),
  ];
  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 lg:px-8">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-display text-lg text-text">Hourhand admin</span>
          <nav aria-label="Admin">
            <ul className="flex flex-wrap gap-1">
              {links.map((l) => (
                <li key={l.href}><Link href={l.href} className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm text-text-muted hover:bg-surface hover:text-text ${focusRing}`}>{l.label}</Link></li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-text-muted">
          <span>{staff.email} · {ROLE_NAMES[staff.role]}</span>
          <form action={signOut}><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
        </div>
      </header>
      <main id="main" className="px-4 py-8 lg:px-8">{children}</main>
    </div>
  );
}
