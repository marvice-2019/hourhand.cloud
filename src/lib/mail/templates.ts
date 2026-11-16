// Hourhand's emails. Every message has a plain-text and an HTML version with the same content.
import type { InviteeAnswer, LocationKind } from "../data/types";
import type { BookingEmailKind } from "../data/notifications";
import { formatDate, formatTime, zoneName, type HourCycle } from "../format";
import { GUEST_LOCATION_LABELS } from "../location-labels";
import { formatMoney } from "../billing/plans";
import { formatAmount } from "../money";
import { buildIcs } from "./ics";
import { LOCATION_KEYS, isLocale, t, type Locale } from "../i18n/guest";
import { mt, type MailKey } from "../i18n/mail";
import { offerLabel } from "../offers/labels";
import type { AdjustmentKind } from "../offers/pricing";
import { pt } from "../i18n/poll";
import type { Attachment } from "./mailer";
import { ht, hostLocaleOf, type HostKey, type HostLocale } from "../i18n/host";
import { hostINR, hostMoney } from "../i18n/host/format";

/** Where a guest's payment went, for the host's emails. */
const providerName = (c: { paidProvider?: "razorpay" | "stripe" | null }) => (c.paidProvider === "stripe" ? "Stripe" : "Razorpay");

export interface BookingMailContext {
  bookingId: string;
  eventName: string;
  hostName: string;
  hostEmail: string;
  hostTimezone: string;
  hostTimeFormat: HourCycle;
  guestName: string;
  guestEmail: string;
  guestTimezone: string;
  startAt: Date;
  endAt: Date;
  location: { kind: LocationKind; value: string | null } | null;
  /** The video link from the host's calendar event (Google Meet), when there is one. */
  joinUrl: string | null;
  answers: InviteeAnswer[];
  cancelledBy: "host" | "guest" | "system" | null;
  cancelReason: string | null;
  /** What the guest paid for this booking (paise, INR), or null for a free booking. */
  paidMinor?: number | null;
  /** The paid amount's currency and where it went (Razorpay for INR, Stripe otherwise). */
  paidCurrency?: string | null;
  paidProvider?: "razorpay" | "stripe" | null;
  /** The payment was a refundable no-show deposit, not a price. */
  paidIsDeposit?: boolean;
  /** The one offer the price got (src/lib/offers): explained next to what was paid. */
  offer?: { kind: AdjustmentKind; label: string; code: string | null; listMinor: number; discountMinor: number } | null;
  /** For reschedules: when the booking used to be. */
  previousStartAt: Date | null;
  /** For a rescheduled booking: who moved it (who cancelled the old one). */
  movedBy?: "host" | "guest" | "system" | null;
  /** When the email was queued. Used as the calendar file's timestamp, so a retried send has exactly the same body. */
  issuedAt: Date;
  /** The guest's cancel / reschedule page. Only ever sent to the guest. */
  manageUrl: string;
  /** The host's view of the booking in the dashboard. */
  dashboardUrl: string;
  /** For late_host: how many minutes late the guest said they'll be. */
  runningLateMinutes?: number | null;
  /** For cancelled_guest after the host cancelled: free times to book instead, nearest the cancelled one. */
  rebook?: { at: Date; url: string }[];
  /** For the first week's confirmations of a weekly series: every week still booked, in order, the first included. */
  series?: { bookingId: string; startAt: Date; endAt: Date; manageUrl: string }[];
  /** For cancellations: later weeks of the same series cancelled in the same step. */
  alsoCancelled?: Date[];
  /** The recipient is an extra guest the booker added: told about the booking, never given the link that changes it. */
  extraGuest?: boolean;
  /** The language the guest booked in; guest emails use it. */
  locale?: string;
  /** The host's own language (users.host_locale); the host's emails use it. Missing means English. */
  hostLocale?: string;
}

export interface RenderedMail { subject: string; text: string; html: string; attachments?: Attachment[]; replyTo?: string; headers?: Record<string, string> }

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Strips line breaks from anything that goes into a subject line. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

const when = (d: Date, tz: string, cycle: HourCycle, locale: Locale = "en") => `${formatDate(d, tz, locale)}, ${formatTime(d, tz, cycle, locale)} ${zoneName(tz)}`;
/** The guest's language for this email, and its lines. */
const lang = (c: BookingMailContext): Locale => (isLocale(c.locale) ? c.locale : "en");
const g = (c: BookingMailContext, key: MailKey, vars: Record<string, string | number> = {}) => mt(lang(c), key, vars);
const minutes = (c: BookingMailContext) => Math.round((c.endAt.getTime() - c.startAt.getTime()) / 60_000);
const hostLabel = (c: BookingMailContext) => c.hostName || c.hostEmail;

function where(c: BookingMailContext, locale: Locale = "en"): string | null {
  if (!c.location) return null;
  const label = locale === "en" ? GUEST_LOCATION_LABELS[c.location.kind] : t(locale, LOCATION_KEYS[c.location.kind]);
  if (c.joinUrl) return `${label}: ${c.joinUrl}`;
  return c.location.value ? `${label}: ${c.location.value}` : label;
}

