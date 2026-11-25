import { saveReminders } from "@/app/dashboard/event-types/reminder-actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { MAX_REMINDERS, REMINDER_CHOICES } from "@/lib/reminders";
import { getHostI18n } from "@/lib/i18n/host/server";

/** "Reminders" under the event type editor: up to 3 times before the session when the guest is reminded by email. */
export async function ReminderSettingsForm({ eventTypeId, minutes, notice, error }: { eventTypeId: string; minutes: number[]; notice: string | null; error: string | null }) {
  const { t } = await getHostI18n();
  const label = (m: number) => m < 60 ? t("eventTypes.remMinutes", { n: m })
    : m < 1440 ? (m === 60 ? t("eventTypes.remHourOne") : t("eventTypes.remHours", { n: m / 60 }))
    : m === 10080 ? t("eventTypes.remWeek") : m === 1440 ? t("eventTypes.remDayOne") : t("eventTypes.remDays", { n: m / 1440 });
  return (
    <Card className="mt-8 max-w-xl">
      <section id="reminders" aria-labelledby="rem-h">
        <h2 id="rem-h" className="font-semibold text-text">{t("eventTypes.remHeading")}</h2>
        <p className="mt-1 text-sm text-text-muted">{t("eventTypes.remIntro", { n: MAX_REMINDERS })}</p>
        {notice && <p role="status" className="mt-3 text-sm text-success">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <form action={saveReminders} className="mt-4 grid gap-4">
          <input type="hidden" name="eventTypeId" value={eventTypeId} />
          <fieldset>
            <legend className="font-semibold text-text">{t("eventTypes.remBefore")}</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {REMINDER_CHOICES.map((m) => (
                <label key={m} className="flex min-h-11 items-center gap-3 text-text">
                  <input type="checkbox" name={`r${m}`} defaultChecked={minutes.includes(m)} className="size-5 shrink-0" />
                  {label(m)}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="text-sm text-text-muted">{t("eventTypes.remHint")}</p>
          <div><Button type="submit" variant="secondary">{t("eventTypes.remSave")}</Button></div>
        </form>
      </section>
    </Card>
  );
}
