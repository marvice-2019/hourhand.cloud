import type pg from "pg";
import { NotFoundError } from "../data/types";
import { formatDate } from "../format";
import { isLocale, type Locale } from "../i18n/guest";
import { ft } from "../i18n/follow-up";
import { listUnsubscribeHeaders } from "../mail/mailer";
import { escapeHtml, type RenderedMail } from "../mail/templates";
import { feedbackToken, optOutToken, readFeedbackToken, readOptOutToken, readRebookToken, rebookToken } from "./tokens";

// 2.6 Follow-ups: one email to the guest a while after their session ends, helping the host get rebooked and reviewed.
// Per event type the host switches on any of: a thank-you with a one-tap rebook link, a private 1–5 feedback form, a
// Google review ask, and a package top-up nudge. All off by default (no settings row), so nothing changes for existing
// event types. Queued through the notifications outbox when a booking is made (dedupe key booking:<id>:follow_up_guest,
// so at most one per booking; each group class seat is its own booking) and checked again when it sends: never for a
// cancelled booking, a no-show, a guest who opted out of this host's follow-ups, or once all follow-ups are switched off.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const FOLLOW_UP_KIND = "follow_up_guest" as const;
export const DELAY_CHOICES = [1, 2, 24] as const;
export type DelayHours = (typeof DELAY_CHOICES)[number];
export const DEFAULT_DELAY_HOURS: DelayHours = 2;
/** A follow-up that couldn't go for this long after the session (worker down, retries) is dropped rather than sent late. */
export const STALE_AFTER_DAYS = 7;
export const COMMENT_MAX = 2000;
const SWITCHED_OFF = "follow-ups switched off";

export const followUpKey = (bookingId: string) => `booking:${bookingId}:${FOLLOW_UP_KIND}`;

export interface FollowUpSettings { thankYou: boolean; feedback: boolean; reviewAsk: boolean; packageNudge: boolean; delayHours: DelayHours }
export const FOLLOW_UPS_OFF: FollowUpSettings = { thankYou: false, feedback: false, reviewAsk: false, packageNudge: false, delayHours: DEFAULT_DELAY_HOURS };
export const anyOn = (s: FollowUpSettings) => s.thankYou || s.feedback || s.reviewAsk || s.packageNudge;

/** The editor's checkboxes and delay picker. A missing box is off; any delay other than 1, 2 or 24 hours is refused. */
export function validateFollowUpForm(form: Record<string, string | undefined>): { ok: true; value: FollowUpSettings } | { ok: false; error: string } {
  const delay = Number(form.delayHours ?? DEFAULT_DELAY_HOURS);
  if (!(DELAY_CHOICES as readonly number[]).includes(delay)) return { ok: false, error: "Pick 1, 2 or 24 hours after the session." };
  const on = (k: string) => form[k] === "on" || form[k] === "1" || form[k] === "true";
  return { ok: true, value: { thankYou: on("thankYou"), feedback: on("feedback"), reviewAsk: on("reviewAsk"), packageNudge: on("packageNudge"), delayHours: delay as DelayHours } };
}

const toSettings = (r: Record<string, unknown> | undefined): FollowUpSettings => r && r.delay_hours != null
  ? { thankYou: r.thank_you === true, feedback: r.feedback === true, reviewAsk: r.review_ask === true, packageNudge: r.package_nudge === true, delayHours: r.delay_hours as DelayHours }
  : FOLLOW_UPS_OFF;

export async function getFollowUpSettings(db: Db, hostId: string, eventTypeId: string): Promise<FollowUpSettings> {
  if (!UUID.test(hostId) || !UUID.test(eventTypeId)) return FOLLOW_UPS_OFF;
  const { rows: [r] } = await db.query(
    "select thank_you, feedback, review_ask, package_nudge, delay_hours from follow_up_settings where event_type_id = $1 and user_id = $2", [eventTypeId, hostId]);
  return toSettings(r);
}

/**
 * Saves one event type's follow-ups and brings the queue in line: switched on, every upcoming confirmed booking of the
 * type gets its follow-up (so turning it on doesn't only apply to bookings made from now on) at the chosen delay;
 * switched off, queued ones are skipped (and come back if it is switched on again before they're due).
 */
