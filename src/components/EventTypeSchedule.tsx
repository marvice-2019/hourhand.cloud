import Link from "next/link";
import { setEventTypeScheduleAction } from "@/app/dashboard/event-types/[id]/schedule-actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import type { ScheduleSummary } from "@/lib/data/types";
import { getHostI18n } from "@/lib/i18n/host/server";

/** Which availability schedule an event type books against. A host with one schedule just sees it named. */
export async function EventTypeSchedule({ eventTypeId, schedules, saved }: { eventTypeId: string; schedules: ScheduleSummary[]; saved: boolean }) {
  const { t, tNodes } = await getHostI18n();
  const current = schedules.find((s) => s.eventTypes.some((e) => e.id === eventTypeId)) ?? schedules[0];
  const zone = (tz: string) => tz.replaceAll("_", " ");
  return (
    <Card className="mt-8 max-w-xl">
      <h2 className="font-semibold text-text">{t("eventTypes.scheduleTitle")}</h2>
      <p className="mt-1 text-text-muted">{t("eventTypes.scheduleIntro")}</p>
      {schedules.length < 2 ? (
        <p className="mt-3 text-text">
          {tNodes("eventTypes.scheduleOnly", {
            name: current.name,
            zone: zone(current.timezone),
            link: <Link href="/dashboard/availability" className="font-semibold text-accent underline">{t("eventTypes.scheduleAddAnother")}</Link>,
          })}
        </p>
      ) : (
        <form action={setEventTypeScheduleAction} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="event-type" value={eventTypeId} />
          <div className="w-72">
            <label htmlFor="event-schedule" className="block text-sm font-semibold text-text">{t("eventTypes.scheduleLabel")}</label>
            <select id="event-schedule" name="schedule" defaultValue={current.id}
              className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
              {schedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {t(s.isDefault ? "eventTypes.scheduleOptionDefault" : "eventTypes.scheduleOption", { name: s.name, zone: zone(s.timezone) })}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary">{t("eventTypes.scheduleUse")}</Button>
          <p role="status" className="w-full min-h-6 text-sm font-semibold text-text">{saved && t("eventTypes.scheduleSaved")}</p>
        </form>
      )}
    </Card>
  );
}
