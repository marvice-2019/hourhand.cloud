import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { COMMENT_MAX, feedbackPage, reviewWording, sessionDate, type FeedbackPage } from "@/lib/follow-ups/follow-ups";
import { linkKey } from "@/lib/follow-ups/tokens";
import { resolveLocale, type Locale } from "@/lib/i18n/guest";
import { ft } from "@/lib/i18n/follow-up";
import { sendFeedback } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

async function load(token: string): Promise<FeedbackPage> {
  try {
    return await feedbackPage(getPool(process.env.DATABASE_URL as string), linkKey(), token, "", new Date());
  } catch (error) {
    // No signing key on this server: no link can be checked.
    if (error instanceof Error && error.message.startsWith("TOKEN_ENCRYPTION_KEY")) return { state: "invalid" };
    throw error;
  }
}

export default async function FeedbackPageRoute({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ r?: string; sent?: string; error?: string; lang?: string }> }) {
  if (!authEnabled()) notFound();
  const { token } = await params;
  const q = await searchParams;
  const page = await load(decodeURIComponent(token));
  const shell = (locale: Locale, children: React.ReactNode) => <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10"><Card className="max-w-md">{children}</Card></main>;

  if (page.state === "invalid" || page.state === "expired") {
    const locale: Locale = resolveLocale(q.lang, null);
    return shell(locale, <>
      <h1 className="font-display text-xl text-text">{ft(locale, page.state === "expired" ? "expiredTitle" : "invalidTitle")}</h1>
      <p className="mt-2 text-text-muted">{ft(locale, page.state === "expired" ? "expiredBody" : "invalidBody")}</p>
    </>);
  }
  const locale = page.locale;
  const v = { host: page.hostName, event: page.eventName };
  if (page.state === "answered") {
    if (q.sent !== "1") {
      return shell(locale, <>
        <h1 className="font-display text-xl text-text">{ft(locale, "alreadyTitle")}</h1>
        <p className="mt-2 text-text-muted">{ft(locale, "alreadyBody", v)}</p>
      </>);
    }
    // Offered to everyone who answered, whatever the rating; the rating only picks the words (Google's review policy).
    const review = page.reviewAsk && page.reviewsUrl && page.rating ? { url: page.reviewsUrl, wording: reviewWording(page.rating) } : null;
    return shell(locale, <>
      <h1 className="font-display text-xl text-text">{ft(locale, "thanksTitle")}</h1>
      <p className="mt-2 text-text-muted">{ft(locale, "thanksBody", v)}</p>
      {review && <>
        <p className="mt-6 text-text">{ft(locale, review.wording, v)}</p>
        <a href={review.url} rel="noopener noreferrer" target="_blank" className={`mt-3 ${buttonClasses({ variant: "secondary" })}`}>{ft(locale, "reviewLink")}</a>
      </>}
      {page.rebookUrl && <p className="mt-6"><Link href={page.rebookUrl} className={buttonClasses()}>{ft(locale, "rebookLink", v)}</Link></p>}
    </>);
  }

  const picked = /^[1-5]$/.test(q.r ?? "") ? Number(q.r) : null;
  const error = q.error === "rating" ? ft(locale, "pickRating") : q.error === "comment" ? ft(locale, "commentTooLong") : q.error === "too_many" ? ft(locale, "tooMany") : null;
  return shell(locale, <>
    <h1 className="font-display text-xl text-text">{ft(locale, "pageTitle", v)}</h1>
    <p className="mt-1 text-sm text-text-muted">{ft(locale, "pageWhen", { date: sessionDate(page) })}</p>
    {error && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{error}</p>}
    <form action={sendFeedback} className="mt-6 grid gap-5">
      <input type="hidden" name="token" value={decodeURIComponent(token)} />
      <fieldset>
        <legend className="font-semibold text-text">{ft(locale, "ratingLabel")}</legend>
        <div className="mt-2 flex gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-border-input bg-card text-text has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-on-accent">
              <input type="radio" name="rating" value={n} required defaultChecked={picked === n} className="sr-only" />
              {n}
            </label>
          ))}
        </div>
        <p className="mt-1 flex max-w-64 justify-between text-sm text-text-muted"><span>1 = {ft(locale, "ratingPoor")}</span><span>5 = {ft(locale, "ratingGreat")}</span></p>
      </fieldset>
      <div>
        <label htmlFor="fb-comment" className="font-semibold text-text">{ft(locale, "commentLabel", v)}</label>
        <textarea id="fb-comment" name="comment" rows={4} maxLength={COMMENT_MAX} className="mt-1 block w-full rounded-md border border-border-input bg-card p-3 text-text" aria-describedby="fb-private" />
        <p id="fb-private" className="mt-1 text-sm text-text-muted">{ft(locale, "privateNote", v)}</p>
      </div>
      <fieldset className="grid gap-2">
        <label className="flex min-h-11 items-start gap-3 text-text">
          <input type="checkbox" name="showPublicly" className="mt-1 size-5 shrink-0" aria-describedby="fb-public-note" />
          {ft(locale, "publicOptIn", v)}
        </label>
        <label className="flex min-h-11 items-start gap-3 pl-8 text-text">
          <input type="checkbox" name="anonymous" className="mt-1 size-5 shrink-0" />
          {ft(locale, "publicAnon")}
        </label>
        <p id="fb-public-note" className="text-sm text-text-muted">{ft(locale, "publicNote", v)}</p>
      </fieldset>
      <div><Button type="submit">{ft(locale, "send")}</Button></div>
    </form>
  </>);
}