export async function saveFollowUpSettings(db: Db, hostId: string, eventTypeId: string, s: FollowUpSettings, now: Date): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(eventTypeId)) throw new NotFoundError("Event type");
  const { rowCount } = await db.query(
    `insert into follow_up_settings (event_type_id, user_id, thank_you, feedback, review_ask, package_nudge, delay_hours, updated_at)
     select e.id, e.user_id, $3, $4, $5, $6, $7, $8 from event_types e where e.id = $1 and e.user_id = $2
     on conflict (event_type_id) do update set thank_you = $3, feedback = $4, review_ask = $5, package_nudge = $6, delay_hours = $7, updated_at = $8`,
    [eventTypeId, hostId, s.thankYou, s.feedback, s.reviewAsk, s.packageNudge, s.delayHours, now]);
  if (!rowCount) throw new NotFoundError("Event type");
  if (!anyOn(s)) {
    await db.query(
      `update notifications n set status = 'skipped', last_error = $3, updated_at = $2 from bookings b
       where n.booking_id = b.id and b.event_type_id = $1 and n.kind = '${FOLLOW_UP_KIND}' and n.status = 'queued' and (n.locked_until is null or n.locked_until < $2)`,
      [eventTypeId, now, SWITCHED_OFF]);
    return;
  }
  // Back on before they were due: the ones switched off return to the queue.
  await db.query(
    `update notifications n set status = 'queued', last_error = null, attempts = 0, updated_at = $2 from bookings b
     where n.booking_id = b.id and b.event_type_id = $1 and n.kind = '${FOLLOW_UP_KIND}' and n.status = 'skipped' and n.last_error = $3 and b.end_at > $2`,
    [eventTypeId, now, SWITCHED_OFF]);
  await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     select b.id, b.host_id, 'email', '${FOLLOW_UP_KIND}', i.email, b.end_at + make_interval(hours => $3), 'booking:' || b.id || ':${FOLLOW_UP_KIND}'
     from bookings b join invitees i on i.booking_id = b.id
     where b.event_type_id = $1 and b.host_id = $2 and b.status in ('confirmed', 'pending_payment') and b.end_at > $4
     on conflict (dedupe_key) do nothing`,
    [eventTypeId, hostId, s.delayHours, now]);
  // A changed delay moves the ones still waiting.
  await db.query(
    `update notifications n set send_at = b.end_at + make_interval(hours => $2), updated_at = $3 from bookings b
     where n.booking_id = b.id and b.event_type_id = $1 and n.kind = '${FOLLOW_UP_KIND}' and n.status = 'queued' and (n.locked_until is null or n.locked_until < $3)`,
    [eventTypeId, s.delayHours, now]);
}

/**
 * Inside the booking's own transaction (called from queueBookingNotifications): queues the guest's follow-up for the
 * session's end plus the chosen delay, if any follow-up is on for its event type. A seat in a group class is its own
 * booking, so every seat gets its own. Extra guests the booker added don't get one.
 */
export async function queueFollowUp(db: Pick<pg.PoolClient, "query">, bookingId: string): Promise<void> {
  await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     select b.id, b.host_id, 'email', '${FOLLOW_UP_KIND}', i.email, b.end_at + make_interval(hours => s.delay_hours), $2
     from bookings b join invitees i on i.booking_id = b.id join follow_up_settings s on s.event_type_id = b.event_type_id
     where b.id = $1 and (s.thank_you or s.feedback or s.review_ask or s.package_nudge)
     on conflict (dedupe_key) do nothing`,
    [bookingId, followUpKey(bookingId)]);
}

// ---- Rebooking ----------------------------------------------------------------------------------------------------

/**
 * The one-tap link to book the same event type again: the booking page with a signed rebook token (and the guest's
 * language), never their name or email in the address.
 */
export function rebookUrl(baseUrl: string, key: Buffer, hostSlug: string, eventSlug: string, bookingId: string, locale: Locale, now: Date): string {
  const q = new URLSearchParams({ rebook: rebookToken(key, bookingId, now), ...(locale === "en" ? {} : { lang: locale }) });
  return `${baseUrl}/${hostSlug}/${eventSlug}?${q}`;
}

/**
 * What a rebook link fills the booking form with: the guest's name and email from the booking it was made for. Only on
 * that booking's host's own pages, so a link can't be replayed on another host's page to read someone's details.
 */
