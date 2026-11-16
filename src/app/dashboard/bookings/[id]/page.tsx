import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { freeSlots } from "@/lib/booking";
import { store } from "@/lib/data";
import { clientKey, sessionNumber } from "@/lib/clients";
import { briefFor } from "@/lib/session-prep/prep";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext, requireHost } from "@/lib/auth/session";
import { MAX_NOTE } from "@/lib/privacy/notes";
import { focusRing } from "@/components/ui/focus";
import { zoneName } from "@/lib/format";
import { getPool } from "@/lib/data/pg-store";
import { bookingPayment, DEPOSIT_HOLD_MS, type BookingPaymentSummary } from "@/lib/payments/booking-payments";
import { LOCATION_KEYS, isLocale, t as guestT } from "@/lib/i18n/guest";
import type { HostKey } from "@/lib/i18n/host";
import type { HostI18n } from "@/lib/i18n/host/format";
import { getHostI18n } from "@/lib/i18n/host/server";
import { GUEST_LOCATION_LABELS } from "@/lib/location-labels";
import { videoJoinUrl } from "@/lib/video/links";
import { waLink, waNumber, whatsappMessage, type WhatsAppKind } from "@/lib/whatsapp";
import { feedbackForBooking } from "@/lib/follow-ups/follow-ups";
import { cancelAsHost, rescheduleAsHost, saveSessionNote, setNoShow } from "./actions";

const PAYMENT_LINES: Record<BookingPaymentSummary["status"], HostKey> = {
  pending: "bookings.paymentPending", paid: "bookings.paymentPaid", failed: "bookings.paymentFailed",
  refund_pending: "bookings.paymentRefundPending", refunded: "bookings.paymentRefunded",
};
const DEPOSIT_LINES: Record<BookingPaymentSummary["status"], HostKey> = {
  pending: "bookings.depositPending", paid: "bookings.depositPaid", failed: "bookings.depositFailed",
  refund_pending: "bookings.depositRefundPending", refunded: "bookings.depositRefunded",
};

const DONE: Record<string, HostKey> = {
  cancelled: "bookings.doneCancelled",
  rescheduled: "bookings.doneRescheduled",
  no_show: "bookings.doneNoShow",
  no_show_undone: "bookings.doneNoShowUndone",
  note_saved: "bookings.doneNoteSaved",
};
const ERRORS: Record<string, HostKey> = {
  not_found: "bookings.errorNotFound",
  reason_too_long: "bookings.errorReasonTooLong",
  not_cancellable: "bookings.errorNotCancellable",
  slot_taken: "bookings.errorSlotTaken",
  not_movable: "bookings.errorNotMovable",
  group_seat: "bookings.errorGroupSeat",
  bad_time: "bookings.errorBadTime",
  not_started: "bookings.errorNotStarted",
  note_too_long: "bookings.errorNoteTooLong",
};
const DAY = 86_400_000;

export const dynamic = "force-dynamic";

type Query = { done?: string; error?: string; confirm?: string; reschedule?: string };

