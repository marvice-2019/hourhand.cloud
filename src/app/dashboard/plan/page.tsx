import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getHostSubscription, type HostSubscription } from "@/lib/billing/account";
import { billingFor } from "@/lib/billing/env";
import { effectivePlan, LIMITS, PLAN_NAMES, PROVIDER_FOR, providerPriceId, type BillingInterval, type Currency, type PaidPlan } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import type { HostI18n } from "@/lib/i18n/host/format";
import { getHostI18n } from "@/lib/i18n/host/server";
import { hostAddonPriceLine, hostPriceLine } from "@/lib/i18n/host/price";
import { SeatForm } from "@/components/SeatForm";
import { seatFor } from "@/lib/seats";
import { SmsUsageMeter } from "@/components/SmsUsageMeter";
import { smsConfig } from "@/lib/sms/config";
import { smsUsage } from "@/lib/sms/outbox";
import { cancelSubscription, choosePlan, openBillingPortal, pauseSubscription, resumeSubscription } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, HostKey> = {
  already_subscribed: "plan.errorAlreadySubscribed",
  not_configured: "plan.errorNotConfigured",
  no_subscription: "plan.errorNoSubscription",
  cannot_pause: "plan.errorCannotPause",
  provider: "plan.errorProvider",
  demo: "plan.errorDemo",
};
const DONE: Record<string, HostKey> = {
  cancelled: "plan.doneCancelled",
  paused: "plan.donePaused",
  resumed: "plan.doneResumed",
};

const FEATURES: Record<PaidPlan, HostKey[]> = {
  solo: ["plan.featureEverythingInFree", "plan.featureUnlimitedCalendars", "plan.featureSchedules", "plan.featureNoFooter"],
  duo: ["plan.featureEverythingInSolo", "plan.featureSecondPerson"],
};

function statusLine(s: HostSubscription, fmt: (d: Date) => string, t: HostI18n["t"]): string {
  const end = s.currentPeriodEnd ? fmt(s.currentPeriodEnd) : null;
  if (s.status === "paused") return t("plan.statusPaused");
  if (s.status === "unpaid") return t("plan.statusUnpaid", { plan: PLAN_NAMES[s.plan] });
  if (s.status === "past_due") return t("plan.statusPastDue");
  if (s.status === "cancelled") return end ? t("plan.statusEndedOn", { date: end }) : t("plan.statusEnded");
  if (s.cancelAtPeriodEnd) return end ? t("plan.statusCancelledUntil", { date: end }) : t("plan.statusCancelled");
  return end ? t("plan.statusRenews", { date: end }) : t("plan.statusActive");
}