type Row = [label: string, value: string];
type Block = { heading: string; intro: string; rows: Row[]; link?: { label: string; url: string }; choices?: { heading: string; items: { label: string; url: string }[] }; note?: string; footer: string };

function toText(b: Block): string {
  const lines = [b.heading, "", b.intro, "", ...b.rows.map(([k, v]) => `${k}: ${v}`)];
  if (b.link) lines.push("", `${b.link.label}: ${b.link.url}`);
  if (b.choices) lines.push("", b.choices.heading, ...b.choices.items.map((i) => `- ${i.label}: ${i.url}`));
  if (b.note) lines.push("", b.note);
  lines.push("", "—", b.footer);
  return lines.join("\n");
}

function toHtml(b: Block): string {
  const rows = b.rows.map(([k, v]) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#5b6170;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:4px 0;color:#16181d">${escapeHtml(v).replace(/\n/g, "<br>")}</td></tr>`).join("");
  const link = b.link
    ? `<p style="margin:24px 0"><a href="${escapeHtml(b.link.url)}" style="background:#16181d;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(b.link.label)}</a></p>`
    : "";
  const note = b.note ? `<p style="margin:16px 0;color:#5b6170">${escapeHtml(b.note)}</p>` : "";
  const choices = b.choices
    ? `<p style="margin:24px 0 8px;font-weight:600;color:#16181d">${escapeHtml(b.choices.heading)}</p>` + b.choices.items.map((i) =>
      `<p style="margin:0 0 8px"><a href="${escapeHtml(i.url)}" style="border:1px solid #16181d;color:#16181d;padding:8px 14px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(i.label)}</a></p>`).join("")
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px">
<h1 style="margin:0 0 12px;font-size:20px;color:#16181d">${escapeHtml(b.heading)}</h1>
<p style="margin:0 0 16px;color:#16181d">${escapeHtml(b.intro)}</p>
<table role="presentation" style="border-collapse:collapse">${rows}</table>${link}${choices}${note}
<p style="margin:28px 0 0;font-size:13px;color:#8a8f9c">${escapeHtml(b.footer)}</p>
</div></body></html>`;
}

export const render = (subject: string, b: Block, extra: Partial<RenderedMail> = {}): RenderedMail =>
  ({ subject: oneLine(subject), text: toText(b), html: toHtml(b), ...extra });

/** "Every week": the series' dates, one line each, when this is a series confirmation. */
const seriesRow = (c: BookingMailContext, tz: string, cycle: HourCycle, locale: Locale = "en"): Row[] => [
  ...(c.series && c.series.length > 1 ? [[mt(locale, "rEveryWeek", { n: c.series.length }), c.series.map((s) => when(s.startAt, tz, cycle, locale)).join("\n")] as Row] : []),
  ...(c.alsoCancelled?.length ? [[mt(locale, "rAlsoCancelled", { n: c.alsoCancelled.length }), c.alsoCancelled.map((d) => when(d, tz, cycle, locale)).join("\n")] as Row] : []),
];

/** "₹944 (₹1,180 less ₹236, code DIWALI20)" when an offer took something off; otherwise just the amount. */
function paidWithOffer(c: BookingMailContext, locale: Locale): string {
  const money = (m: number) => formatAmount(m, c.paidCurrency);
  const paid = money(c.paidMinor ?? 0);
  const o = c.offer;
  if (!o) return paid;
  if (o.discountMinor <= 0) return `${paid} (${offerLabel(locale, o)})`;
  return t(locale, "offerPaidLine", { price: paid, list: money(o.listMinor), amount: money(o.discountMinor), label: offerLabel(locale, o) });
}

function guestRows(c: BookingMailContext): Row[] {
  const l = lang(c);
  const rows: Row[] = [[g(c, "rWhat"), `${c.eventName} (${g(c, "minutes", { n: minutes(c) })})`], [g(c, "rWhen"), when(c.startAt, c.guestTimezone, "12h", l)],
    ...seriesRow(c, c.guestTimezone, "12h", l), [g(c, "rWith"), hostLabel(c)]];
  const w = where(c, l);
  if (w) rows.push([g(c, "rWhere"), w]);
  if (c.paidMinor) rows.push(c.paidIsDeposit ? [g(c, "rDeposit"), g(c, "rDepositValue", { amount: formatAmount(c.paidMinor, c.paidCurrency) })] : [g(c, "rPaid"), paidWithOffer(c, l)]);
  return rows;
}

/** The host's language for this email, and its lines. */
const hl = (c: { hostLocale?: string | null }): HostLocale => hostLocaleOf(c);
const h = (c: { hostLocale?: string | null }, key: HostKey, vars: Record<string, string | number> = {}) => ht(hl(c), key, vars);

function hostRows(c: BookingMailContext): Row[] {
  const l = hl(c);
  const rows: Row[] = [[h(c, "mail.rWhat"), h(c, "mail.eventLength", { event: c.eventName, n: minutes(c) })], [h(c, "mail.rWhen"), when(c.startAt, c.hostTimezone, c.hostTimeFormat, l)],
    ...hostSeriesRow(c), [h(c, "mail.rGuest"), `${c.guestName} <${c.guestEmail}>`], [h(c, "mail.rGuestZone"), zoneName(c.guestTimezone)]];
  const w = where(c, l);
  if (w) rows.push([h(c, "mail.rWhere"), w]);
  for (const a of c.answers) if (a.answer.trim()) rows.push([a.label, a.answer]);
  if (c.paidMinor) rows.push(c.paidIsDeposit
    ? [h(c, "mail.rDeposit"), h(c, "mail.rDepositValue", { amount: hostMoney(c.paidMinor, c.paidCurrency, l), provider: providerName(c) })]
    : [h(c, "mail.rPaid"), h(c, "mail.rPaidValue", { amount: paidWithOffer(c, l), provider: providerName(c) })]);
  return rows;
}

/** The host's "Every week" and "Also cancelled" rows, in the host's language and time format. */
const hostSeriesRow = (c: BookingMailContext): Row[] => {
  const l = hl(c);
  return [
    ...(c.series && c.series.length > 1 ? [[h(c, "mail.rEveryWeek", { n: c.series.length }), c.series.map((s) => when(s.startAt, c.hostTimezone, c.hostTimeFormat, l)).join("\n")] as Row] : []),
    ...(c.alsoCancelled?.length ? [[h(c, "mail.rAlsoCancelled", { n: c.alsoCancelled.length }), c.alsoCancelled.map((d) => when(d, c.hostTimezone, c.hostTimeFormat, l)).join("\n")] as Row] : []),
  ];
};

function calendarFile(c: BookingMailContext): Attachment {
  const weeks = c.series && c.series.length > 1 ? c.series : [{ bookingId: c.bookingId, startAt: c.startAt, endAt: c.endAt, manageUrl: c.manageUrl }];
  const ics = buildIcs(weeks.map((w) => ({
    uid: `${w.bookingId}@hourhand`, start: w.startAt, end: w.endAt, stamp: c.issuedAt,
    summary: g(c, "calWith", { event: c.eventName, host: hostLabel(c) }), description: g(c, "calChange", { url: w.manageUrl }), location: where(c, lang(c)), url: w.manageUrl,
  })));
  return { filename: "booking.ics", content: Buffer.from(ics, "utf8").toString("base64"), contentType: "text/calendar; charset=utf-8; method=PUBLISH" };
}

const guestFooter = (c: BookingMailContext) => g(c, "fGuest", { host: hostLabel(c) });
const hostFooter = (c: { hostLocale?: string | null }) => h(c, "mail.footer");
const manageLink = (c: BookingMailContext) => ({ label: g(c, "lManage"), url: c.manageUrl });
const dashboardLink = (c: BookingMailContext) => ({ label: h(c, "mail.openInHourhand"), url: c.dashboardUrl });

function cancelNote(c: BookingMailContext, to: "guest" | "host"): string | undefined {
  if (to === "guest") {
    const refund = !c.paidMinor ? "" : g(c, c.paidIsDeposit ? "refundDeposit" : "refundPayment", { amount: formatAmount(c.paidMinor, c.paidCurrency) });
    return [refund, c.cancelReason ? g(c, "reason", { reason: c.cancelReason }) : ""].filter(Boolean).join(" ") || undefined;
  }
  // A paid booking is refunded in full on cancellation; say so, since that's what each side wants to know first.
  const reason = c.cancelReason ? h(c, "mail.reason", { reason: c.cancelReason }) : "";
  const refund = !c.paidMinor ? "" : h(c, "mail.refund", { amount: hostMoney(c.paidMinor, c.paidCurrency, hl(c)), provider: providerName(c) });
  return [refund, reason].filter(Boolean).join(" ") || undefined;
}

/** What an extra guest hears: the same news, framed as an invitation, with no manage link, payment or refund details. */
function renderForExtraGuest(kind: "booked_guest" | "reminder_guest" | "cancelled_guest" | "rescheduled_guest", c: BookingMailContext): RenderedMail {
  const host = hostLabel(c);
  const l = lang(c);
  const v = { guest: c.guestName, event: c.eventName, host };
  const rows = guestRows({ ...c, paidMinor: null });
  const footer = g(c, "fExtra", v);
  const file = () => {
    const weeks = c.series && c.series.length > 1 ? c.series : [{ bookingId: c.bookingId, startAt: c.startAt, endAt: c.endAt }];
    const ics = buildIcs(weeks.map((w) => ({
      uid: `${w.bookingId}@hourhand`, start: w.startAt, end: w.endAt, stamp: c.issuedAt,
      summary: g(c, "calWith", v), description: g(c, "calBookedBy", v), location: where(c, l),
    })));
    return { filename: "booking.ics", content: Buffer.from(ics, "utf8").toString("base64"), contentType: "text/calendar; charset=utf-8; method=PUBLISH" };
  };
  switch (kind) {
    case "booked_guest":
      return render(g(c, "subjInvitation", { ...v, date: formatDate(c.startAt, c.guestTimezone, l) }), {
        heading: g(c, "hInvited"), intro: g(c, "iInvited", v), rows, footer, note: g(c, "nInvited"),
      }, { attachments: [file()], replyTo: c.guestEmail });
    case "reminder_guest":
      return render(g(c, "subjReminder", { ...v, time: `${formatTime(c.startAt, c.guestTimezone, "12h", l)} ${zoneName(c.guestTimezone)}` }), {
        heading: g(c, "hSoon"), intro: g(c, "iReminderExtra", v), rows, footer,
      }, { replyTo: c.guestEmail });
    case "cancelled_guest":
      return render(g(c, "subjCancelled", v), {
        heading: g(c, "hCancelledExtra"), intro: g(c, "iCancelledExtra", v), rows, footer,
      }, { replyTo: c.guestEmail });
    case "rescheduled_guest":
      return render(g(c, "subjMoved", { ...v, date: formatDate(c.startAt, c.guestTimezone, l) }), {
        heading: g(c, "hMovedExtra"), intro: g(c, "iMovedExtra", v),
        rows: [...rows, ...(c.previousStartAt ? [[g(c, "rWas"), when(c.previousStartAt, c.guestTimezone, "12h", l)] as Row] : [])], footer, note: g(c, "nMoved"),
      }, { attachments: [file()], replyTo: c.guestEmail });
  }
}

export function renderBookingMail(kind: BookingEmailKind, c: BookingMailContext): RenderedMail {
  if (c.extraGuest && (kind === "booked_guest" || kind === "reminder_guest" || kind === "cancelled_guest" || kind === "rescheduled_guest")) return renderForExtraGuest(kind, c);
  const host = hostLabel(c);
  const l = lang(c);
  switch (kind) {
    case "booked_guest":
      return render(g(c, "subjBooked", { event: c.eventName, host, date: formatDate(c.startAt, c.guestTimezone, l) }), {
        heading: g(c, "hBooked"), intro: g(c, "iBooked", { guest: c.guestName, host }),
        rows: guestRows(c), link: manageLink(c), footer: guestFooter(c),
        note: g(c, c.series && c.series.length > 1 ? "nBookedSeries" : "nBooked"),
      }, { attachments: [calendarFile(c)], replyTo: c.hostEmail });
    case "booked_host":
      return render(h(c, "mail.subjNewBooking", { guest: c.guestName, event: c.eventName, date: formatDate(c.startAt, c.hostTimezone, hl(c)) }), {
        heading: h(c, "mail.hNewBooking"), intro: h(c, "mail.iNewBooking", { guest: c.guestName, event: c.eventName }), rows: hostRows(c), link: dashboardLink(c), footer: hostFooter(c),
      }, { replyTo: c.guestEmail });
    case "reminder_guest":
      return render(g(c, "subjReminder", { event: c.eventName, host, time: `${formatTime(c.startAt, c.guestTimezone, "12h", l)} ${zoneName(c.guestTimezone)}` }), {
        heading: g(c, "hSoon"), intro: g(c, "iReminder", { guest: c.guestName, host }),
        rows: guestRows(c), link: manageLink(c), note: g(c, "nReminder"), footer: guestFooter(c),
      }, { replyTo: c.hostEmail });
    case "cancelled_guest":
      return render(g(c, "subjCancelled", { event: c.eventName, host }), {
        heading: g(c, "hCancelled"),
        intro: g(c, c.cancelledBy === "guest" ? "iCancelledByGuest" : "iCancelledByHost", { guest: c.guestName, host }),
        rows: guestRows(c), note: cancelNote(c, "guest"), footer: guestFooter(c),
        ...(c.cancelledBy === "host" && c.rebook?.length ? {
          choices: { heading: g(c, "rebook", { host }), items: c.rebook.map((s) => ({ label: when(s.at, c.guestTimezone, "12h", l), url: s.url })) },
        } : {}),
      }, { replyTo: c.hostEmail });
    case "cancelled_host":
      return render(h(c, "mail.subjCancelled", { guest: c.guestName, event: c.eventName, date: formatDate(c.startAt, c.hostTimezone, hl(c)) }), {
        heading: h(c, "mail.hCancelled"),
        intro: h(c, c.cancelledBy === "guest" ? "mail.iCancelledByGuest" : "mail.iCancelledByYou", { guest: c.guestName, event: c.eventName }),
        rows: hostRows(c), note: cancelNote(c, "host"), footer: hostFooter(c),
      }, { replyTo: c.guestEmail });
    case "rescheduled_guest":
      return render(g(c, "subjMoved", { event: c.eventName, host, date: formatDate(c.startAt, c.guestTimezone, l) }), {
        heading: g(c, "hMoved"), intro: g(c, c.movedBy === "host" ? "iMovedByHost" : "iMoved", { guest: c.guestName, host }),
        rows: [...guestRows(c), ...(c.previousStartAt ? [[g(c, "rWas"), when(c.previousStartAt, c.guestTimezone, "12h", l)] as Row] : [])],
        link: manageLink(c), note: g(c, "nMoved"), footer: guestFooter(c),
      }, { attachments: [calendarFile(c)], replyTo: c.hostEmail });
    case "late_host":
      return render(h(c, "mail.subjLate", { guest: c.guestName, n: c.runningLateMinutes ?? h(c, "mail.aFew"), event: c.eventName }), {
        heading: h(c, "mail.hLate", { guest: c.guestName }),
        intro: h(c, "mail.iLate", { guest: c.guestName, n: c.runningLateMinutes ?? h(c, "mail.aFew"), event: c.eventName, time: formatTime(c.startAt, c.hostTimezone, c.hostTimeFormat, hl(c)) }),
        rows: hostRows(c), link: dashboardLink(c), footer: hostFooter(c),
      }, { replyTo: c.guestEmail });
    case "rescheduled_host":
      return render(h(c, "mail.subjMoved", { guest: c.guestName, event: c.eventName, date: formatDate(c.startAt, c.hostTimezone, hl(c)) }), {
        heading: h(c, "mail.hMoved"), intro: h(c, c.movedBy === "host" ? "mail.iMovedByYou" : "mail.iMovedByGuest", { guest: c.guestName, event: c.eventName }),
        rows: [...hostRows(c), ...(c.previousStartAt ? [[h(c, "mail.rWas"), when(c.previousStartAt, c.hostTimezone, c.hostTimeFormat, hl(c))] as Row] : [])],
        link: dashboardLink(c), footer: hostFooter(c),
      }, { replyTo: c.guestEmail });
  }
}

/** Tells a host their calendar connection is failing, so Hourhand has stopped offering times. Sent once per outage. */
export function renderCalendarAlert(a: { accountEmail: string; disconnected: boolean; lastError: string | null; calendarsUrl: string; hostLocale?: string | null }): RenderedMail {
  return render(h(a, a.disconnected ? "mail.subjCalDisconnected" : "mail.subjCalFailing"), {
    heading: h(a, a.disconnected ? "mail.hCalDisconnected" : "mail.hCalFailing"),
    intro: h(a, a.disconnected ? "mail.iCalDisconnected" : "mail.iCalFailing", { account: a.accountEmail }),
    rows: a.lastError ? [[h(a, "mail.rLastError"), a.lastError.slice(0, 200)]] : [],
    link: { label: h(a, a.disconnected ? "mail.lReconnect" : "mail.lCheckCalendars"), url: a.calendarsUrl },
    footer: hostFooter(a),
  });
}

/** Zoom stopped letting Hourhand make meetings: the grant was revoked, expired, or the app was removed in Zoom. */
export function renderZoomAlert(a: { accountEmail: string; lastError: string | null; integrationsUrl: string; hostLocale?: string | null }): RenderedMail {
  return render(h(a, "mail.subjZoom"), {
    heading: h(a, "mail.hZoom"),
    intro: h(a, "mail.iZoom", { account: a.accountEmail }),
    rows: a.lastError ? [[h(a, "mail.rLastError"), a.lastError.slice(0, 200)]] : [],
    link: { label: h(a, "mail.lReconnectZoom"), url: a.integrationsUrl },
    footer: hostFooter(a),
  });
}

export function renderRenewalReminder(a: { planName: string; price: string; renewsOn: Date; timezone: string; planUrl: string; hostLocale?: string | null }): RenderedMail {
  const on = formatDate(a.renewsOn, a.timezone, hl(a));
  const v = { plan: a.planName, date: on };
  return render(h(a, "mail.subjRenewal", v), {
    heading: h(a, "mail.hRenewal", v),
    intro: h(a, "mail.iRenewal", v),
    rows: [[h(a, "mail.rPlan"), a.planName], [h(a, "mail.rPrice"), a.price], [h(a, "mail.rRenews"), on]],
    link: { label: h(a, "mail.lManagePlan"), url: a.planUrl },
    footer: h(a, "mail.footerSubscription"),
  });
}

export interface PackageMailContext {
  hostName: string; hostEmail: string; guestName: string; guestEmail: string; packageName: string; eventName: string;
  sessions: number; priceMinor: number; currency?: string; provider?: "razorpay" | "stripe"; expiresAt: Date; timezone: string; buyerUrl: string; dashboardUrl: string;
  /** The host's language, for package_host. */
  hostLocale?: string | null;
}

/** A paid session package: the buyer's private link to book their sessions, or the host's note of the sale. */
export function renderPackageMail(kind: "package_guest" | "package_host", c: PackageMailContext): RenderedMail {
  const until = formatDate(c.expiresAt, c.timezone);
  const rows: Row[] = [["Package", c.packageName], ["Sessions", `${c.sessions} × ${c.eventName}`], ["Paid", formatAmount(c.priceMinor, c.currency)], ["Book by", until]];
  if (kind === "package_guest") {
    return render(`Your ${c.sessions} sessions with ${c.hostName}`, {
      heading: "Your package is ready", intro: `Hi ${c.guestName}, thanks for buying ${c.packageName}. Book your sessions any time before ${until}.`,
      rows, link: { label: "Book your sessions", url: c.buyerUrl },
      note: "Keep this email: the link is yours alone and shows how many sessions you have left. Cancel a session in time and you get it back.",
      footer: `Sent by Hourhand for ${c.hostName}. Reply to this email to reach them.`,
    }, { replyTo: c.hostEmail });
  }
  const l = hl(c);
  const hostRowsForPackage: Row[] = [[h(c, "mail.rPackage"), c.packageName], [h(c, "mail.rSessions"), h(c, "mail.sessionsValue", { n: c.sessions, event: c.eventName })],
    [h(c, "mail.rPaid"), hostMoney(c.priceMinor, c.currency, l)], [h(c, "mail.rBookBy"), formatDate(c.expiresAt, c.timezone, l)]];
  return render(h(c, "mail.subjPackageSold", { guest: c.guestName, package: c.packageName }), {
    heading: h(c, "mail.hPackageSold"), intro: h(c, "mail.iPackageSold", { guest: c.guestName, email: c.guestEmail, package: c.packageName, provider: c.provider === "stripe" ? "Stripe" : "Razorpay" }),
    rows: hostRowsForPackage, link: { label: h(c, "mail.openInHourhand"), url: c.dashboardUrl }, footer: hostFooter(c),
  }, { replyTo: c.guestEmail });
}

/** A GST invoice or credit note for the guest: the key figures and a link to the full document to view, print or save. */
export function renderInvoiceMail(v: { kind: "invoice" | "credit_note"; number: string; supplierName: string; supplierEmail: string; totalMinor: number; description: string; url: string; originalNumber: string | null }): RenderedMail {
  const isNote = v.kind === "credit_note";
  return render(isNote ? `Credit note ${v.number} from ${v.supplierName}` : `Invoice ${v.number} from ${v.supplierName}`, {
    heading: isNote ? "Your credit note" : "Your tax invoice",
    intro: isNote ? `Your refund is recorded against invoice ${v.originalNumber}.` : `Thanks for your payment to ${v.supplierName}. Here's your GST invoice.`,
    rows: [["Number", v.number], ["For", v.description], [isNote ? "Refunded" : "Paid", formatMoney(v.totalMinor, "INR")]],
    link: { label: isNote ? "View the credit note" : "View the invoice", url: v.url },
    note: "Open the link to print it or save it as a PDF for your records.",
    footer: `Sent by Hourhand for ${v.supplierName}. Reply to this email to reach them.`,
  }, { replyTo: v.supplierEmail });
}

