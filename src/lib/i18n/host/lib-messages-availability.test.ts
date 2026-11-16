// The availability checks' errors (AVAILABILITY_MESSAGES, SCHEDULE_MESSAGES) each have a host line with the same English.
import { describe, expect, it } from "vitest";
import { AVAILABILITY_MESSAGES, MAX_BLOCK_DAYS, validateDateRange, validateIntervals } from "../../availability";
import { MAX_SCHEDULE_NAME, SCHEDULE_MESSAGES, validateSchedule } from "../../schedules";
import { ScheduleLimitError, ScheduleNameTakenError } from "../../data/types";
import { HOST_CATALOGS, type HostKey } from "./index";
import { decode } from "./lib-messages";

// Same map as src/app/dashboard/availability/actions.ts.
const KEYS: Record<keyof typeof AVAILABILITY_MESSAGES, HostKey> = {
  timeFrom: "availability.errTimeFrom",
  timeTo: "availability.errTimeTo",
  endBeforeStart: "availability.errEndBeforeStart",
  overlap: "availability.errOverlap",
  unknownDay: "availability.errUnknownDay",
  pickDate: "availability.errPickDate",
  datePassed: "availability.errDatePassed",
  lastBeforeFirst: "availability.errLastBeforeFirst",
  tooManyDays: "availability.errTooManyDays",
};

// Same map as the schedule codes in src/app/dashboard/availability/actions.ts.
const SCHEDULE_KEYS: Record<keyof typeof SCHEDULE_MESSAGES, HostKey> = {
  nameMissing: "availability.errScheduleNameMissing",
  nameTooLong: "availability.errScheduleNameTooLong",
  pickZone: "availability.errPickZone",
};

describe("availability messages", () => {
  it("has a host line with the same English for every code", () => {
    for (const [code, template] of Object.entries(AVAILABILITY_MESSAGES)) expect(HOST_CATALOGS.en[KEYS[code as keyof typeof KEYS]]).toBe(template);
  });

  it("decodes real messages", () => {
    const tooMany = validateDateRange("2026-01-01", "2026-12-31", "2026-01-01");
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(decode(AVAILABILITY_MESSAGES, tooMany.errors["block-to"])).toEqual({ code: "tooManyDays", vars: { n: String(MAX_BLOCK_DAYS) } });
    const bad = validateIntervals([{ from: "9", to: "08:00" }, { from: "10:00", to: "09:00" }], "w1");
    expect(decode(AVAILABILITY_MESSAGES, bad["w1-0-from"])).toEqual({ code: "timeFrom", vars: {} });
    expect(decode(AVAILABILITY_MESSAGES, bad["w1-1-to"])).toEqual({ code: "endBeforeStart", vars: {} });
  });

  it("has a host line with the same English for every schedule code", () => {
    for (const [code, template] of Object.entries(SCHEDULE_MESSAGES)) expect(HOST_CATALOGS.en[SCHEDULE_KEYS[code as keyof typeof SCHEDULE_KEYS]]).toBe(template);
  });

  it("decodes real schedule messages", () => {
    const isZone = (tz: unknown): tz is string => tz === "Asia/Kolkata";
    const empty = validateSchedule({ name: "  ", timezone: "Mars/Base" }, isZone);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(decode(SCHEDULE_MESSAGES, empty.errors["schedule-name"])).toEqual({ code: "nameMissing", vars: {} });
      expect(decode(SCHEDULE_MESSAGES, empty.errors["schedule-timezone"])).toEqual({ code: "pickZone", vars: {} });
    }
    const long = validateSchedule({ name: "x".repeat(MAX_SCHEDULE_NAME + 1), timezone: "Asia/Kolkata" }, isZone);
    if (!long.ok) expect(decode(SCHEDULE_MESSAGES, long.errors["schedule-name"])).toEqual({ code: "nameTooLong", vars: { n: String(MAX_SCHEDULE_NAME) } });
    else expect.unreachable();
  });

  it("words the store's schedule errors the same as their own messages", () => {
    const en = HOST_CATALOGS.en;
    expect(en["availability.errScheduleNameTaken"]).toBe(new ScheduleNameTakenError().message);
    expect(en["availability.errScheduleLimitOne"]).toBe(new ScheduleLimitError(1).message);
    expect(en["availability.errScheduleLimitN"].replace("{n}", "3")).toBe(new ScheduleLimitError(3).message);
  });
});
