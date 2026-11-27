// B12: find bookings on the Bookings page, and download them as CSV.
import { csvCell } from "@/lib/analytics/store";
import { upcomingFirst } from "@/lib/booking";
import { isUnpaidRelease } from "@/lib/booking-reasons";
import type { BookingWithInvitee } from "@/lib/data/types";
import { dayKey } from "@/lib/format";

export const BOOKING_VIEWS = ["all", "upcoming", "past", "cancelled", "requests"] as const;
export type BookingView = (typeof BOOKING_VIEWS)[number];

/** The page shows this many; the download has them all. */
export const PAGE_LIMIT = 200;
const MAX_QUERY = 100;

export interface BookingsQuery {
  q: string;
  view: BookingView;
  eventTypeId: string | null;
  /** YYYY-MM-DD in the host's zone, inclusive. */
  from: string | null;
  to: string | null;
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** A real calendar date as YYYY-MM-DD, or null. */
function validDay(v: string | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** Reads the page's URL. `show=requests` (the older link) reads as the Requests view. */
export function parseBookingsQuery(params: Params): BookingsQuery {
  const q = (one(params.q) ?? "").trim().slice(0, MAX_QUERY);
  const asked = one(params.view) ?? (one(params.show) === "requests" ? "requests" : undefined);
  const view = (BOOKING_VIEWS as readonly string[]).includes(asked ?? "") ? (asked as BookingView) : "all";
  const event = one(params.event)?.trim();
  let from = validDay(one(params.from));
  let to = validDay(one(params.to));
  if (from && to && from > to) [from, to] = [to, from];
  return { q, view, eventTypeId: event ? event : null, from, to };
}

/** The query string that asks for the same bookings again (for the download link). Empty parts are left out. */
export function bookingsQueryString(query: BookingsQuery): string {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  if (query.view !== "all") p.set("view", query.view);
  if (query.eventTypeId) p.set("event", query.eventTypeId);
  if (query.from) p.set("from", query.from);
  if (query.to) p.set("to", query.to);
  return p.toString();
}

/** Whether any filter is set (so the page can offer Clear). */
export function isFiltered(query: BookingsQuery): boolean {
  return bookingsQueryString(query) !== "";
}

/** A request (B9) still holding its slot, waiting on the host. */
export function isLiveRequest(b: BookingWithInvitee, at: Date): boolean {
  return b.status === "pending_approval" && b.holdExpiresAt !== null && b.holdExpiresAt > at;
}

const digits = (s: string) => s.replace(/\D/g, "");

function matchesText(b: BookingWithInvitee, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const i = b.invitee;
  if (i.name.toLowerCase().includes(needle) || i.email.toLowerCase().includes(needle)) return true;
  if (i.guests.some((g) => g.toLowerCase().includes(needle))) return true;
  const d = digits(q);
  return d.length >= 3 && i.phone !== null && digits(i.phone).includes(d);
}

function matchesView(b: BookingWithInvitee, view: BookingView, at: Date): boolean {
  const cancelled = b.status === "cancelled";
  switch (view) {
    case "all": return true;
    case "upcoming": return !cancelled && b.endAt >= at;
    case "past": return !cancelled && b.endAt < at;
    case "cancelled": return cancelled;
    case "requests": return isLiveRequest(b, at);
  }
}

/**
 * The bookings the page lists (holds that lapsed unpaid and requests that ran out left out), narrowed by the query and
 * ordered upcoming first. `requests` counts the live requests whatever the filters, for the banner.
 */
export function searchBookings(all: BookingWithInvitee[], query: BookingsQuery, tz: string, at: Date):
  { bookings: BookingWithInvitee[]; requests: number; now: number } {
  const listed = all.filter((b) => !(b.status === "cancelled" && isUnpaidRelease(b.cancelReason)) && (b.status !== "pending_approval" || isLiveRequest(b, at)));
  const matching = listed.filter((b) => {
    if (query.eventTypeId && b.eventTypeId !== query.eventTypeId) return false;
    if (query.from || query.to) {
      const day = dayKey(b.startAt, tz);
      if (query.from && day < query.from) return false;
      if (query.to && day > query.to) return false;
    }
    return matchesView(b, query.view, at) && matchesText(b, query.q);
  });
  const { bookings, now } = upcomingFirst(matching, at);
  return { bookings, requests: listed.filter((b) => isLiveRequest(b, at)).length, now };
}

/** The word for a booking's state, in English for the CSV. */
export function statusWord(b: BookingWithInvitee, now: number): string {
  if (b.status === "cancelled") return "Cancelled";
  if (b.status === "pending_approval") return "Waiting for approval";
  if (b.status === "pending_payment") return "Awaiting payment";
  return b.endAt.getTime() < now ? "Done" : "Confirmed";
}

const hhmm = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

/**
 * The bookings as CSV, times in the host's zone. Answers and private notes are left out: they can hold sensitive
 * details, and the host sees them on each booking.
 */
export function bookingsCsv(bookings: BookingWithInvitee[], eventNames: Map<string, string>, tz: string, now: number): string {
  const head = ["Date", "Start", "End", "Time zone", "Event type", "Guest name", "Guest email", "Phone", "Extra guests", "Status", "No-show", "Cancelled by", "Cancel reason", "Booked on"];
  const rows = bookings.map((b) => [
    dayKey(b.startAt, tz), hhmm(b.startAt, tz), hhmm(b.endAt, tz), tz, eventNames.get(b.eventTypeId) ?? "",
    b.invitee.name, b.invitee.email, b.invitee.phone, b.invitee.guests.join("; "), statusWord(b, now),
    b.invitee.noShowAt ? "yes" : "no", b.status === "cancelled" ? b.cancelledBy : null, b.status === "cancelled" ? b.cancelReason : null,
    dayKey(b.createdAt, tz),
  ]);
  return [head, ...rows].map((row) => row.map((c) => csvCell(c)).join(",")).join("\r\n") + "\r\n";
}
