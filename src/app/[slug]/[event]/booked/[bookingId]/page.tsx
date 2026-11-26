import Link from "next/link";
import { EmbedResize } from "@/components/EmbedResize";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { LocalTime } from "@/components/LocalTime";
import { buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { isUnpaidRelease } from "@/lib/booking-reasons";
import { store } from "@/lib/data";
import { formatDate, zoneName } from "@/lib/format";
import { LOCATION_KEYS, resolveLocale, t, tNodes } from "@/lib/i18n/guest";
import { mt } from "@/lib/i18n/mail";
import { AddToCalendar } from "@/components/AddToCalendar";
import { AutoRedirect } from "@/components/AutoRedirect";
import { cleanRedirectUrl } from "@/lib/calendar-links";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { formatAmount } from "@/lib/money";
import { getPool } from "@/lib/data/pg-store";
import { offerLabel } from "@/lib/offers/labels";
import { offerForBooking } from "@/lib/offers/offers";
import { requestPaymentDeps } from "@/lib/payments/request-deps";
import { settleStripeSession } from "@/lib/payments/stripe-checkout";
import { videoJoinUrl } from "@/lib/video/links";

export const dynamic = "force-dynamic";


export default async function BookedPage({ params, searchParams }: { params: Promise<{ slug: string; event: string; bookingId: string }>; searchParams: Promise<{ lang?: string; session_id?: string }> }) {
  const { slug, bookingId } = await params;
  const { lang, session_id: sessionId } = await searchParams;
  const host = await store.getUserBySlug(slug);
  let booking = host && (await store.getBooking(host.id, bookingId));
  if (!host || !booking) notFound();
  // Back from Stripe Checkout: the redirect proves nothing by itself, so the session is read back from Stripe as the
  // host's account and checked against this booking's payment before it counts. The webhook does the same independently.
  const paymentDeps = booking.status === "pending_payment" ? requestPaymentDeps() : null;
  const { rows: [pending] } = paymentDeps
    ? await paymentDeps.pool.query("select provider, provider_order_id from payments where booking_id = $1 and status = 'pending'", [booking.id])
    : { rows: [] };
  const onStripe = pending?.provider === "stripe";
  const stripe = paymentDeps?.stripe;
  if (stripe && onStripe && typeof sessionId === "string") {
    if (pending.provider_order_id === sessionId) {
      await settleStripeSession(stripe.deps, sessionId!, new Date()).catch((error) => console.error("[payments] Stripe return check failed", (error as Error).message));
      booking = (await store.getBooking(host.id, bookingId)) ?? booking;
    }
  }
  const eventType = await store.getEventType(host.id, booking.eventTypeId);
  // Checked again here: a stored value from before the https rule must never become a link or a redirect.
  const redirectUrl = eventType?.redirectUrl ? cleanRedirectUrl(eventType.redirectUrl) : null;
  const tz = booking.invitee.timezone;
  // Hourhand video bookings join through /b/<token>/video, which checks the booking on every visit.
  const joinUrl = booking.joinUrl ?? videoJoinUrl((resolveBaseUrl() ?? "").replace(/\/+$/, ""), booking.locationKind, booking.invitee.manageToken);
  const locale = resolveLocale(lang, host.locale);
  const q = typeof lang === "string" && lang === locale ? `?lang=${locale}` : "";
  const time = (d: Date) => <LocalTime date={d} tz={tz} locale={locale} />;
  // The price and the one offer it got, explained as it was charged.
  const offer = authEnabled() ? await offerForBooking(getPool(process.env.DATABASE_URL as string), booking.id) : null;
  const money = (m: number) => formatAmount(m, eventType?.currency ?? "INR");
  if (booking.status === "pending_payment") {
    return (
      <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <EmbedResize />
        <h1 className="font-display text-xl text-text">{t(locale, "confirmingPayment")}</h1>
        <p className="mt-2 max-w-md text-text-muted" role="status">
          {t(locale, "paymentSeconds")} {booking.holdExpiresAt ? tNodes(locale, "heldUntil", { time: time(booking.holdExpiresAt) }) : t(locale, "heldGeneric")}{" "}
          {!onStripe && t(locale, "closedRazorpay")}
        </p>
        <AutoRefresh labels={{ waiting: t(locale, "updatesItself"), stopped: t(locale, "stillWaiting") }} />
      </main>
    );
  }
  if (booking.status === "pending_approval") {
    // B9: a request the host still has to approve. No calendar buttons and no join link until it's confirmed.
    return (
      <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <EmbedResize />
        <h1 className="font-display text-xl text-text">{t(locale, "requestSent")}</h1>
        <p className="mt-2 max-w-md text-text" role="status">
          {tNodes(locale, "requestWaiting", { host: host.name, time: booking.holdExpiresAt ? time(booking.holdExpiresAt) : t(locale, "fewMinutes") })}
        </p>
        <p className="mt-2 max-w-md text-text-muted">{t(locale, "requestEmail", { host: host.name })}</p>
        <Link href={`/b/${booking.invitee.manageToken}${q}`} className={`mt-4 ${buttonClasses({ variant: "secondary" })}`}>{t(locale, "manageBooking")}</Link>
      </main>
    );
  }
  if (booking.status === "cancelled") {
    const unpaid = isUnpaidRelease(booking.cancelReason);
    return (
      <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <EmbedResize />
        <h1 className="font-display text-xl text-text">{t(locale, unpaid ? "unpaidTitle" : "cancelledTitle")}</h1>
        <p className="mt-2 max-w-md text-text-muted">{t(locale, unpaid ? "unpaidBody" : "nothingMore")}</p>
        <Link href={`/${host.slug}/${eventType?.slug ?? ""}${q}`} className={`mt-4 ${buttonClasses({ variant: "primary" })}`}>{t(locale, "bookATime")}</Link>
      </main>
    );
  }
  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <EmbedResize />
      <h1 className="font-display text-xl text-text">{t(locale, "booked")}</h1>
      <Card className="mt-4 max-w-md">
        <dl className="grid gap-3">
          <div><dt className="text-sm text-text-muted">{t(locale, "what")}</dt><dd className="text-text">{t(locale, "eventWith", { event: eventType?.name ?? "", host: host.name })}</dd></div>
          <div>
            <dt className="text-sm text-text-muted">{t(locale, "when")}</dt>
            <dd className="text-text">{tNodes(locale, "whenRange", { date: formatDate(booking.startAt, tz, locale), start: time(booking.startAt), end: time(booking.endAt), zone: zoneName(tz) })}</dd>
          </div>
          {booking.locationKind && <div><dt className="text-sm text-text-muted">{t(locale, "where")}</dt><dd className="text-text">{t(locale, LOCATION_KEYS[booking.locationKind])}{joinUrl && booking.status === "confirmed" && <> · <a href={joinUrl} className="font-semibold text-accent underline" rel="noopener noreferrer" target="_blank">{t(locale, "joinCall")}</a></>}</dd></div>}
          <div><dt className="text-sm text-text-muted">{t(locale, "bookedFor")}</dt><dd className="text-text">{booking.invitee.name}, {/\.invalid$/i.test(booking.invitee.email) ? booking.invitee.phone : booking.invitee.email}</dd></div>
          {offer && (
            <div>
              <dt className="text-sm text-text-muted">{t(locale, "price")}</dt>
              <dd className="text-text">
                {offer.discountMinor > 0
                  ? t(locale, "offerPaidLine", { price: money(offer.chargeMinor), list: money(offer.listMinor), amount: money(offer.discountMinor), label: offerLabel(locale, offer) })
                  : `${money(offer.chargeMinor)} (${offerLabel(locale, offer)})`}
              </dd>
            </div>
          )}
        </dl>
      </Card>
      {booking.status === "confirmed" && (
        <AddToCalendar
          token={booking.invitee.manageToken} title={mt(locale, "calWith", { event: eventType?.name ?? "", host: host.name })} start={booking.startAt} end={booking.endAt} locale={locale}
          location={joinUrl ?? (booking.locationKind ? t(locale, LOCATION_KEYS[booking.locationKind]) : null)}
          manageUrl={`${(resolveBaseUrl() ?? "").replace(/\/+$/, "")}/b/${booking.invitee.manageToken}`}
        />
      )}
      <p className="mt-4 text-text-muted">{t(locale, "keepLink")}</p>
      <Link href={`/b/${booking.invitee.manageToken}${q}`} className={`mt-2 ${buttonClasses({ variant: "secondary" })}`}>{t(locale, "manageBooking")}</Link>
      {redirectUrl && (
        <AutoRedirect url={redirectUrl} waiting={t(locale, "redirecting")} label={t(locale, "continueTo", { site: new URL(redirectUrl).hostname })} />
      )}
    </main>
  );
}
