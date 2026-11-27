import { Card } from "@/components/ui/Card";
import { overview } from "@/lib/admin/queries";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { focusRing } from "@/components/ui/focus";
import { can } from "@/lib/admin/roles";
import { countPending, getRequireApproval } from "@/lib/admin/review";
import { requireStaff } from "@/lib/admin/session";
import { setRequireApprovalAction } from "./actions";
import { getPool } from "@/lib/data/pg-store";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const staff = await requireStaff("view_overview");
  const db = getPool(process.env.DATABASE_URL as string);
  const [o, pending, requireApproval] = await Promise.all([overview(db, new Date()), countPending(db), getRequireApproval(db)]);
  const tiles: [string, number | string][] = [
    ["Hosts", o.hosts], ["New hosts, last 30 days", o.newHosts30d], ["Closed accounts", o.closedHosts],
    ["Paying: Solo", o.paidHosts.solo], ["Paying: Duo", o.paidHosts.duo], ["Hourhand payment failing", o.pastDueHosts],
    ["Bookings made, last 30 days", o.bookings30d], ["Active client memberships", o.activeMemberships], ["Messages failed, last 24 hours", o.failedNotifications24h],
  ];
  return (
    <div>
      <h1 className="font-display text-xl text-text">Overview</h1>
      <ul className="mt-6 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map(([label, value]) => (
          <li key={label}><Card><p className="text-sm text-text-muted">{label}</p><p className="mt-1 text-2xl font-semibold text-text tabular-nums">{value}</p></Card></li>
        ))}
      </ul>
      <section aria-labelledby="approval-heading" className="mt-8 max-w-4xl">
        <h2 id="approval-heading" className="font-semibold text-text">Host approval</h2>
        <p className="mt-2 text-text">
          <Link href="/admin/hosts?status=pending" className={`font-semibold text-accent underline ${focusRing}`}>{pending} {pending === 1 ? "host is" : "hosts are"} waiting for approval</Link>
        </p>
        <p className="mt-2 text-text-muted">
          {requireApproval ? "New hosts wait for a super admin's approval before their booking pages go live." : "New hosts go live straight away."}
        </p>
        {can(staff.role, "review_hosts") && (
          <form action={setRequireApprovalAction} className="mt-3">
            <input type="hidden" name="on" value={requireApproval ? "0" : "1"} />
            <Button type="submit" variant="secondary" size="sm">{requireApproval ? "Stop requiring approval" : "Require my approval for new hosts"}</Button>
          </form>
        )}
      </section>
    </div>
  );
}
