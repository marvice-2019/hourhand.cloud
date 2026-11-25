import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_MINUTES, normaliseReminderMinutes, validateReminderForm } from "./reminders";

describe("reminder times", () => {
  it("reads the editor's boxes, longest first", () => {
    expect(validateReminderForm({ r60: "on", r2880: "on" })).toEqual({ ok: true, value: [2880, 60] });
  });
  it("allows none (no reminders) and refuses more than 3", () => {
    expect(validateReminderForm({})).toEqual({ ok: true, value: [] });
    expect(validateReminderForm({ r15: "on", r60: "on", r1440: "on", r10080: "on" })).toEqual({ ok: false, error: "too_many" });
  });
  it("ignores times that aren't choices", () => {
    expect(validateReminderForm({ r45: "on", r1440: "on" })).toEqual({ ok: true, value: [1440] });
  });
  it("cleans what the database holds: known choices, no repeats, at most 3, default when missing", () => {
    expect(normaliseReminderMinutes([60, 60, 999, 1440])).toEqual([1440, 60]);
    expect(normaliseReminderMinutes([15, 30, 60, 120])).toEqual([120, 60, 30]);
    expect(normaliseReminderMinutes(null)).toEqual([...DEFAULT_REMINDER_MINUTES]);
    expect(normaliseReminderMinutes([])).toEqual([]);
  });
});
