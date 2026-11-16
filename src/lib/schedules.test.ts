import { describe, expect, it } from "vitest";
import { isIanaTimeZone } from "./booking";
import { blockTargets, copyName, validateSchedule, zoneOptions } from "./schedules";

describe("validateSchedule", () => {
  it("trims and squeezes the name and accepts a real zone", () => {
    expect(validateSchedule({ name: "  UK   clients ", timezone: "Europe/London" }, isIanaTimeZone)).toEqual({ ok: true, value: { name: "UK clients", timezone: "Europe/London" } });
  });
  it("refuses an empty or overlong name, a made-up zone and non-text input", () => {
    expect(validateSchedule({ name: " ", timezone: "Asia/Kolkata" }, isIanaTimeZone)).toMatchObject({ ok: false, errors: { "schedule-name": expect.any(String) } });
    expect(validateSchedule({ name: "x".repeat(61), timezone: "Asia/Kolkata" }, isIanaTimeZone)).toMatchObject({ ok: false, errors: { "schedule-name": expect.any(String) } });
    expect(validateSchedule({ name: "Clinic", timezone: "Mars/Olympus" }, isIanaTimeZone)).toMatchObject({ ok: false, errors: { "schedule-timezone": expect.any(String) } });
    expect(validateSchedule({ name: null, timezone: null }, isIanaTimeZone).ok).toBe(false);
  });
});

describe("copyName", () => {
  it("adds a number until the name is free, in any case, within 60 characters", () => {
    expect(copyName("Clinic", ["Clinic"])).toBe("Copy of Clinic");
    expect(copyName("Clinic", ["Clinic", "copy of clinic", "Copy of Clinic (2)"])).toBe("Copy of Clinic (3)");
    expect(copyName("x".repeat(60), ["Copy of " + "x".repeat(52)]).length).toBeLessThanOrEqual(60);
  });
});

describe("blockTargets", () => {
  const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("is every schedule for 'all' and only the current one otherwise", () => {
    expect(blockTargets("all", "b", all)).toEqual(["a", "b", "c"]);
    expect(blockTargets("one", "b", all)).toEqual(["b"]);
    expect(blockTargets(null, "b", all)).toEqual(["b"]);
  });
  it("never targets an id that isn't in the host's list", () => {
    expect(blockTargets("one", "zzz", all)).toEqual([]);
  });
});

describe("zoneOptions", () => {
  it("keeps every zone the page needs, even ones the runtime list lacks, once each", () => {
    const zones = zoneOptions("Asia/Kolkata", "Europe/London", "Asia/Kolkata");
    expect(zones.filter((z) => z === "Asia/Kolkata")).toHaveLength(1);
    expect(zones.filter((z) => z === "Europe/London")).toHaveLength(1);
    expect(zoneOptions("Etc/GMT+5")[0]).toBe("Etc/GMT+5");
  });
});
