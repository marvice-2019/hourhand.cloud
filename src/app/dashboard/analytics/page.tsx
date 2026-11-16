import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { analyticsReport, rate, type Counts } from "@/lib/analytics/store";
import { analyticsWindow, WINDOWS } from "@/lib/analytics/window";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

const STEPS: { key: keyof Counts; label: HostKey; hint: HostKey }[] = [
  { key: "views", label: "analytics.stepViews", hint: "analytics.stepViewsHint" },
  { key: "slotClicks", label: "analytics.stepPicked", hint: "analytics.stepPickedHint" },
  { key: "started", label: "analytics.stepStarted", hint: "analytics.stepStartedHint" },
  { key: "completed", label: "analytics.stepCompleted", hint: "analytics.stepCompletedHint" },
];

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string; event?: string }> }) {
  const user = await requireOwnAccount();
  const { t, tNodes, number } = await getHostI18n();
  const { days: asked, event } = await searchParams;
  if (!authEnabled()) {
    return (
      <div>
        <h1 className="font-display text-xl text-text">{t("analytics.title")}</h1>
        <p className="mt-6 text-text-muted">{t("analytics.demo")}</p>
      </div>
    );
  }
  const num = (n: number) => number(n);
  const pct = (part: number, whole: number) => { const r = rate(part, whole); return r === null ? "–" : `${number(r)}%`; };
  const pool = getPool(process.env.DATABASE_URL as string);
  const plan = await hostPlan(pool, user.id);
  const win = analyticsWindow(plan, asked);
  const eventTypes = (await store.listEventTypes(user.id)).sort((a, b) => a.position - b.position);
  const eventTypeId = eventTypes.some((et) => et.id === event) ? event! : null;
  const r = await analyticsReport(pool, user.id, { days: win.days, eventTypeId }, new Date());
  const href = (o: { days?: number; event?: string | null }) => {
    const q = new URLSearchParams();
    q.set("days", String(o.days ?? win.days));
    const ev = o.event === undefined ? eventTypeId : o.event;
    if (ev) q.set("event", ev);
    return `/dashboard/analytics?${q}`;
  };
  const pill = (active: boolean) => `inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-semibold ${active ? "border-accent bg-surface text-text" : "border-border text-text-muted hover:bg-surface hover:text-text"} ${focusRing}`;
  const channel = (c: string) => t(`analytics.ch${c[0].toUpperCase()}${c.slice(1)}` as HostKey);
  const f = r.funnel;
  const top = Math.max(f.views, 1);

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("analytics.title")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-text-muted">{t("analytics.intro")}</p>

      <nav aria-label={t("analytics.periodNav")} className="mt-4 flex flex-wrap items-center gap-2">
        {WINDOWS.map((d) => win.locked.includes(d)
          ? <Link key={d} href="/dashboard/plan" className={pill(false)} title={t("analytics.upgradeTitle")}>{t("analytics.lastDaysUpgrade", { n: d })}</Link>
          : <Link key={d} href={href({ days: d })} aria-current={d === win.days ? "page" : undefined} className={pill(d === win.days)}>{t("analytics.lastDays", { n: d })}</Link>)}
      </nav>
      {eventTypes.length > 1 && (
        <nav aria-label={t("analytics.eventTypeNav")} className="mt-2 flex flex-wrap items-center gap-2">
          <Link href={href({ event: null })} aria-current={!eventTypeId ? "page" : undefined} className={pill(!eventTypeId)}>{t("analytics.allEventTypes")}</Link>
          {eventTypes.map((et) => <Link key={et.id} href={href({ event: et.id })} aria-current={et.id === eventTypeId ? "page" : undefined} className={pill(et.id === eventTypeId)}>{et.name}</Link>)}
        </nav>
      )}

      <section aria-labelledby="funnel" className="mt-6 max-w-3xl">
        <h2 id="funnel" className="font-semibold text-text">{t("analytics.funnel")}</h2>
        <ol className="mt-2 grid gap-2">
          {STEPS.map((s, i) => (
            <li key={s.key}>
              <Card>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm text-text-muted">{t(s.label)}</p>
                  {i > 0 && <p className="text-sm text-text-muted">{t("analytics.ofStepBefore", { pct: pct(f[s.key], f[STEPS[i - 1].key]) })}</p>}
                </div>
                <p className="mt-1 text-xl font-semibold text-text">{num(f[s.key])}</p>
                <div className="mt-2 h-2 rounded-full bg-surface" aria-hidden="true">
                  <div className="h-2 rounded-full bg-accent" style={{ width: `${Math.round((f[s.key] / top) * 100)}%` }} />
                </div>
                <p className="mt-1 text-xs text-text-muted">{t(s.hint)}</p>
              </Card>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-text">
          {tNodes("analytics.conversion", { pct: <span className="font-semibold">{pct(f.completed, f.views)}</span> })}
          {!eventTypeId && r.profileViews > 0 && <> {r.profileViews === 1 ? t("analytics.profileViewsOne") : t("analytics.profileViews", { n: num(r.profileViews) })}</>}
        </p>
      </section>

      <section aria-labelledby="sources" className="mt-8">
        <h2 id="sources" className="font-semibold text-text">{t("analytics.sources")}</h2>
        {r.sources.length === 0 ? (
          // i18n-ignore: a query parameter, not words
          <p className="mt-2 text-text-muted">{tNodes("analytics.noVisits", { example: <code>?utm_source=whatsapp</code> })}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead><tr className="text-text-muted">
                <th className="py-2 pr-4 font-medium">{t("analytics.colChannel")}</th><th className="py-2 pr-4 font-medium">{t("analytics.colSource")}</th><th className="py-2 pr-4 font-medium">{t("analytics.colCampaign")}</th>
                <th className="py-2 pr-4 text-right font-medium">{t("analytics.colViews")}</th><th className="py-2 pr-4 text-right font-medium">{t("analytics.colPicked")}</th><th className="py-2 pr-4 text-right font-medium">{t("analytics.colStarted")}</th>
                <th className="py-2 pr-4 text-right font-medium">{t("analytics.colBookings")}</th><th className="py-2 text-right font-medium">{t("analytics.colConversion")}</th>
              </tr></thead>
              <tbody>
                {r.sources.map((s) => (
                  <tr key={JSON.stringify([s.channel, s.source, s.medium, s.campaign, s.embed])} className="border-t border-border text-text">
                    <td className="py-2 pr-4">{channel(s.channel)}{s.embed && s.channel !== "embed" && <span className="text-text-muted"> · {t("analytics.embedded")}</span>}</td>
                    <td className="py-2 pr-4 break-all">{s.source || "–"}{s.medium && <span className="text-text-muted"> / {s.medium}</span>}</td>
                    <td className="py-2 pr-4 break-all">{s.campaign || "–"}</td>
                    <td className="py-2 pr-4 text-right">{num(s.views)}</td><td className="py-2 pr-4 text-right">{num(s.slotClicks)}</td><td className="py-2 pr-4 text-right">{num(s.started)}</td>
                    <td className="py-2 pr-4 text-right font-semibold">{num(s.completed)}</td><td className="py-2 text-right">{pct(s.completed, s.views)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!eventTypeId && r.byEventType.length > 1 && (
        <section aria-labelledby="by-type" className="mt-8">
          <h2 id="by-type" className="font-semibold text-text">{t("analytics.byEventType")}</h2>
          <table className="mt-2 w-full max-w-2xl text-left text-sm">
            <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">{t("analytics.colEventType")}</th><th className="py-2 pr-4 text-right font-medium">{t("analytics.colViews")}</th><th className="py-2 pr-4 text-right font-medium">{t("analytics.colBookings")}</th><th className="py-2 text-right font-medium">{t("analytics.colConversion")}</th></tr></thead>
            <tbody>
              {r.byEventType.map((et) => (
                <tr key={et.eventTypeId} className="border-t border-border text-text"><td className="py-2 pr-4">{eventTypes.some((x) => x.id === et.eventTypeId) ? et.name : t("analytics.deletedEventType")}</td><td className="py-2 pr-4 text-right">{num(et.views)}</td><td className="py-2 pr-4 text-right font-semibold">{num(et.completed)}</td><td className="py-2 text-right">{pct(et.completed, et.views)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="mt-8 text-sm text-text-muted">{t("analytics.utcNote", { from: r.from, to: r.to })}</p>
      {win.canExport
        ? <a href={`/dashboard/analytics/export?${new URLSearchParams({ days: String(win.days), ...(eventTypeId ? { event: eventTypeId } : {}) })}`} className="mt-2 inline-flex min-h-11 items-center font-semibold text-accent underline">{t("analytics.download")}</a>
        : <p className="mt-2 text-sm text-text">{tNodes("analytics.upsell", { plans: <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t("analytics.upsellPlans")}</Link> })}</p>}
    </div>
  );
}
