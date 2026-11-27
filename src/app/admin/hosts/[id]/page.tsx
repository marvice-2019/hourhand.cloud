import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { hostDetail } from "@/lib/admin/queries";
import { audit, can } from "@/lib/admin/roles";
import { Button } from "@/components/ui/Button";
import { focusRing } from "@/components/ui/focus";
import { reviewHostAction, setPlanAction } from "./actions";
import { actionsFor, reviewStatusOf, type ReviewAction, type ReviewStatus } from "@/lib/admin/review";
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
  review_approve: ["Approved. Their booking pages are live.", true],
  review_decline: ["Declined. Their booking pages stay hidden.", true],
  review_suspend: ["Suspended. Their booking pages are hidden and take no new bookings; guests can still cancel.", true],
  review_reactivate: ["Reactivated. Their booking pages are live again.", true],
  review_bad_transition: ["That account changed since you opened this page. Check its status and try again.", false],
  review_closed: ["That account is closed.", false],
  review_self: ["You can't review your own account.", false],
  review_not_allowed: ["Only a super admin can approve, decline or suspend hosts.", false],
};

const REVIEW_LABELS: Record<ReviewStatus, string> = { pending: "Waiting for approval", approved: "Approved", declined: "Declined", suspended: "Suspended" };
const ACTION_LABELS: Record<ReviewAction, string> = { approve: "Approve", decline: "Decline", suspend: "Suspend", reactivate: "Reactivate" };

export default async function AdminHostPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  const staff = await requireStaff("view_hosts");
  const { id } = await params;
  const { result } = await searchParams;
  const db = getPool(process.env.DATABASE_URL as string);
  const h = await hostDetail(db, id, new Date());
  if (!h) notFound();
  const review = await reviewStatusOf(db, h.id);
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
      {message && <p role={message[1] ? "status" : "alert"} className={`mt-4 text-sm ${message[1] ? "text-success" : "text-danger"}`}>{message[0]}</p>}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card><h2 className="mb-3 font-semibold text-text">Account</h2><dl className="grid gap-3">
          {row("Status", REVIEW_LABELS[review])}
          {row("Joined", formatDate(h.createdAt, tz))}{row("Time zone", h.timezone)}{row("Language", h.locale)}{row("GST registered", h.taxRegistered ? "Yes" : "No")}
        </dl>
        {can(staff.role, "review_hosts") && !h.closedAt && h.id !== staff.id && actionsFor(review).length > 0 && (
          <form action={reviewHostAction} className="mt-4 flex flex-wrap gap-2">
            <input type="hidden" name="hostId" value={h.id} />
            {actionsFor(review).map((a) => (
              <Button key={a} type="submit" name="action" value={a} size="sm" variant={a === "approve" || a === "reactivate" ? "primary" : "secondary"}>{ACTION_LABELS[a]}</Button>
            ))}
          </form>
        )}
        </Card>
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
      {can(staff.role, "view_customer_data") && (
        <nav aria-label="Customer data" className="mt-6 flex flex-wrap gap-4">
          <Link href={`/admin/hosts/${h.id}/clients`} className={`font-semibold text-accent underline ${focusRing}`}>Clients</Link>
          <Link href={`/admin/hosts/${h.id}/bookings`} className={`font-semibold text-accent underline ${focusRing}`}>Bookings and answers</Link>
          <Link href={`/admin/hosts/${h.id}/payments`} className={`font-semibold text-accent underline ${focusRing}`}>Payments and gateways</Link>
        </nav>
      )}
      <p className="mt-6 text-sm text-text-muted">Your visit to this page, and to each customer-data page, is in the audit log.</p>
    </div>
  );
}
