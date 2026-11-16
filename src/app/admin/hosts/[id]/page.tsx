import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { hostDetail } from "@/lib/admin/queries";
import { audit, can } from "@/lib/admin/roles";
import { Button } from "@/components/ui/Button";
import { focusRing } from "@/components/ui/focus";
import { setPlanAction } from "./actions";
import { requireStaff } from "@/lib/admin/session";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** One host's account for support. Opening it is logged: it shows a person's account details. */
const RESULTS: Record<string, [string, boolean]> = {
  plan_saved: ["Plan updated. The host has it now.", true],
  paid_subscription: ["This host pays through Razorpay or Stripe. They change their plan from their own Plan page.", false],
  not_found: ["That account is closed or doesn't exist.", false],
  bad_plan: ["Pick Free, Solo or Duo.", false],
  not_allowed: ["Only a super admin can change plans.", false],
};

export default async function AdminHostPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  const staff = await requireStaff("view_hosts");
  const { id } = await params;
  const { result } = await searchParams;
  const db = getPool(process.env.DATABASE_URL as string);
  const h = await hostDetail(db, id, new Date());
  if (!h) notFound();
  await audit(db, staff, "host.view", "user", h.id);
  const tz = "Asia/Kolkata";
  const row = (label: string, value: React.ReactNode) => <div><dt className="text-sm text-text-muted">{label}</dt><dd className="text-text">{value}</dd></div>;
  const s = h.subscription;
  const paying = Boolean(s?.provider) && s!.plan !== "free" && s!.status !== "cancelled";
  const message = result ? RESULTS[result] : undefined;
  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-xl text-text">{h.name || "(no name)"}</h1>
      <p className="mt-1 text-text-muted">{h.email} · hourhand.cloud/{h.slug}{h.closedAt ? ` · closed ${formatDate(h.closedAt, tz)}` : ""}</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card><h2 className="mb-3 font-semibold text-text">Account</h2><dl className="grid gap-3">
          {row("Joined", formatDate(h.createdAt, tz))}{row("Time zone", h.timezone)}{row("Language", h.locale)}{row("GST registered", h.taxRegistered ? "Yes" : "No")}
        </dl></Card>
        <Card><h2 className="mb-3 font-semibold text-text">Hourhand plan</h2><dl className="grid gap-3">
          {row("Plan", s ? `${s.plan}${s.interval ? `, ${s.interval}ly` : ""}` : "free")}
          {row("Status", s ? `${s.status}${s.cancelAtPeriodEnd ? ", cancelling" : ""}` : "–")}
          {row("Paid through", s?.currentPeriodEnd ? formatDate(s.currentPeriodEnd, tz) : "–")}
          {row("Billed by", s?.provider ?? (s && s.plan !== "free" ? "Complimentary (set by staff)" : "–"))}
        </dl>
        {can(staff.role, "manage_plans") && !h.closedAt && (paying ? (
          <p className="mt-4 text-sm text-text-muted">Paying through {s!.provider}: the host changes this from their own Plan page.</p>
        ) : (
          <form action={setPlanAction} className="mt-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="hostId" value={h.id} />
            <label className="text-sm text-text-muted" htmlFor="plan">Give plan (no charge)</label>
            <select id="plan" name="plan" defaultValue={s?.plan ?? "free"} className={`h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
              <option value="free">Free</option><option value="solo">Solo</option><option value="duo">Duo</option>
            </select>
            <Button type="submit" size="sm">Save</Button>
          </form>
        ))}
        {message && <p role={message[1] ? "status" : "alert"} className={`mt-3 text-sm ${message[1] ? "text-success" : "text-danger"}`}>{message[0]}</p>}
      </Card>
        <Card><h2 className="mb-3 font-semibold text-text">Connections</h2><dl className="grid gap-3">
          {h.connections.length === 0 && h.calendars.length === 0 && <p className="text-text-muted">None.</p>}
          {h.connections.map((c) => row(c.provider, c.status))}
          {h.calendars.map((c, i) => <div key={i}>{row(`${c.provider} calendar`, `${c.status}${c.lastSyncedAt ? `, synced ${formatDate(c.lastSyncedAt, tz)}` : ""}`)}</div>)}
        </dl></Card>
        <Card><h2 className="mb-3 font-semibold text-text">Activity</h2><dl className="grid gap-3">
          {row("Event types", h.counts.eventTypes)}{row("Bookings (upcoming)", `${h.counts.bookings} (${h.counts.upcoming})`)}
          {row("Packages sold", h.counts.packagesSold)}{row("Active members", h.counts.activeMembers)}{row("Invoices issued", h.counts.invoices)}
        </dl></Card>
      </div>
      <p className="mt-6 text-sm text-text-muted">Client names and details are not shown here. Your visit to this page is in the audit log.</p>
    </div>
  );
}
