// B12: finding bookings and downloading them as CSV.
import { describe, expect, it } from "vitest";
import { PAYMENT_NOT_COMPLETED } from "./booking-reasons";
import { bookingsCsv, bookingsQueryString, parseBookingsQuery, searchBookings, type BookingsQuery } from "./bookings-search";
import type { BookingWithInvitee } from "./data/types";

const TZ = "Asia/Kolkata";
const at = new Date("2026-11-10T06:30:00Z"); // 12:00 IST, 10 Nov
const H = 3_600_000;

let n = 0;
function booking(startIso: string, over: Partial<BookingWithInvitee> = {}, invitee: Partial<BookingWithInvitee["invitee"]> = {}): BookingWithInvitee {
  const id = `b${++n}`;
  const startAt = new Date(startIso);
  const endAt = new Date(startAt.getTime() + H);
  return {
    id, eventTypeId: "evt_coaching", hostId: "usr_priya", startAt, endAt, bufferedStart: startAt, bufferedEnd: endAt,
    status: "confirmed", holdExpiresAt: null, locationKind: null, joinUrl: null, idempotencyKey: id, cancelledAt: null,
    cancelledBy: null, cancelReason: null, rescheduledFromId: null, seriesId: null, seriesIndex: null, classKey: null,
    createdAt: new Date("2026-11-01T04:00:00Z"),
    ...over,
    invitee: {
      id: `i${id}`, bookingId: id, hostId: "usr_priya", name: "Meera Iyer", email: "meera@example.com", timezone: TZ,
      phone: null, answers: [], manageToken: `t${id}`, noShowAt: null, runningLateMinutes: null, runningLateAt: null,
      guests: [], locale: "en", whatsappOptIn: false, ...invitee,
    },
  };
}

const query = (over: Partial<BookingsQuery> = {}): BookingsQuery => ({ q: "", view: "all", eventTypeId: null, from: null, to: null, ...over });
const ids = (r: { bookings: BookingWithInvitee[] }) => r.bookings.map((b) => b.id);

describe("finding bookings (B12)", () => {
  const meera = booking("2026-11-12T04:30:00Z", {}, { phone: "+91 98765 43210", guests: ["Ravi@Family.in"] });
  const arjun = booking("2026-11-05T04:30:00Z", { eventTypeId: "evt_intro" }, { name: "Arjun Rao", email: "arjun@rao.dev" });
  const gone = booking("2026-11-14T04:30:00Z", { status: "cancelled", cancelledBy: "guest", cancelReason: "Travelling" }, { name: "Kavya S", email: "kavya@x.io" });
  const unpaid = booking("2026-11-15T04:30:00Z", { status: "cancelled", cancelledBy: "system", cancelReason: PAYMENT_NOT_COMPLETED });
  const request = booking("2026-11-16T04:30:00Z", { status: "pending_approval", holdExpiresAt: new Date(at.getTime() + H) }, { name: "Nila R", email: "nila@r.in" });
  const lapsed = booking("2026-11-17T04:30:00Z", { status: "pending_approval", holdExpiresAt: new Date(at.getTime() - H) });
  const all = [meera, arjun, gone, unpaid, request, lapsed];

  it("lists what the page lists today, upcoming first, without lapsed holds or lapsed requests", () => {
    const r = searchBookings(all, query(), TZ, at);
    expect(ids(r)).toEqual([meera.id, gone.id, request.id, arjun.id]);
    expect(r.requests).toBe(1);
  });

  it("matches name, email, extra guests and phone digits, ignoring case and spaces", () => {
    expect(ids(searchBookings(all, query({ q: "MEERA" }), TZ, at))).toEqual([meera.id]);
    expect(ids(searchBookings(all, query({ q: "rao.dev" }), TZ, at))).toEqual([arjun.id]);
    expect(ids(searchBookings(all, query({ q: "ravi@family" }), TZ, at))).toEqual([meera.id]);
    expect(ids(searchBookings(all, query({ q: "98765 432" }), TZ, at))).toEqual([meera.id]);
    // Two digits are too few to match a phone.
    expect(ids(searchBookings(all, query({ q: "91" }), TZ, at))).toEqual([]);
  });

  it("filters by view", () => {
    expect(ids(searchBookings(all, query({ view: "upcoming" }), TZ, at))).toEqual([meera.id, request.id]);
    expect(ids(searchBookings(all, query({ view: "past" }), TZ, at))).toEqual([arjun.id]);
    expect(ids(searchBookings(all, query({ view: "cancelled" }), TZ, at))).toEqual([gone.id]);
    expect(ids(searchBookings(all, query({ view: "requests" }), TZ, at))).toEqual([request.id]);
  });

  it("filters by event type; an unknown one matches nothing", () => {
    expect(ids(searchBookings(all, query({ eventTypeId: "evt_intro" }), TZ, at))).toEqual([arjun.id]);
    expect(ids(searchBookings(all, query({ eventTypeId: "someone-elses" }), TZ, at))).toEqual([]);
  });

  it("compares dates in the host's zone, both ends inclusive", () => {
    // 18:00 UTC on the 5th is 23:30 IST on the 5th; 18:30 UTC is already the 6th in IST.
    const late = booking("2026-11-05T18:00:00Z");
    const next = booking("2026-11-05T18:30:00Z");
    const list = [late, next];
    expect(ids(searchBookings(list, query({ from: "2026-11-05", to: "2026-11-05" }), TZ, at))).toEqual([late.id]);
    expect(ids(searchBookings(list, query({ from: "2026-11-06" }), TZ, at))).toEqual([next.id]);
  });
});