export async function rebookPrefill(db: Db, key: Buffer, token: unknown, hostId: string, now: Date): Promise<{ name: string; email: string } | null> {
  const bookingId = readRebookToken(key, token, now);
  if (!bookingId || !UUID.test(hostId)) return null;
  const { rows: [r] } = await db.query(
    "select i.name, i.email from bookings b join invitees i on i.booking_id = b.id where b.id = $1 and b.host_id = $2", [bookingId, hostId]);
  return r ? { name: String(r.name).slice(0, 100), email: String(r.email).slice(0, 254) } : null;
}

// ---- What to send ----------------------------------------------------------------------------------------------

export type PackageNudge = { kind: "one_left" | "used_up"; packageName: string; bookUrl: string | null; buyUrl: string | null };

/** 1 session left (not yet expired): book the last one, or buy again. None left: buy again. Otherwise nothing. */
export function packageNudgeKind(p: { sessions: number; used: number; expiresAt: Date | null }, now: Date): "one_left" | "used_up" | null {
  const left = p.sessions - p.used;
  if (left <= 0) return "used_up";
  if (left === 1 && (!p.expiresAt || p.expiresAt.getTime() > now.getTime())) return "one_left";
  return null;
}

/**
 * The review link's wording after feedback. It is offered to everyone who leaves feedback, whatever the rating: Google
 * forbids "selectively soliciting positive reviews" (Maps user-generated content policy). Only the tone changes.
 */
export const reviewWording = (rating: number): "reviewHigh" | "reviewLow" => (rating >= 4 ? "reviewHigh" : "reviewLow");

export interface FollowUpFacts {
  status: string;
  noShow: boolean;
  optedOut: boolean;
  hostClosed: boolean;
  endAt: Date;
  settings: FollowUpSettings;
  answered: boolean;
  reviewsUrl: string | null;
  rebookUrl: string | null;
  nudge: PackageNudge | null;
}

export interface FollowUpPlan { thankYou: boolean; rebookUrl: string | null; feedback: boolean; review: string | null; nudge: PackageNudge | null }

/** Why the follow-up shouldn't go now, or what goes in it. */
export function planFollowUp(f: FollowUpFacts, now: Date): { skip: string } | FollowUpPlan {
  if (f.status !== "confirmed") return { skip: "booking cancelled" };
  if (f.noShow) return { skip: "guest marked as a no-show" };
  if (f.hostClosed) return { skip: "host account closed" };
  if (!anyOn(f.settings)) return { skip: SWITCHED_OFF };
  if (f.optedOut) return { skip: "guest opted out of this host's follow-ups" };
  if (f.endAt.getTime() > now.getTime()) return { skip: "session not over yet" };
  if (now.getTime() - f.endAt.getTime() > STALE_AFTER_DAYS * DAY) return { skip: "too late for a follow-up" };
  const s = f.settings;
  const plan: FollowUpPlan = {
    thankYou: s.thankYou,
    rebookUrl: s.thankYou ? f.rebookUrl : null,
    feedback: s.feedback && !f.answered,
    // With the feedback form on, the review link comes after the guest answers (to everyone who does). Without it, the
    // email offers it to every guest.
    review: s.reviewAsk && !s.feedback ? f.reviewsUrl : null,
    nudge: s.packageNudge ? f.nudge : null,
  };
  if (!plan.thankYou && !plan.feedback && !plan.review && !plan.nudge) return { skip: "nothing to send" };
  return plan;
}

export interface FollowUpMailContext {
  locale: Locale;
  guestName: string;
  hostName: string;
  hostEmail: string;
  eventName: string;
  /** `/b/feedback/<token>`; each rating button adds ?r=N (opens the form with it picked; nothing is saved on open). */
  feedbackUrl: string;
  optOutUrl: string;
  /** The RFC 8058 one-click endpoint (POST /api/follow-ups/stop/<token>) for the List-Unsubscribe header. https only. */
  oneClickUrl: string;
}

const button = (label: string, url: string, solid: boolean) =>
  `<a href="${escapeHtml(url)}" style="${solid ? "background:#16181d;color:#ffffff;" : "border:1px solid #16181d;color:#16181d;"}padding:9px 14px;border-radius:6px;text-decoration:none;display:inline-block;margin:0 6px 8px 0">${escapeHtml(label)}</a>`;

