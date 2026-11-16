import { describe, expect, it } from "vitest";
import { RESERVED_EVENT_SLUGS, validateEventType, NEW_EVENT_TYPE_FORM } from "../event-types";
import type { PortalBooking } from "./store";
import { clientZone, dayIn, packageBalance, rebookOptions, splitSessions } from "./view";

const MIN = 60_000;
let n = 0;
function booking(start: string, over: Partial<PortalBooking> & { cutoff?: number; event?: Partial<PortalBooking["eventType"]> } = {}): PortalBooking {
  const startAt = new Date(start);
  const { cutoff = 0, event = {}, ...rest } = over;
  n += 1;
  return {
    id: `b${n}`, startAt, endAt: new Date(startAt.getTime() + 60 * MIN), status: "confirmed", cancelledBy: null, manageToken: `t${n}`,
    timezone: "Asia/Kolkata", locale: "en", joinUrl: null, classKey: null, createdAt: new Date("2026-01-01T00:00:00Z"), noShow: false,
    eventType: { id: "e1", name: "Coaching", slug: "coaching", durationMinutes: 60, cancelCutoffMinutes: cutoff, active: true, kind: "one_on_one", ...event },
    ...rest,
  };
}

describe("upcoming and past, in the client's time zone", () => {
  const now = new Date("2026-11-15T10:00:00Z"); // 15:30 in India, 10:00 in London

  it("puts sessions that haven't ended in upcoming (soonest first) and the rest in past (latest first)", () => {
    const inProgress = booking("2026-11-15T09:30:00Z"); // ends 10:30, still on
    const ended = booking("2026-11-15T08:00:00Z"); // ended 09:00
    const later = booking("2026-11-20T10:00:00Z");
    const soon = booking("2026-11-16T10:00:00Z");
    const cancelledLater = booking("2026-11-18T10:00:00Z", { status: "cancelled", cancelledBy: "guest" });
    const { upcoming, past } = splitSessions([later, ended, cancelledLater, inProgress, soon], now, "Asia/Kolkata");
    expect(upcoming.map((r) => r.booking.id)).toEqual([inProgress.id, soon.id, later.id]);
    expect(past.map((r) => r.booking.id)).toEqual([cancelledLater.id, ended.id]);
  });

  it("dates each session by the client's zone, not the server's or the host's", () => {
    // 19:00 UTC on the 15th is 00:30 on the 16th in India, still the 15th in London.
    const late = booking("2026-11-15T19:00:00Z");
    expect(dayIn(late.startAt, "Asia/Kolkata")).toBe("2026-11-16");
    expect(dayIn(late.startAt, "Europe/London")).toBe("2026-11-15");
    expect(splitSessions([late], now, "Asia/Kolkata").upcoming[0]).toMatchObject({ day: "2026-11-16", relative: "tomorrow" });
    expect(splitSessions([late], now, "Europe/London").upcoming[0]).toMatchObject({ day: "2026-11-15", relative: "today" });
  });

  it("uses the zone the client booked in most recently", () => {
    const older = booking("2026-11-01T10:00:00Z", { timezone: "Europe/London", createdAt: new Date("2026-10-01T00:00:00Z") });
    const newer = booking("2026-10-01T10:00:00Z", { timezone: "Asia/Dubai", createdAt: new Date("2026-10-20T00:00:00Z") });
    expect(clientZone([older, newer], "Asia/Kolkata")).toBe("Asia/Dubai");
    expect(clientZone([], "Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("opens changes only before the host's cutoff", () => {
    const in3h = booking("2026-11-15T13:00:00Z", { cutoff: 24 * 60 });
    const in3days = booking("2026-11-18T10:00:00Z", { cutoff: 24 * 60 });
    const noCutoff = booking("2026-11-15T10:30:00Z");
    const rows = splitSessions([in3h, in3days, noCutoff], now, "Asia/Kolkata").upcoming;
    const byId = Object.fromEntries(rows.map((r) => [r.booking.id, r]));
    expect(byId[in3h.id]).toMatchObject({ canChange: false });
    expect(byId[in3days.id]).toMatchObject({ canChange: true, changeUntil: new Date("2026-11-17T10:00:00Z") });
    expect(byId[noCutoff.id]).toMatchObject({ canChange: true, changeUntil: null });
  });
});

describe("package balance", () => {
  const now = new Date("2026-11-15T10:00:00Z");
  it("counts what's left and stops at the end date", () => {
    expect(packageBalance({ sessions: 5, used: 2, expiresAt: new Date("2026-12-01T00:00:00Z") }, now)).toEqual({ left: 3, expired: false, canBook: true });
    expect(packageBalance({ sessions: 5, used: 5, expiresAt: new Date("2026-12-01T00:00:00Z") }, now)).toEqual({ left: 0, expired: false, canBook: false });
    expect(packageBalance({ sessions: 5, used: 1, expiresAt: now }, now)).toEqual({ left: 4, expired: true, canBook: false });
  });
});

describe("book again", () => {
  it("offers event types the client has had, most recent first, once each, still bookable", () => {
    const a = booking("2026-10-01T10:00:00Z", { event: { id: "e1", slug: "coaching", name: "Coaching" } });
    const b = booking("2026-10-05T10:00:00Z", { event: { id: "e2", slug: "intro", name: "Intro" } });
    const c = booking("2026-10-07T10:00:00Z", { event: { id: "e1", slug: "coaching", name: "Coaching" } });
    const off = booking("2026-10-08T10:00:00Z", { event: { id: "e3", slug: "old", active: false } });
    const oneOff = booking("2026-10-09T10:00:00Z", { event: { id: "e4", slug: "one-off", kind: "one_off" } });
    const cancelled = booking("2026-10-10T10:00:00Z", { status: "cancelled", event: { id: "e5", slug: "never-had" } });
    expect(rebookOptions([a, b, c, off, oneOff, cancelled]).map((o) => o.slug)).toEqual(["coaching", "intro"]);
  });
});

describe("the portal's address", () => {
  it("can't be taken by an event type", () => {
    expect(RESERVED_EVENT_SLUGS.has("portal")).toBe(true);
    const r = validateEventType({ ...NEW_EVENT_TYPE_FORM, name: "Portal", slug: "portal" }, []);
    expect(r).toMatchObject({ ok: false, errors: { slug: expect.any(String) } });
  });
});
