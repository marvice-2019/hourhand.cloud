import Link from "next/link";
import { notFound } from "next/navigation";
import { EventTypeEditor } from "@/components/EventTypeEditor";
import { store } from "@/lib/data";
import { toForm } from "@/lib/event-types";
import { requireHost } from "@/lib/auth/session";
import { authEnabled } from "@/lib/auth/auth";
import { FollowUpSettingsForm } from "@/components/FollowUpSettingsForm";
import { getPool } from "@/lib/data/pg-store";
import { getFollowUpSettings } from "@/lib/follow-ups/follow-ups";
import { getProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

export default async function EventTypePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; followups?: string }>;
}) {
  const { id } = await params;
  const { saved, followups } = await searchParams;
  const user = await requireHost();
  const eventType = await store.getEventType(user.id, id);
  if (!eventType) notFound();
  const [locations, questions] = await Promise.all([store.listEventLocations(user.id, id), store.listCustomQuestions(user.id, id)]);
  const ordered = [...questions].sort((a, b) => a.position - b.position);
  // Follow-ups need Postgres (the outbox and the feedback table); the demo store has neither.
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [followUps, profile] = db ? await Promise.all([getFollowUpSettings(db, user.id, id), getProfile(db, user.id)]) : [null, null];

  return (
    <div>
      <Link href="/dashboard/event-types" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Back to event types</Link>
      <h1 className="mt-2 font-display text-xl text-text">{eventType.name}</h1>
      <p className="mt-2 text-text-muted">Change how this booking link works and what people see when they book.</p>
      {!eventType.active && <p className="mt-2 text-sm text-text-muted">This link is off, so nobody can book it right now.</p>}
      <EventTypeEditor
        key={`${eventType.id}-${saved ?? ""}`}
        id={eventType.id}
        userSlug={user.slug}
        initial={toForm(eventType, locations[0])}
        initialQuestions={ordered.map(({ id: qid, label, kind, required, choices }) => ({ id: qid, label, kind, required, choices }))}
        justSaved={saved === "1"}
      />
      {followUps && (
        <FollowUpSettingsForm eventTypeId={eventType.id} settings={followUps} hasReviewLink={Boolean(profile?.reviewsUrl)}
          notice={followups === "saved" ? "Follow-ups saved." : followups === "bad_delay" ? "Pick 1, 2 or 24 hours." : null} />
      )}
    </div>
  );
}
