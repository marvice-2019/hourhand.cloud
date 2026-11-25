import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { getHostI18n } from "@/lib/i18n/host/server";
import { listFeedback } from "@/lib/follow-ups/follow-ups";
import { getShowReviews } from "@/lib/follow-ups/public-reviews";
import { Button } from "@/components/ui/Button";
import { saveShowReviews, toggleReview } from "./actions";

export const dynamic = "force-dynamic";

/** What guests said after their sessions. Private to the host, except reviews the guest agreed to show and the host chose to. */
export default async function FeedbackListPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await requireHost();
  const { t, tNodes, date } = await getHostI18n();
  const notice = (await searchParams).page;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const { entries, average, count } = pool ? await listFeedback(pool, user.id) : { entries: [], average: null, count: 0 };
  const showReviews = pool ? await getShowReviews(pool, user.id) : false;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("feedback.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("feedback.intro")}</p>
      {pool && (
        <Card className="mt-6 max-w-2xl">
          {notice && <p role="status" className="mb-3 text-success">{t(notice === "on" ? "feedback.pageOn" : "feedback.pageOff")}</p>}
          <form action={saveShowReviews} className="grid gap-3">
            <label className="flex min-h-11 items-start gap-3 font-semibold text-text">
              <input type="checkbox" name="showReviews" defaultChecked={showReviews} className="mt-1 size-5 shrink-0" aria-describedby="fb-page-hint" />
              {t("feedback.showOnPage")}
            </label>
            <p id="fb-page-hint" className="text-sm text-text-muted">{t("feedback.showOnPageHint")}</p>
            <div><Button type="submit" variant="secondary">{t("feedback.savePage")}</Button></div>
          </form>
        </Card>
      )}
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
                {f.publicConsent && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-text-muted">{f.publicName ? t("feedback.consentedNamed", { name: f.publicName }) : t("feedback.consentedAnon")}</span>
                    {f.shown && <span className="font-semibold text-success">{t("feedback.shown")}</span>}
                    <form action={toggleReview}>
                      <input type="hidden" name="bookingId" value={f.bookingId} />
                      <input type="hidden" name="show" value={f.shown ? "0" : "1"} />
                      <Button type="submit" variant="secondary">{t(f.shown ? "feedback.hide" : "feedback.show")}</Button>
                    </form>
                  </div>
                )}
                <Link href={`/dashboard/bookings/${f.bookingId}`} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("feedback.openBooking")}</Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
