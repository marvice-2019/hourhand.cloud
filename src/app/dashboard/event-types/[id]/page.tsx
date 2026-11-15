import Link from "next/link";
import { notFound } from "next/navigation";
import { EventTypeEditor } from "@/components/EventTypeEditor";
import { store } from "@/lib/data";
import { toForm } from "@/lib/event-types";
import { requireHost } from "@/lib/auth/session";
import { templateChoices, templatesEnabled } from "@/lib/intake/options";
import { toDrafts } from "@/lib/intake/templates-shape";

export const dynamic = "force-dynamic";

export default async function EventTypePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const user = await requireHost();
  const eventType = await store.getEventType(user.id, id);
  if (!eventType) notFound();
  const [locations, questions, templates] = await Promise.all([store.listEventLocations(user.id, id), store.listCustomQuestions(user.id, id), templateChoices(user.id)]);

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
        initialQuestions={toDrafts(questions)}
        templates={templates}
        canSaveTemplates={templatesEnabled()}
        justSaved={saved === "1"}
      />
    </div>
  );
}
