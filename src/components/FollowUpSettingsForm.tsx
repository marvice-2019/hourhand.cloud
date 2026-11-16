import Link from "next/link";
import { saveFollowUps } from "@/app/dashboard/event-types/follow-up-actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DELAY_CHOICES, type FollowUpSettings } from "@/lib/follow-ups/follow-ups";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";

const BOXES: { name: keyof Omit<FollowUpSettings, "delayHours">; label: HostKey; hint: HostKey }[] = [
  { name: "thankYou", label: "eventTypes.fuThankYou", hint: "eventTypes.fuThankYouHint" },
  { name: "feedback", label: "eventTypes.fuFeedback", hint: "eventTypes.fuFeedbackHint" },
  { name: "reviewAsk", label: "eventTypes.fuReviewAsk", hint: "eventTypes.fuReviewAskHint" },
  { name: "packageNudge", label: "eventTypes.fuPackageNudge", hint: "eventTypes.fuPackageNudgeHint" },
];

/** The follow-up section under the event type editor. Everything is off until the host switches it on. */
export async function FollowUpSettingsForm({ eventTypeId, settings, hasReviewLink, notice }: { eventTypeId: string; settings: FollowUpSettings; hasReviewLink: boolean; notice: string | null }) {
  const { t, tNodes } = await getHostI18n();
  return (
    <Card className="mt-8 max-w-xl">
      <section id="follow-ups" aria-labelledby="fu-h">
        <h2 id="fu-h" className="font-semibold text-text">{t("eventTypes.fuHeading")}</h2>
        <p className="mt-1 text-sm text-text-muted">{t("eventTypes.fuIntro")}</p>
        {notice && <p role="status" className="mt-3 text-sm text-success">{notice}</p>}
        <form action={saveFollowUps} className="mt-4 grid gap-4">
          <input type="hidden" name="eventTypeId" value={eventTypeId} />
          {BOXES.map((b) => (
            <div key={b.name} className="flex gap-3">
              <input id={`fu-${b.name}`} type="checkbox" name={b.name} defaultChecked={settings[b.name]} className="mt-1 size-5 shrink-0" aria-describedby={`fu-${b.name}-hint`} />
              <div>
                <label htmlFor={`fu-${b.name}`} className="font-semibold text-text">{t(b.label)}</label>
                <p id={`fu-${b.name}-hint`} className="text-sm text-text-muted">{t(b.hint)}</p>
                {b.name === "reviewAsk" && !hasReviewLink && (
                  <p className="mt-1 text-sm text-warning">{tNodes("eventTypes.fuNoReviewLink", { link: <Link key="link" href="/dashboard/profile" className="font-semibold underline">{t("eventTypes.fuYourPage")}</Link> })}</p>
                )}
              </div>
            </div>
          ))}
          <div>
            <label htmlFor="fu-delay" className="font-semibold text-text">{t("eventTypes.fuSendIt")}</label>
            <select id="fu-delay" name="delayHours" defaultValue={String(settings.delayHours)} className="mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-text">
              {DELAY_CHOICES.map((h) => <option key={h} value={h}>{h === 1 ? t("eventTypes.fuDelayOne") : t("eventTypes.fuDelayMany", { n: h })}</option>)}
            </select>
          </div>
          <div><Button type="submit" variant="secondary">{t("eventTypes.fuSave")}</Button></div>
        </form>
      </section>
    </Card>
  );
}