/** Last month in a few figures, with a link to the full report. `monthLabel` is already in the host's language. */
export function renderEarningsMail(e: { currency?: string; monthLabel: string; netMinor: number; bookingsMinor: number; packagesMinor: number; refundsMinor: number; sessionsHeld: number; noShows: number; url: string; hostLocale?: string | null }): RenderedMail {
  const l = hl(e);
  const inr = (m: number) => hostMoney(m, e.currency, l);
  const month = e.monthLabel;
  return render(h(e, "mail.subjEarnings", { month, amount: inr(e.netMinor) }), {
    heading: h(e, "mail.hEarnings", { month }), intro: h(e, "mail.iEarnings", { month }),
    rows: [[h(e, "mail.rNet"), inr(e.netMinor)], [h(e, "mail.rBookings"), inr(e.bookingsMinor)], [h(e, "mail.rPackages"), inr(e.packagesMinor)],
      [h(e, "mail.rRefunds"), inr(e.refundsMinor)], [h(e, "mail.rHeld"), String(e.sessionsHeld)], [h(e, "mail.rNoShows"), String(e.noShows)]],
    link: { label: h(e, "mail.lFullReport"), url: e.url }, footer: h(e, "mail.footerMonthly"),
  });
}

export function renderSeatInviteMail(c: { ownerName: string; ownerEmail: string; url: string }): RenderedMail {
  return render(`${c.ownerName} added you to their Hourhand plan`, {
    heading: "You're invited to Hourhand", intro: `${c.ownerName} added you as the second person on their Duo plan. Sign in with this email address to accept.`,
    rows: [], link: { label: "Sign in to accept", url: c.url },
    note: "Once you accept, you get your own booking page on Duo and can manage their bookings. If you weren't expecting this, ignore it.",
    footer: `Sent by Hourhand for ${c.ownerName}. Reply to reach them.`,
  }, { replyTo: c.ownerEmail });
}

