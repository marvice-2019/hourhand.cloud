import Link from "next/link";
import { notFound } from "next/navigation";
import { EventTypeEditor } from "@/components/EventTypeEditor";
import { EventTypeSchedule } from "@/components/EventTypeSchedule";
import { store } from "@/lib/data";
import { toForm } from "@/lib/event-types";
import { requireHost } from "@/lib/auth/session";
import { videoAvailabilityFor } from "@/lib/video/server";
import { authEnabled } from "@/lib/auth/auth";
import { FollowUpSettingsForm } from "@/components/FollowUpSettingsForm";
import { getPool } from "@/lib/data/pg-store";
import { getFollowUpSettings } from "@/lib/follow-ups/follow-ups";
import { paymentAccount, priceCurrency } from "@/lib/payments/host-payments";
import { getHostI18n } from "@/lib/i18n/host/server";
import { getProfile } from "@/lib/profile";
import { zoomSetupFor } from "@/lib/zoom/connection";

export const dynamic = "force-dynamic";

export default async function EventTypePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; followups?: string; schedule?: string }>;
}) {
  const { id } = await params;
  const { saved, followups, schedule } = await searchParams;
  const user = await requireHost();
  const { t } = await getHostI18n();
  const video = await videoAvailabilityFor(user.id);
  const eventType = await store.getEventType(user.id, id);
  if (!eventType) notFound();
  const [locations, questions, account, schedules] = await Promise.all([
    store.listEventLocations(user.id, id), store.listCustomQuestions(user.id, id),
    authEnabled() ? paymentAccount(getPool(process.env.DATABASE_URL as string), user.id) : null,
    store.listSchedules(user.id),
  ]);
  const currency = priceCurrency(account);
  // Saved in another currency (the host switched payment providers): saving again re-prices it, so say so.
  const otherCurrency = eventType.currency !== null && eventType.currency !== currency ? eventType.currency : null;
  const ordered = [...questions].sort((a, b) => a.position - b.position);
  // Follow-ups need Postgres (the outbox and the feedback table); the demo store has neither.
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [followUps, profile] = db ? await Promise.all([getFollowUpSettings(db, user.id, id), getProfile(db, user.id)]) : [null, null];

  return (
    <div>
      <Link href="/dashboard/event-types" className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("eventTypes.backToList")}</Link>
      <h1 className="mt-2 font-display text-xl text-text">{eventType.name}</h1>
      <p className="mt-2 text-text-muted">{t("eventTypes.editIntro")}</p>
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
        initial={toForm(eventType, locations[0])}
        initialQuestions={ordered.map(({ id: qid, label, kind, required, choices }) => ({ id: qid, label, kind, required, choices }))}
        justSaved={saved === "1"}
        video={video}
        currency={currency}
        provider={account?.provider ?? null}
        zoomSetup={await zoomSetupFor(() => getPool(process.env.DATABASE_URL as string), user.id)}
      />
      {eventType.kind !== "one_off" && <EventTypeSchedule eventTypeId={eventType.id} schedules={schedules} saved={schedule === "saved"} />}
      {followUps && (
        <FollowUpSettingsForm eventTypeId={eventType.id} settings={followUps} hasReviewLink={Boolean(profile?.reviewsUrl)}
          notice={followups === "saved" ? t("eventTypes.fuSaved") : followups === "bad_delay" ? t("eventTypes.fuBadDelay") : null} />
      )}
    </div>
  );
}