/** The email: thank-you, rating buttons, review link, package nudge and rebook link, as switched on. Text and HTML match. */
export function renderFollowUpMail(c: FollowUpMailContext, plan: FollowUpPlan): RenderedMail {
  const l = c.locale;
  const v = { guest: c.guestName, host: c.hostName, event: c.eventName };
  const text: string[] = [ft(l, "heading", v), "", ft(l, "intro", v)];
  const html: string[] = [
    `<h1 style="margin:0 0 12px;font-size:20px;color:#16181d">${escapeHtml(ft(l, "heading", v))}</h1>`,
    `<p style="margin:0 0 16px;color:#16181d">${escapeHtml(ft(l, "intro", v))}</p>`,
  ];
  if (plan.feedback) {
    const rate = (n: number) => `${c.feedbackUrl}?r=${n}`;
    text.push("", ft(l, "feedbackHeading"), ...[1, 2, 3, 4, 5].map((n) => `${n}: ${rate(n)}`), ft(l, "feedbackNote", v));
    html.push(`<p style="margin:24px 0 8px;font-weight:600;color:#16181d">${escapeHtml(ft(l, "feedbackHeading"))}</p>`,
      `<p style="margin:0">${[1, 2, 3, 4, 5].map((n) => button(String(n), rate(n), false)).join("")}</p>`,
      `<p style="margin:4px 0 16px;color:#5b6170;font-size:14px">${escapeHtml(ft(l, "feedbackNote", v))}</p>`);
  }
  if (plan.review) {
    text.push("", ft(l, "reviewEmail", v), `${ft(l, "reviewLink")}: ${plan.review}`);
    html.push(`<p style="margin:16px 0 8px;color:#16181d">${escapeHtml(ft(l, "reviewEmail", v))}</p>`, `<p style="margin:0">${button(ft(l, "reviewLink"), plan.review, false)}</p>`);
  }
  if (plan.nudge) {
    const n = plan.nudge;
    const line = ft(l, n.kind === "one_left" ? "packageOneLeft" : "packageUsedUp", { package: n.packageName });
    const links = [
      ...(n.kind === "one_left" && n.bookUrl ? [[ft(l, "packageBookLast"), n.bookUrl]] : []),
      ...(n.buyUrl ? [[ft(l, "packageBuyAgain", { package: n.packageName }), n.buyUrl]] : []),
    ];
    text.push("", line, ...links.map(([label, url]) => `${label}: ${url}`));
    html.push(`<p style="margin:16px 0 8px;color:#16181d">${escapeHtml(line)}</p>`, `<p style="margin:0">${links.map(([label, url], i) => button(label, url, i === 0)).join("")}</p>`);
  }
  if (plan.rebookUrl) {
    text.push("", `${ft(l, "rebookLink", v)}: ${plan.rebookUrl}`);
    html.push(`<p style="margin:24px 0">${button(ft(l, "rebookLink", v), plan.rebookUrl, true)}</p>`);
  }
  text.push("", "—", ft(l, "footer", v), `${ft(l, "optOutText", v)} ${ft(l, "optOutLink")}: ${c.optOutUrl}`);
  html.push(`<p style="margin:28px 0 0;font-size:13px;color:#8a8f9c">${escapeHtml(ft(l, "footer", v))}<br>${escapeHtml(ft(l, "optOutText", v))} <a href="${escapeHtml(c.optOutUrl)}" style="color:#8a8f9c">${escapeHtml(ft(l, "optOutLink"))}</a></p>`);
  return {
    subject: ft(l, "subject", v).replace(/[\r\n]+/g, " ").trim(),
    text: text.join("\n"),
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px">${html.join("\n")}</div></body></html>`,
    replyTo: c.hostEmail,
    // The mail client's own "Unsubscribe" button: one POST, no page. Mail clients ignore a non-https one, so none is sent then.
    ...(c.oneClickUrl.startsWith("https://") ? { headers: listUnsubscribeHeaders(c.oneClickUrl) } : {}),
  };
}

/**
 * The worker's renderer for a claimed follow_up_guest row: reads the booking, settings, opt-out and package as they are
 * now, and returns the email or why it is skipped. `key` is the link-signing key (null: links can't be signed here).
 */
