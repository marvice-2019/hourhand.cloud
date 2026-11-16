import Link from "next/link";
import { saveFollowUps } from "@/app/dashboard/event-types/follow-up-actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DELAY_CHOICES, type FollowUpSettings } from "@/lib/follow-ups/follow-ups";

const BOXES: { name: keyof Omit<FollowUpSettings, "delayHours">; label: string; hint: string }[] = [
  { name: "thankYou", label: "Thank-you and rebook link", hint: "A short thank-you with a one-tap link to book this again, their name and email already filled in." },
  { name: "feedback", label: "Feedback form", hint: "A 1 to 5 rating and an optional comment. Only you see the answers, on the booking and under Feedback. Never public." },
  { name: "reviewAsk", label: "Ask for a Google review", hint: "Offers your Google review link to every guest who leaves feedback (or to every guest, if the feedback form is off). The rating only changes the wording: Google doesn't allow asking only happy customers." },
  { name: "packageNudge", label: "Package top-up nudge", hint: "When the guest booked with a package that has 1 session left or none, a link to book the last one or buy it again." },
];

/** The follow-up section under the event type editor. Everything is off until the host switches it on. */
export function FollowUpSettingsForm({ eventTypeId, settings, hasReviewLink, notice }: { eventTypeId: string; settings: FollowUpSettings; hasReviewLink: boolean; notice: string | null }) {
  return (
    <Card className="mt-8 max-w-xl">
      <section id="follow-ups" aria-labelledby="fu-h">
        <h2 id="fu-h" className="font-semibold text-text">After the session</h2>
        <p className="mt-1 text-sm text-text-muted">
          One email to the guest after each session, in the language they booked in. Never for cancelled bookings or no-shows, never twice, and guests can
          stop them with one link. Each seat in a group class gets its own.
        </p>
        {notice && <p role="status" className="mt-3 text-sm text-success">{notice}</p>}
        <form action={saveFollowUps} className="mt-4 grid gap-4">
          <input type="hidden" name="eventTypeId" value={eventTypeId} />
          {BOXES.map((b) => (
            <div key={b.name} className="flex gap-3">
              <input id={`fu-${b.name}`} type="checkbox" name={b.name} defaultChecked={settings[b.name]} className="mt-1 size-5 shrink-0" aria-describedby={`fu-${b.name}-hint`} />
              <div>
                <label htmlFor={`fu-${b.name}`} className="font-semibold text-text">{b.label}</label>
                <p id={`fu-${b.name}-hint`} className="text-sm text-text-muted">{b.hint}</p>
                {b.name === "reviewAsk" && !hasReviewLink && (
                  <p className="mt-1 text-sm text-warning">No Google review link saved yet, so this sends nothing. Add it on <Link href="/dashboard/profile" className="font-semibold underline">Your page</Link>.</p>
                )}
              </div>
            </div>
          ))}
          <div>
            <label htmlFor="fu-delay" className="font-semibold text-text">Send it</label>
            <select id="fu-delay" name="delayHours" defaultValue={String(settings.delayHours)} className="mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-text">
              {DELAY_CHOICES.map((h) => <option key={h} value={h}>{h === 1 ? "1 hour" : `${h} hours`} after the session ends</option>)}
            </select>
          </div>
          <div><Button type="submit" variant="secondary">Save follow-ups</Button></div>
        </form>
      </section>
    </Card>
  );
}