export default async function BookingDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Query> }) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requireHost();
  const i18n = await getHostI18n();
  const { t, date, time, money } = i18n;
  const booking = await store.getBooking(user.id, id);
  if (!booking) notFound();
  const now = new Date();
  const tz = user.timezone;
  const confirmed = booking.status === "confirmed";
  const upcoming = confirmed && booking.startAt > now;
  const started = confirmed && booking.startAt <= now;
  // Next 14 days of times the host is free, not counting this booking's own slot, grouped by day in the host's zone.
  const eventType = upcoming && query.reschedule ? await store.getEventType(user.id, booking.eventTypeId) : null;
  const slots = eventType ? await freeSlots(store, user, eventType, now, new Date(now.getTime() + 14 * DAY), now, booking.id) : [];
  const byDay = new Map<string, Date[]>();
  for (const s of slots) byDay.set(date(s, tz), [...(byDay.get(date(s, tz)) ?? []), s]);
  const key = randomUUID();
  const done = query.done && Object.hasOwn(DONE, query.done) ? t(DONE[query.done]) : null;
  const error = query.error && Object.hasOwn(ERRORS, query.error) ? t(ERRORS[query.error]) : null;
  const payment = authEnabled() ? await bookingPayment(getPool(process.env.DATABASE_URL as string), user.id, booking.id) : null;
  const whatsapp = upcoming ? await whatsappLinks(user, booking, i18n) : null;
  // Messages Hourhand's own WhatsApp number sent (or will send) to this guest, when they ticked it.
  const automatic = authEnabled()
    ? (await getPool(process.env.DATABASE_URL as string).query(
        "select kind, status, last_error from notifications where booking_id = $1 and user_id = $2 and channel = 'whatsapp' order by send_at, kind",
        [booking.id, user.id])).rows as { kind: string; status: string; last_error: string | null }[]
    : [];
  const allBookings = await store.listBookings(user.id);
  const series = booking.seriesId ? allBookings.filter((b) => b.seriesId === booking.seriesId) : [];
  const nth = sessionNumber(allBookings, booking);
  // Private notes are decrypted for the account owner only, never for a Duo second person managing the account.
  const owner = !(await getHostContext())?.acting;
  const [clientNote, sessionNote] = owner ? await Promise.all([store.getClientNote(user.id, booking.invitee.email), store.getBookingNote(user.id, booking.id)]) : ["", ""];
  const prepPool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const brief = prepPool ? await briefFor(prepPool, user.id, booking.id) : null;
  // Everyone holding a live seat in the same group class, this guest included.
  const classmates = booking.classKey ? allBookings.filter((b) => b.classKey === booking.classKey && (b.status === "confirmed" || b.status === "pending_payment")) : [];
  const seatLimit = booking.classKey ? (await store.getEventType(user.id, booking.eventTypeId))?.seatLimit ?? null : null;
  const laterWeeks = series.filter((b) => (b.seriesIndex ?? 0) > (booking.seriesIndex ?? 0) && b.status === "confirmed" && b.startAt > now).length;
  // The guest's private after-session feedback (src/lib/follow-ups), if they left any.
  const feedback = authEnabled() ? await feedbackForBooking(getPool(process.env.DATABASE_URL as string), user.id, booking.id) : null;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("bookings.detailTitle", { name: booking.invitee.name })}</h1>
      <p className="mt-1 text-sm text-text-muted">
        {nth > 1 ? t("bookings.returningClient", { n: nth }) : nth === 1 ? t("bookings.firstSession") : ""}{nth > 0 && " · "}
        <Link href={`/dashboard/clients/${clientKey(booking.invitee.email)}`} className="font-semibold text-accent underline">{t("bookings.clientHistory")}</Link>
      </p>
      {clientNote && <p className="mt-3 max-w-xl whitespace-pre-line rounded-md bg-surface p-3 text-sm text-text"><span className="font-semibold">{t("bookings.yourNote")} </span>{clientNote}</p>}
      {done && <p role="status" className="mt-4 max-w-xl text-success">{done}</p>}
      {error && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{error}</p>}
      <dl className="mt-4 grid max-w-md gap-3">
        <div>
          <dt className="text-sm text-text-muted">{t("bookings.when")}</dt>
          <dd className="text-text">
            {t("bookings.whenValue", { date: date(booking.startAt, tz), time: time(booking.startAt, tz), zone: zoneName(tz) })}
            {booking.status === "cancelled" && <span className="ml-2 rounded-md bg-danger-bg px-2 py-0.5 text-sm text-danger">{t("bookings.statusCancelled")}</span>}
            {booking.status === "pending_payment" && <span className="ml-2 rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">{t("bookings.statusAwaitingPayment")}</span>}
            {booking.invitee.noShowAt && <span className="ml-2 rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">{t("bookings.noShow")}</span>}
            {confirmed && booking.invitee.runningLateMinutes && (
              <span className="ml-2 rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">
                {booking.invitee.runningLateAt
                  ? t("bookings.runningLateSaidAt", { n: booking.invitee.runningLateMinutes, time: time(booking.invitee.runningLateAt, tz) })
                  : t("bookings.runningLate", { n: booking.invitee.runningLateMinutes })}
              </span>
            )}
          </dd>
          {series.length > 1 && <dd className="text-sm text-text-muted">{t("bookings.seriesWeek", { n: booking.seriesIndex ?? "", total: new Set(series.map((b) => b.seriesIndex)).size })}</dd>}
        </div>
        {booking.classKey && (
          <div>
            <dt className="text-sm text-text-muted">{seatLimit ? t("bookings.groupClassSeatsOf", { taken: classmates.length, limit: seatLimit }) : t("bookings.groupClassSeats", { taken: classmates.length })}</dt>
            <dd className="text-text">
              <ul className="space-y-1">
                {classmates.map((b) => (
                  <li key={b.id}>{b.id === booking.id ? b.invitee.name : <Link href={`/dashboard/bookings/${b.id}`} className="text-accent underline">{b.invitee.name}</Link>}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {confirmed && booking.locationKind === "hourhand_video" && (
          <div>
            <dt className="text-sm text-text-muted">{t("bookings.videoTitle")}</dt>
            <dd className="text-text">
              <a href={`/dashboard/bookings/${booking.id}/video`} className="font-semibold text-accent underline" rel="noopener noreferrer" target="_blank">{t("bookings.videoStart")}</a>
              <span className="block text-sm text-text-muted">{t(booking.classKey ? "bookings.videoHintClass" : "bookings.videoHintGuest")}</span>
            </dd>
          </div>
        )}
        <div><dt className="text-sm text-text-muted">{t("bookings.email")}</dt><dd className="text-text">{booking.invitee.email}</dd></div>
        {booking.invitee.guests.length > 0 && <div><dt className="text-sm text-text-muted">{t("bookings.alsoInvited")}</dt><dd className="text-text">{booking.invitee.guests.join(", ")}</dd></div>}
        {payment && (
          <div>
            <dt className="text-sm text-text-muted">{t("bookings.payment")}</dt>
            <dd className="text-text">
              {t(payment.kind !== "deposit" ? PAYMENT_LINES[payment.status] : payment.status === "paid" && booking.invitee.noShowAt ? "bookings.depositKept" : DEPOSIT_LINES[payment.status], { amount: money(payment.amountMinor, payment.currency) })}
              {payment.kind === "deposit" && payment.status === "paid" && !booking.invitee.noShowAt && confirmed && (
                <span className="block text-sm text-text-muted">{t("bookings.depositRefundOn", { date: date(new Date(booking.endAt.getTime() + DEPOSIT_HOLD_MS), tz), time: time(new Date(booking.endAt.getTime() + DEPOSIT_HOLD_MS), tz) })}</span>
              )}
              {payment.status === "refund_pending" && payment.lastError && (
                <span className="block text-sm text-danger">{t("bookings.refundStuck", { provider: payment.provider === "stripe" ? "Stripe" : "Razorpay", error: payment.lastError.slice(0, 120) })}</span>
              )}
            </dd>
          </div>
        )}
        {booking.invitee.phone && <div><dt className="text-sm text-text-muted">{t("bookings.phone")}</dt><dd className="text-text">{booking.invitee.phone}</dd></div>}
        {booking.invitee.answers.map((a) => (
          <div key={a.questionId}><dt className="text-sm text-text-muted">{a.label}</dt><dd className="whitespace-pre-line text-text">{a.answer}</dd></div>
        ))}
      </dl>
      {brief?.status === "ready" && (
        <section aria-labelledby="prep" className="mt-6 max-w-xl rounded-md border border-border bg-card p-4">
          <h2 id="prep" className="font-display text-lg text-text">{t("bookings.prepTitle")}</h2>
          <p className="mt-1 whitespace-pre-line text-text">{brief.text}</p>
          <p className="mt-2 text-xs text-text-muted">{t("bookings.prepNote", { name: booking.invitee.name.split(" ")[0] })}</p>
        </section>
      )}
      {upcoming && (
        <section aria-labelledby="whatsapp" className="mt-6 grid max-w-xl gap-2">
          <h2 id="whatsapp" className="font-display text-lg text-text">{t("bookings.whatsappTitle")}</h2>
          {automatic.length > 0 && (
            <ul className="grid gap-1 text-sm text-text">
              {automatic.map((a) => (
                <li key={a.kind}>
                  {automaticLine(t, a)}
                </li>
              ))}
            </ul>
          )}
          {whatsapp ? (
            <>
              <p className="text-sm text-text-muted">{t("bookings.whatsappHelp")}</p>
              <div className="flex flex-wrap gap-2">
                {whatsapp.map((w) => (
                  <a key={w.kind} href={w.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-md border border-border px-3 font-semibold text-accent underline">
                    {w.label}
                  </a>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-text-muted">
              {booking.invitee.phone
                ? t("bookings.whatsappNoCountryCode", { name: booking.invitee.name, phone: booking.invitee.phone })
                : t("bookings.whatsappNoNumber", { name: booking.invitee.name })}
            </p>
          )}
        </section>
      )}
      {upcoming && (
        <section aria-labelledby="actions" className="mt-6 grid max-w-xl gap-4">
          <h2 id="actions" className="font-display text-lg text-text">{t("bookings.changeTitle")}</h2>
          {query.confirm === "cancel" ? (
            <form action={cancelAsHost} className="grid gap-2">
              <input type="hidden" name="bookingId" value={booking.id} />
              <label htmlFor="reason" className="text-sm text-text-muted">{t("bookings.reasonLabel", { name: booking.invitee.name })}</label>
              <textarea id="reason" name="reason" maxLength={500} rows={3} className="rounded-md border border-border bg-card p-2 text-text" />
              {laterWeeks > 0 && (
                <label className="flex min-h-11 items-center gap-3 text-text">
                  <input type="checkbox" name="laterWeeks" className="h-5 w-5 accent-accent" />
                  {laterWeeks === 1 ? t("bookings.alsoCancelNextWeek") : t("bookings.alsoCancelLaterWeeks", { n: laterWeeks })}
                </label>
              )}
              <p className="text-sm text-text-muted">{t("bookings.cancelNote", { name: booking.invitee.name })}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="danger">{t("bookings.yesCancel")}</Button>
                <Link href={`/dashboard/bookings/${booking.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("bookings.keepIt")}</Link>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-4">
              <Link href={`/dashboard/bookings/${booking.id}?confirm=cancel`} className="inline-flex min-h-11 items-center font-semibold text-danger underline">{t("bookings.cancelBooking")}</Link>
              {!booking.classKey && <Link href={`/dashboard/bookings/${booking.id}?reschedule=1`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("bookings.moveBooking")}</Link>}
            </div>
          )}
          {query.reschedule && !booking.classKey && (
            <div>
              <h3 className="font-semibold text-text">{t("bookings.pickNewTime", { zone: zoneName(tz) })}</h3>
              {byDay.size === 0 ? (
                <p className="mt-2 text-text-muted">{t("bookings.noFreeTimes")}</p>
              ) : (
                [...byDay].map(([day, times]) => (
                  <div key={day} className="mt-3">
                    <h4 className="text-sm text-text-muted">{day}</h4>
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {times.map((s) => (
                        <li key={s.toISOString()}>
                          <form action={rescheduleAsHost}>
                            <input type="hidden" name="bookingId" value={booking.id} />
                            <input type="hidden" name="start" value={s.toISOString()} />
                            {/* One key per time: clicking a second time on a stale page is refused instead of silently repeating the first move. */}
                            <input type="hidden" name="key" value={`${key}:${s.toISOString()}`} />
                            <Button type="submit" variant="secondary">{time(s, tz)}</Button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      )}
      {feedback && (
        <section aria-labelledby="bk-feedback" className="mt-6 max-w-xl rounded-md bg-surface p-3">
          <h2 id="bk-feedback" className="font-semibold text-text">{t("bookings.feedbackTitle", { rating: feedback.rating })}</h2>
          {feedback.comment && <p className="mt-1 whitespace-pre-line break-words text-text">{feedback.comment}</p>}
          <p className="mt-1 text-sm text-text-muted">{t("bookings.feedbackLeft", { date: date(feedback.createdAt, tz) })}</p>
        </section>
      )}
      {owner ? (
        <section aria-labelledby="session-note" className="mt-6 max-w-xl">
          <form action={saveSessionNote} className="grid gap-2">
            <input type="hidden" name="bookingId" value={booking.id} />
            <label id="session-note" htmlFor="note" className="font-semibold text-text">{t("bookings.sessionNote")}</label>
            <p className="text-sm text-text-muted">{t("bookings.sessionNoteHelp")}</p>
            <textarea id="note" name="note" rows={5} maxLength={MAX_NOTE} defaultValue={sessionNote} placeholder={t("bookings.sessionNotePlaceholder")}
              className={`block w-full rounded-md border border-border-input bg-card p-3 text-base text-text ${focusRing}`} />
            <div><Button type="submit" variant="secondary">{t("bookings.saveSessionNote")}</Button></div>
          </form>
        </section>
      ) : (
        <p className="mt-6 max-w-xl text-sm text-text-muted">{t("bookings.notesOwnerOnly")}</p>
      )}
      {started && (
        <form action={setNoShow} className="mt-6">
          <input type="hidden" name="bookingId" value={booking.id} />
          <input type="hidden" name="on" value={booking.invitee.noShowAt ? "0" : "1"} />
          <Button type="submit" variant="secondary">{t(booking.invitee.noShowAt ? "bookings.undoNoShow" : "bookings.markNoShow")}</Button>
        </form>
      )}
      <Link href="/dashboard/bookings" className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">{t("bookings.back")}</Link>
    </div>
  );
}

const AUTOMATIC_LABELS: Record<string, HostKey> = {
  booked_guest: "bookings.autoConfirmation", reminder_guest: "bookings.autoReminder", cancelled_guest: "bookings.autoCancellation", rescheduled_guest: "bookings.autoRescheduled",
};
const WHATSAPP_LABELS: Record<WhatsAppKind, HostKey> = { confirmation: "bookings.sendConfirmation", reminder: "bookings.sendReminder", manage: "bookings.sendManage" };

/** "Reminder a day before: will be sent automatically", for one message Hourhand's own number handles. */
function automaticLine(t: HostI18n["t"], a: { kind: string; status: string; last_error: string | null }): string {
  const label = Object.hasOwn(AUTOMATIC_LABELS, a.kind) ? t(AUTOMATIC_LABELS[a.kind]) : a.kind;
  if (a.status === "sent") return t("bookings.autoSent", { label });
  if (a.status === "queued") return t("bookings.autoQueued", { label });
  if (a.status === "failed") return a.last_error ? t("bookings.autoFailedWhy", { label, error: a.last_error }) : t("bookings.autoFailed", { label });
  return a.last_error ? t("bookings.autoNotSentWhy", { label, error: a.last_error }) : t("bookings.autoNotSent", { label });
}

/** One wa.me link per message, or null when the guest left no usable number. */
async function whatsappLinks(
  user: { id: string; name: string },
  booking: NonNullable<Awaited<ReturnType<typeof store.getBooking>>>,
  { t }: HostI18n,
): Promise<{ kind: WhatsAppKind; label: string; href: string }[] | null> {
  const number = waNumber(booking.invitee.phone);
  if (!number) return null;
  const [eventType, locations, h] = await Promise.all([
    store.getEventType(user.id, booking.eventTypeId), store.listEventLocations(user.id, booking.eventTypeId), headers(),
  ]);
  const origin = process.env.BETTER_AUTH_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const kind = booking.locationKind;
  const value = locations.find((l) => l.kind === kind)?.value ?? null;
  const locale = isLocale(booking.invitee.locale) ? booking.invitee.locale : "en";
  const label = kind ? (locale === "en" ? GUEST_LOCATION_LABELS[kind] : guestT(locale, LOCATION_KEYS[kind])) : null;
  // A WhatsApp message to the guest: the guest's own join link for Hourhand video.
  const joinUrl = booking.joinUrl ?? videoJoinUrl(origin.replace(/\/+$/, ""), kind, booking.invitee.manageToken);
  const where = label ? `${label}${joinUrl ? `: ${joinUrl}` : value ? `: ${value}` : ""}` : null;
  const ctx = {
    guestName: booking.invitee.name, hostName: user.name, eventName: eventType?.name ?? "booking", startAt: booking.startAt,
    guestTimezone: booking.invitee.timezone, where, locale, manageUrl: `${origin.replace(/\/+$/, "")}/b/${booking.invitee.manageToken}`,
  };
  return (Object.keys(WHATSAPP_LABELS) as WhatsAppKind[]).map((k) => ({ kind: k, label: t(WHATSAPP_LABELS[k]), href: waLink(number, whatsappMessage(k, ctx)) }));
}
