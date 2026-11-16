import Link from "next/link";
import { notFound } from "next/navigation";
import { EventTypeEditor } from "@/components/EventTypeEditor";
import { store } from "@/lib/data";
import { toForm } from "@/lib/event-types";
import { requireHost } from "@/lib/auth/session";
import { videoAvailabilityFor } from "@/lib/video/server";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { paymentAccount, priceCurrency } from "@/lib/payments/host-payments";

export const dynamic = "force-dynamic";

export default async function EventTypePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const user = await requireHost();
  const video = await videoAvailabilityFor(user.id);
  const eventType = await store.getEventType(user.id, id);
  if (!eventType) notFound();
  const [locations, questions, account] = await Promise.all([
    store.listEventLocations(user.id, id), store.listCustomQuestions(user.id, id),
    authEnabled() ? paymentAccount(getPool(process.env.DATABASE_URL as string), user.id) : null,
  ]);
  const currency = priceCurrency(account);
  // Saved in another currency (the host switched payment providers): saving again re-prices it, so say so.
  const otherCurrency = eventType.currency !== null && eventType.currency !== currency ? eventType.currency : null;
  const ordered = [...questions].sort((a, b) => a.position - b.position);

  return (
    <div>
      <Link href="/dashboard/event-types" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Back to event types</Link>
      <h1 className="mt-2 font-display text-xl text-text">{eventType.name}</h1>
      <p className="mt-2 text-text-muted">Change how this booking link works and what people see when they book.</p>
      {!eventType.active && <p className="mt-2 text-sm text-text-muted">This link is off, so nobody can book it right now.</p>}
      {otherCurrency && (
        <p role="alert" className="mt-2 max-w-xl text-sm text-danger">
          This price is in {otherCurrency}, but you now take payments in {currency}. Guests can&apos;t pay it until you check the amount below and save.
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
      />
    </div>
  );
}