export function renderPracticeInviteMail(c: { practiceName: string; inviterName: string; replyTo: string; role: "admin" | "practitioner"; url: string }): RenderedMail {
  return render(`${c.practiceName} invited you to Hourhand`, {
    heading: `Join ${c.practiceName} on Hourhand`,
    intro: `${c.inviterName} added you to ${c.practiceName} as ${c.role === "admin" ? "an admin" : "a practitioner"}. Sign in with this email address to accept.`,
    rows: [], link: { label: "Sign in to accept", url: c.url },
    note: c.role === "admin"
      ? "As an admin you manage the practice's practitioners and see its bookings. Practitioners' client notes stay private to them. If you weren't expecting this, ignore it."
      : "You keep your own Hourhand account: your calendars, hours, services and client notes stay yours, and you're listed on the practice's page. If you weren't expecting this, ignore it.",
    footer: `Sent by Hourhand for ${c.practiceName}. Reply to reach them.`,
  }, { replyTo: c.replyTo });
}

/**
 * To the host: one of their clients asked, from their booking's manage link, for a copy or deletion of their data. It
 * carries no details of the client; the host opens the dashboard to see who and act.
 */
export function renderDataRequestMail(c: { kind: "access" | "erasure"; dueAt: Date; timezone: string; url: string; hostLocale?: string | null }): RenderedMail {
  const access = c.kind === "access";
  return render(h(c, access ? "mail.subjDataAccess" : "mail.subjDataErasure"), {
    heading: h(c, "mail.hDataRequest"), intro: h(c, access ? "mail.iDataAccess" : "mail.iDataErasure"),
    rows: [[h(c, "mail.rRespondBy"), when(c.dueAt, c.timezone, "12h", hl(c))]], link: { label: h(c, "mail.lOpenRequest"), url: c.url },
    note: h(c, access ? "mail.nDataAccess" : "mail.nDataErasure"),
    footer: h(c, "mail.footerDataRequest"),
  });
}

