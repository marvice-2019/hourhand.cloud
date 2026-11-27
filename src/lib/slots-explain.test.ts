import { describe, expect, it } from "vitest";
import { computeSlots, explainDay, type SlotInput, type SlotReason } from "./slots";
import type { AvailabilityRule } from "./data/types";

// B15. 2026-10-12 is a Monday. India is UTC+05:30 all year.
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const weekly = (weekday: number, intervals: { from: string; to: string }[]): AvailabilityRule => ({ id: `w${weekday}`, scheduleId: "s", kind: "weekly", weekday, onDate: null, intervals });
const override = (onDate: string, intervals: { from: string; to: string }[]): AvailabilityRule => ({ id: `d${onDate}`, scheduleId: "s", kind: "date", weekday: null, onDate, intervals });
const DAY = "2026-10-12";

type In = Omit<SlotInput, "rangeStart" | "rangeEnd">;
function input(over: Partial<Omit<In, "eventType">> & { eventType?: Partial<SlotInput["eventType"]> } = {}): In {
  const { eventType, ...rest } = over;
  return {
    eventType: { id: "et", durationMinutes: 60, startIncrementMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, bookingWindowDays: 60, dailyLimit: null, weeklyLimit: null, ...eventType },
    schedule: { timezone: "Asia/Kolkata" },
    rules: [weekly(1, [{ from: "10:00", to: "14:00" }])],
    busyBlocks: [],
    bookings: [],
    now: ist("2026-10-11", "00:00"),
    syncStale: false,
    ...rest,
  };
}
const booking = (start: Date, end: Date, eventTypeId = "other", id = "b1") =>
  ({ id, eventTypeId, status: "confirmed" as const, holdExpiresAt: null, startAt: start, bufferedStart: start, bufferedEnd: end });
const reasons = (i: In, date = DAY) =>
  Object.fromEntries(explainDay(i, date).starts.map((v) => [v.start.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }), v.reason]));