export async function buildFollowUp(db: Db, n: { booking_id: string | null; recipient: string }, baseUrl: string, now: Date, key: Buffer | null): Promise<RenderedMail | { skip: string }> {
  if (!n.booking_id) return { skip: "booking no longer exists" };
  const { rows: [r] } = await db.query(
    `select b.id, b.host_id, b.status, b.end_at, b.package_purchase_id, i.name as guest_name, i.email as guest_email, i.locale, i.no_show_at,
       e.name as event_name, e.slug as event_slug, e.active as event_active, e.kind as event_kind,
       coalesce(u.name, '') as host_name, u.email as host_email, u.slug as host_slug, u.deleted_at,
       s.thank_you, s.feedback, s.review_ask, s.package_nudge, s.delay_hours, p.reviews_url,
       exists (select 1 from follow_up_opt_outs o where o.host_id = b.host_id and o.email in (i.email, $2::citext)) as opted_out,
       exists (select 1 from booking_feedback f where f.booking_id = b.id) as answered
     from bookings b join invitees i on i.booking_id = b.id join event_types e on e.id = b.event_type_id join users u on u.id = b.host_id
     left join follow_up_settings s on s.event_type_id = b.event_type_id left join profiles p on p.user_id = b.host_id
     where b.id = $1`, [n.booking_id, n.recipient]);
  if (!r) return { skip: "booking no longer exists" };
  if (!key) return { skip: "follow-up links need TOKEN_ENCRYPTION_KEY on this server" };
  const locale: Locale = isLocale(r.locale) ? r.locale : "en";
  const lang = locale === "en" ? "" : `lang=${locale}`;

  let nudge: PackageNudge | null = null;
  if (r.package_purchase_id && r.package_nudge) {
    const { rows: [pp] } = await db.query(
      `select pp.sessions, pp.expires_at, pp.token, pp.package_id, k.name, k.active and e.active as on_sale,
         (select count(*)::int from bookings x where x.package_purchase_id = pp.id and x.status <> 'cancelled') as used
       from package_purchases pp join packages k on k.id = pp.package_id join event_types e on e.id = k.event_type_id where pp.id = $1`, [r.package_purchase_id]);
    const kind = pp ? packageNudgeKind({ sessions: pp.sessions, used: pp.used, expiresAt: pp.expires_at }, now) : null;
    if (pp && kind) {
      const nn: PackageNudge = { kind, packageName: pp.name, bookUrl: kind === "one_left" ? `${baseUrl}/p/${pp.token}${lang ? `?${lang}` : ""}` : null, buyUrl: pp.on_sale ? `${baseUrl}/pkg/${pp.package_id}${lang ? `?${lang}` : ""}` : null };
      if (nn.bookUrl || nn.buyUrl) nudge = nn;
    }
  }
  const bookable = r.event_active && r.event_kind !== "one_off" && r.host_slug;
  const rebook = bookable ? rebookUrl(baseUrl, key, r.host_slug, r.event_slug, r.id, locale, now) : null;
  const plan = planFollowUp({
    status: r.status, noShow: r.no_show_at !== null, optedOut: r.opted_out, hostClosed: r.deleted_at !== null, endAt: new Date(r.end_at),
    settings: toSettings(r), answered: r.answered, reviewsUrl: r.reviews_url ?? null, rebookUrl: rebook, nudge,
  }, now);
  if ("skip" in plan) return plan;
  const optOut = optOutToken(key, r.host_id, n.recipient);
  return renderFollowUpMail({
    locale, guestName: r.guest_name, hostName: r.host_name || r.host_email, hostEmail: r.host_email, eventName: r.event_name,
    feedbackUrl: `${baseUrl}/b/feedback/${feedbackToken(key, r.id, now)}`,
    optOutUrl: `${baseUrl}/b/stop/${optOut}${lang ? `?${lang}` : ""}`,
    oneClickUrl: `${baseUrl}/api/follow-ups/stop/${optOut}`,
  }, plan);
}

// ---- The guest's feedback page -------------------------------------------------------------------------------------

export interface FeedbackBooking { bookingId: string; hostId: string; hostName: string; eventName: string; startAt: Date; timezone: string; locale: Locale; answered: boolean; rating: number | null; reviewAsk: boolean; reviewsUrl: string | null; rebookUrl: string | null }

export interface FeedbackForm extends FeedbackBooking { state: "form" | "answered" }
export type FeedbackPage = { state: "invalid" } | { state: "expired" } | FeedbackForm;

