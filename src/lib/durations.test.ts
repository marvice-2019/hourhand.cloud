import { describe, expect, it } from "vitest";
import { handleCreateBooking, handleGetSlots } from "./booking";
import { createMemoryStore } from "./data/memory-store";
import { buildSeed } from "./data/seed";
import type { AvailabilityRule, EventType } from "./data/types";
import { durationChoices, priceFor, resolveDuration, withDuration } from "./durations";
import { NEW_EVENT_TYPE_FORM, toForm, validateEventType, type EventTypeForm } from "./event-types";
import { handleReschedule } from "./manage";
import { computeSlots, type SlotInput } from "./slots";

// 2026-10-12 is a Monday. India is UTC+05:30 all year.
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const weekly = (weekday: number, intervals: { from: string; to: string }[]): AvailabilityRule => ({ id: `w${weekday}`, scheduleId: "s", kind: "weekly", weekday, onDate: null, intervals });
const times = (slots: Date[]) => slots.map((d) => d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }));

const multi: SlotInput["eventType"] & Pick<EventType, "priceMinor" | "durationOptions"> = {
  id: "et", durationMinutes: 30, startIncrementMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, bookingWindowDays: 60,
  dailyLimit: null, weeklyLimit: null, priceMinor: 50_000,
  durationOptions: [{ minutes: 30, priceMinor: null }, { minutes: 60, priceMinor: 90_000 }, { minutes: 90, priceMinor: null }],
};

function input(eventType: SlotInput["eventType"], over: Partial<SlotInput> = {}): SlotInput {
  return {
    eventType, schedule: { timezone: "Asia/Kolkata" }, rules: [weekly(1, [{ from: "10:00", to: "13:00" }])], busyBlocks: [], bookings: [],
    now: ist("2026-10-11", "00:00"), rangeStart: ist("2026-10-12", "00:00"), rangeEnd: ist("2026-10-13", "00:00"), syncStale: false, ...over,
  };
}
/** A confirmed booking of this event type, `minutes` long, with the type's buffers around it. */
const booked = (start: Date, minutes: number, before = 0, after = 0) => ({
  eventTypeId: "et", status: "confirmed" as const, holdExpiresAt: null, startAt: start,
  bufferedStart: new Date(start.getTime() - before * 60_000), bufferedEnd: new Date(start.getTime() + (minutes + after) * 60_000),
});

describe("lengths and prices", () => {
  it("lists every length shortest first with its own price, falling back to the event's price", () => {
    expect(durationChoices(multi)).toEqual([{ minutes: 30, priceMinor: 50_000 }, { minutes: 60, priceMinor: 90_000 }, { minutes: 90, priceMinor: 50_000 }]);
    expect(priceFor(multi, 60)).toBe(90_000);
    expect(priceFor(multi, 90)).toBe(50_000);
  });

  it("an event type with one length offers only that one, as before", () => {
    const single = { durationMinutes: 45, priceMinor: null, durationOptions: [] };
    expect(durationChoices(single)).toEqual([{ minutes: 45, priceMinor: null }]);
    expect(resolveDuration(single, undefined)).toBe(45);
    expect(resolveDuration(single, 45)).toBe(45);
    expect(resolveDuration(single, 60)).toBeNull();
    expect(withDuration(single, 45)).toBe(single);
  });

  it("only an offered length resolves", () => {
    expect(resolveDuration(multi, null)).toBe(30);
    expect(resolveDuration(multi, 90)).toBe(90);
    expect(resolveDuration(multi, 45)).toBeNull();
  });
});

describe("slots per length", () => {
  it("a longer length ends its last start earlier in the same hours", () => {
    expect(times(computeSlots(input(withDuration(multi, 30))))).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]);
    expect(times(computeSlots(input(withDuration(multi, 60))))).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00"]);
    expect(times(computeSlots(input(withDuration(multi, 90))))).toEqual(["10:00", "10:30", "11:00", "11:30"]);
  });

  it("buffers sit around each booking's own length, whichever length is being offered", () => {
    const buffered = { ...multi, startIncrementMinutes: 15, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 };
    // A 60-minute booking at 10:00 holds 09:45 to 11:15.
    const bookings = [booked(ist("2026-10-12", "10:00"), 60, 15, 15)];
    const short = times(computeSlots(input(withDuration(buffered, 30), { bookings })));
    expect(short).not.toContain("11:15"); // its own before-buffer (11:00) overlaps the booking's after-buffer
    expect(short).toContain("11:30"); // buffered 11:15 to 12:15 only touches
    // A 90-minute choice needs room for itself plus buffers: 11:30 + 90 = 13:00, the end of the hours.
    expect(times(computeSlots(input(withDuration(buffered, 90), { bookings })))).toEqual(["11:30"]);
  });

  it("daily and weekly limits count sessions, not minutes, across lengths", () => {
    const limited = { ...multi, dailyLimit: 2 };
    const bookings = [booked(ist("2026-10-12", "10:00"), 30), booked(ist("2026-10-12", "11:00"), 90)];
    expect(computeSlots(input(withDuration(limited, 30), { bookings }))).toEqual([]);
    expect(computeSlots(input(withDuration(limited, 60), { bookings }))).toEqual([]);
    const weeklyLimited = { ...multi, weeklyLimit: 2 };
    expect(computeSlots(input(withDuration(weeklyLimited, 90), { bookings }))).toEqual([]);
    expect(computeSlots(input(withDuration({ ...multi, dailyLimit: 3 }, 30), { bookings }))).not.toEqual([]);
  });
});

