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

export const dynamic = "force-dynamic";

const pct = (part: number, whole: number) => { const r = rate(part, whole); return r === null ? "–" : `${r}%`; };
const num = (n: number) => n.toLocaleString("en-IN");

const STEPS: { key: keyof Counts; label: string; hint: string }[] = [
  { key: "views", label: "Booking-page views", hint: "One per visitor, page and day" },
  { key: "slotClicks", label: "Picked a time", hint: "Tapped a time on the page" },
  { key: "started", label: "Started booking", hint: "Sent the booking form" },
  { key: "completed", label: "Completed bookings", hint: "Booked (paid, where there's a price)" },
];

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string; event?: string }> }) {
  const user = await requireOwnAccount();
  const { days: asked, event } = await searchParams;
  if (!authEnabled()) {
    return (
      <div>
        <h1 className="font-display text-xl text-text">Analytics</h1>
        <p className="mt-6 text-text-muted">Analytics need the database, which this demo copy doesn&apos;t have.</p>
      </div>
    );
  }
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
  const f = r.funnel;
  const top = Math.max(f.views, 1);

  return (
    <div>
      <h1 className="font-display text-xl text-text">Analytics</h1>
      <p className="mt-1 max-w-2xl text-sm text-text-muted">Which channels bring your bookings. Counted on Hourhand itself: no cookies, no trackers, and guests who ask browsers not to track them aren&apos;t counted.</p>

      <nav aria-label="Period" className="mt-4 flex flex-wrap items-center gap-2">
        {WINDOWS.map((d) => win.locked.includes(d)
          ? <Link key={d} href="/dashboard/plan" className={pill(false)} title="Solo and Duo plans show 90 days">Last {d} days · upgrade</Link>
          : <Link key={d} href={href({ days: d })} aria-current={d === win.days ? "page" : undefined} className={pill(d === win.days)}>Last {d} days</Link>)}
      </nav>
      {eventTypes.length > 1 && (
        <nav aria-label="Event type" className="mt-2 flex flex-wrap items-center gap-2">
          <Link href={href({ event: null })} aria-current={!eventTypeId ? "page" : undefined} className={pill(!eventTypeId)}>All event types</Link>
          {eventTypes.map((et) => <Link key={et.id} href={href({ event: et.id })} aria-current={et.id === eventTypeId ? "page" : undefined} className={pill(et.id === eventTypeId)}>{et.name}</Link>)}
        </nav>
      )}

      <section aria-labelledby="funnel" className="mt-6 max-w-3xl">
        <h2 id="funnel" className="font-semibold text-text">Funnel</h2>
        <ol className="mt-2 grid gap-2">
          {STEPS.map((s, i) => (
            <li key={s.key}>
              <Card>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm text-text-muted">{s.label}</p>
                  {i > 0 && <p className="text-sm text-text-muted">{pct(f[s.key], f[STEPS[i - 1].key])} of the step before</p>}
                </div>
                <p className="mt-1 text-xl font-semibold text-text">{num(f[s.key])}</p>
                <div className="mt-2 h-2 rounded-full bg-surface" aria-hidden="true">
                  <div className="h-2 rounded-full bg-accent" style={{ width: `${Math.round((f[s.key] / top) * 100)}%` }} />
                </div>
                <p className="mt-1 text-xs text-text-muted">{s.hint}</p>
              </Card>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-text">
          <span className="font-semibold">{pct(f.completed, f.views)}</span> of booking-page views became a booking.
          {!eventTypeId && r.profileViews > 0 && ` Your profile page had ${num(r.profileViews)} ${r.profileViews === 1 ? "view" : "views"} too.`}
        </p>
      </section>

      <section aria-labelledby="sources" className="mt-8">
        <h2 id="sources" className="font-semibold text-text">Where bookings come from</h2>
        {r.sources.length === 0 ? (
          <p className="mt-2 text-text-muted">No visits in this period yet. Share your link (add <code>?utm_source=whatsapp</code> or similar to tell your channels apart) and they&apos;ll show up here.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead><tr className="text-text-muted">
                <th className="py-2 pr-4 font-medium">Channel</th><th className="py-2 pr-4 font-medium">Source</th><th className="py-2 pr-4 font-medium">Campaign</th>
                <th className="py-2 pr-4 text-right font-medium">Views</th><th className="py-2 pr-4 text-right font-medium">Picked a time</th><th className="py-2 pr-4 text-right font-medium">Started</th>
                <th className="py-2 pr-4 text-right font-medium">Bookings</th><th className="py-2 text-right font-medium">Conversion</th>
              </tr></thead>
              <tbody>
                {r.sources.map((s) => (
                  <tr key={JSON.stringify([s.channel, s.source, s.medium, s.campaign, s.embed])} className="border-t border-border text-text">
                    <td className="py-2 pr-4">{s.channelLabel}{s.embed && s.channel !== "embed" && <span className="text-text-muted"> · embedded</span>}</td>
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
          <h2 id="by-type" className="font-semibold text-text">By event type</h2>
          <table className="mt-2 w-full max-w-2xl text-left text-sm">
            <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">Event type</th><th className="py-2 pr-4 text-right font-medium">Views</th><th className="py-2 pr-4 text-right font-medium">Bookings</th><th className="py-2 text-right font-medium">Conversion</th></tr></thead>
            <tbody>
              {r.byEventType.map((t) => (
                <tr key={t.eventTypeId} className="border-t border-border text-text"><td className="py-2 pr-4">{t.name}</td><td className="py-2 pr-4 text-right">{num(t.views)}</td><td className="py-2 pr-4 text-right font-semibold">{num(t.completed)}</td><td className="py-2 text-right">{pct(t.completed, t.views)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="mt-8 text-sm text-text-muted">Days run midnight to midnight UTC ({r.from} to {r.to}).</p>
      {win.canExport
        ? <a href={`/dashboard/analytics/export?${new URLSearchParams({ days: String(win.days), ...(eventTypeId ? { event: eventTypeId } : {}) })}`} className="mt-2 inline-flex min-h-11 items-center font-semibold text-accent underline">Download as CSV</a>
        : <p className="mt-2 text-sm text-text"><Link href="/dashboard/plan" className="font-semibold text-accent underline">Solo and Duo</Link> show 90 days and let you download the numbers as CSV.</p>}
    </div>
  );
}
