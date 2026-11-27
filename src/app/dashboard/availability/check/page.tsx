import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { isValidDate, todayIn } from "@/lib/availability";
import { requireHost } from "@/lib/auth/session";
import { checkDay } from "@/lib/booking";
import { store, type EventType, type User } from "@/lib/data";
import type { HostI18n } from "@/lib/i18n/host/format";
import { getHostI18n } from "@/lib/i18n/host/server";
import type { SlotVerdict } from "@/lib/slots";

export const dynamic = "force-dynamic";

// B15: one day of an event type's hours, each time open or with why it's closed. Read-only.
export default async function CheckDayPage({ searchParams }: { searchParams: Promise<{ event?: string; date?: string }> }) {
  const user = await requireHost();
  const i18n = await getHostI18n();
  const { t } = i18n;
  const params = await searchParams;
  const now = new Date();
  const eventTypes = (await store.listEventTypes(user.id)).filter((e) => e.kind !== "one_off");
  const eventType = eventTypes.find((e) => e.id === params.event) ?? eventTypes[0];
  const badDate = params.date !== undefined && !isValidDate(params.date);
  const date = params.date && !badDate ? params.date : todayIn(user.timezone, now);
  const field = `mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/availability" className={`text-accent underline ${focusRing}`}>{t("availability.checkBack")}</Link>
        <h1 className="mt-2 font-display text-xl text-text">{t("availability.checkTitle")}</h1>
        <p className="mt-2 max-w-xl text-text-muted">{t("availability.checkIntro")}</p>
      </div>

      {!eventType ? (
        <p className="text-text-muted">{t("availability.checkNoEvents")}</p>
      ) : (
        <>
          <form method="get" action="/dashboard/availability/check" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="event" className="block text-sm font-semibold text-text">{t("availability.checkEvent")}</label>
              <select id="event" name="event" defaultValue={eventType.id} className={`${field} max-w-full`}>
                {eventTypes.map((e) => <option key={e.id} value={e.id}>{e.active ? e.name : t("availability.checkOffOption", { name: e.name })}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="date" className="block text-sm font-semibold text-text">{t("availability.checkDate")}</label>
              <input id="date" name="date" type="date" required defaultValue={date} aria-invalid={badDate || undefined}
                aria-describedby={badDate ? "date-error" : undefined} className={field} />
            </div>
            <Button type="submit">{t("availability.checkSubmit")}</Button>
          </form>
          {badDate && <p id="date-error" role="alert" className="font-semibold text-danger">{t("availability.checkBadDate")}</p>}
          <DayResult i18n={i18n} host={user} eventType={eventType} date={date} now={now} />
        </>
      )}
    </div>
  );
}

async function DayResult({ i18n, host, eventType, date, now }: { i18n: HostI18n; host: User; eventType: EventType; date: string; now: Date }) {
  const { t, tNodes, zoneLongName } = i18n;
  const [check, calendars] = await Promise.all([checkDay(store, host, eventType, date, now), store.listCalendars(host.id)]);
  const calendarNames = new Map(calendars.map((c) => [c.id, c.name]));
  const zone = zoneLongName(check.timezone) ?? check.timezone;
  const open = check.starts.filter((v) => v.reason === null).length;
  const hoursLink = (
    <Link href={`/dashboard/availability?schedule=${check.scheduleId}`} className={`font-semibold text-accent underline ${focusRing}`}>{t("availability.checkEditHours")}</Link>
  );

  return (
    <Card>
      <section aria-labelledby="check-heading" className="space-y-3">
        <h2 id="check-heading" className="font-display text-lg text-text">{t("availability.checkHeading", { event: eventType.name, date: i18n.dayDate(date) })}</h2>
        <p className="text-text-muted">{t("availability.checkTimesIn", { zone, schedule: check.scheduleName })}</p>
        {!eventType.active && (
          <p role="status" className="rounded-md bg-warning-bg px-3 py-2 text-warning">
            {tNodes("availability.checkOffNotice", { link: <Link href={`/dashboard/event-types/${eventType.id}`} className={`font-semibold underline ${focusRing}`}>{t("availability.checkOffLink")}</Link> })}
          </p>
        )}
        {check.syncStale && (
          <p role="alert" className="rounded-md bg-warning-bg px-3 py-2 text-warning">
            {tNodes("availability.checkStale", { link: <Link href="/dashboard/calendars" className={`font-semibold underline ${focusRing}`}>{t("availability.checkStaleLink")}</Link> })}
          </p>
        )}
        {check.hours.length === 0 ? (
          <p className="text-text">{tNodes(check.hoursFrom === "date" ? "availability.checkDayOff" : "availability.checkNoHours", { link: hoursLink })}</p>
        ) : (
          <>
            <p className="font-semibold text-text">{t(eventType.active ? "availability.checkSummary" : "availability.checkSummaryOff", { open: String(open), total: String(check.starts.length) })}</p>
            <ul className="divide-y divide-border">
              {check.starts.map((v) => (
                <li key={v.start.toISOString()} className="flex flex-wrap gap-x-4 gap-y-1 py-2">
                  <span className="w-24 shrink-0 font-semibold tabular-nums text-text">{i18n.time(v.start, check.timezone)}</span>
                  <span className={v.reason === null ? "font-semibold text-success" : "text-text-muted"}>
                    {why(v, eventType, check.timezone, i18n, calendarNames)}
                  </span>
                </li>
              ))}
            </ul>
            <p>
              <Link href={`/dashboard/event-types/${eventType.id}`} className={`text-accent underline ${focusRing}`}>{t("availability.checkEditEvent")}</Link>
            </p>
          </>
        )}
      </section>
    </Card>
  );
}

function why(v: SlotVerdict, et: EventType, tz: string, { t, time }: HostI18n, calendarNames: Map<string, string>) {
  const range = () => ({ from: time(v.blocker!.start, tz), to: time(v.blocker!.end, tz) });
  switch (v.reason) {
    case null: return v.seatsLeft === null ? t("availability.checkOpen") : t("availability.checkOpenSeats", { n: String(v.seatsLeft) });
    case "sync_stale": return t("availability.whyStale");
    case "past": return t("availability.whyPast");
    case "notice": return t("availability.whyNotice", { n: String(et.minNoticeMinutes) });
    case "window": return t("availability.whyWindow", { n: String(et.bookingWindowDays) });
    case "class_full": return t("availability.whyClassFull");
    case "day_full": return t("availability.whyDayFull", { n: String(et.dailyLimit) });
    case "week_full": return t("availability.whyWeekFull", { n: String(et.weeklyLimit) });
    case "booking": {
      const buffered = et.bufferBeforeMinutes > 0 || et.bufferAfterMinutes > 0;
      const text = t(buffered ? "availability.whyBookingBuffers" : "availability.whyBooking", { time: time(v.blocker!.start, tz) });
      return v.blocker?.bookingId
        ? <>{text} <Link href={`/dashboard/bookings/${v.blocker.bookingId}`} className={`text-accent underline ${focusRing}`}>{t("availability.whySeeBooking")}</Link></>
        : text;
    }
    case "calendar": {
      const name = (v.blocker?.calendarId && calendarNames.get(v.blocker.calendarId)) || t("availability.whyCalendarUnnamed");
      return t("availability.whyCalendar", { calendar: name, ...range() });
    }
    case "poll": return t("availability.whyPoll", range());
  }
}