describe("event type editor: other lengths", () => {
  const form = (over: Partial<EventTypeForm>): EventTypeForm => ({ ...NEW_EVENT_TYPE_FORM, name: "Coaching", ...over });

  it("saves the main length plus the others, shortest first, each with its own price or the event's", () => {
    const r = validateEventType(form({ durationMinutes: "45", price: "499", durations: [{ minutes: "90", price: "899" }, { minutes: "30", price: "" }] }), []);
    expect(r).toMatchObject({ ok: true, value: { durationMinutes: 45, priceMinor: 49_900, durationOptions: [
      { minutes: 30, priceMinor: null }, { minutes: 45, priceMinor: null }, { minutes: 90, priceMinor: 89_900 },
    ] } });
  });

  it("no other lengths means none: an existing single-length form saves exactly as before", () => {
    expect(validateEventType(form({}), [])).toMatchObject({ ok: true, value: { durationMinutes: 30, durationOptions: [] } });
    const { durations: _, ...older } = form({});
    void _;
    expect(validateEventType(older, [])).toMatchObject({ ok: true, value: { durationOptions: [] } });
    // Blank rows are ignored.
    expect(validateEventType(form({ durations: [{ minutes: "", price: "" }] }), [])).toMatchObject({ ok: true, value: { durationOptions: [] } });
  });

  it("refuses duplicates, bad lengths, too many, a price on a free event, and a group class", () => {
    const err = (over: Partial<EventTypeForm>) => {
      const r = validateEventType(form(over), []);
      return r.ok ? null : r.errors.durations;
    };
    expect(err({ durations: [{ minutes: "30", price: "" }] })).toMatch(/twice/);
    expect(err({ durations: [{ minutes: "3", price: "" }] })).toMatch(/between/);
    expect(err({ durations: [{ minutes: "abc", price: "" }] })).toMatch(/between/);
    expect(err({ durations: ["45", "60", "90", "120"].map((minutes) => ({ minutes, price: "" })) })).toMatch(/up to 4/);
    expect(err({ durations: [{ minutes: "60", price: "899" }] })).toMatch(/price first/);
    expect(err({ durations: [{ minutes: "60", price: "x" }] })).toBeTruthy();
    expect(err({ seats: "10", durations: [{ minutes: "60", price: "" }] })).toMatch(/group class/);
    expect(err({ durations: "60" as unknown as EventTypeForm["durations"] })).toBeTruthy();
  });

  it("loads saved lengths back into the editor without the main one", () => {
    const seed = buildSeed(new Date("2026-10-10T04:00:00Z"));
    const et = { ...seed.eventTypes[0], durationMinutes: 45, priceMinor: 49_900, currency: "INR" as const, durationOptions: [{ minutes: 45, priceMinor: null }, { minutes: 60, priceMinor: 69_900 }] };
    expect(toForm(et, undefined).durations).toEqual([{ minutes: "60", price: "699" }]);
    expect(toForm({ ...et, durationOptions: [] }, undefined).durations).toEqual([]);
  });
});