export default async function PlanPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const live = authEnabled();
  const sub = live ? await getHostSubscription(getPool(process.env.DATABASE_URL as string), user.id) : null;
  const seat = live ? await seatFor(getPool(process.env.DATABASE_URL as string), user.id) : null;
  // Booking texts: shown only where SMS is set up on this server. Counted for whoever is signed in (a Duo second person
  // has their own count, against Duo's allowance).
  const texts = live && smsConfig() ? await smsUsage(getPool(process.env.DATABASE_URL as string), user.id, new Date()) : null;
  const holding = Boolean(sub?.subscriptionId) && sub!.plan !== "free" && sub!.status !== "cancelled";
  const currency: Currency = params.currency === "USD" ? "USD" : "INR";
  const interval: BillingInterval = params.interval === "year" ? "year" : "month";
  const provider = PROVIDER_FOR[currency];
  const providerReady = live && billingFor(provider) !== null;
  const i18n = await getHostI18n();
  const { t, tNodes, mediumDate, dayMonth } = i18n;
  const fmt = (d: Date) => mediumDate(d, user.timezone);
  const toggle = (key: "currency" | "interval", value: string, label: string, on: boolean) => (
    <Link
      href={`/dashboard/plan?${new URLSearchParams({ currency, interval, [key]: value })}`}
      aria-current={on ? "true" : undefined}
      className={`inline-flex min-h-11 items-center rounded-pill px-4 text-sm ${on ? "bg-accent text-on-accent" : "text-text-muted hover:text-text"} ${focusRing}`}
    >
      {label}
    </Link>
  );

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("plan.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        {t("plan.intro", { n: LIMITS.free.checkedCalendars })}
      </p>
      {!live && (
        <p role="note" className="mt-4 max-w-xl rounded-md bg-surface p-3 text-text">
          {tNodes(LIMITS.free.schedules === 1 ? "plan.demoSchedulesOne" : "plan.demoSchedulesMany", {
            label: <strong>{t("plan.demoLabel")}</strong>,
            n: String(LIMITS.free.schedules),
          })}
        </p>
      )}

      {params.checkout === "done" && (
        <p role="status" className="mt-4 max-w-xl text-success">{t("plan.checkoutDone")}</p>
      )}
      {params.checkout === "cancelled" && <p role="status" className="mt-4 text-text-muted">{t("plan.checkoutCancelled")}</p>}
      {params.done && Object.hasOwn(DONE, params.done) && <p role="status" className="mt-4 max-w-xl text-success">{t(DONE[params.done])}</p>}
      {params.error && <p role="alert" className="mt-4 max-w-xl text-danger">{t((Object.hasOwn(ERRORS, params.error) && ERRORS[params.error]) || ERRORS.provider)}</p>}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("plan.currentPlan", { plan: PLAN_NAMES[effectivePlan(sub && sub.plan !== "free" ? { plan: sub.plan, status: sub.status } : null)] })}</h2>
        {sub && sub.plan !== "free" && <p className="mt-1 text-text-muted">{statusLine(sub, fmt, t)}</p>}
        {holding && (
          <div className="mt-4 flex flex-wrap gap-2">
            {(sub!.status === "active" || sub!.status === "past_due" || sub!.status === "unpaid") && !sub!.cancelAtPeriodEnd && (
              <form action={cancelSubscription}>
                <Button type="submit" variant="secondary" size="sm">{t("plan.cancelRenewal")}</Button>
              </form>
            )}
            {sub!.status === "active" && (
              <form action={pauseSubscription}>
                <Button type="submit" variant="ghost" size="sm">{t("plan.pauseBilling")}</Button>
              </form>
            )}
            {sub!.status === "paused" && (
              <form action={resumeSubscription}>
                <Button type="submit" size="sm">{t("plan.resume")}</Button>
              </form>
            )}
            {sub!.provider === "stripe" && sub!.customerId && (
              <form action={openBillingPortal}>
                <Button type="submit" variant="ghost" size="sm">{t("plan.cardAndInvoices")}</Button>
              </form>
            )}
          </div>
        )}
      </Card>

      {texts && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">{t("plan.smsTitle")}</h2>
          <SmsUsageMeter usage={texts} resets={dayMonth(texts.resetsAt, "Asia/Kolkata")} i18n={i18n} />
        </Card>
      )}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("plan.addonDomainTitle")}</h2>
        <p className="mt-1 text-text-muted">
          {t("plan.addonDomainBody", { price: hostAddonPriceLine("domain", i18n) })}{" "}
          <Link href="/dashboard/domain" className={`font-semibold text-accent underline ${focusRing}`}>{t("plan.addonDomainLink")}</Link>
        </p>
      </Card>

      {live && sub && effectivePlan(sub.plan !== "free" ? { plan: sub.plan, status: sub.status } : null) === "duo" && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">{t("plan.secondPersonTitle")}</h2>
          <p className="mt-1 mb-4 max-w-xl text-text-muted">
            {t("plan.secondPersonIntro")}
          </p>
          <SeatForm seat={seat} />
        </Card>
      )}

      {!holding && (
        <>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <div role="group" aria-label={t("plan.currency")} className="flex rounded-pill border border-border p-1">
              {toggle("currency", "INR", t("plan.currencyInr"), currency === "INR")}
              {toggle("currency", "USD", t("plan.currencyUsd"), currency === "USD")}
            </div>
            <div role="group" aria-label={t("plan.billingPeriod")} className="flex rounded-pill border border-border p-1">
              {toggle("interval", "month", t("plan.monthly"), interval === "month")}
              {toggle("interval", "year", t("plan.yearly"), interval === "year")}
            </div>
          </div>
          <div className="mt-4 grid max-w-3xl gap-4 sm:grid-cols-2">
            {(["solo", "duo"] as const).map((plan) => {
              const ready = providerReady && providerPriceId(provider, plan, interval) !== null;
              return (
                <Card key={plan}>
                  <h2 className="font-display text-lg text-text">{PLAN_NAMES[plan]}</h2>
                  <p className="mt-1 text-text">{hostPriceLine(plan, interval, currency, i18n)}</p>
                  <ul className="mt-3 grid gap-1 text-sm text-text-muted">
                    {FEATURES[plan].map((f) => <li key={f}>{t(f)}</li>)}
                    {smsConfig() && <li>{t("plan.smsFeature", { n: LIMITS[plan].smsPerMonth })}</li>}
                  </ul>
                  {ready ? (
                    <form action={choosePlan} className="mt-4">
                      <input type="hidden" name="plan" value={plan} />
                      <input type="hidden" name="interval" value={interval} />
                      <input type="hidden" name="currency" value={currency} />
                      <Button type="submit" className="w-full">{t("plan.choose", { plan: PLAN_NAMES[plan] })}</Button>
                    </form>
                  ) : (
                    <p className="mt-4 text-sm text-text-muted">{live ? t(ERRORS.not_configured) : t(ERRORS.demo)}</p>
                  )}
                </Card>
              );
            })}
          </div>
          <p className="mt-4 max-w-xl text-sm text-text-muted">
            {currency === "INR" ? t("plan.paidInRupees") : t("plan.paidInDollars")}
          </p>
        </>
      )}
    </div>
  );
}
