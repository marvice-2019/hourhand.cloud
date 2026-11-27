// Several named availability schedules per host: slots follow each event type's schedule (its hours, zone and days off),
// while bookings and calendar busy time block the host on every schedule.
import { describe, expect, it } from "vitest";
import { freeSlots } from "./booking";
import { LIMITS } from "./billing/plans";
import { createMemoryStore } from "./data/memory-store";
import type { Seed } from "./data/seed";
import { DefaultScheduleError, NotFoundError, ScheduleInUseError, ScheduleLimitError, ScheduleNameTakenError, type AvailabilityRule, type EventType, type Interval, type User } from "./data/types";
import { blockTargets } from "./schedules";

const NOW = new Date("2030-03-25T00:00:00Z"); // a Monday
const FRI = { from: new Date("2030-03-29T00:00:00Z"), to: new Date("2030-03-30T00:00:00Z") }; // London still on GMT
const MON = { from: new Date("2030-04-01T00:00:00Z"), to: new Date("2030-04-02T00:00:00Z") }; // London on BST since Sunday

const host: User = { id: "usr_asha", email: "asha@example.in", name: "Asha", slug: "asha", timezone: "Asia/Kolkata", timeFormat: "12h", locale: "en" };
const other: User = { id: "usr_ravi", email: "ravi@example.in", name: "Ravi", slug: "ravi", timezone: "Asia/Kolkata", timeFormat: "12h", locale: "en" };

const weekly = (scheduleId: string, days: number[], intervals: Interval[]): AvailabilityRule[] =>
  days.map((d) => ({ id: `${scheduleId}_w${d}`, scheduleId, kind: "weekly", weekday: d, onDate: null, intervals }));

const eventType = (id: string, scheduleId: string | null, position: number, userId = host.id): EventType => ({
  id, userId, scheduleId, name: id, slug: id, description: null, durationMinutes: 60, minNoticeMinutes: 0, bookingWindowDays: 730,
  startIncrementMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, dailyLimit: null, cancelCutoffMinutes: 0, priceMinor: null,
  currency: null, hidden: false, active: true, position, kind: "one_on_one", seatLimit: null, maxRepeats: 1, depositMinor: null,
  redirectUrl: null, weeklyLimit: null, cancelPolicy: null, durationOptions: [], requiresApproval: false,
});

/** Clinic (the default): Mon/Wed/Fri 10–12 IST. Online: weekdays 14–16 IST. UK clients: weekdays 09–11 London time. */
function setup() {
  const seed: Seed = {
    users: [host, other],
    schedules: [
      { id: "sch_clinic", userId: host.id, name: "Clinic", timezone: "Asia/Kolkata", isDefault: true },
      { id: "sch_online", userId: host.id, name: "Online", timezone: "Asia/Kolkata", isDefault: false },
      { id: "sch_uk", userId: host.id, name: "UK clients", timezone: "Europe/London", isDefault: false },
      { id: "sch_ravi", userId: other.id, name: "Working hours", timezone: "Asia/Kolkata", isDefault: true },
    ],
    rules: [
      ...weekly("sch_clinic", [1, 3, 5], [{ from: "10:00", to: "12:00" }]),
      ...weekly("sch_online", [1, 2, 3, 4, 5], [{ from: "14:00", to: "16:00" }]),
      ...weekly("sch_uk", [1, 2, 3, 4, 5], [{ from: "09:00", to: "11:00" }]),
    ],
    // clinic has no schedule of its own (null), as event types made before schedules existed may.
    eventTypes: [eventType("clinic", null, 0), eventType("online", "sch_online", 1), eventType("uk", "sch_uk", 2), eventType("ravi", "sch_ravi", 0, other.id)],
    locations: [], questions: [], connections: [], calendars: [], busyBlocks: [], bookings: [],
  };
  const store = createMemoryStore(seed);
  const type = async (id: string) => (await store.getEventType(host.id, id))!;
  const slots = async (id: string, day: { from: Date; to: Date }) => (await freeSlots(store, host, await type(id), day.from, day.to, NOW)).map((d) => d.toISOString());
  return { store, slots };
}

const iso = (...times: string[]) => times.map((t) => new Date(t).toISOString());

