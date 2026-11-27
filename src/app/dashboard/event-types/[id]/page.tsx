import Link from "next/link";
import { notFound } from "next/navigation";
import { EventTypeEditor } from "@/components/EventTypeEditor";
import { EventTypeSchedule } from "@/components/EventTypeSchedule";
import { store } from "@/lib/data";
import { toForm } from "@/lib/event-types";
import { requireHost } from "@/lib/auth/session";
import { videoAvailabilityFor } from "@/lib/video/server";
import { authEnabled, bookingHostName } from "@/lib/auth/auth";
import { FollowUpSettingsForm } from "@/components/FollowUpSettingsForm";
import { ReminderSettingsForm } from "@/components/ReminderSettingsForm";
import { getReminderMinutes } from "@/lib/reminders";
import { getPool } from "@/lib/data/pg-store";
import { getFollowUpSettings } from "@/lib/follow-ups/follow-ups";
import { paymentAccount, priceCurrency } from "@/lib/payments/host-payments";
import { templateChoices, templatesEnabled } from "@/lib/intake/options";
import { toDrafts } from "@/lib/intake/templates-shape";
import { getHostI18n } from "@/lib/i18n/host/server";
import { getProfile } from "@/lib/profile";
import { zoomSetupFor } from "@/lib/zoom/connection";

export const dynamic = "force-dynamic";

export default async function EventTypePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; followups?: string; schedule?: string; reminders?: string; copied?: string }>;
}) {
  const { id } = await params;
  const { saved, followups, schedule, reminders, copied } = await searchParams;
  const user = await requireHost();
  const { t } = await getHostI18n();
  const video = await videoAvailabilityFor(user.id);
  const eventType = await store.getEventType(user.id, id);
  if (!eventType) notFound();
  const [locations, questions, templates, account, schedules] = await Promise.all([
    store.listEventLocations(user.id, id), store.listCustomQuestions(user.id, id), templateChoices(user.id, t),
    authEnabled() ? paymentAccount(getPool(process.env.DATABASE_URL as string), user.id) : null,
    store.listSchedules(user.id),
  ]);
  const currency = priceCurrency(account);
  // Saved in another currency (the host switched payment providers): saving again re-prices it, so say so.
  const otherCurrency = eventType.currency !== null && eventType.currency !== currency ? eventType.currency : null;
  // Follow-ups need Postgres (the outbox and the feedback table); the demo store has neither.
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [followUps, profile, reminderMinutes] = db
    ? await Promise.all([getFollowUpSettings(db, user.id, id), getProfile(db, user.id), getReminderMinutes(db, user.id, id)])
    : [null, null, null];

  return (
    <div>
      <Link href="/dashboard/event-types" className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("eventTypes.backToList")}</Link>
      <h1 className="mt-2 font-display text-xl text-text">{eventType.name}</h1>
      <p className="mt-2 text-text-muted">{t("eventTypes.editIntro")}</p>
      {copied === "1" && <p role="status" className="mt-3 max-w-xl rounded-md bg-success-bg px-3 py-2 text-success">{t("eventTypes.copied")}</p>}
      {!eventType.active && <p className="mt-2 text-sm text-text-muted">{t("eventTypes.linkOff")}</p>}
      {otherCurrency && (
        <p role="alert" className="mt-2 max-w-xl text-sm text-danger">
          {t("eventTypes.otherCurrency", { from: otherCurrency, to: currency })}
        </p>
      )}
      <EventTypeEditor
        key={`${eventType.id}-${saved ?? ""}`}
        id={eventType.id}
        userSlug={user.slug}
        bookingHost={bookingHostName()}
        initial={toForm(eventType, locations[0])}
        initialQuestions={toDrafts(questions)}
        templates={templates}
        canSaveTemplates={templatesEnabled()}
        justSaved={saved === "1"}
        video={video}
        currency={currency}
        provider={account?.provider ?? null}
        zoomSetup={await zoomSetupFor(() => getPool(process.env.DATABASE_URL as string), user.id)}
      />
      {eventType.kind !== "one_off" && <EventTypeSchedule eventTypeId={eventType.id} schedules={schedules} saved={schedule === "saved"} />}
      {reminderMinutes && (
        <ReminderSettingsForm eventTypeId={eventType.id} minutes={reminderMinutes}
          notice={reminders === "saved" ? t("eventTypes.remSaved") : null}
          error={reminders === "too_many" ? t("eventTypes.remTooMany", { n: 3 }) : null} />
      )}
      {followUps && (
        <FollowUpSettingsForm eventTypeId={eventType.id} settings={followUps} hasReviewLink={Boolean(profile?.reviewsUrl)}
          notice={followups === "saved" ? t("eventTypes.fuSaved") : followups === "bad_delay" ? t("eventTypes.fuBadDelay") : null} />
      )}
    </div>
  );
}