async function feedbackBooking(db: Db, key: Buffer, bookingId: string, baseUrl: string, now: Date): Promise<FeedbackBooking | null> {
  const { rows: [r] } = await db.query(
    `select b.id, b.host_id, b.status, b.start_at, i.name as guest_name, i.email as guest_email, i.timezone, i.locale,
       e.name as event_name, e.slug as event_slug, e.active as event_active, e.kind as event_kind, coalesce(nullif(u.name, ''), u.email) as host_name, u.slug as host_slug, u.deleted_at,
       coalesce(s.review_ask, false) as review_ask, coalesce(s.thank_you, false) as thank_you, p.reviews_url,
       (select f.rating from booking_feedback f where f.booking_id = b.id) as rating
     from bookings b join invitees i on i.booking_id = b.id join event_types e on e.id = b.event_type_id join users u on u.id = b.host_id
     left join follow_up_settings s on s.event_type_id = b.event_type_id left join profiles p on p.user_id = b.host_id
     where b.id = $1`, [bookingId]);
  if (!r || r.status !== "confirmed" || r.deleted_at) return null;
  const locale: Locale = isLocale(r.locale) ? r.locale : "en";
  const bookable = r.thank_you && r.event_active && r.event_kind !== "one_off" && r.host_slug;
  return {
    bookingId: r.id, hostId: r.host_id, hostName: r.host_name, eventName: r.event_name, startAt: new Date(r.start_at), timezone: r.timezone, locale, answered: r.rating !== null, rating: r.rating ?? null,
    reviewAsk: r.review_ask, reviewsUrl: r.reviews_url ?? null,
    rebookUrl: bookable ? rebookUrl(baseUrl, key, r.host_slug, r.event_slug, r.id, locale, now) : null,
  };
}

/** What the feedback page shows for a link: the form, "already answered", or why the link doesn't work. */
export async function feedbackPage(db: Db, key: Buffer, token: unknown, baseUrl: string, now: Date): Promise<FeedbackPage> {
  const t = readFeedbackToken(key, token, now);
  if (!t.ok) return t.reason === "expired" ? { state: "expired" } : { state: "invalid" };
  const b = await feedbackBooking(db, key, t.bookingId, baseUrl, now);
  if (!b) return { state: "invalid" };
  return { state: b.answered ? "answered" : "form", ...b };
}

export type FeedbackResult =
  | { status: "saved"; rating: number; locale: Locale; hostName: string; review: { url: string; wording: "reviewHigh" | "reviewLow" } | null; rebookUrl: string | null }
  | { status: "already"; locale: Locale; hostName: string }
  | { status: "invalid" | "expired" }
  | { status: "bad_input"; field: "rating" | "comment"; locale: Locale };

/** Checks the rating (whole number 1–5) and comment (plain text, up to 2,000 characters; blank is none). */
export function validateFeedback(input: { rating: unknown; comment: unknown }): { ok: true; rating: number; comment: string | null } | { ok: false; field: "rating" | "comment" } {
  const rating = typeof input.rating === "string" && /^[1-5]$/.test(input.rating.trim()) ? Number(input.rating.trim()) : typeof input.rating === "number" ? input.rating : NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, field: "rating" };
  if (input.comment != null && typeof input.comment !== "string") return { ok: false, field: "comment" };
  const comment = (input.comment ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (comment.length > COMMENT_MAX) return { ok: false, field: "comment" };
  return { ok: true, rating, comment: comment || null };
}

/**
 * Saves the guest's answer. The link works once: the first answer for a booking is kept and any later submit reads as
 * "already". After saving, the host's Google review link (if they set one and switched the ask on) is offered whatever
 * the rating; only the wording follows it.
 */
export async function submitFeedback(db: Db, key: Buffer, token: unknown, input: { rating: unknown; comment: unknown }, baseUrl: string, now: Date): Promise<FeedbackResult> {
  const t = readFeedbackToken(key, token, now);
  if (!t.ok) return { status: t.reason };
  const b = await feedbackBooking(db, key, t.bookingId, baseUrl, now);
  if (!b) return { status: "invalid" };
  const v = validateFeedback(input);
  if (!v.ok) return { status: "bad_input", field: v.field, locale: b.locale };
  const { rowCount } = await db.query(
    `insert into booking_feedback (booking_id, host_id, rating, comment, created_at) values ($1, $2, $3, $4, $5) on conflict (booking_id) do nothing`,
    [b.bookingId, b.hostId, v.rating, v.comment, now]);
  if (!rowCount) return { status: "already", locale: b.locale, hostName: b.hostName };
  return {
    status: "saved", rating: v.rating, locale: b.locale, hostName: b.hostName, rebookUrl: b.rebookUrl,
    review: b.reviewAsk && b.reviewsUrl ? { url: b.reviewsUrl, wording: reviewWording(v.rating) } : null,
  };
}