describe("explainDay", () => {
  it("lists every start the hours offer, open ones with no reason", () => {
    const check = explainDay(input(), DAY);
    expect(check.hours).toEqual([{ from: "10:00", to: "14:00" }]);
    expect(check.hoursFrom).toBe("weekly");
    expect(reasons(input())).toEqual({ "10:00": null, "11:00": null, "12:00": null, "13:00": null });
  });

  it("a day off has no hours and no starts, and says it comes from a date override", () => {
    const check = explainDay(input({ rules: [weekly(1, [{ from: "10:00", to: "14:00" }]), override(DAY, [])] }), DAY);
    expect(check).toMatchObject({ hours: [], hoursFrom: "date", starts: [] });
  });

  it("a weekday with no hours has no starts", () => {
    expect(explainDay(input(), "2026-10-13")).toMatchObject({ hours: [], hoursFrom: "weekly", starts: [] });
  });

  it("names past times, the notice period and the booking window", () => {
    expect(reasons(input({ now: ist(DAY, "11:30"), eventType: { minNoticeMinutes: 60 } }))).toEqual({ "10:00": "past", "11:00": "past", "12:00": "notice", "13:00": null });
    expect(reasons(input({ now: ist("2026-10-10", "12:30"), eventType: { bookingWindowDays: 2 } }))).toEqual({ "10:00": null, "11:00": null, "12:00": null, "13:00": "window" });
  });

  it("names a booking, a calendar event and a poll hold, with what they clash with", () => {
    const check = explainDay(input({
      bookings: [booking(ist(DAY, "10:00"), ist(DAY, "11:00"), "other", "bk")],
      busyBlocks: [
        { start: ist(DAY, "11:30"), end: ist(DAY, "12:15"), calendarId: "cal-1" },
        { start: ist(DAY, "13:00"), end: ist(DAY, "13:30"), kind: "poll" },
      ],
    }), DAY);
    expect(check.starts.map((v) => v.reason)).toEqual(["booking", "calendar", "calendar", "poll"]);
    expect(check.starts[0].blocker).toMatchObject({ bookingId: "bk", calendarId: null, start: ist(DAY, "10:00") });
    expect(check.starts[1].blocker).toMatchObject({ bookingId: null, calendarId: "cal-1", start: ist(DAY, "11:30"), end: ist(DAY, "12:15") });
  });

  it("a booking wins over a calendar event at the same time", () => {
    expect(reasons(input({
      bookings: [booking(ist(DAY, "10:00"), ist(DAY, "11:00"))],
      busyBlocks: [{ start: ist(DAY, "10:00"), end: ist(DAY, "11:00") }],
    }))["10:00"]).toBe("booking");
  });

  it("names buffers through the clash they cause", () => {
    expect(reasons(input({ eventType: { bufferAfterMinutes: 30 }, busyBlocks: [{ start: ist(DAY, "11:15"), end: ist(DAY, "11:45") }] }))["10:00"]).toBe("calendar");
  });

  it("names a full day and a full week", () => {
    const own = booking(ist(DAY, "10:00"), ist(DAY, "11:00"), "et");
    expect(reasons(input({ eventType: { dailyLimit: 1 }, bookings: [own] }))).toEqual({ "10:00": "day_full", "11:00": "day_full", "12:00": "day_full", "13:00": "day_full" });
    const sameWeek = booking(ist("2026-10-13", "10:00"), ist("2026-10-13", "11:00"), "et");
    expect(reasons(input({ eventType: { weeklyLimit: 1 }, bookings: [sameWeek] }))["12:00"]).toBe("week_full");
  });

  it("names a full group class and keeps one with seats open on a full day", () => {
    const seat = (n: number) => ({ ...booking(ist(DAY, "10:00"), ist(DAY, "11:00"), "et", `s${n}`), classKey: `et@${ist(DAY, "10:00").toISOString()}` });
    const group = { seatLimit: 2, dailyLimit: 1 };
    expect(reasons(input({ eventType: group, bookings: [seat(1)] }))).toMatchObject({ "10:00": null, "11:00": "day_full" });
    expect(reasons(input({ eventType: group, bookings: [seat(1), seat(2)] }))["10:00"]).toBe("class_full");
    expect(explainDay(input({ eventType: group, bookings: [seat(1)] }), DAY).starts[0].seatsLeft).toBe(1);
  });

  it("marks every start when a calendar is out of date", () => {
    const check = explainDay(input({ syncStale: true }), DAY);
    expect(check.syncStale).toBe(true);
    expect(new Set(check.starts.map((v) => v.reason))).toEqual(new Set<SlotReason>(["sync_stale"]));
  });

  it("works across a daylight-saving change", () => {
    const check = explainDay(input({ schedule: { timezone: "Europe/London" }, rules: [weekly(0, [{ from: "09:00", to: "11:00" }])], now: new Date("2026-10-20T00:00:00Z") }), "2026-10-25");
    expect(check.starts.map((v) => v.start.toISOString())).toEqual(["2026-10-25T09:00:00.000Z", "2026-10-25T10:00:00.000Z"]);
  });

  // The page must never say a time is open when the booking page hides it, or the other way round.
  it("its open starts are exactly computeSlots for that day, over many mixed inputs", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const at = (h: number, m: number) => ist(DAY, `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    for (let run = 0; run < 300; run++) {
      const bookings = Array.from({ length: rnd(4) }, (_, i) => {
        const h = 9 + rnd(8), m = [0, 15, 30, 45][rnd(4)], start = at(h, m);
        const own = rnd(2) === 0;
        return { ...booking(start, new Date(start.getTime() + (30 + rnd(3) * 30) * 60_000), own ? "et" : "other", `b${i}`), ...(own && rnd(3) === 0 ? { classKey: `et@${start.toISOString()}` } : {}) };
      });
      const busyBlocks = Array.from({ length: rnd(3) }, () => { const s = at(9 + rnd(8), [0, 20, 40][rnd(3)]); return { start: s, end: new Date(s.getTime() + (15 + rnd(6) * 15) * 60_000), ...(rnd(2) ? { kind: "poll" as const } : {}) }; });
      const i = input({
        eventType: {
          durationMinutes: [15, 30, 45, 60][rnd(4)], startIncrementMinutes: [15, 30, 60][rnd(3)], bufferBeforeMinutes: [0, 10][rnd(2)], bufferAfterMinutes: [0, 15][rnd(2)],
          minNoticeMinutes: [0, 120, 600][rnd(3)], bookingWindowDays: [1, 60][rnd(2)], dailyLimit: [null, 1, 3][rnd(3)], weeklyLimit: [null, 2][rnd(2)], seatLimit: [undefined, 3][rnd(2)],
        },
        rules: [weekly(1, [{ from: "09:00", to: "13:00" }, { from: "14:30", to: "18:00" }])],
        bookings, busyBlocks, now: at(rnd(2) ? 7 : 11, 0),
      });
      const open = explainDay(i, DAY).starts.filter((v) => v.reason === null).map((v) => v.start.toISOString());
      const engine = computeSlots({ ...i, rangeStart: ist(DAY, "00:00"), rangeEnd: ist("2026-10-13", "00:00") }).map((d) => d.toISOString());
      expect(open, `run ${run}`).toEqual(engine);
    }
  });
});