export function renderWaitlistMail(c: { guestName: string; hostName: string; eventName: string; start: Date; timezone: string; url: string }): RenderedMail {
  return render(`A time opened up with ${c.hostName}`, {
    heading: "A time opened up", intro: `Hi ${c.guestName}, a ${c.eventName} time with ${c.hostName} just became free on the day you asked about.`,
    rows: [["Time", when(c.start, c.timezone, "12h")]], link: { label: "Book it", url: c.url },
    note: "Everyone on the waitlist for that day gets this email, so it goes to whoever books first. We only send it once.",
    footer: `Sent by Hourhand for ${c.hostName}.`,
  });
}

export function renderMagicLink(url: string): RenderedMail {
  return render("Your Hourhand sign-in link", {
    heading: "Sign in to Hourhand", intro: "Use the button below to sign in. The link works once and expires in 15 minutes.",
    rows: [], link: { label: "Sign in", url }, note: "If you didn't ask for this, ignore this email. Nobody can sign in without the link.",
    footer: "Sent by Hourhand.",
  });
}

/** An invitee's answers to a meeting poll are in: their link to change them, in the language they answered in. */
export function renderPollVoterMail(c: { locale: Locale; voterName: string; hostName: string; title: string; deadline: Date; timezone: string; url: string }): RenderedMail {
  const l = c.locale;
  return render(pt(l, "mSubject", { title: c.title }), {
    heading: pt(l, "mHeading"), intro: pt(l, "mIntro", { name: c.voterName, host: c.hostName, title: c.title }),
    rows: [[pt(l, "mCloses"), when(c.deadline, c.timezone, "12h", l)]], link: { label: pt(l, "mLink"), url: c.url },
    note: pt(l, "mNote", { host: c.hostName }), footer: pt(l, "mFooter", { host: c.hostName }),
  });
}