describe("booking a picked length (memory store)", () => {
  const now = new Date("2026-10-10T04:00:00Z");
  const DAY = 86_400_000;
  /** The demo data, with coaching (45 min, 10-minute buffers) also offered at 60 and 90 minutes. */
  function fresh(maxRepeats = 1) {
    const seed = buildSeed(now);
    const coaching = seed.eventTypes.find((e) => e.id === "evt_coaching")!;
    coaching.durationOptions = [{ minutes: 45, priceMinor: null }, { minutes: 60, priceMinor: null }, { minutes: 90, priceMinor: null }];
    coaching.maxRepeats = maxRepeats;
    return createMemoryStore(seed);
  }
  const slots = async (store: ReturnType<typeof fresh>, extra: Record<string, string> = {}, event = "coaching") =>
    handleGetSlots(store, new URLSearchParams({ slug: "priya", event, from: now.toISOString(), to: new Date(now.getTime() + 30 * DAY).toISOString(), ...extra }), now);
  const list = (res: { body: unknown }) => (res.body as { slots: string[] }).slots;
  const book = (store: ReturnType<typeof fresh>, start: string, extra: Record<string, unknown> = {}) =>
    handleCreateBooking(store, {
      slug: "priya", event: "coaching", start, name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata", answers: { q_goal: "Practice." }, idempotencyKey: `dur-${Math.random()}`, ...extra,
    }, now);

  it("offers fewer times for a longer length, and refuses a length that isn't offered", async () => {
    const store = fresh();
    const base = list(await slots(store));
    const long = list(await slots(store, { duration: "90" }));
    expect(long.length).toBeGreaterThan(0);
    expect(long.length).toBeLessThan(base.length);
    expect(list(await slots(store, { duration: "45" }))).toEqual(base);
    expect(await slots(store, { duration: "50" })).toMatchObject({ status: 400, body: { fields: { duration: expect.any(String) } } });
    expect(await slots(store, { duration: "ninety" })).toMatchObject({ status: 400 });
  });

  it("a single-length event type behaves exactly as before", async () => {
    const store = fresh();
    const base = list(await slots(store, {}, "intro"));
    expect(list(await slots(store, { duration: "15" }, "intro"))).toEqual(base);
    expect(await slots(store, { duration: "30" }, "intro")).toMatchObject({ status: 400 });
  });

  it("books the picked length with the event's buffers around it, and refuses a length that isn't offered", async () => {
    const store = fresh();
    const start = list(await slots(store, { duration: "90" }))[0];
    const res = await book(store, start, { duration: 90 });
    expect(res.status).toBe(201);
    const b = (await store.listBookings("usr_priya")).find((x) => x.id === (res.body as { bookingId: string }).bookingId)!;
    expect((b.endAt.getTime() - b.startAt.getTime()) / 60_000).toBe(90);
    expect((b.bufferedEnd.getTime() - b.bufferedStart.getTime()) / 60_000).toBe(110);
    expect(await book(store, start, { duration: 50 })).toMatchObject({ status: 400 });
    expect(await book(store, start, { duration: "90" })).toMatchObject({ status: 400 });
  });

  it("a time open for 45 minutes but not 90 is refused for 90", async () => {
    const store = fresh();
    const short = list(await slots(store));
    const long = new Set(list(await slots(store, { duration: "90" })));
    const onlyShort = short.find((s) => !long.has(s))!;
    expect(onlyShort).toBeDefined();
    expect(await book(store, onlyShort, { duration: 90 })).toMatchObject({ status: 409, body: { error: "slot_taken" } });
    expect(await book(store, onlyShort)).toMatchObject({ status: 201 });
  });

  it("weekly repeats book every week at the picked length", async () => {
    const store = fresh(3);
    const open = list(await slots(store, { duration: "60" }));
    const set = new Set(open.map((s) => new Date(s).getTime()));
    const start = open.find((s) => [1, 2].every((w) => set.has(new Date(s).getTime() + w * 7 * DAY)))!;
    expect(await book(store, start, { duration: 60, weeks: 3 })).toMatchObject({ status: 201 });
    const series = (await store.listBookings("usr_priya")).filter((b) => b.seriesId !== null);
    expect(series).toHaveLength(3);
    expect(series.map((b) => (b.endAt.getTime() - b.startAt.getTime()) / 60_000)).toEqual([60, 60, 60]);
  });

  it("a moved booking keeps its length, and the manage page's times are for that length", async () => {
    const store = fresh();
    const open = list(await slots(store, { duration: "90" }));
    const res = (await book(store, open[0], { duration: 90 })).body as { bookingId: string; manageToken: string };
    // Its own time doesn't block it, so the times are the 90-minute ones from before it was booked.
    expect(list(await slots(store, { token: res.manageToken }))).toEqual(open);
    const moved = await handleReschedule(store, res.manageToken, { start: open[3], idempotencyKey: "move-dur-0001" }, now);
    expect(moved.status).toBe(201);
    const b = (await store.listBookings("usr_priya")).find((x) => x.id === (moved.body as { bookingId: string }).bookingId)!;
    expect((b.endAt.getTime() - b.startAt.getTime()) / 60_000).toBe(90);
  });
});