describe("slots per schedule", () => {
  it("an event type with no schedule books against the default; one with a schedule against its own hours", async () => {
    const { slots } = setup();
    expect(await slots("clinic", FRI)).toEqual(iso("2030-03-29T04:30:00Z", "2030-03-29T05:30:00Z")); // 10:00, 11:00 IST
    expect(await slots("online", FRI)).toEqual(iso("2030-03-29T08:30:00Z", "2030-03-29T09:30:00Z")); // 14:00, 15:00 IST
  });

  it("reads hours in the schedule's own time zone, across the UK clock change", async () => {
    const { slots } = setup();
    expect(await slots("uk", FRI)).toEqual(iso("2030-03-29T09:00:00Z", "2030-03-29T10:00:00Z")); // 09:00, 10:00 GMT
    expect(await slots("uk", MON)).toEqual(iso("2030-04-01T08:00:00Z", "2030-04-01T09:00:00Z")); // 09:00, 10:00 BST
  });

  it("changing a schedule's zone moves its slots and leaves the other schedules alone", async () => {
    const { store, slots } = setup();
    await store.updateSchedule(host.id, "sch_uk", { name: "UK clients", timezone: "Asia/Kolkata" });
    expect(await slots("uk", FRI)).toEqual(iso("2030-03-29T03:30:00Z", "2030-03-29T04:30:00Z"));
    expect(await slots("online", FRI)).toEqual(iso("2030-03-29T08:30:00Z", "2030-03-29T09:30:00Z"));
  });

  it("a date override changes only its own schedule", async () => {
    const { store, slots } = setup();
    await store.saveDateOverride(host.id, "sch_online", "2030-03-29", []);
    await store.saveDateOverride(host.id, "sch_uk", "2030-03-29", [{ from: "12:00", to: "13:00" }]);
    expect(await slots("online", FRI)).toEqual([]);
    expect(await slots("uk", FRI)).toEqual(iso("2030-03-29T12:00:00Z"));
    expect(await slots("clinic", FRI)).toEqual(iso("2030-03-29T04:30:00Z", "2030-03-29T05:30:00Z"));
  });

  it("days off go on one schedule or on all of them", async () => {
    const { store, slots } = setup();
    const all = await store.listSchedules(host.id);
    for (const id of blockTargets("one", "sch_uk", all)) await store.blockDateRange(host.id, id, "2030-03-29", "2030-03-29");
    expect(await slots("uk", FRI)).toEqual([]);
    expect(await slots("clinic", FRI)).toHaveLength(2);
    for (const id of blockTargets("all", "sch_uk", all)) await store.blockDateRange(host.id, id, "2030-03-29", "2030-03-29");
    for (const id of ["clinic", "online", "uk"]) expect(await slots(id, FRI)).toEqual([]);
  });

  it("a booking on one schedule blocks the same time on the others, and so does calendar busy time", async () => {
    const { store, slots } = setup();
    expect(await slots("online", FRI)).toHaveLength(2);
    // A UK client books 09:00–10:00 UTC Friday: the online hour 08:30–09:30 and 09:30–10:30 both overlap it.
    await store.createBooking({ eventTypeId: "uk", startAt: new Date("2030-03-29T09:00:00Z"), idempotencyKey: "uk-fri-0900",
      invitee: { name: "Tom", email: "tom@example.co.uk", timezone: "Europe/London", phone: null, answers: [] } });
    expect(await slots("online", FRI)).toEqual([]);
    expect(await slots("uk", FRI)).toEqual(iso("2030-03-29T10:00:00Z"));
    expect(await slots("clinic", FRI)).toHaveLength(2); // 04:30 and 05:30 UTC don't touch it
  });
});

