import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";
import { listFeedback } from "@/lib/follow-ups/follow-ups";

export const dynamic = "force-dynamic";

/** What guests said after their sessions. Private to the host: never shown on any public page. */
export default async function FeedbackListPage() {
  const user = await requireHost();
  const { entries, average, count } = authEnabled() ? await listFeedback(getPool(process.env.DATABASE_URL as string), user.id) : { entries: [], average: null, count: 0 };
  return (
    <div>
      <h1 className="font-display text-xl text-text">Feedback</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        Ratings and comments guests left after a session. Only you see them. Switch the feedback form on per event type, under &ldquo;After the session&rdquo;.
      </p>
      {count > 0 && <p className="mt-4 text-text"><span className="font-semibold">{average?.toFixed(1)} out of 5</span> from {count} {count === 1 ? "answer" : "answers"}</p>}
      {entries.length === 0 ? <p className="mt-6 text-text-muted">No feedback yet.</p> : (
        <ul className="mt-6 grid max-w-2xl gap-3">
          {entries.map((f) => (
            <li key={f.bookingId}>
              <Card>
                <p className="text-text"><span className="font-semibold">{f.rating} / 5</span> · {f.guestName} · {f.eventName}, {formatDate(f.startAt, user.timezone)}</p>
                {/* Plain text: React escapes it, and line breaks are kept. */}
                {f.comment && <p className="mt-2 whitespace-pre-line break-words text-text">{f.comment}</p>}
                <Link href={`/dashboard/bookings/${f.bookingId}`} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">Open booking</Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
