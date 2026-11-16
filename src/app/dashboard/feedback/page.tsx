import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { getHostI18n } from "@/lib/i18n/host/server";
import { listFeedback } from "@/lib/follow-ups/follow-ups";

export const dynamic = "force-dynamic";

/** What guests said after their sessions. Private to the host: never shown on any public page. */
export default async function FeedbackListPage() {
  const user = await requireHost();
  const { t, tNodes, date } = await getHostI18n();
  const { entries, average, count } = authEnabled() ? await listFeedback(getPool(process.env.DATABASE_URL as string), user.id) : { entries: [], average: null, count: 0 };
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("feedback.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("feedback.intro")}</p>
      {count > 0 && <p className="mt-4 text-text">{tNodes(count === 1 ? "feedback.summaryOne" : "feedback.summaryMany", {
        average: <span className="font-semibold">{t("feedback.average", { average: String(average?.toFixed(1)) })}</span>, count,
      })}</p>}
      {entries.length === 0 ? <p className="mt-6 text-text-muted">{t("feedback.none")}</p> : (
        <ul className="mt-6 grid max-w-2xl gap-3">
          {entries.map((f) => (
            <li key={f.bookingId}>
              <Card>
                <p className="text-text">{tNodes("feedback.entry", {
                  rating: <span className="font-semibold">{t("feedback.rating", { rating: f.rating })}</span>, guest: f.guestName, event: f.eventName, date: date(f.startAt, user.timezone),
                })}</p>
                {/* Plain text: React escapes it, and line breaks are kept. */}
                {f.comment && <p className="mt-2 whitespace-pre-line break-words text-text">{f.comment}</p>}
                <Link href={`/dashboard/bookings/${f.bookingId}`} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("feedback.openBooking")}</Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
