import type pg from "pg";
import { accessTokenFor } from "../calendar/connections";
import type { GoogleClient } from "../calendar/google";
import { CalendarApiError, PROVIDER_NAMES, type CalendarProvider, type CalendarProviderId, type CalendarProviders } from "../calendar/provider";
import { recordConnectionFailure } from "../calendar/sync";
import type { BookingEmailKind, CalendarJobKind, NotificationKind, VideoJobKind } from "../data/notifications";
import type { InviteeAnswer, LocationKind } from "../data/types";
import type { HourCycle } from "../format";
import { GUEST_LOCATION_LABELS } from "../location-labels";
import { extraGuestVideoJoinUrl, videoJoinUrlFor, type VideoAudience } from "../video/links";
import { pgExtraGuestLinks } from "../video/guest-links";
import { MailError, type Mailer } from "../mail/mailer";
import { invoiceById } from "../gst/invoices";
import { monthlyEarnings } from "../earnings";
import { requestForEmail } from "../privacy/rights";
import { paymentAccount, priceCurrency } from "../payments/host-payments";
import { renderBookingMail, renderCalendarAlert, renderEarningsMail, renderInvoiceMail, renderPackageMail, renderRenewalReminder, renderPollClosedMail, renderPollVoterMail, renderSeatInviteMail, renderWaitlistMail, renderDataRequestMail, renderZoomAlert, type BookingMailContext, type RenderedMail } from "../mail/templates";
import { PLAN_NAMES, PRICES, priceLine, type BillingInterval, type PaidPlan } from "../billing/plans";
import { freeSlots } from "../booking";
import { pollMailData } from "../polls/polls";
import { createPgStore } from "../data/pg-store";
import { hostPlan } from "../billing/account";
import { buildFollowUp, FOLLOW_UP_KIND } from "../follow-ups/follow-ups";
import { linkKey } from "../follow-ups/tokens";
import { isWhatsAppKind, sendWhatsApp, templateMessage, WhatsAppError, WHATSAPP_MONTHLY_LIMITS, type WhatsAppConfig } from "../whatsapp-cloud";
import { ZoomApiError, type ZoomMeetingInput } from "../zoom/client";
import { withZoomToken, type ZoomDeps } from "../zoom/connection";
import { ZOOM_READY_SQL } from "../zoom/sql";
import type { SmsConfig } from "../sms/config";
import { queueSmsFallback, sendBookingSms, smsSkipReason } from "../sms/outbox";
import { SmsError } from "../sms/provider";
import { renderMembership } from "../memberships/mail";

// Runs due rows of the notifications queue: emails, writes to the host's calendar (Google, Microsoft, iCloud) and to
// their Zoom (a meeting per booking). Several workers can run
// at once: each claims rows with FOR UPDATE SKIP LOCKED and a lease (locked_until), so a row is never run by two
// workers, and a worker that dies mid-run frees its rows when the lease ends. Re-running a row is harmless: the
// notification id is Resend's idempotency key, and a calendar event's id is fixed per booking.

export const MAX_ATTEMPTS = 5;
/** Wait before attempt 2, 3, 4, 5. */
export const RETRY_DELAYS_MINUTES = [1, 5, 30, 120] as const;
const LEASE_MINUTES = 5;
/** Rows claimed per run. Each row's lease is renewed before it runs, so a slow batch can't outlive its lease. */
export const BATCH_SIZE = 10;
/** How long a guest's confirmation may wait for its video link (Google Meet, Teams or Zoom) before it goes without it. */
export const MEET_LINK_WAIT_SECONDS = 180;
const VIDEO_LINK_WAIT = "waiting for the video link";
const ZOOM_LINK_WAIT = "waiting for the Zoom link";
const DEFER_SECONDS = 20;
const MIN = 60_000;

/** `released`: emails a calendar write just unblocked, which are due now (the runner goes round again for them). */
export interface WorkerResult { claimed: number; sent: number; skipped: number; retrying: number; failed: number; deferred: number; released: number }
/** `pushAddress`: where Google sends change pings, or null when push can't work (no public https URL). */
/** `providers`: the calendar providers configured here. `google`: the Google client, for watch channels only. */
export interface CalendarDeps { providers: CalendarProviders; google?: GoogleClient; key: Buffer; pushAddress?: string | null }

interface Claimed { id: string; booking_id: string | null; user_id: string; kind: NotificationKind; channel: string; recipient: string; attempts: number; locked_until: Date; dedupe_key: string }

/** Claims up to `limit` due rows. Each claim counts as an attempt, so a row that keeps crashing its worker still runs out. */
export async function claimDue(pool: pg.Pool, now: Date, limit: number): Promise<Claimed[]> {
  const { rows } = await pool.query(
    `update notifications n set locked_until = $1::timestamptz + make_interval(mins => $3), attempts = n.attempts + 1, updated_at = $1
     from (select id from notifications
           where status = 'queued' and channel in ('email', 'calendar', 'whatsapp', 'sms', 'video') and send_at <= $1 and (locked_until is null or locked_until < $1)
           order by send_at limit $2 for update skip locked) due
     where n.id = due.id
     returning n.id, n.booking_id, n.user_id, n.kind, n.channel, n.recipient, n.attempts, n.locked_until, n.dedupe_key`, [now, limit, LEASE_MINUTES]);
  return rows as Claimed[];
}

