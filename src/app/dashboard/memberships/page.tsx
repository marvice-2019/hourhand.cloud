import Link from "next/link";
import { toggleMembershipPlan } from "./actions";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { MembershipPlanForm } from "@/components/MembershipPlanForm";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { resolveBaseUrl } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { store } from "@/lib/data";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { membershipsAllowed } from "@/lib/memberships/handlers";
import { listMembers, listMembershipPlans, type Membership } from "@/lib/memberships/memberships";
import { requestMembershipDeps } from "@/lib/memberships/request-deps";
import { WEBHOOK_EVENTS, webhookLastSeen, webhookPath, webhookSecret } from "@/lib/memberships/webhook";

export const dynamic = "force-dynamic";

const ROLLOVER = { none: "memberships.rolloverNone", capped: "memberships.rolloverCapped", unlimited: "memberships.rolloverUnlimited" } as const satisfies Record<string, HostKey>;

function statusLabel(m: Membership): HostKey {
  if (m.cancelAtPeriodEnd && !["cancelled", "completed", "expired"].includes(m.status)) return "memberships.statusCancelling";
  return ({
    authenticated: "memberships.statusStarting", active: "memberships.statusActive", pending: "memberships.statusPaymentFailing", halted: "memberships.statusOnHold",
    paused: "memberships.statusPaused", cancelled: "memberships.statusEnded", completed: "memberships.statusEnded", expired: "memberships.statusEnded", created: "memberships.statusNotPaid",
  } as const)[m.status];
}

export default async function MembershipsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireOwnAccount();
  const { error } = await searchParams;
  const { t, tNodes, date, inr } = await getHostI18n();
  const deps = requestMembershipDeps();
  if (!deps) {
    return <div><h1 className="font-display text-xl text-text">{t("memberships.title")}</h1><p className="mt-2 text-text-muted">{t("memberships.needsPayments")}</p></div>;
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
      <h1 className="font-display text-xl text-text">{t("memberships.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("memberships.intro")}</p>
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("memberships.errNotFound")}</p>}

      {!allowed && <Card className="mt-6 max-w-xl"><p className="text-text">{tNodes("memberships.needsPlan", { link: <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t("memberships.upgradeLink")}</Link> })}</p></Card>}
      {allowed && !connected && <Card className="mt-6 max-w-xl"><p className="text-text">{tNodes("memberships.connectRazorpay", { link: <Link href="/dashboard/integrations" className="font-semibold text-accent underline">{t("nav.integrations")}</Link> })}</p></Card>}

      {connected && secret && (
        <Card className="mt-6 max-w-xl">
          <h2 className="font-semibold text-text">{t("memberships.webhookTitle")} {lastSeen ? <span className="ml-2 text-sm font-normal text-success">{t("memberships.webhookWorking", { date: date(lastSeen, tz) })}</span> : null}</h2>
          <p className="mt-2 text-sm text-text-muted">{t("memberships.webhookBody")}</p>
          <dl className="mt-3 grid gap-2 text-sm">
            <div><dt className="text-text-muted">{t("memberships.webhookUrl")}</dt><dd className="break-all font-mono text-text">{url}</dd></div>
            <div><dt className="text-text-muted">{t("memberships.webhookSecret")}</dt><dd className="break-all font-mono text-text">{secret}</dd></div>
            <div><dt className="text-text-muted">{t("memberships.webhookEvents")}</dt><dd className="text-text">{WEBHOOK_EVENTS.join(", ")}</dd></div>
          </dl>
        </Card>
      )}

      {allowed && connected && <Card className="mt-6 max-w-xl"><h2 className="mb-4 font-semibold text-text">{t("memberships.newTitle")}</h2><MembershipPlanForm eventTypes={bookable} /></Card>}

      <section aria-labelledby="mb-list" className="mt-8">
        <h2 id="mb-list" className="font-semibold text-text">{t("memberships.yours")}</h2>
        {plans.length === 0 ? <p className="mt-2 text-text-muted">{t("memberships.noneYet")}</p> : (
          <ul className="mt-3 grid max-w-xl gap-3">
            {plans.map((p) => (
              <li key={p.id}>
                <Card className="grid gap-2">
                  <p className="font-semibold text-text">{p.name} {!p.active && <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-sm text-text-muted">{t("memberships.offSale")}</span>}</p>
                  <p className="text-sm text-text-muted">
                    {t("memberships.planLine", {
                      sessions: p.sessions, price: inr(p.priceMinor), rollover: t(ROLLOVER[p.rollover], { n: String(p.rolloverCap) }),
                      eventTypes: p.eventTypeIds.map((id) => names.get(id) ?? t("memberships.unknownEventType")).join(", "),
                    })}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <CopyLinkButton path={`/join/${p.id}`} />
                    <form action={toggleMembershipPlan}>
                      <input type="hidden" name="planId" value={p.id} />
                      {!p.active && <input type="hidden" name="active" value="on" />}
                      <Button type="submit" variant="ghost" size="sm">{p.active ? t("memberships.takeOffSale") : t("memberships.putOnSale")}</Button>
                    </form>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="mb-members" className="mt-8">
        <h2 id="mb-members" className="font-semibold text-text">{t("memberships.members")}</h2>
        {members.length === 0 ? <p className="mt-2 text-text-muted">{t("memberships.noMembers")}</p> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full max-w-4xl text-left text-sm">
              <thead><tr className="text-text-muted">
                <th className="py-2 pr-4 font-medium">{t("memberships.colMember")}</th><th className="py-2 pr-4 font-medium">{t("memberships.colPlan")}</th><th className="py-2 pr-4 font-medium">{t("memberships.colStatus")}</th>
                <th className="py-2 pr-4 font-medium">{t("memberships.colSessionsLeft")}</th><th className="py-2 pr-4 font-medium">{t("memberships.colPaidMonths")}</th><th className="py-2 pr-4 font-medium">{t("memberships.colRenews")}</th><th className="py-2 font-medium">{t("memberships.colFailed")}</th>
              </tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-t border-border text-text">
                    <td className="py-2 pr-4">{m.guestName}<br /><span className="text-text-muted">{m.guestEmail}</span></td>
                    <td className="py-2 pr-4">{m.planName}</td>
                    <td className={`py-2 pr-4 ${m.status === "pending" || m.status === "halted" ? "text-danger" : ""}`}>{t(statusLabel(m))}</td>
                    <td className="py-2 pr-4">{m.creditsLeft}</td>
                    <td className="py-2 pr-4">{m.charges}</td>
                    <td className="py-2 pr-4">{m.endedAt ? date(m.endedAt, tz) : m.paidThrough ? date(m.paidThrough, tz) : "–"}</td>
                    <td className="py-2">{m.failedPayments}{m.lastFailureAt ? <><br /><span className="text-text-muted">{t("memberships.lastFailure", { date: date(m.lastFailureAt, tz) })}</span></> : null}</td>
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