describe("managing schedules", () => {
  it("lists the default first with the event types on each; null falls back to the default", async () => {
    const { store } = setup();
    const all = await store.listSchedules(host.id);
    expect(all.map((s) => [s.name, s.isDefault, s.eventTypes.map((e) => e.id)])).toEqual([
      ["Clinic", true, ["clinic"]], ["Online", false, ["online"]], ["UK clients", false, ["uk"]],
    ]);
  });

  it("won't delete a schedule event types use, names them, and moves them in the same step when asked", async () => {
    const { store, slots } = setup();
    const refused = await store.deleteSchedule(host.id, "sch_online").catch((e) => e);
    expect(refused).toBeInstanceOf(ScheduleInUseError);
    expect((refused as ScheduleInUseError).eventTypes).toEqual([{ id: "online", name: "online" }]);
    expect((await store.listSchedules(host.id)).map((s) => s.id)).toContain("sch_online");

    await store.deleteSchedule(host.id, "sch_online", { moveTo: "sch_uk" });
    expect((await store.listSchedules(host.id)).map((s) => s.id)).toEqual(["sch_clinic", "sch_uk"]);
    expect((await store.getEventType(host.id, "online"))!.scheduleId).toBe("sch_uk");
    expect(await slots("online", FRI)).toEqual(await slots("uk", FRI));
  });

  it("won't delete the default, or move event types to a schedule that isn't the host's", async () => {
    const { store } = setup();
    await expect(store.deleteSchedule(host.id, "sch_clinic")).rejects.toBeInstanceOf(DefaultScheduleError);
    await expect(store.deleteSchedule(host.id, "sch_online", { moveTo: "sch_ravi" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.deleteSchedule(other.id, "sch_online")).rejects.toBeInstanceOf(NotFoundError);
    expect(await store.listSchedules(host.id)).toHaveLength(3);
  });

  it("Free keeps one schedule; Solo and Duo keep as many as they like", async () => {
    expect([LIMITS.free.schedules, LIMITS.solo.schedules, LIMITS.duo.schedules]).toEqual([1, Infinity, Infinity]);
    const { store } = setup();
    await expect(store.createSchedule(other.id, { name: "Evenings" }, LIMITS.free.schedules)).rejects.toBeInstanceOf(ScheduleLimitError);
    expect(await store.listSchedules(other.id)).toHaveLength(1);
    const made = await store.createSchedule(other.id, { name: "Evenings", timezone: "Europe/London" }, LIMITS.solo.schedules);
    expect(made).toMatchObject({ name: "Evenings", timezone: "Europe/London", isDefault: false });
    expect((await store.getSchedule(other.id, made.id)).rules.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5]);
  });

  it("duplicating copies hours, overrides and zone; names are unique per host in any case", async () => {
    const { store } = setup();
    await store.saveDateOverride(host.id, "sch_uk", "2030-03-29", []);
    const copy = await store.createSchedule(host.id, { name: "Copy of UK clients", copyFrom: "sch_uk" }, Infinity);
    const [a, b] = await Promise.all([store.getSchedule(host.id, "sch_uk"), store.getSchedule(host.id, copy.id)]);
    expect(b.schedule.timezone).toBe("Europe/London");
    const shape = (rules: AvailabilityRule[]) => rules.map(({ kind, weekday, onDate, intervals }) => ({ kind, weekday, onDate, intervals }));
    expect(shape(b.rules)).toEqual(shape(a.rules));
    await expect(store.createSchedule(host.id, { name: "online" }, Infinity)).rejects.toBeInstanceOf(ScheduleNameTakenError);
    await expect(store.updateSchedule(host.id, copy.id, { name: "CLINIC", timezone: "Asia/Kolkata" })).rejects.toBeInstanceOf(ScheduleNameTakenError);
    await expect(store.createSchedule(host.id, { name: "x", copyFrom: "sch_ravi" }, Infinity)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a new default takes over event types without a schedule; picking a schedule checks it is the host's", async () => {
    const { store, slots } = setup();
    await store.setDefaultSchedule(host.id, "sch_uk");
    expect((await store.listSchedules(host.id)).filter((s) => s.isDefault).map((s) => s.id)).toEqual(["sch_uk"]);
    expect(await slots("clinic", FRI)).toEqual(await slots("uk", FRI));

    await expect(store.setEventTypeSchedule(host.id, "clinic", "sch_ravi")).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.setEventTypeSchedule(other.id, "clinic", "sch_ravi")).rejects.toBeInstanceOf(NotFoundError);
    expect((await store.setEventTypeSchedule(host.id, "clinic", "sch_online")).scheduleId).toBe("sch_online");
    expect(await slots("clinic", FRI)).toEqual(await slots("online", FRI));
  });

  it("a schedule id that isn't the host's falls back to their default rather than leaking another host's hours", async () => {
    const { store } = setup();
    expect((await store.getSchedule(host.id, "sch_ravi")).schedule.id).toBe("sch_clinic");
    expect((await store.getSchedule(host.id, null)).schedule.id).toBe("sch_clinic");
  });
});