const CONTEXT = `
  select n.id as notification_id, n.created_at as queued_at, n.dedupe_key, b.id, b.host_id, b.series_id, b.status, b.start_at, b.end_at, b.cancelled_by, b.cancel_reason,
    b.location_kind as booking_location_kind, b.external_event_id, b.external_calendar_id, b.zoom_meeting_id, b.class_key,
    -- seats of one group class or confirmed poll share one calendar event, so its video link is on whichever seat holds it
    coalesce(b.join_url, (select m.join_url from bookings m where b.class_key is not null and m.class_key = b.class_key and m.join_url is not null limit 1)) as join_url,
    prev.start_at as previous_start_at, prev.external_event_id as previous_event_id, prev.external_calendar_id as previous_calendar_id,
    prev.join_url as previous_join_url, prev.cancelled_by as previous_cancelled_by, prev.zoom_meeting_id as previous_zoom_meeting_id, prev.class_key as previous_class_key,
    i.name as guest_name, i.email as guest_email, i.timezone as guest_timezone, i.locale as guest_locale, i.answers, i.manage_token, i.reminders_opt_out, i.running_late_minutes,
    e.name as event_name, e.slug as event_slug, e.kind as event_kind, e.active as event_active, b.event_type_id, u.slug as host_slug,
    (select p.amount_minor from payments p where p.booking_id = b.id and p.status in ('paid', 'refund_pending', 'refunded')
      order by p.created_at desc limit 1) as paid_minor,
    (select p.kind from payments p where p.booking_id = b.id and p.status in ('paid', 'refund_pending', 'refunded')
      order by p.created_at desc limit 1) as paid_kind,
    (select p.currency from payments p where p.booking_id = b.id and p.status in ('paid', 'refund_pending', 'refunded')
      order by p.created_at desc limit 1) as paid_currency,
    (select p.provider from payments p where p.booking_id = b.id and p.status in ('paid', 'refund_pending', 'refunded')
      order by p.created_at desc limit 1) as paid_provider,
    coalesce(u.name, '') as host_name, u.email as host_email, u.timezone as host_timezone, u.time_format as host_time_format,
    loc.kind as location_kind, loc.value as location_value, atc.provider as add_to_provider, atc.can_teams as add_to_can_teams,
    -- a calendar write that hasn't been tried yet or is running right now; one waiting to retry doesn't hold emails back
    exists (select 1 from notifications cj where (cj.booking_id = b.id or cj.booking_id in (select m.id from bookings m where b.class_key is not null and m.class_key = b.class_key))
            and cj.channel = 'calendar' and cj.kind <> 'calendar_delete'
            and cj.status = 'queued' and (cj.attempts = 0 or cj.locked_until > $2)) as calendar_write_pending,
    exists (select 1 from notifications cj where cj.booking_id in (b.id, b.rescheduled_from_id) and cj.id <> n.id and cj.channel = 'calendar'
            and cj.status = 'queued' and cj.locked_until > $2) as calendar_write_in_flight,
    -- the same two for Zoom: a meeting being made for this booking, and another Zoom write running for it right now
    exists (select 1 from notifications vj where vj.booking_id = b.id and vj.channel = 'video' and vj.kind <> 'zoom_delete'
            and vj.status = 'queued' and (vj.attempts = 0 or vj.locked_until > $2)) as video_write_pending,
    exists (select 1 from notifications vj where vj.booking_id in (b.id, b.rescheduled_from_id) and vj.id <> n.id and vj.channel = 'video'
            and vj.status = 'queued' and vj.locked_until > $2) as video_write_in_flight
  from notifications n
  left join bookings b on b.id = n.booking_id
  left join invitees i on i.booking_id = b.id
  left join event_types e on e.id = b.event_type_id
  left join users u on u.id = b.host_id
  left join bookings prev on prev.id = b.rescheduled_from_id
  left join lateral (select kind, value from event_locations l where l.event_type_id = e.id order by position limit 1) loc on true
  -- the calendar the booking's event goes into: the old event's calendar when a move updates it, else the calendar job's target
  left join lateral (select cc.provider, c.can_teams from calendars c join calendar_connections cc on cc.id = c.connection_id
    where c.user_id = b.host_id and ((prev.external_event_id is not null and c.id = prev.external_calendar_id)
      or c.id::text = (select cj.recipient from notifications cj where cj.booking_id = b.id and cj.channel = 'calendar'
                       and cj.kind in ('calendar_create', 'calendar_move') order by cj.created_at desc limit 1))
    order by (prev.external_event_id is not null and c.id = prev.external_calendar_id) is true desc limit 1) atc on true
  where n.id = any($1::uuid[])`;

type ContextRow = Record<string, unknown>;

function toContext(r: ContextRow, baseUrl: string, audience: VideoAudience = "guest"): BookingMailContext {
  return {
    bookingId: r.id as string, eventName: r.event_name as string,
    hostName: r.host_name as string, hostEmail: r.host_email as string, hostTimezone: r.host_timezone as string, hostTimeFormat: r.host_time_format as HourCycle,
    guestName: r.guest_name as string, guestEmail: r.guest_email as string, guestTimezone: r.guest_timezone as string, locale: (r.guest_locale as string | null) ?? "en",
    startAt: new Date(r.start_at as Date), endAt: new Date(r.end_at as Date),
    location: r.location_kind ? { kind: r.location_kind as LocationKind, value: (r.location_value as string | null) ?? null } : null,
    // Hourhand video: Hourhand's own join page (never the room or a token), the host's or the guest's, checked on every visit.
    joinUrl: (r.join_url as string | null)
      ?? videoJoinUrlFor(audience, baseUrl, r.booking_location_kind as string | null, { bookingId: r.id as string, manageToken: r.manage_token as string | null }),
    answers: (r.answers as InviteeAnswer[]) ?? [],
    cancelledBy: (r.cancelled_by as BookingMailContext["cancelledBy"]) ?? null, cancelReason: (r.cancel_reason as string | null) ?? null,
    paidMinor: (r.paid_minor as number | null) ?? null, paidIsDeposit: r.paid_kind === "deposit",
    paidCurrency: (r.paid_currency as string | null) ?? null, paidProvider: (r.paid_provider as "razorpay" | "stripe" | null) ?? null,
    previousStartAt: r.previous_start_at ? new Date(r.previous_start_at as Date) : null,
    movedBy: (r.previous_cancelled_by as BookingMailContext["movedBy"]) ?? null,
    issuedAt: new Date(r.queued_at as Date),
    manageUrl: `${baseUrl}/b/${r.manage_token as string}`, dashboardUrl: `${baseUrl}/dashboard/bookings/${r.id as string}`,
    // The minutes this email was queued for (in its key), not whatever the guest has tapped since.
    runningLateMinutes: Number(/:late:(\d+)/.exec(String(r.dedupe_key ?? ""))?.[1] ?? r.running_late_minutes) || null,
  };
}

/** A guest email going to someone the guest added, not the guest who booked. */
const extraGuestMail = (c: Claimed, r: ContextRow) => c.recipient.toLowerCase() !== String(r.guest_email).toLowerCase() && c.kind.endsWith("_guest");

const REBOOK_DAYS = 21;

/** Later weeks of the same series cancelled in the same transaction as this one (same cancelled_at). */
async function cancelledWith(pool: pg.Pool, bookingId: string): Promise<Date[]> {
  const { rows } = await pool.query(
    `select w.start_at from bookings b join bookings w on w.series_id = b.series_id and w.id <> b.id and w.cancelled_at = b.cancelled_at and w.series_index > b.series_index
     where b.id = $1 order by w.series_index`, [bookingId]);
  return rows.map((w) => new Date(w.start_at));
}

