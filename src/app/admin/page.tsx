import { Card } from "@/components/ui/Card";
import { overview } from "@/lib/admin/queries";
import { requireStaff } from "@/lib/admin/session";
import { getPool } from "@/lib/data/pg-store";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  await requireStaff("view_overview");
  const o = await overview(getPool(process.env.DATABASE_URL as string), new Date());
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
    </div>
  );
}
