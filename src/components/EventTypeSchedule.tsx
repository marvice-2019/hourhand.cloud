import Link from "next/link";
import { setEventTypeScheduleAction } from "@/app/dashboard/event-types/[id]/schedule-actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import type { ScheduleSummary } from "@/lib/data/types";

/** Which availability schedule an event type books against. A host with one schedule just sees it named. */
export function EventTypeSchedule({ eventTypeId, schedules, saved }: { eventTypeId: string; schedules: ScheduleSummary[]; saved: boolean }) {
  const current = schedules.find((s) => s.eventTypes.some((e) => e.id === eventTypeId)) ?? schedules[0];
  return (
    <Card className="mt-8 max-w-xl">
      <h2 className="font-semibold text-text">Availability schedule</h2>
      <p className="mt-1 text-text-muted">The weekly hours, time zone and days off this event type is booked against.</p>
      {schedules.length < 2 ? (
        <p className="mt-3 text-text">
          {current.name} ({current.timezone.replaceAll("_", " ")}).{" "}
          <Link href="/dashboard/availability" className="font-semibold text-accent underline">Add another schedule</Link>
        </p>
      ) : (
        <form action={setEventTypeScheduleAction} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="event-type" value={eventTypeId} />
          <div className="w-72">
            <label htmlFor="event-schedule" className="block text-sm font-semibold text-text">Schedule</label>
            <select id="event-schedule" name="schedule" defaultValue={current.id}
              className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
              {schedules.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.timezone.replaceAll("_", " ")}){s.isDefault ? ", default" : ""}</option>)}
            </select>
          </div>
          <Button type="submit" variant="secondary">Use this schedule</Button>
          <p role="status" className="w-full min-h-6 text-sm font-semibold text-text">{saved && "Schedule saved"}</p>
        </form>
      )}
    </Card>
  );
}