/** The weeks of a series still booked, read at send time, so a week cancelled before the confirmation went out isn't listed. */
async function seriesWeeks(pool: pg.Pool, seriesId: string, baseUrl: string): Promise<NonNullable<BookingMailContext["series"]>> {
  const { rows } = await pool.query(
    `select b.id, b.start_at, b.end_at, i.manage_token from bookings b join invitees i on i.booking_id = b.id
     where b.series_id = $1 and b.status = 'confirmed' order by b.series_index`, [seriesId]);
  return rows.map((w) => ({ bookingId: w.id, startAt: new Date(w.start_at), endAt: new Date(w.end_at), manageUrl: `${baseUrl}/b/${w.manage_token}` }));
}

/**
 * When the host cancels, the guest's email offers the three free times nearest the one that was cancelled, each opening
 * the booking page on that day. The window starts when the email was queued; the free times are read at send time.
 * None for a guest's own cancel, a one-off meeting (link only) or an event type that's switched off.
 */
async function rebookSuggestions(pool: pg.Pool, r: ContextRow, baseUrl: string): Promise<{ at: Date; url: string }[]> {
  if (r.cancelled_by !== "host" || r.event_kind === "one_off" || !r.event_active || !r.host_slug || !r.event_slug) return [];
  let host, eventType, slots: Date[];
  try {
    const store = createPgStore(pool);
    [host, eventType] = await Promise.all([store.getUser(r.host_id as string), store.getEventType(r.host_id as string, r.event_type_id as string)]);
    if (!host || !eventType) return [];
    const asOf = new Date(r.queued_at as Date);
    slots = await freeSlots(store, host, eventType, asOf, new Date(asOf.getTime() + REBOOK_DAYS * 86_400_000), asOf);
  } catch (error) {
    // Suggestions are a nicety: the cancellation itself must still reach the guest.
    console.error("rebook suggestions failed", { bookingId: r.id, error });
    return [];
  }
  const target = new Date(r.start_at as Date).getTime();
  // Not the time the host just cancelled: they can't make it.
  return slots.filter((s) => s.getTime() !== target).sort((a, b) => Math.abs(a.getTime() - target) - Math.abs(b.getTime() - target)).slice(0, 3)
    .sort((a, b) => a.getTime() - b.getTime())
    .map((at) => ({ at, url: `${baseUrl}/${host.slug}/${eventType.slug}?at=${encodeURIComponent(at.toISOString())}` }));
}

const isCalendarJob = (kind: NotificationKind): kind is CalendarJobKind => kind.startsWith("calendar_") && kind !== "calendar_alert_host";
const isVideoJob = (kind: NotificationKind): kind is VideoJobKind => kind === "zoom_create" || kind === "zoom_move" || kind === "zoom_delete";

/** Why a claimed row should not run any more, or null to run it. */
/** Why a WhatsApp row shouldn't go (checked as it sends), or null: set up here, not opted out, within the host's plan. */
async function whatsappSkipReason(pool: pg.Pool, c: Claimed, cfg: WhatsAppConfig | null, now: Date): Promise<string | null> {
  if (!cfg) return "WhatsApp is not configured on this server";
  if (!isWhatsAppKind(c.kind)) return "not a WhatsApp message";
  if ((await pool.query("select 1 from whatsapp_opt_outs where phone = $1", [c.recipient])).rowCount) return "guest replied STOP on WhatsApp";
  const limit = WHATSAPP_MONTHLY_LIMITS[await hostPlan(pool, c.user_id)];
  if (limit === 0) return "the host's plan doesn't include WhatsApp";
  // This calendar month in India, where the plans are sold.
  const { rows: [used] } = await pool.query(
    `select count(*)::int as n from notifications where user_id = $1 and channel = 'whatsapp' and status = 'sent'
       and sent_at >= (date_trunc('month', $2::timestamptz at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`, [c.user_id, now]);
  return used.n >= limit ? `monthly WhatsApp limit reached (${limit})` : null;
}

export function skipReason(kind: NotificationKind, r: ContextRow, now: Date): string | null {
  const start = new Date(r.start_at as Date);
  // Cancellation emails and removing the calendar event are the only things that still make sense for a cancelled booking.
  const forCancelled = kind === "cancelled_guest" || kind === "cancelled_host" || kind === "calendar_delete" || kind === "zoom_delete";
  if (!forCancelled && r.status !== "confirmed") return "booking cancelled";
  if (kind === "calendar_delete" || kind === "zoom_delete") return null;
  // Sent after the session by design; buildFollowUp checks everything else when it renders.
  if (kind === FOLLOW_UP_KIND) return null;
  if (kind === "reminder_guest") {
    if (r.reminders_opt_out) return "guest opted out of reminders";
    if (start <= now) return "booking already started";
    return null;
  }
  // A guest may say they're late until 30 minutes after the start, which can be after a short meeting's end.
  if (kind === "late_host") return now.getTime() - start.getTime() > 60 * 60_000 ? "booking already over" : null;
  // Everything else is news about a booking; once the meeting is over it is no longer worth sending.
  if (new Date(r.end_at as Date) <= now) return "booking already over";
  return null;
}

/** Why a claimed row should wait a little before running, or null to run it now. */
export function deferReason(kind: NotificationKind, r: ContextRow, now: Date, calendarOn = true, zoomOn = false): string | null {
  // The guest's confirmation carries the video link, which exists once the host's calendar event is written. A Teams
  // link only comes from a Microsoft calendar that allows Teams meetings; otherwise there is none to wait for.
  const calendarLinkComing = calendarOn && r.calendar_write_pending && (r.booking_location_kind === "google_meet"
    || (r.booking_location_kind === "teams" && r.add_to_provider === "microsoft" && r.add_to_can_teams !== false));
  // A Zoom link comes from the host's own Zoom, made by a Zoom job queued only while their Zoom is connected.
  const zoomLinkComing = zoomOn && r.booking_location_kind === "zoom" && r.video_write_pending;
  const withinWait = now.getTime() - new Date(r.queued_at as Date).getTime() < MEET_LINK_WAIT_SECONDS * 1000;
  if ((kind === "booked_guest" || kind === "rescheduled_guest") && (calendarLinkComing || zoomLinkComing) && !r.join_url && withinWait) {
    return VIDEO_LINK_WAIT;
  }
  // The host's calendar event carries the Zoom link too, so its creation gets the same bounded wait.
  if (kind === "calendar_create" && zoomLinkComing && !r.join_url && withinWait) return ZOOM_LINK_WAIT;
  // Never delete or move an event while another worker may still be creating it.
  if ((kind === "calendar_delete" || kind === "calendar_move") && r.calendar_write_in_flight) return "another calendar write is running";
  if ((kind === "zoom_delete" || kind === "zoom_move") && r.video_write_in_flight) return "another Zoom write is running";
  return null;
}