/** A poll reached its deadline undecided: the host picks a time. The tally per remaining time, best first marked. */
export function renderPollClosedMail(c: { title: string; hostTimezone: string; hostTimeFormat: HourCycle; hostLocale?: string | null; voters: number;
  options: { startAt: Date; yes: number; ifNeeded: number; no: number; best: boolean }[]; url: string }): RenderedMail {
  const l = hl(c);
  const rows: Row[] = c.options.map((o) => [when(o.startAt, c.hostTimezone, c.hostTimeFormat, l),
    h(c, o.best ? "mail.pollTallyBest" : "mail.pollTally", { yes: o.yes, ifNeeded: o.ifNeeded, no: o.no })]);
  return render(h(c, "mail.subjPollClosed", { title: c.title }), {
    heading: h(c, "mail.hPollClosed"),
    intro: c.voters === 0 ? h(c, "mail.iPollNobody", { title: c.title }) : h(c, c.voters === 1 ? "mail.iPollOne" : "mail.iPollMany", { n: c.voters, title: c.title }),
    rows, link: { label: h(c, "mail.lPickTime"), url: c.url },
    note: h(c, c.options.length === 0 ? "mail.nPollAllPassed" : "mail.nPollNotHeld"),
    footer: h(c, "mail.footerPlain"),
  });
}

