import { describe, expect, it } from "vitest";
import { formatDayMonth, formatTime } from "./format";

const afternoon = new Date("2026-10-20T08:00:00Z"); // 13:30 in Asia/Kolkata
const midnight = new Date("2026-10-19T18:30:00Z"); // 00:00 on the 20th in Asia/Kolkata

describe("formatTime", () => {
  it("uses the 12 hour cycle by default and when asked", () => {
    expect(formatTime(afternoon, "Asia/Kolkata")).toBe("1:30 pm");
    expect(formatTime(afternoon, "Asia/Kolkata", "12h")).toBe("1:30 pm");
  });
  it("uses the 24 hour cycle when asked", () => {
    expect(formatTime(afternoon, "Asia/Kolkata", "24h")).toBe("13:30");
  });
  it("writes midnight as 00:00 in 24h and 12:00 am in 12h", () => {
    expect(formatTime(midnight, "Asia/Kolkata", "24h")).toBe("00:00");
    expect(formatTime(midnight, "Asia/Kolkata", "12h")).toBe("12:00 am");
  });
  it("pads morning hours in 24h", () => {
    expect(formatTime(new Date("2026-10-20T03:30:00Z"), "Asia/Kolkata", "24h")).toBe("09:00");
  });
});

describe("formatDayMonth", () => {
  // 20:00 UTC on Thursday is already 01:30 on Friday in India: the guest's own day is the one shown.
  const late = new Date("2026-11-26T20:00:00Z");
  it("names the day in the guest's time zone", () => {
    expect(formatDayMonth(late, "Asia/Kolkata")).toBe("Friday, 27 November");
    expect(formatDayMonth(late, "Europe/London")).toBe("Thursday, 26 November");
  });
  it("speaks the guest's language", () => {
    expect(formatDayMonth(late, "Asia/Kolkata", "hi")).toContain("27");
    expect(formatDayMonth(late, "Asia/Kolkata", "hi")).not.toContain("Friday");
  });
});