/** Writes one booking change to the host's calendar. Returns the event id, or a reason to skip. */
async function runCalendarJob(pool: pg.Pool, deps: CalendarDeps, c: Claimed, r: ContextRow, baseUrl: string, now: Date): Promise<{ eventId: string } | { skip: string }> {
  const calendarRow = async (calendarId: unknown) => {
    if (typeof calendarId !== "string" || !/^[0-9a-f-]{36}$/i.test(calendarId)) return null;
    const { rows: [cal] } = await pool.query(
      `select c.external_id, c.connection_id, c.can_teams, cc.provider from calendars c join calendar_connections cc on cc.id = c.connection_id
       where c.id = $1 and c.user_id = $2 and cc.status <> 'disconnected'`, [calendarId, r.host_id]);
    return cal ? {
      externalId: cal.external_id as string, connectionId: cal.connection_id as string, providerId: cal.provider as CalendarProviderId,
      canTeams: cal.can_teams === true,
    } : null;
  };
  /** The provider for a calendar's connection, or a reason to skip when that provider isn't configured here. */
  const providerOf = (cal: { providerId: CalendarProviderId }): CalendarProvider | { skip: string } =>
    deps.providers[cal.providerId] ?? { skip: `${PROVIDER_NAMES[cal.providerId] ?? cal.providerId} calendars are not configured on this server` };
  const kind = c.kind as CalendarJobKind;
  // The event goes in the host's calendar, so it carries the host's join link (Hourhand video).
  const ctx = toContext(r, baseUrl, "host");
  const placeOf = (joinUrl: string | null) => !ctx.location || ctx.location.kind === "google_meet" || ctx.location.kind === "teams" ? null
    : joinUrl ? `${GUEST_LOCATION_LABELS[ctx.location.kind]}: ${joinUrl}`
    : ctx.location.value ? `${GUEST_LOCATION_LABELS[ctx.location.kind]}: ${ctx.location.value}` : GUEST_LOCATION_LABELS[ctx.location.kind];
  const summary = `${ctx.eventName} with ${ctx.guestName}`;

  let connectionId: string | null = null;
  try {
    if (kind === "calendar_delete") {
      const cal = await calendarRow(r.external_calendar_id);
      if (!r.external_event_id || !cal) return { skip: "no calendar event to remove" };
      connectionId = cal.connectionId;
      const provider = providerOf(cal);
      if ("skip" in provider) return provider;
      await provider.deleteEvent(await accessTokenFor(pool, deps.providers, deps.key, cal.connectionId, now), cal.externalId, r.external_event_id as string);
      return { eventId: r.external_event_id as string };
    }

    if (kind === "calendar_move" && r.previous_event_id) {
      const cal = await calendarRow(r.previous_calendar_id);
      if (cal) {
        connectionId = cal.connectionId;
        const provider = providerOf(cal);
        if ("skip" in provider) return provider;
        const token = await accessTokenFor(pool, deps.providers, deps.key, cal.connectionId, now);
        const moved = await provider.moveEvent(token, cal.externalId, r.previous_event_id as string, ctx.startAt, ctx.endAt, ctx.hostTimezone, summary);
        // A Zoom move may have given this booking a new link already; it is never replaced by the old booking's.
        await pool.query("update bookings set external_event_id = $2, external_calendar_id = $3, join_url = coalesce($4, join_url, $5), updated_at = now() where id = $1",
          [r.id, moved.id, r.previous_calendar_id, moved.joinUrl, r.previous_join_url ?? null]);
        return { eventId: moved.id };
      }
    }

    // A new booking, or a move whose old booking never got an event: create one in the chosen calendar.
    const cal = await calendarRow(c.recipient);
    if (!cal) return { skip: "no calendar to add the event to" };
    connectionId = cal.connectionId;
    const provider = providerOf(cal);
    if ("skip" in provider) return provider;
    const token = await accessTokenFor(pool, deps.providers, deps.key, cal.connectionId, now);
    const description = [
      `Booked through Hourhand by ${ctx.guestName} <${ctx.guestEmail}>, time zone ${ctx.guestTimezone}.`,
      ...ctx.answers.filter((a) => a.answer.trim()).map((a) => `${a.label}: ${a.answer}`),
      "", `Details: ${ctx.dashboardUrl}`,
    ].join("\n");
    // Only a calendar that allows Teams meetings can make one; asking any other (e.g. a personal Outlook account) can fail the whole write.
    const conference = r.booking_location_kind === "google_meet" ? "google_meet" : r.booking_location_kind === "teams" && cal.canTeams ? "teams" : null;
    // A Zoom link made since this batch was read goes in the event's location.
    const zoomUrl = ctx.location?.kind === "zoom" ? ((await pool.query("select join_url from bookings where id = $1", [r.id])).rows[0]?.join_url as string | null) ?? null : null;
    let event = await provider.insertEvent(token, cal.externalId, {
      summary, description, start: ctx.startAt, end: ctx.endAt, timeZone: ctx.hostTimezone, location: placeOf(zoomUrl ?? (ctx.location?.kind === "hourhand_video" ? ctx.joinUrl : null)),
      attendee: { email: ctx.guestEmail, name: ctx.guestName }, conference, bookingId: ctx.bookingId,
    });
    // Meet and Teams links can be created asynchronously; give the provider a moment so the guest's confirmation can carry the link.
    for (let i = 0; i < 3 && event.conferencePending; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      event = await provider.getEvent(token, cal.externalId, event.id);
    }
    await pool.query("update bookings set external_event_id = $2, external_calendar_id = $3, join_url = coalesce($4, join_url), updated_at = now() where id = $1",
      [r.id, event.id, c.recipient, event.joinUrl]);
    return { eventId: event.id };
  } catch (error) {
    // A revoked grant or missing permission disconnects the connection (and tells the host) right away.
    if (connectionId && error instanceof CalendarApiError && error.revoked) await recordConnectionFailure(pool, connectionId, error, now);
    throw error;
  }
}

const LIVE = "('confirmed', 'pending_payment')";

/**
 * Makes, moves or deletes the booking's meeting in the host's own Zoom. Returns the meeting id, or a reason to skip.
 * Seats of one group class share one meeting: the first seat's job makes it (under a per-class lock) and gives it to
 * every seat; a meeting is deleted only once no live booking uses it. A host whose Zoom is disconnected keeps the links
 * their bookings already have.
 */