describe("reading the page's URL (B12)", () => {
  it("reads every filter, trims the search and caps it at 100 characters", () => {
    expect(parseBookingsQuery({ q: "  Meera ", view: "past", event: "evt_intro", from: "2026-11-01", to: "2026-11-30" }))
      .toEqual({ q: "Meera", view: "past", eventTypeId: "evt_intro", from: "2026-11-01", to: "2026-11-30" });
    expect(parseBookingsQuery({ q: "x".repeat(150) }).q).toHaveLength(100);
  });

  it("reads the older show=requests link, ignores an unknown view and bad dates, and swaps from and to", () => {
    expect(parseBookingsQuery({ show: "requests" }).view).toBe("requests");
    expect(parseBookingsQuery({ view: "everything" }).view).toBe("all");
    expect(parseBookingsQuery({ from: "2026-02-30", to: "yesterday" })).toMatchObject({ from: null, to: null });
    expect(parseBookingsQuery({ from: "2026-11-30", to: "2026-11-01" })).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
  });

  it("writes the same query back for the download link, leaving empty parts out", () => {
    const q = parseBookingsQuery({ q: "a&b", view: "cancelled", from: "2026-11-01" });
    expect(parseBookingsQuery(Object.fromEntries(new URLSearchParams(bookingsQueryString(q))))).toEqual(q);
    expect(bookingsQueryString(parseBookingsQuery({}))).toBe("");
  });
});

describe("downloading bookings as CSV (B12)", () => {
  it("writes one row per booking in the host's zone, with a formula guard", () => {
    const b = booking("2026-11-12T04:30:00Z", { status: "cancelled", cancelledBy: "guest", cancelReason: "=cmd()" },
      { name: "Meera, Iyer", phone: "+91 98765 43210", guests: ["a@x.in", "b@x.in"], noShowAt: null });
    const csv = bookingsCsv([b], new Map([["evt_coaching", "Coaching"]]), TZ, at.getTime());
    const [head, row] = csv.split("\r\n");
    expect(head).toBe("Date,Start,End,Time zone,Event type,Guest name,Guest email,Phone,Extra guests,Status,No-show,Cancelled by,Cancel reason,Booked on");
    expect(row).toBe(`2026-11-12,10:00,11:00,Asia/Kolkata,Coaching,"Meera, Iyer",meera@example.com,"'+91 98765 43210",a@x.in; b@x.in,Cancelled,no,guest,"'=cmd()",2026-11-01`);
  });

  it("says Done for a past booking and Confirmed for an upcoming one, and leaves cancel fields empty", () => {
    const past = booking("2026-11-05T04:30:00Z");
    const next = booking("2026-11-12T04:30:00Z");
    const rows = bookingsCsv([next, past], new Map(), TZ, at.getTime()).trim().split("\r\n").slice(1);
    expect(rows[0]).toContain(",Confirmed,no,,,");
    expect(rows[1]).toContain(",Done,no,,,");
  });
});
