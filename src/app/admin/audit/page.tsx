import Link from "next/link";
import { listAudit } from "@/lib/admin/roles";
import { requireStaff } from "@/lib/admin/session";
import { getPool } from "@/lib/data/pg-store";

export const dynamic = "force-dynamic";

const ACTIONS: Record<string, string> = { "host.view": "Opened host", "staff.grant": "Added to staff", "staff.revoke": "Removed from staff", "host.plan": "Changed plan" };

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  await requireStaff("view_audit");
  const { before } = await searchParams;
  const entries = await listAudit(getPool(process.env.DATABASE_URL as string), { limit: 100, before });
  const when = (d: Date) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(d);
  return (
    <div className="max-w-4xl">
      <h1 className="font-display text-xl text-text">Audit log</h1>
      <p className="mt-2 text-text-muted">Every staff action, newest first. Times in IST.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">When</th><th className="py-2 pr-4 font-medium">Who</th><th className="py-2 pr-4 font-medium">What</th><th className="py-2 font-medium">On</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-border text-text">
                <td className="py-2 pr-4 whitespace-nowrap">{when(e.at)}</td>
                <td className="py-2 pr-4">{e.actorEmail}</td>
                <td className="py-2 pr-4">{ACTIONS[e.action] ?? e.action}{e.detail.role ? ` (${String(e.detail.role)})` : ""}{e.detail.to ? ` (${String(e.detail.from)} to ${String(e.detail.to)})` : ""}</td>
                <td className="py-2">{e.targetType === "user" && e.targetId ? <Link href={`/admin/hosts/${e.targetId}`} className="text-accent underline">{String(e.detail.email ?? e.targetId)}</Link> : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length === 100 && <Link href={`/admin/audit?before=${entries[entries.length - 1].id}`} className="mt-4 inline-block font-semibold text-accent underline">Older</Link>}
    </div>
  );
}