// ---- Opting out ----------------------------------------------------------------------------------------------------

export async function optOutPage(db: Db, key: Buffer, token: unknown): Promise<{ hostName: string; hostLocale: string | null; done: boolean } | null> {
  const t = readOptOutToken(key, token);
  if (!t) return null;
  const { rows: [r] } = await db.query(
    `select coalesce(nullif(u.name, ''), u.email) as host_name, u.locale,
       exists (select 1 from follow_up_opt_outs o where o.host_id = u.id and o.email = $2) as done
     from users u where u.id = $1 and u.deleted_at is null`, [t.hostId, t.email]);
  return r ? { hostName: r.host_name, hostLocale: r.locale ?? null, done: r.done } : null;
}

/** Records the opt-out and drops that guest's follow-ups still queued for this host. Doing it twice is fine. */
export async function applyOptOut(db: Db, key: Buffer, token: unknown, now: Date): Promise<boolean> {
  const t = readOptOutToken(key, token);
  if (!t) return false;
  const { rowCount } = await db.query(
    `insert into follow_up_opt_outs (host_id, email, opted_out_at) select id, $2, $3 from users where id = $1 on conflict (host_id, email) do nothing`,
    [t.hostId, t.email, now]);
  const { rows: [exists] } = await db.query("select 1 as ok from follow_up_opt_outs where host_id = $1 and email = $2", [t.hostId, t.email]);
  if (!exists) return false;
  if (rowCount) {
    await db.query(
      `update notifications set status = 'skipped', last_error = 'guest opted out of this host''s follow-ups', updated_at = $3
       where user_id = $1 and kind = '${FOLLOW_UP_KIND}' and status = 'queued' and lower(recipient) = lower($2) and (locked_until is null or locked_until < $3)`,
      [t.hostId, t.email, now]);
  }
  return true;
}

// ---- What the host sees -----------------------------------------------------------------------------------------

export interface FeedbackEntry { bookingId: string; rating: number; comment: string | null; createdAt: Date; guestName: string; guestEmail: string; eventName: string; startAt: Date }

const ENTRY = `select f.booking_id, f.rating, f.comment, f.created_at, i.name as guest_name, i.email as guest_email, e.name as event_name, b.start_at
  from booking_feedback f join bookings b on b.id = f.booking_id join invitees i on i.booking_id = b.id join event_types e on e.id = b.event_type_id`;
const toEntry = (r: Record<string, unknown>): FeedbackEntry => ({
  bookingId: r.booking_id as string, rating: r.rating as number, comment: (r.comment as string | null) ?? null, createdAt: r.created_at as Date,
  guestName: r.guest_name as string, guestEmail: r.guest_email as string, eventName: r.event_name as string, startAt: r.start_at as Date,
});

/** The host's feedback, newest first. Private: only ever shown in their dashboard. */
export async function listFeedback(db: Db, hostId: string, limit = 200): Promise<{ entries: FeedbackEntry[]; average: number | null; count: number }> {
  if (!UUID.test(hostId)) return { entries: [], average: null, count: 0 };
  const [{ rows }, { rows: [agg] }] = await Promise.all([
    db.query(`${ENTRY} where f.host_id = $1 order by f.created_at desc limit $2`, [hostId, limit]),
    db.query("select count(*)::int as n, avg(rating)::float as avg from booking_feedback where host_id = $1", [hostId]),
  ]);
  return { entries: rows.map(toEntry), average: agg.n ? Math.round(agg.avg * 10) / 10 : null, count: agg.n };
}

export async function feedbackForBooking(db: Db, hostId: string, bookingId: string): Promise<FeedbackEntry | null> {
  if (!UUID.test(hostId) || !UUID.test(bookingId)) return null;
  const { rows: [r] } = await db.query(`${ENTRY} where f.booking_id = $1 and f.host_id = $2`, [bookingId, hostId]);
  return r ? toEntry(r) : null;
}

/** The session's date as the guest reads it on the feedback page. */
export const sessionDate = (b: Pick<FeedbackBooking, "startAt" | "timezone" | "locale">) => formatDate(b.startAt, b.timezone, b.locale);