async function runZoomJob(pool: pg.Pool, deps: ZoomDeps, c: Claimed, r: ContextRow, now: Date): Promise<{ eventId: string } | { skip: string }> {
  const kind = c.kind as VideoJobKind;
  const hostId = r.host_id as string;
  const bookingId = r.id as string;
  const classKey = (r.class_key as string | null) ?? null;
  const start = new Date(r.start_at as Date);
  const meeting: ZoomMeetingInput = {
    topic: classKey ? (r.event_name as string) : `${r.event_name as string} with ${r.guest_name as string}`,
    start, durationMinutes: Math.round((new Date(r.end_at as Date).getTime() - start.getTime()) / MIN), timeZone: r.host_timezone as string,
    agenda: "Booked through Hourhand.",
  };
  const connected = async () => (await pool.query(`select ${ZOOM_READY_SQL("$1::uuid")} as ok`, [hostId])).rows[0].ok as boolean;
  const inUse = async (meetingId: string) =>
    Boolean((await pool.query(`select 1 from bookings where zoom_meeting_id = $1 and host_id = $2 and status in ${LIVE} limit 1`, [meetingId, hostId])).rowCount);
  const zoom = <T>(fn: (token: string) => Promise<T>) => withZoomToken(pool, deps, hostId, now, fn);
  // Read fresh: a job that finished moments ago (a create for this booking, or a class mate's) may have just written it.
  const current = async () => (await pool.query("select zoom_meeting_id from bookings where id = $1", [bookingId])).rows[0]?.zoom_meeting_id as string | null;

  if (kind === "zoom_delete") {
    const id = await current();
    if (!id) return { skip: "no Zoom meeting to remove" };
    if (await inUse(id)) return { skip: "another booking still uses this Zoom meeting" };
    if (!(await connected())) return { skip: "Zoom is not connected; the meeting stays in the host's Zoom" };
    await zoom((t) => deps.client.deleteMeeting(t, id));
    return { eventId: id };
  }

  const already = await current();
  if (already) return { eventId: already }; // a retry after the write landed, or a class mate shared its meeting
  const isZoom = r.booking_location_kind === "zoom";
  const previousId = kind === "zoom_move" ? (r.previous_zoom_meeting_id as string | null) : null;

  // A one-to-one move keeps its meeting: same id and link, at the new time.
  if (previousId && !classKey && !r.previous_class_key) {
    if (!(await connected())) {
      if (isZoom) await pool.query("update bookings set zoom_meeting_id = $2, join_url = coalesce(join_url, $3), updated_at = now() where id = $1", [bookingId, previousId, r.previous_join_url]);
      return { skip: "Zoom is not connected; the booking keeps its link" };
    }
    if (isZoom) {
      if (await zoom((t) => deps.client.updateMeeting(t, previousId, meeting))) {
        await pool.query("update bookings set zoom_meeting_id = $2, join_url = coalesce($3, join_url), updated_at = now() where id = $1", [bookingId, previousId, r.previous_join_url]);
        return { eventId: previousId };
      }
      // The host deleted it in Zoom: make a new one below.
    }
  }
  if (!isZoom) {
    if (previousId && !(await inUse(previousId)) && (await connected())) await zoom((t) => deps.client.deleteMeeting(t, previousId));
    return { skip: "not a Zoom booking" };
  }
  if (!(await connected())) return { skip: "Zoom is not connected" };

  const id = await createOrShare(pool, deps, hostId, bookingId, classKey, meeting, zoom);
  // A class seat that moved leaves its old class's meeting to the seats still in it; the last one out deletes it.
  if (previousId && previousId !== id && !(await inUse(previousId))) {
    await zoom((t) => deps.client.deleteMeeting(t, previousId)).catch((error) => console.warn(`[jobs] old Zoom meeting not removed: ${(error as Error).message}`));
  }
  return { eventId: id };
}

/** Under a per-class (or per-booking) lock: a class mate's meeting if there is one, else a new meeting for every seat still without one. */
async function createOrShare(
  pool: pg.Pool, deps: ZoomDeps, hostId: string, bookingId: string, classKey: string | null, meeting: ZoomMeetingInput,
  zoom: <T>(fn: (token: string) => Promise<T>) => Promise<T>,
): Promise<string> {
  const lock = `zoom-meeting:${classKey ?? bookingId}`;
  const client = await pool.connect();
  let unlockError: Error | undefined;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [lock]);
    try {
      const { rows: [mine] } = await client.query("select zoom_meeting_id from bookings where id = $1", [bookingId]);
      if (mine?.zoom_meeting_id) return mine.zoom_meeting_id as string;
      if (classKey) {
        const { rows: [mate] } = await client.query(
          `select zoom_meeting_id, join_url from bookings where class_key = $1 and host_id = $2 and zoom_meeting_id is not null and status in ${LIVE} limit 1`, [classKey, hostId]);
        if (mate) {
          await client.query("update bookings set zoom_meeting_id = $2, join_url = $3, updated_at = now() where id = $1", [bookingId, mate.zoom_meeting_id, mate.join_url]);
          return mate.zoom_meeting_id as string;
        }
      }
      const made = await zoom((t) => deps.client.createMeeting(t, meeting));
      await client.query(
        `update bookings set zoom_meeting_id = $2, join_url = $3, updated_at = now()
         where (id = $1 or ($4::text is not null and class_key = $4 and host_id = $5 and status in ${LIVE})) and zoom_meeting_id is null`,
        [bookingId, made.id, made.joinUrl, classKey, hostId]);
      return made.id;
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [lock]).catch((e: Error) => { unlockError = e; });
    }
  } finally {
    client.release(unlockError);
  }
}

/** The host's one email about a Zoom connection that stopped working; skipped once they've reconnected or removed it. */
async function renderZoomAlertMail(pool: pg.Pool, c: Claimed, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  const id = /^zoom:([0-9a-f-]{36}):alert:/.exec(c.dedupe_key)?.[1];
  const { rows: [z] } = id ? await pool.query("select account_email, status, last_error from integrations where id = $1", [id]) : { rows: [] };
  if (!z) return { skip: "Zoom connection removed" };
  if (z.status === "ok") return { skip: "Zoom reconnected" };
  return renderZoomAlert({ accountEmail: z.account_email ?? "your Zoom account", lastError: z.last_error, integrationsUrl: `${baseUrl}/dashboard/integrations` });
}

async function renderAlert(pool: pg.Pool, c: Claimed, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  const connectionId = /^calendar:([0-9a-f-]{36}):alert:/.exec(c.dedupe_key)?.[1];
  const { rows: [conn] } = connectionId
    ? await pool.query("select account_email, status, last_error from calendar_connections where id = $1", [connectionId])
    : { rows: [] };
  if (!conn) return { skip: "calendar connection removed" };
  if (conn.status === "ok") return { skip: "calendar connection recovered" };
  return renderCalendarAlert({ accountEmail: conn.account_email, disconnected: conn.status === "disconnected", lastError: conn.last_error, calendarsUrl: `${baseUrl}/dashboard/calendars` });
}

