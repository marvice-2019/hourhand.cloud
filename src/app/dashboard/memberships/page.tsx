import Link from "next/link";
import { toggleMembershipPlan } from "./actions";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { MembershipPlanForm } from "@/components/MembershipPlanForm";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { resolveBaseUrl } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { formatMoney } from "@/lib/billing/plans";
import { store } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { membershipsAllowed } from "@/lib/memberships/handlers";
import { listMembers, listMembershipPlans, type Membership } from "@/lib/memberships/memberships";
import { requestMembershipDeps } from "@/lib/memberships/request-deps";
import { WEBHOOK_EVENTS, webhookLastSeen, webhookPath, webhookSecret } from "@/lib/memberships/webhook";

export const dynamic = "force-dynamic";

const ROLLOVER = { none: "no carry-over", capped: "carry over up to", unlimited: "unused sessions carry over" } as const;

function statusLabel(m: Membership): string {
  if (m.cancelAtPeriodEnd && !["cancelled", "completed", "expired"].includes(m.status)) return "Cancelling";
  return ({ authenticated: "Starting", active: "Active", pending: "Payment failing", halted: "On hold", paused: "Paused", cancelled: "Ended", completed: "Ended", expired: "Ended", created: "Not paid" } as const)[m.status];
}

export default async function MembershipsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireOwnAccount();
  const { error } = await searchParams;
  const deps = requestMembershipDeps();
  if (!deps) {
    return <div><h1 className="font-display text-xl text-text">Memberships</h1><p className="mt-2 text-text-muted">Memberships need payments, which this copy of Hourhand doesn&apos;t have.</p></div>;
  }
  const { pool, key } = deps;
  const [plan, connected, eventTypes, plans, members, lastSeen] = await Promise.all([
    deps.planFor(user.id), deps.authFor(user.id), store.listEventTypes(user.id), listMembershipPlans(pool, user.id), listMembers(pool, user.id), webhookLastSeen(pool, user.id),
  ]);
  const allowed = membershipsAllowed(plan);
  const names = new Map(eventTypes.map((e) => [e.id, e.name]));
  const bookable = eventTypes.filter((e) => e.active && e.kind === "one_on_one").map(({ id, name }) => ({ id, name }));
  const tz = user.timezone;
  const secret = connected ? await webhookSecret(pool, key, user.id) : null;
  const url = `${resolveBaseUrl() ?? "http://localhost:3000"}${webhookPath(user.id)}`;

  return (
    <div>
      <h1 className="font-display text-xl text-text">Memberships</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        Sell a monthly plan, like 4 sessions a month, charged automatically to your client&apos;s card or UPI Autopay and paid straight into your Razorpay account.
        Each paid month adds sessions they book from their private link. They can cancel any time; a cancelled membership runs to the end of the paid month.
      </p>
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">That membership isn&apos;t yours, or no longer exists.</p>}

      {!allowed && <Card className="mt-6 max-w-xl"><p className="text-text">Memberships come with Solo and Duo. <Link href="/dashboard/plan" className="font-semibold text-accent underline">Upgrade your plan</Link> to sell them. Existing members keep renewing either way.</p></Card>}
      {allowed && !connected && <Card className="mt-6 max-w-xl"><p className="text-text">Connect your Razorpay account under <Link href="/dashboard/integrations" className="font-semibold text-accent underline">Integrations</Link> first: members pay you directly.</p></Card>}

      {connected && secret && (
        <Card className="mt-6 max-w-xl">
          <h2 className="font-semibold text-text">1. Connect Razorpay&apos;s renewal notices {lastSeen ? <span className="ml-2 text-sm font-normal text-success">Working, last heard {formatDate(lastSeen, tz)}</span> : null}</h2>
          <p className="mt-2 text-sm text-text-muted">
            Sessions are added only when Razorpay tells Hourhand a payment went through. In your Razorpay Dashboard, make sure Subscriptions is enabled, then go to
            Accounts &amp; Settings → Webhooks → Add New Webhook and enter:
          </p>
          <dl className="mt-3 grid gap-2 text-sm">
            <div><dt className="text-text-muted">Webhook URL</dt><dd className="break-all font-mono text-text">{url}</dd></div>
            <div><dt className="text-text-muted">Secret</dt><dd className="break-all font-mono text-text">{secret}</dd></div>
            <div><dt className="text-text-muted">Active events</dt><dd className="text-text">{WEBHOOK_EVENTS.join(", ")}</dd></div>
          </dl>
        </Card>
      )}

      {allowed && connected && <Card className="mt-6 max-w-xl"><h2 className="mb-4 font-semibold text-text">2. New membership</h2><MembershipPlanForm eventTypes={bookable} /></Card>}

      <section aria-labelledby="mb-list" className="mt-8">
        <h2 id="mb-list" className="font-semibold text-text">Your memberships</h2>
        {plans.length === 0 ? <p className="mt-2 text-text-muted">None yet.</p> : (
          <ul className="mt-3 grid max-w-xl gap-3">
            {plans.map((p) => (
              <li key={p.id}>
                <Card className="grid gap-2">
                  <p className="font-semibold text-text">{p.name} {!p.active && <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-sm text-text-muted">Off sale</span>}</p>
                  <p className="text-sm text-text-muted">
                    {p.sessions} a month · {formatMoney(p.priceMinor, "INR")} a month · {ROLLOVER[p.rollover]}{p.rollover === "capped" ? ` ${p.rolloverCap}` : ""} · {p.eventTypeIds.map((id) => names.get(id) ?? "event type").join(", ")}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <CopyLinkButton path={`/join/${p.id}`} />
                    <form action={toggleMembershipPlan}>
                      <input type="hidden" name="planId" value={p.id} />
                      {!p.active && <input type="hidden" name="active" value="on" />}
                      <Button type="submit" variant="ghost" size="sm">{p.active ? "Take off sale" : "Put on sale"}</Button>
                    </form>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="mb-members" className="mt-8">
        <h2 id="mb-members" className="font-semibold text-text">Members</h2>
        {members.length === 0 ? <p className="mt-2 text-text-muted">No members yet.</p> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full max-w-4xl text-left text-sm">
              <thead><tr className="text-text-muted">
                <th className="py-2 pr-4 font-medium">Member</th><th className="py-2 pr-4 font-medium">Plan</th><th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Sessions left</th><th className="py-2 pr-4 font-medium">Paid months</th><th className="py-2 pr-4 font-medium">Renews / ends</th><th className="py-2 font-medium">Failed payments</th>
              </tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-t border-border text-text">
                    <td className="py-2 pr-4">{m.guestName}<br /><span className="text-text-muted">{m.guestEmail}</span></td>
                    <td className="py-2 pr-4">{m.planName}</td>
                    <td className={`py-2 pr-4 ${m.status === "pending" || m.status === "halted" ? "text-danger" : ""}`}>{statusLabel(m)}</td>
                    <td className="py-2 pr-4">{m.creditsLeft}</td>
                    <td className="py-2 pr-4">{m.charges}</td>
                    <td className="py-2 pr-4">{m.endedAt ? formatDate(m.endedAt, tz) : m.paidThrough ? formatDate(m.paidThrough, tz) : "–"}</td>
                    <td className="py-2">{m.failedPayments}{m.lastFailureAt ? <><br /><span className="text-text-muted">last {formatDate(m.lastFailureAt, tz)}</span></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
