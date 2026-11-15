import Link from "next/link";
import { BlockRangeForm, DateOverrideForm, ScheduleForm, ScopeChoice, WeeklyHoursForm } from "@/components/AvailabilityForms";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { todayIn } from "@/lib/availability";
import { store, type Interval } from "@/lib/data";
import { blockHolidaysAction, deleteDateOverrideAction, deleteScheduleAction, duplicateScheduleAction, makeDefaultScheduleAction } from "./actions";
import { upcomingHolidays } from "@/lib/holidays";
import { requireHost } from "@/lib/auth/session";
import { authEnabled } from "@/lib/auth/auth";
import { scheduleLimit } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { zoneOptions } from "@/lib/schedules";

export const dynamic = "force-dynamic";

function zoneName(timezone: string): string {
  const part = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
  return part ? `${part.value} (${timezone})` : timezone;
}

const longDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const hoursText = (intervals: Interval[]) => (intervals.length ? intervals.map((i) => `${i.from}–${i.to}`).join(", ") : "Unavailable");
const usedBy = (n: number) => (n === 0 ? "No event types" : n === 1 ? "1 event type" : `${n} event types`);

const NOTICES: Record<string, string> = {
  duplicated: "Copied. Rename it below, then change its hours.",
  default: "This is now your default schedule. New event types use it.",
  deleted: "Schedule deleted.",
};
const ERRORS: Record<string, string> = {
  limit: "Your plan includes one schedule. Upgrade to Solo or Duo to keep several.",
  default: "This is your default schedule. Make another schedule the default before deleting this one.",
  in_use: "Event types started using this schedule while you were deleting it. Pick where they should go and try again.",
};