/** The renewal reminder goes only if that same period is still about to renew: not after a cancel, pause or renewal. */
async function renderRenewal(pool: pg.Pool, c: Claimed, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  const m = /^renewal:([^:]+):(\d+)$/.exec(c.dedupe_key);
  const { rows: [s] } = await pool.query(
    `select s.plan, s.interval, s.provider, s.provider_subscription_id, s.status, s.current_period_end, s.cancel_at_period_end, u.timezone
       from subscriptions s join users u on u.id = s.user_id where s.user_id = $1`,
    [c.user_id]);
  if (!m || !s || s.provider_subscription_id !== m[1]) return { skip: "subscription changed" };
  if (s.status !== "active" || s.cancel_at_period_end) return { skip: "subscription no longer renewing" };
  if (!s.current_period_end || s.current_period_end.getTime() !== Number(m[2])) return { skip: "period already renewed" };
  if (!(s.plan in PRICES)) return { skip: "not a paid plan" };
  return renderRenewalReminder({
    planName: PLAN_NAMES[s.plan as PaidPlan], price: priceLine(s.plan as PaidPlan, s.interval as BillingInterval, s.provider === "stripe" ? "USD" : "INR"),
    renewsOn: s.current_period_end, timezone: s.timezone, planUrl: `${baseUrl}/dashboard/plan`,
  });
}

