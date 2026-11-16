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
import { getHostI18n } from "@/lib/i18n/host/server";
import type { HostI18n } from "@/lib/i18n/host/format";
import type { HostKey } from "@/lib/i18n/host";

export const dynamic = "force-dynamic";

const hoursText = (intervals: Interval[], t: HostI18n["t"]) => (intervals.length ? intervals.map((i) => `${i.from}–${i.to}`).join(", ") : t("availability.unavailable"));
const usedBy = (n: number, t: HostI18n["t"]) =>
  n === 0 ? t("availability.usedByNone") : n === 1 ? t("availability.usedByOne") : t("availability.usedByMany", { n });

const NOTICES: Record<string, HostKey> = {
  duplicated: "availability.noticeDuplicated",
  default: "availability.noticeDefault",
  deleted: "availability.noticeDeleted",
};
const ERRORS: Record<string, HostKey> = {
  limit: "availability.errLimit",
  default: "availability.errDefault",
  in_use: "availability.errInUse",
};

export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<{ schedule?: string; notice?: string; error?: string }> }) {
  const user = await requireHost();
  const { t, tNodes, dayDate: longDate, zoneLongName } = await getHostI18n();
  const zoneName = (timezone: string) => {
    const long = zoneLongName(timezone);
    return long ? `${long} (${timezone})` : timezone;
  };
  const params = await searchParams;
  const all = await store.listSchedules(user.id);
  const current = all.find((s) => s.id === params.schedule) ?? all[0];
  const { schedule, rules } = await store.getSchedule(user.id, current.id);
  const limit = authEnabled() ? await scheduleLimit(getPool(process.env.DATABASE_URL as string), user.id) : LIMITS.solo.schedules; // the demo gets Solo, as in actions.ts
  const atLimit = all.length >= limit;
  const several = all.length > 1;
  const today = todayIn(schedule.timezone, new Date());
  const zones = zoneOptions(user.timezone, schedule.timezone);
  const others = all.filter((s) => s.id !== schedule.id);
  const notice = params.notice && NOTICES[params.notice] ? t(NOTICES[params.notice]) : undefined;
  const error = params.error && ERRORS[params.error] ? t(ERRORS[params.error]) : undefined;

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
        <h1 className="font-display text-xl text-text">{t("availability.title")}</h1>
        <p className="mt-2 text-text-muted">{t("availability.intro")}</p>
        {notice && <p role="status" className="mt-3 rounded-md bg-surface p-3 font-semibold text-text">{notice}</p>}
        {error && <p role="alert" className="mt-3 rounded-md bg-surface p-3 font-semibold text-danger">{error}</p>}
      </div>

      <Card>
        <section aria-labelledby="schedules-heading">
          <h2 id="schedules-heading" className="font-display text-lg text-text">{t("availability.schedulesTitle")}</h2>
          <p className="mt-1 max-w-xl text-text-muted">{t("availability.schedulesIntro")}</p>
          <ul className="mt-4 divide-y divide-border">
            {all.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="inline-flex items-center gap-2">
                  <Link href={`/dashboard/availability?schedule=${s.id}`} aria-current={s.id === schedule.id ? "page" : undefined}
                    className={`inline-flex min-h-11 items-center font-semibold underline ${s.id === schedule.id ? "text-text" : "text-accent"} ${focusRing}`}>
                    {s.name}
                  </Link>
                  {s.isDefault && <span className="rounded-pill bg-surface px-2 text-sm text-text-muted">{t("availability.defaultBadge")}</span>}
                </span>
                <span className="text-sm text-text-muted">{s.timezone.replaceAll("_", " ")} · {usedBy(s.eventTypes.length, t)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="font-semibold text-text">{t("availability.addScheduleTitle")}</h3>
            {atLimit ? (
              <p className="mt-1 text-text-muted">
                {tNodes(limit === 1 ? "availability.limitOne" : "availability.limitMany", {
                  n: String(limit),
                  link: <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t("availability.upgradeLink")}</Link>,
                })}
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
            {schedule.name}{schedule.isDefault && <span className="ml-2 text-base font-normal text-text-muted">{t("availability.defaultSuffix")}</span>}
          </h2>
          <p className="mt-1 text-text">{tNodes("availability.timesIn", { zone: <strong>{zoneName(schedule.timezone)}</strong> })}</p>
          <p className="mt-1 text-text-muted">
            {current.eventTypes.length ? t("availability.usedByList", { names: current.eventTypes.map((e) => e.name).join(", ") }) : t("availability.usedByNoneYet")}
          </p>
          <div className="mt-4"><ScheduleForm key={schedule.id} schedule={schedule} zones={zones} defaultZone={schedule.timezone} /></div>
          <div className="mt-4 flex flex-wrap gap-3">
            {!atLimit && (
              <form action={duplicateScheduleAction}>
                <input type="hidden" name="schedule" value={schedule.id} />
                <Button type="submit" variant="secondary">{t("availability.duplicate")}<span className="sr-only">{t("availability.duplicateHidden", { name: schedule.name })}</span></Button>
              </form>
            )}
            {!schedule.isDefault && (
              <form action={makeDefaultScheduleAction}>
                <input type="hidden" name="schedule" value={schedule.id} />
                <Button type="submit" variant="secondary">{t("availability.makeDefault")}</Button>
              </form>
            )}
          </div>
        </section>
        {!schedule.isDefault && (
          <section aria-labelledby="delete-schedule-heading" className="border-t border-border pt-4">
            <h3 id="delete-schedule-heading" className="font-semibold text-text">{t("availability.deleteTitle")}</h3>
            <form action={deleteScheduleAction} className="mt-2 flex flex-wrap items-end gap-3">
              <input type="hidden" name="schedule" value={schedule.id} />
              {current.eventTypes.length > 0 && (
                <div className="w-full max-w-md">
                  <p className="text-text-muted">
                    {t(current.eventTypes.length === 1 ? "availability.moveOne" : "availability.moveMany", { names: current.eventTypes.map((e) => e.name).join(", ") })}
                  </p>
                  <label htmlFor="move-to" className="sr-only">{t("availability.moveToLabel")}</label>
                  <select id="move-to" name="move-to" required defaultValue={others.find((o) => o.isDefault)?.id}
                    className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
                    {others.map((o) => <option key={o.id} value={o.id}>{o.isDefault ? t("availability.optionDefault", { name: o.name }) : o.name}</option>)}
                  </select>
                </div>
              )}
              <Button type="submit" variant="ghost">{current.eventTypes.length > 0 ? t("availability.moveAndDelete") : t("availability.deleteSchedule")}</Button>
            </form>
          </section>
        )}
      </Card>

      <Card>
        <h2 className="font-display text-lg text-text">{t("availability.weeklyHours")}</h2>
        <WeeklyHoursForm key={schedule.id} initial={weekly} scheduleId={schedule.id} />
      </Card>

      <Card className="space-y-6">
        <section aria-labelledby="overrides-heading">
          <h2 id="overrides-heading" className="font-display text-lg text-text">{t("availability.overridesTitle")}</h2>
          <p className="mt-1 text-text-muted">{t(several ? "availability.overridesIntroSchedule" : "availability.overridesIntro")}</p>
          {overrides.length === 0 ? (
            <p className="mt-4 rounded-md bg-surface p-4 text-text-muted">{t("availability.noOverrides")}</p>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {overrides.map((o) => (
                <li key={o.date} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-text">
                    <span className="font-semibold">{longDate(o.date)}</span>
                    <span className="text-text-muted"> · {hoursText(o.intervals, t)}</span>
                  </span>
                  <form action={deleteDateOverrideAction}>
                    <input type="hidden" name="schedule" value={schedule.id} />
                    <input type="hidden" name="date" value={o.date} />
                    <Button type="submit" variant="ghost">
                      {t("common.remove")}<span className="sr-only">{t("availability.removeOverrideHidden", { date: longDate(o.date) })}</span>
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="add-override-heading" className="border-t border-border pt-6">
          <h3 id="add-override-heading" className="font-semibold text-text">{t("availability.addOverrideTitle")}</h3>
          <div className="mt-3">
            <DateOverrideForm key={schedule.id} today={today} scheduleId={schedule.id} />
          </div>
        </section>

        <section aria-labelledby="block-heading" className="border-t border-border pt-6">
          <h3 id="block-heading" className="font-semibold text-text">{t("availability.blockTitle")}</h3>
          <p className="mt-1 text-text-muted">{t("availability.blockIntro")}</p>
          <div className="mt-3">
            <BlockRangeForm key={schedule.id} today={today} scheduleId={schedule.id} scheduleName={several ? schedule.name : undefined} />
          </div>
        </section>
      </Card>

      <Card>
        <section aria-labelledby="holidays-heading">
          <h2 id="holidays-heading" className="font-display text-lg text-text">{t("availability.holidaysTitle")}</h2>
          <p className="mt-1 max-w-xl text-text-muted">
            {t("availability.holidaysIntro")}
          </p>
          {holidays.length === 0 ? (
            <p className="mt-3 text-text-muted">{t("availability.noHolidays")}</p>
          ) : (
            <form action={blockHolidaysAction} className="mt-4 grid gap-1">
              <input type="hidden" name="schedule" value={schedule.id} />
              {holidays.map((h) => (
                <label key={h.date} className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" name="holiday" value={h.date} defaultChecked={false} disabled={daysOff.has(h.date)} className="size-5 accent-accent" />
                  <span className="text-text">
                    {longDate(h.date)}: {h.name}{h.lunar ? " *" : ""}
                    {daysOff.has(h.date) && <span className="ml-2 text-sm text-text-muted">{t(several ? "availability.alreadyOffHere" : "availability.alreadyOff")}</span>}
                  </span>
                </label>
              ))}
              {several && <div className="mt-2"><ScopeChoice scheduleName={schedule.name} /></div>}
              <div className="mt-3"><Button type="submit">{t("availability.blockTicked")}</Button></div>
            </form>
          )}
        </section>
      </Card>
    </div>
  );
}