export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<{ schedule?: string; notice?: string; error?: string }> }) {
  const user = await requireHost();
  const params = await searchParams;
  const all = await store.listSchedules(user.id);
  const current = all.find((s) => s.id === params.schedule) ?? all[0];
  const { schedule, rules } = await store.getSchedule(user.id, current.id);
  const limit = authEnabled() ? await scheduleLimit(getPool(process.env.DATABASE_URL as string), user.id) : LIMITS.free.schedules;
  const atLimit = all.length >= limit;
  const several = all.length > 1;
  const today = todayIn(schedule.timezone, new Date());
  const zones = zoneOptions(user.timezone, schedule.timezone);
  const others = all.filter((s) => s.id !== schedule.id);
  const notice = params.notice ? NOTICES[params.notice] : undefined;
  const error = params.error ? ERRORS[params.error] : undefined;

  const weekly: Record<number, Interval[]> = {};
  const overrides: { date: string; intervals: Interval[] }[] = [];
  for (const r of rules) {
    if (r.kind === "weekly") weekly[r.weekday] = r.intervals;
    else if (r.onDate >= today) overrides.push({ date: r.onDate, intervals: r.intervals });
  }
  overrides.sort((a, b) => a.date.localeCompare(b.date));
  const daysOff = new Set(overrides.filter((o) => o.intervals.length === 0).map((o) => o.date));
  const holidays = upcomingHolidays(today);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-xl text-text">Availability</h1>
        <p className="mt-2 text-text-muted">Set the hours people can book you each week, plus days off. Each event type books against one schedule.</p>
        {notice && <p role="status" className="mt-3 rounded-md bg-surface p-3 font-semibold text-text">{notice}</p>}
        {error && <p role="alert" className="mt-3 rounded-md bg-surface p-3 font-semibold text-danger">{error}</p>}
      </div>

      <Card>
        <section aria-labelledby="schedules-heading">
          <h2 id="schedules-heading" className="font-display text-lg text-text">Schedules</h2>
          <p className="mt-1 max-w-xl text-text-muted">
            Keep separate hours for different kinds of work, like clinic days, evening calls or clients in another time zone.
            A booking on any schedule blocks that time on all of them.
          </p>
          <ul className="mt-4 divide-y divide-border">
            {all.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="inline-flex items-center gap-2">
                  <Link href={`/dashboard/availability?schedule=${s.id}`} aria-current={s.id === schedule.id ? "page" : undefined}
                    className={`inline-flex min-h-11 items-center font-semibold underline ${s.id === schedule.id ? "text-text" : "text-accent"} ${focusRing}`}>
                    {s.name}
                  </Link>
                  {s.isDefault && <span className="rounded-pill bg-surface px-2 text-sm text-text-muted">Default</span>}
                </span>
                <span className="text-sm text-text-muted">{s.timezone.replaceAll("_", " ")} · {usedBy(s.eventTypes.length)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="font-semibold text-text">Add a schedule</h3>
            {atLimit ? (
              <p className="mt-1 text-text-muted">
                Your plan includes {limit === 1 ? "one schedule" : `${limit} schedules`}.{" "}
                <Link href="/dashboard/plan" className="font-semibold text-accent underline">Upgrade to Solo or Duo</Link> to keep several.
              </p>
            ) : (
              <div className="mt-3"><ScheduleForm zones={zones} defaultZone={user.timezone} /></div>
            )}
          </div>
        </section>
      </Card>

      <Card className="space-y-4">
        <section aria-labelledby="this-schedule-heading">
          <h2 id="this-schedule-heading" className="font-display text-lg text-text">
            {schedule.name}{schedule.isDefault && <span className="ml-2 text-base font-normal text-text-muted">(default)</span>}
          </h2>
          <p className="mt-1 text-text">All times on this schedule are in <strong>{zoneName(schedule.timezone)}</strong>.</p>
          <p className="mt-1 text-text-muted">
            {current.eventTypes.length ? `Used by ${current.eventTypes.map((e) => e.name).join(", ")}.` : "No event types use this schedule yet. Pick it in an event type’s settings."}
          </p>
          <div className="mt-4"><ScheduleForm key={schedule.id} schedule={schedule} zones={zones} defaultZone={schedule.timezone} /></div>
          <div className="mt-4 flex flex-wrap gap-3">
            {!atLimit && (
              <form action={duplicateScheduleAction}>
                <input type="hidden" name="schedule" value={schedule.id} />
                <Button type="submit" variant="secondary">Duplicate<span className="sr-only"> {schedule.name}</span></Button>
              </form>
            )}
            {!schedule.isDefault && (
              <form action={makeDefaultScheduleAction}>
                <input type="hidden" name="schedule" value={schedule.id} />
                <Button type="submit" variant="secondary">Make default</Button>
              </form>
            )}
          </div>
        </section>
        {!schedule.isDefault && (
          <section aria-labelledby="delete-schedule-heading" className="border-t border-border pt-4">
            <h3 id="delete-schedule-heading" className="font-semibold text-text">Delete this schedule</h3>
            <form action={deleteScheduleAction} className="mt-2 flex flex-wrap items-end gap-3">
              <input type="hidden" name="schedule" value={schedule.id} />
              {current.eventTypes.length > 0 && (
                <div className="w-full max-w-md">
                  <p className="text-text-muted">{current.eventTypes.map((e) => e.name).join(", ")} {current.eventTypes.length === 1 ? "uses" : "use"} this schedule. Move {current.eventTypes.length === 1 ? "it" : "them"} to:</p>
                  <label htmlFor="move-to" className="sr-only">Move event types to</label>
                  <select id="move-to" name="move-to" required defaultValue={others.find((o) => o.isDefault)?.id}
                    className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
                    {others.map((o) => <option key={o.id} value={o.id}>{o.name}{o.isDefault ? " (default)" : ""}</option>)}
                  </select>
                </div>
              )}
              <Button type="submit" variant="ghost">{current.eventTypes.length > 0 ? "Move and delete" : "Delete schedule"}</Button>
            </form>
          </section>
        )}
      </Card>

      <Card>
        <h2 className="font-display text-lg text-text">Weekly hours</h2>
        <WeeklyHoursForm key={schedule.id} initial={weekly} scheduleId={schedule.id} />
      </Card>

      <Card className="space-y-6">
        <section aria-labelledby="overrides-heading">
          <h2 id="overrides-heading" className="font-display text-lg text-text">Date overrides</h2>
          <p className="mt-1 text-text-muted">Change your hours for a single day. Overrides win over your weekly hours{several ? " on this schedule" : ""}.</p>
          {overrides.length === 0 ? (
            <p className="mt-4 rounded-md bg-surface p-4 text-text-muted">No date overrides. Add one when your hours change for a day.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {overrides.map((o) => (
                <li key={o.date} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-text">
                    <span className="font-semibold">{longDate(o.date)}</span>
                    <span className="text-text-muted"> · {hoursText(o.intervals)}</span>
                  </span>
                  <form action={deleteDateOverrideAction}>
                    <input type="hidden" name="schedule" value={schedule.id} />
                    <input type="hidden" name="date" value={o.date} />
                    <Button type="submit" variant="ghost">
                      Remove<span className="sr-only"> override for {longDate(o.date)}</span>
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="add-override-heading" className="border-t border-border pt-6">
          <h3 id="add-override-heading" className="font-semibold text-text">Add an override</h3>
          <div className="mt-3">
            <DateOverrideForm key={schedule.id} today={today} scheduleId={schedule.id} />
          </div>
        </section>

        <section aria-labelledby="block-heading" className="border-t border-border pt-6">
          <h3 id="block-heading" className="font-semibold text-text">Block a stretch of days</h3>
          <p className="mt-1 text-text-muted">Going away? Pick the first and last day and nobody can book you in between.</p>
          <div className="mt-3">
            <BlockRangeForm key={schedule.id} today={today} scheduleId={schedule.id} scheduleName={several ? schedule.name : undefined} />
          </div>
        </section>
      </Card>

      <Card>
        <section aria-labelledby="holidays-heading">
          <h2 id="holidays-heading" className="font-display text-lg text-text">Holidays</h2>
          <p className="mt-1 max-w-xl text-text-muted">
            India&apos;s gazetted holidays for the next year. Tick the ones you take off and nobody can book you on them.
            Dates marked * follow the moon and can move by a day. For Pongal, Onam, Ugadi and other regional festivals, use &ldquo;Add an override&rdquo; above.
          </p>
          {holidays.length === 0 ? (
            <p className="mt-3 text-text-muted">No holiday dates loaded for the coming year yet.</p>
          ) : (
            <form action={blockHolidaysAction} className="mt-4 grid gap-1">
              <input type="hidden" name="schedule" value={schedule.id} />
              {holidays.map((h) => (
                <label key={h.date} className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" name="holiday" value={h.date} defaultChecked={false} disabled={daysOff.has(h.date)} className="size-5 accent-accent" />
                  <span className="text-text">
                    {longDate(h.date)}: {h.name}{h.lunar ? " *" : ""}
                    {daysOff.has(h.date) && <span className="ml-2 text-sm text-text-muted">already a day off{several ? " here" : ""}</span>}
                  </span>
                </label>
              ))}
              {several && <div className="mt-2"><ScopeChoice scheduleName={schedule.name} /></div>}
              <div className="mt-3"><Button type="submit">Block the ticked days</Button></div>
            </form>
          )}
        </section>
      </Card>
    </div>
  );
}