export interface MembershipMailContext {
  what: "joined" | "renewed" | "payment_failed" | "halted" | "cancel_requested" | "ended";
  hostName: string; hostEmail: string; guestName: string; guestEmail: string; planName: string; sessions: number; priceMinor: number;
  creditsLeft: number; paidThrough: Date | null; timezone: string; memberUrl: string; dashboardUrl: string;
  /** The host's language, for the host's copy. */
  hostLocale?: string | null;
}

/** A membership's life to its client (sessions added, a payment failed, cancelled) and to the host (new member, failures, ends). */
export function renderMembershipMail(to: "guest" | "host", c: MembershipMailContext): RenderedMail {
  const until = c.paidThrough ? formatDate(c.paidThrough, c.timezone) : null;
  const price = `${formatMoney(c.priceMinor, "INR")} a month`;
  const rows: Row[] = [["Membership", c.planName], ["Each month", `${c.sessions} sessions for ${price}`], ...(until ? [["Paid until", until] as Row] : [])];
  if (to === "guest") {
    const sign = { footer: `Sent by Hourhand for ${c.hostName}. Reply to this email to reach them.` };
    const link = { label: "Book your sessions", url: c.memberUrl };
    const mail = (subject: string, heading: string, intro: string, note?: string) =>
      render(subject, { heading, intro, rows: [...rows, ["Sessions left", String(c.creditsLeft)]], link, ...(note ? { note } : {}), ...sign }, { replyTo: c.hostEmail });
    switch (c.what) {
      case "joined": return mail(`Your ${c.planName} membership with ${c.hostName}`, "You're a member",
        `Hi ${c.guestName}, your first payment went through and ${c.sessions} sessions are ready to book.`,
        "Keep this email: the link is yours alone. It shows your sessions left and lets you cancel at any time; a cancelled membership runs to the end of the paid month.");
      case "renewed": return mail(`${c.sessions} new sessions with ${c.hostName}`, "Your membership renewed",
        `Hi ${c.guestName}, this month's payment went through and ${c.sessions} sessions were added.`);
      case "payment_failed": return mail(`Payment failed for your ${c.planName} membership`, "Your payment didn't go through",
        `Hi ${c.guestName}, this month's payment for ${c.planName} failed. Razorpay will try again over the next few days; check your card or UPI app has funds and the mandate is active.`,
        until ? `Your sessions left stay bookable for sessions before ${until}. New sessions are added once a payment goes through.` : undefined);
      case "halted": return mail(`Your ${c.planName} membership is on hold`, "Renewal stopped",
        `Hi ${c.guestName}, Razorpay couldn't collect this month's payment after several tries, so your membership is on hold and no new sessions will be added.`,
        `${until ? `Sessions you have left can still be booked for times before ${until}. ` : ""}Reply to this email to sort out the payment with ${c.hostName}.`);
      case "cancel_requested": return mail(`You've cancelled ${c.planName}`, "Membership cancelled",
        `Hi ${c.guestName}, your ${c.planName} membership won't renew and you won't be charged again.`,
        until ? `You can still book the sessions you have left for times before ${until}.` : undefined);
      case "ended": return mail(`Your ${c.planName} membership has ended`, "Membership ended",
        `Hi ${c.guestName}, your ${c.planName} membership with ${c.hostName} has ended and won't be charged again. Thanks for being a member.`);
    }
  }
  const l = hl(c);
  const v = { guest: c.guestName, plan: c.planName, n: c.sessions };
  const hostRowsForMember: Row[] = [[h(c, "mail.rMembership"), c.planName],
    [h(c, "mail.rEachMonth"), h(c, "mail.memberEachMonth", { n: c.sessions, price: h(c, "mail.memberPrice", { amount: hostINR(c.priceMinor, l) }) })],
    ...(c.paidThrough ? [[h(c, "mail.rPaidUntil"), formatDate(c.paidThrough, c.timezone, l)] as Row] : []),
    [h(c, "mail.rMember"), `${c.guestName} <${c.guestEmail}>`]];
  const host = (what: "Joined" | "Failed" | "Halted" | "Cancelled" | "Renewed" | "Ended") =>
    render(h(c, `mail.subjMember${what}`, v), { heading: h(c, `mail.hMember${what}`), intro: h(c, `mail.iMember${what}`, v), rows: hostRowsForMember,
      link: { label: h(c, "mail.openInHourhand"), url: c.dashboardUrl }, footer: h(c, "mail.footerMemberships") }, { replyTo: c.guestEmail });
  switch (c.what) {
    case "joined": return host("Joined");
    case "payment_failed": return host("Failed");
    case "halted": return host("Halted");
    case "cancel_requested": return host("Cancelled");
    case "renewed": return host("Renewed");
    case "ended": return host("Ended");
  }
}
