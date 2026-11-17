import { describe, expect, it } from "vitest";
import { reportAccess } from "./access";
import { clampToWindow, localDate, monthsBetween, resolvePeriod } from "./period";

const IST = "Asia/Kolkata";
const iso = (d: Date) => d.toISOString();

describe("report periods in the host's time zone", () => {
  // 15 Nov 2026, 01:00 in India = 14 Nov 19:30 UTC: the UTC date and the host's date differ.
  const now = new Date("2026-11-14T19:30:00Z");

  it("bounds this month at the host's midnight, not UTC's", () => {
    const p = resolvePeriod({ period: "this_month" }, IST, now);
    expect(iso(p.from)).toBe("2026-10-31T18:30:00.000Z");
    expect(iso(p.to)).toBe("2026-11-15T18:30:00.000Z"); // through the end of today
    expect([p.first, p.last]).toEqual(["2026-11-01", "2026-11-15"]);
  });

  it("uses another host's zone, across a DST change", () => {
    const ny = resolvePeriod({ period: "last_month" }, "America/New_York", new Date("2026-11-20T12:00:00Z"));
    expect(iso(ny.from)).toBe("2026-10-01T04:00:00.000Z"); // EDT
    expect(iso(ny.to)).toBe("2026-11-01T04:00:00.000Z");
    const march = resolvePeriod({ period: "custom", from: "2026-03-01", to: "2026-03-31" }, "America/New_York", new Date("2026-06-01T00:00:00Z"));
    expect(iso(march.from)).toBe("2026-03-01T05:00:00.000Z"); // EST before the 8 March change
    expect(iso(march.to)).toBe("2026-04-01T04:00:00.000Z"); // EDT after
  });

  it("runs the financial year April to March", () => {
    const fy = resolvePeriod({ period: "this_fy" }, IST, now);
    expect(iso(fy.from)).toBe("2026-03-31T18:30:00.000Z");
    expect(fy.first).toBe("2026-04-01");
    const last = resolvePeriod({ period: "last_fy" }, IST, now);
    expect([last.first, last.last]).toEqual(["2025-04-01", "2026-03-31"]);
    // In February the year started last April.
    const feb = resolvePeriod({ period: "this_fy" }, IST, new Date("2027-02-10T06:00:00Z"));
    expect(feb.first).toBe("2026-04-01");
    // 1 April 00:10 IST is already the new year, though UTC still says 31 March.
    const april = resolvePeriod({ period: "this_fy" }, IST, new Date("2027-03-31T18:40:00Z"));
    expect(april.first).toBe("2027-04-01");
  });

  it("uses financial-year quarters", () => {
    expect(resolvePeriod({ period: "this_quarter" }, IST, now).first).toBe("2026-10-01");
    const lq = resolvePeriod({ period: "last_quarter" }, IST, now);
    expect([lq.first, lq.last]).toEqual(["2026-07-01", "2026-09-30"]);
    const janLast = resolvePeriod({ period: "last_quarter" }, IST, new Date("2027-01-20T06:00:00Z"));
    expect([janLast.first, janLast.last]).toEqual(["2026-10-01", "2026-12-31"]);
  });

  it("reads custom dates safely", () => {
    const p = resolvePeriod({ period: "custom", from: "2026-09-10", to: "2026-09-01" }, IST, now);
    expect([p.first, p.last]).toEqual(["2026-09-01", "2026-09-10"]); // swapped back into order
    expect(resolvePeriod({ period: "custom", from: "2026-02-30", to: "2026-03-01" }, IST, now).kind).toBe("this_month");
    expect(resolvePeriod({ period: "custom", from: "2026-11-01", to: "2027-05-01" }, IST, now).last).toBe("2026-11-15"); // never past today
    const long = resolvePeriod({ period: "custom", from: "2015-01-01", to: "2026-10-31" }, IST, now);
    expect(long.first).toBe("2024-10-31"); // at most 731 days
    expect(resolvePeriod({ period: "nonsense" }, IST, now).kind).toBe("this_month");
  });

  it("opens a month from the monthly email's link", () => {
    const p = resolvePeriod({ month: "2026-10" }, IST, now);
    expect([p.first, p.last]).toEqual(["2026-10-01", "2026-10-31"]);
  });

  it("lists the months a range touches", () => {
    const p = resolvePeriod({ period: "this_fy" }, IST, now);
    expect(monthsBetween(p.from, p.to, IST)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(localDate(new Date("2026-10-31T19:00:00Z"), IST)).toBe("2026-11-01");
  });
});

describe("plan window", () => {
  const now = new Date("2026-11-15T06:00:00Z");

  it("shows Free the last 30 days and no export", () => {
    const free = reportAccess({}, IST, "free", now);
    expect(free.period.kind).toBe("last_30");
    expect([free.period.first, free.period.last]).toEqual(["2026-10-17", "2026-11-15"]);
    expect(free.canExport).toBe(false);
    expect(iso(free.earliest!)).toBe("2026-10-16T18:30:00.000Z");
    // Asking for the year cuts it to the window; asking for last year gives the window instead.
    const fy = reportAccess({ period: "this_fy" }, IST, "free", now);
    expect([fy.period.first, fy.period.clamped]).toEqual(["2026-10-17", true]);
    const old = reportAccess({ period: "last_fy" }, IST, "free", now);
    expect([old.period.first, old.period.last, old.period.clamped]).toEqual(["2026-10-17", "2026-11-15", true]);
  });

  it("shows Solo and Duo everything, with export", () => {
    for (const plan of ["solo", "duo"] as const) {
      const a = reportAccess({ period: "last_fy" }, IST, plan, now);
      expect([a.period.first, a.period.clamped, a.canExport, a.earliest]).toEqual(["2025-04-01", false, true, null]);
      expect(reportAccess({}, IST, plan, now).period.kind).toBe("this_month");
    }
  });

  it("leaves a period inside the window alone", () => {
    const p = resolvePeriod({ period: "this_month" }, IST, now);
    expect(clampToWindow(p, 30, now)).toEqual(p);
    expect(clampToWindow(p, Infinity, now)).toEqual(p);
  });
});