async function renderEarnings(pool: pg.Pool, c: Claimed, baseUrl: string, now: Date): Promise<RenderedMail | { skip: string }> {
  const m = /^earnings:[0-9a-f-]{36}:(\d{4}-\d{2})$/.exec(c.dedupe_key);
  const e = m ? await monthlyEarnings(pool, c.user_id, m[1], now, priceCurrency(await paymentAccount(pool, c.user_id))) : null;
  if (!e) return { skip: "no report" };
  const monthLabel = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${e.month}-01T00:00:00Z`));
  return renderEarningsMail({ currency: e.currency, monthLabel, netMinor: e.netMinor, bookingsMinor: e.bookingsMinor, packagesMinor: e.packagesMinor, refundsMinor: e.refundsMinor,
    sessionsHeld: e.sessions.held, noShows: e.sessions.noShows, url: `${baseUrl}/dashboard/earnings?month=${e.month}` });
}

/** A Duo owner's invitation to their second person; skipped if it was withdrawn, moved to someone else, or accepted. */
async function renderSeatInvite(pool: pg.Pool, c: Claimed, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  const { rows: [s] } = await pool.query(
    `select u.name, u.email from seats s join users u on u.id = s.owner_id
     where s.owner_id = $1 and s.member_email = $2 and s.accepted_at is null and u.deleted_at is null`, [c.user_id, c.recipient]);
  if (!s) return { skip: "invitation withdrawn or already accepted" };
  return renderSeatInviteMail({ ownerName: s.name, ownerEmail: s.email, url: `${baseUrl}/sign-in` });
}

/** A client's data request, to their host. Skipped once the host has dealt with it. */
async function renderDataRequest(pool: pg.Pool, c: Claimed, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  const m = /^data_request:([0-9a-f-]{36})$/.exec(c.dedupe_key);
  const r = m ? await requestForEmail(pool, m[1]) : null;
  if (!r) return { skip: "request already dealt with" };
  const { rows: [u] } = await pool.query("select timezone from users where id = $1", [c.user_id]);
  return renderDataRequestMail({ kind: r.kind, dueAt: r.dueAt, timezone: u?.timezone ?? "Asia/Kolkata", url: `${baseUrl}/dashboard/clients/requests` });
}

const isPollKind = (kind: NotificationKind) => kind === "poll_voter_link" || kind === "poll_host_closed";

/** A meeting poll email: an invitee's change link (signed when it is sent), or the host's nudge to pick a time. */
async function renderPoll(pool: pg.Pool, c: Claimed, baseUrl: string, now: Date): Promise<RenderedMail | { skip: string }> {
  const d = await pollMailData(pool, c.kind, c.dedupe_key, baseUrl, now);
  if ("skip" in d) return d;
  return d.kind === "poll_voter_link" ? renderPollVoterMail(d) : renderPollClosedMail(d);
}

/** A time opened on a day the guest waited for. The booking is the cancelled one; its start is the freed time. */
async function renderWaitlist(pool: pg.Pool, c: Claimed, baseUrl: string, now: Date): Promise<RenderedMail | { skip: string }> {
  const m = /^waitlist:([0-9a-f-]{36})$/.exec(c.dedupe_key);
  if (!m) return { skip: "not a waitlist email" };
  const { rows: [w] } = await pool.query(
    `select w.name, w.timezone, b.start_at, e.name as event_name, e.slug as event_slug, e.active, u.name as host_name, u.slug as host_slug, u.deleted_at
     from waitlist w join bookings b on b.id = $2 join event_types e on e.id = w.event_type_id join users u on u.id = w.host_id where w.id = $1`, [m[1], c.booking_id]);
  if (!w) return { skip: "waitlist entry gone" };
  if (new Date(w.start_at).getTime() <= now.getTime()) return { skip: "the time has passed" };
  if (!w.active || w.deleted_at || !w.host_slug) return { skip: "event no longer bookable" };
  const start = new Date(w.start_at);
  return renderWaitlistMail({ guestName: w.name, hostName: w.host_name, eventName: w.event_name, start, timezone: w.timezone,
    url: `${baseUrl}/${w.host_slug}/${w.event_slug}?at=${encodeURIComponent(start.toISOString())}` });
}

async function renderInvoice(pool: pg.Pool, c: Claimed, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  const m = /^invoice:([0-9a-f-]{36})$/.exec(c.dedupe_key);
  const v = m ? await invoiceById(pool, m[1]) : null;
  if (!v) return { skip: "invoice not found" };
  const { rows: [u] } = await pool.query("select email from users where id = $1", [v.hostId]);
  return renderInvoiceMail({ kind: v.kind, number: v.number, supplierName: v.supplier.legalName, supplierEmail: u?.email ?? "", totalMinor: v.totalMinor,
    description: v.description, url: `${baseUrl}/invoice/${v.token}`, originalNumber: v.originalNumber });
}

async function renderPackage(pool: pg.Pool, c: Claimed, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  const m = /^purchase:([0-9a-f-]{36}):package_(guest|host)$/.exec(c.dedupe_key);
  if (!m) return { skip: "not a package email" };
  const { rows: [p] } = await pool.query(
    `select p.guest_name, p.guest_email, p.sessions, p.price_minor, p.currency, p.provider, p.expires_at, p.token, p.status, k.name as package_name, e.name as event_name,
       u.name as host_name, u.email as host_email, u.timezone
     from package_purchases p join packages k on k.id = p.package_id join event_types e on e.id = p.event_type_id join users u on u.id = p.host_id
     where p.id = $1`, [m[1]]);
  if (!p || p.status !== "paid") return { skip: "package not paid" };
  return renderPackageMail(c.kind as "package_guest" | "package_host", {
    hostName: p.host_name, hostEmail: p.host_email, guestName: p.guest_name, guestEmail: p.guest_email, packageName: p.package_name, eventName: p.event_name,
    sessions: p.sessions, priceMinor: p.price_minor, currency: p.currency, provider: p.provider, expiresAt: p.expires_at, timezone: p.timezone,
    buyerUrl: `${baseUrl}/p/${p.token}`, dashboardUrl: `${baseUrl}/dashboard/packages`,
  });
}

/** The follow-up links' signing key, or null when TOKEN_ENCRYPTION_KEY isn't set (follow-ups are then skipped, saying why). */
function followUpLinkKey(): Buffer | null {
  try { return linkKey(); } catch { return null; }
}

export async function processDueNotifications(
  pool: pg.Pool, mailer: Mailer, opts: { baseUrl: string; now?: Date; limit?: number; calendar?: CalendarDeps | null; zoom?: ZoomDeps | null; whatsapp?: WhatsAppConfig | null; sms?: SmsConfig | null; fetch?: typeof fetch },
): Promise<WorkerResult> {
  const now = opts.now ?? new Date();
  const claimed = await claimDue(pool, now, opts.limit ?? BATCH_SIZE);
  const result: WorkerResult = { claimed: claimed.length, sent: 0, skipped: 0, retrying: 0, failed: 0, deferred: 0, released: 0 };
  if (claimed.length === 0) return result;

  const { rows } = await pool.query(CONTEXT, [claimed.map((c) => c.id), now]);
  const contexts = new Map(rows.map((r) => [r.notification_id as string, r as ContextRow]));

  // Every write checks the lease, so a worker whose lease ran out can't overwrite the next worker's result.
  const finish = (c: Claimed, status: "sent" | "skipped" | "failed", fields: { providerId?: string; error?: string }) =>
    pool.query(
      `update notifications set status = $3, provider_message_id = coalesce($4, provider_message_id), last_error = $5,
         sent_at = case when $3 = 'sent' then $6::timestamptz else sent_at end, locked_until = null, updated_at = $6
       where id = $1 and locked_until = $2`,
      [c.id, c.locked_until, status, fields.providerId ?? null, fields.error ?? null, now]);
  const skip = async (c: Claimed, reason: string) => {
    await finish(c, "skipped", { error: reason });
    result.skipped++;
  };
  // Once a calendar or Zoom write has run, whatever the outcome, a guest confirmation waiting for its video link goes at
  // once: with the link if the write worked, without it if not. It never waits on a service that may take hours to
  // recover. A Zoom write also wakes the calendar event waiting to carry its link, and every seat of a class it served.
  const release = async (c: Claimed) => {
    const zoomJob = c.kind === "zoom_create" || c.kind === "zoom_move";
    if (c.kind !== "calendar_create" && c.kind !== "calendar_move" && !zoomJob) return;
    const woken = await pool.query(
      `update notifications set send_at = $2, last_error = null where status = 'queued' and send_at > $2 and kind = any($3::text[])
         and (booking_id = $1 or booking_id in (select m.id from bookings m join bookings s on s.id = $1 where s.class_key is not null and m.class_key = s.class_key))`,
      [c.booking_id, now, zoomJob ? ["booked_guest", "rescheduled_guest", "calendar_create"] : ["booked_guest", "rescheduled_guest"]]);
    result.released += woken.rowCount ?? 0;
  };

  for (const c of claimed) {
    const r = contexts.get(c.id)!;
    if (c.attempts > MAX_ATTEMPTS) {
      await finish(c, "failed", { error: `gave up after ${MAX_ATTEMPTS} attempts (the worker stopped during the last one)` });
      result.failed++;
      continue;
    }
    // Host emails about their account rather than a booking.
    const isAccountMail = c.kind === "calendar_alert_host" || c.kind === "zoom_alert_host" || c.kind === "renewal_reminder_host" || c.kind === "package_guest" || c.kind === "package_host" || c.kind === "invoice_guest" || c.kind === "earnings_host" || c.kind === "waitlist_guest" || c.kind === "seat_invite" || isPollKind(c.kind) || c.kind === "data_request_host" || c.kind === "membership_guest" || c.kind === "membership_host";
    if (!isAccountMail) {
      if (!r?.id) { await skip(c, "booking no longer exists"); continue; }
      const why = skipReason(c.kind, r, now);
      if (why) { await skip(c, why); continue; }
      // WhatsApp and SMS templates carry no video link, so they never wait for one.
      let wait = c.channel === "whatsapp" || c.channel === "sms" ? null : deferReason(c.kind, r, now, Boolean(opts.calendar), Boolean(opts.zoom));
      if (wait === VIDEO_LINK_WAIT || wait === ZOOM_LINK_WAIT) {
        // The calendar or Zoom write may have finished earlier in this same batch: look again before waiting.
        const { rows: [fresh] } = await pool.query(
          `select coalesce(b.join_url, (select m.join_url from bookings m where b.class_key is not null and m.class_key = b.class_key and m.join_url is not null limit 1)) as join_url,
             exists (select 1 from notifications cj where (cj.booking_id = b.id or cj.booking_id in (select m.id from bookings m where b.class_key is not null and m.class_key = b.class_key))
               and cj.channel = 'calendar' and cj.kind <> 'calendar_delete' and cj.status = 'queued' and (cj.attempts = 0 or cj.locked_until > $2)) as pending,
             exists (select 1 from notifications vj where vj.booking_id = b.id and vj.channel = 'video'
             and vj.kind <> 'zoom_delete' and vj.status = 'queued' and (vj.attempts = 0 or vj.locked_until > $2)) as video_pending
           from bookings b where b.id = $1`, [r.id, now]);
        r.join_url = fresh.join_url;
        r.calendar_write_pending = fresh.pending;
        r.video_write_pending = fresh.video_pending;
        wait = deferReason(c.kind, r, now, Boolean(opts.calendar), Boolean(opts.zoom));
      }
      if (wait) {
        // Not an attempt: hand the row back for a little later.
        await pool.query("update notifications set send_at = $3, attempts = attempts - 1, locked_until = null, last_error = $4 where id = $1 and locked_until = $2",
          [c.id, c.locked_until, new Date(now.getTime() + DEFER_SECONDS * 1000), wait]);
        result.deferred++;
        continue;
      }
    }
    if (c.channel === "whatsapp") {
      const why = await whatsappSkipReason(pool, c, opts.whatsapp ?? null, now);
      if (why) { await skip(c, why); await queueSmsFallback(pool, c.id, now, Boolean(opts.sms)); continue; }
    }
    if (c.channel === "sms") {
      const why = await smsSkipReason(pool, c, opts.sms ?? null, now);
      if (why) { await skip(c, why); continue; }
    }
    if (isCalendarJob(c.kind) && !opts.calendar) { await skip(c, `${new Intl.ListFormat("en").format(Object.values(PROVIDER_NAMES))} calendars are not configured on this server`); await release(c); continue; }
    if (isVideoJob(c.kind) && !opts.zoom) { await skip(c, "Zoom is not configured on this server"); await release(c); continue; }

    // Renew the lease for this row only, right before running it. If another worker took the row over, leave it to them.
    const renewed = await pool.query(
      "update notifications set locked_until = $3 where id = $1 and locked_until = $2 returning locked_until",
      [c.id, c.locked_until, new Date(Math.max(now.getTime(), Date.now()) + LEASE_MINUTES * MIN)]);
    if (!renewed.rowCount) continue;
    c.locked_until = renewed.rows[0].locked_until as Date;

    let providerId: string;
    try {
      if (c.channel === "whatsapp") {
        const message = templateMessage(c.kind as Parameters<typeof templateMessage>[0], {
          guestName: r.guest_name as string, hostName: r.host_name as string, eventName: r.event_name as string, startAt: new Date(r.start_at as Date),
          guestTimezone: r.guest_timezone as string, locale: (r.guest_locale as string | null) ?? "en", manageToken: r.manage_token as string,
        }, c.recipient);
        ({ id: providerId } = await sendWhatsApp(opts.whatsapp!, message, opts.fetch));
      } else if (isVideoJob(c.kind)) {
        const out = await runZoomJob(pool, opts.zoom!, c, r, now);
        if ("skip" in out) { await skip(c, out.skip); await release(c); continue; }
        providerId = out.eventId;
      } else if (c.channel === "sms") {
        providerId = await sendBookingSms(pool, opts.sms!, c, {
          guestName: r.guest_name as string, hostName: r.host_name as string, eventName: r.event_name as string, startAt: new Date(r.start_at as Date),
          guestTimezone: r.guest_timezone as string, locale: (r.guest_locale as string | null) ?? "en",
        }, opts.baseUrl, opts.fetch);
      } else if (isCalendarJob(c.kind)) {
        const out = await runCalendarJob(pool, opts.calendar!, c, r, opts.baseUrl, now);
        if ("skip" in out) { await skip(c, out.skip); await release(c); continue; }
        providerId = out.eventId;
      } else {
        const mail = c.kind === "calendar_alert_host" ? await renderAlert(pool, c, opts.baseUrl)
          : c.kind === "zoom_alert_host" ? await renderZoomAlertMail(pool, c, opts.baseUrl)
          : c.kind === "renewal_reminder_host" ? await renderRenewal(pool, c, opts.baseUrl)
          : c.kind === "package_guest" || c.kind === "package_host" ? await renderPackage(pool, c, opts.baseUrl)
          : c.kind === "invoice_guest" ? await renderInvoice(pool, c, opts.baseUrl)
          : c.kind === "earnings_host" ? await renderEarnings(pool, c, opts.baseUrl, now)
          : c.kind === "waitlist_guest" ? await renderWaitlist(pool, c, opts.baseUrl, now)
          : c.kind === "seat_invite" ? await renderSeatInvite(pool, c, opts.baseUrl)
          : c.kind === "data_request_host" ? await renderDataRequest(pool, c, opts.baseUrl)
          : c.kind === FOLLOW_UP_KIND ? await buildFollowUp(pool, c, opts.baseUrl, now, followUpLinkKey())
          : isPollKind(c.kind) ? await renderPoll(pool, c, opts.baseUrl, now)
          : c.kind === "membership_guest" || c.kind === "membership_host" ? await renderMembership(pool, c, opts.baseUrl, now)
          : renderBookingMail(c.kind as BookingEmailKind, {
            ...toContext(r, opts.baseUrl, c.kind.endsWith("_host") ? "host" : extraGuestMail(c, r) ? "extra_guest" : "guest"),
            extraGuest: extraGuestMail(c, r),
            // An extra guest on Hourhand video gets a join link of their own (never the guest's manage token).
            ...(extraGuestMail(c, r) && r.booking_location_kind === "hourhand_video" && c.kind !== "cancelled_guest"
              ? { joinUrl: extraGuestVideoJoinUrl(opts.baseUrl, await pgExtraGuestLinks(pool).linkFor(r.id as string, r.host_id as string, c.recipient)) } : {}),
            ...(c.kind === "cancelled_guest" ? { rebook: await rebookSuggestions(pool, r, opts.baseUrl) } : {}),
            ...((c.kind === "booked_guest" || c.kind === "booked_host") && r.series_id === r.id ? { series: await seriesWeeks(pool, r.id as string, opts.baseUrl) } : {}),
            ...((c.kind === "cancelled_guest" || c.kind === "cancelled_host") && r.series_id ? { alsoCancelled: await cancelledWith(pool, r.id as string) } : {}),
          });
        if ("skip" in mail) { await skip(c, mail.skip); continue; }
        ({ id: providerId } = await mailer.send({ ...mail, to: c.recipient, idempotencyKey: `notification-${c.id}` }));
      }
    } catch (error) {
      const retryable = error instanceof MailError || error instanceof CalendarApiError || error instanceof WhatsAppError || error instanceof SmsError || error instanceof ZoomApiError ? error.retryable : true;
      const message = (error as Error).message.slice(0, 500);
      if (!retryable || c.attempts >= MAX_ATTEMPTS) {
        await finish(c, "failed", { error: message });
        result.failed++;
        if (c.channel === "whatsapp") await queueSmsFallback(pool, c.id, now, Boolean(opts.sms));
        console.error(`[jobs] notification ${c.id} (${c.kind}) failed for good: ${message}`);
      } else {
        const delay = RETRY_DELAYS_MINUTES[Math.min(c.attempts, RETRY_DELAYS_MINUTES.length) - 1];
        await pool.query(
          "update notifications set send_at = $3, last_error = $4, locked_until = null, updated_at = $5 where id = $1 and locked_until = $2",
          [c.id, c.locked_until, new Date(now.getTime() + delay * MIN), message, now]);
        result.retrying++;
        console.warn(`[jobs] notification ${c.id} (${c.kind}) attempt ${c.attempts} failed, retrying in ${delay} min: ${message}`);
      }
      await release(c);
      continue;
    }
    // Recorded outside the try: a database error here must not be mistaken for a failed send and retried.
    await finish(c, "sent", { providerId });
    result.sent++;
    await release(c);
  }
  return result;
}
