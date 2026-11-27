// B16: an empty stretch of the booking page says where the next open time is, and the look-ahead finds the same
// first time a plain scan of the whole booking window would.
import { describe, expect, it } from "vitest";
import { freeSlotSeats, handleGetSlots, nextOpenTime } from "./booking";
import { createMemoryStore } from "./data/memory-store";
import { buildSeed } from "./data/seed";

const DAY = 86_400_000;
const now = new Date("2026-10-10T04:00:00Z");
const fresh = () => createMemoryStore(buildSeed(now));
const ist = (date: string) => new Date(`${date}T00:00:00+05:30`);
const dateIn = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function priyaCoaching(store: ReturnType<typeof fresh>) {
  const found = await store.getPublicEventType("priya", "coaching");
  if (!found) throw new Error("seed has no priya/coaching");
  return found;
}

/** Days off on Priya's coaching schedule, `days` of them starting `first`. */
async function closeDays(store: ReturnType<typeof fresh>, first: string, days: number) {
  const { host, eventType } = await priyaCoaching(store);
  const { schedule } = await store.getSchedule(host.id, eventType.scheduleId);
  for (let i = 0; i < days; i++) await store.saveDateOverride(host.id, schedule.id, dateIn(ist(first).getTime() + i * DAY + 12 * 3_600_000), []);
}

async function slots(store: ReturnType<typeof fresh>, from: Date, to: Date, next?: boolean) {
  const params = new URLSearchParams({ slug: "priya", event: "coaching", from: from.toISOString(), to: to.toISOString(), tz: "Asia/Kolkata" });
  if (next) params.set("next", "1");
  const res = await handleGetSlots(store, params, now);
  expect(res.status).toBe(200);
  return res.body as { slots: string[]; next?: string | null };
}

describe("next open time on the slots API", () => {
  it("an empty range asked with next=1 names the first open time after it", async () => {
    const store = fresh();
    await closeDays(store, "2026-10-20", 5);
    const empty = await slots(store, ist("2026-10-20"), ist("2026-10-23"), true);
    expect(empty.slots).toEqual([]);
    const after = await slots(store, ist("2026-10-23"), ist("2026-11-23"));
    expect(after.slots.length).toBeGreaterThan(0);
    expect(empty.next).toBe(after.slots[0]);
    expect(Date.parse(empty.next!)).toBeGreaterThanOrEqual(ist("2026-10-25").getTime()); // the closed days stay closed
  });

  it("says nothing about the next time unless asked, or when the range has times", async () => {
    const store = fresh();
    await closeDays(store, "2026-10-20", 3);
    expect(await slots(store, ist("2026-10-20"), ist("2026-10-23"))).not.toHaveProperty("next");
    expect(await slots(store, ist("2026-10-26"), ist("2026-10-28"), true)).not.toHaveProperty("next");
  });

  it("says null when nothing is left in the booking window", async () => {
    const store = fresh();
    await closeDays(store, "2026-10-10", 62); // the whole 60-day window, and then some
    const body = await slots(store, ist("2026-10-12"), ist("2026-11-12"), true);
    expect(body).toEqual(expect.objectContaining({ slots: [], next: null }));
  });
});

describe("nextOpenTime", () => {
  it("looks past one 62-day slice and finds what a scan of the whole window finds", async () => {
    const store = fresh();
    await closeDays(store, "2026-10-10", 70);
    const { host, eventType } = await priyaCoaching(store);
    const wide = { ...eventType, bookingWindowDays: 120 };
    const scan = await freeSlotSeats(store, host, wide, now, new Date(now.getTime() + 120 * DAY), now);
    expect(scan.length).toBeGreaterThan(0);
    const found = await nextOpenTime(store, host, wide, now, now);
    expect(found?.toISOString()).toBe(scan[0].start.toISOString());
    expect(found!.getTime()).toBeGreaterThan(now.getTime() + 62 * DAY);
    // Started anywhere, it agrees with the scan's first time at or after that point.
    for (const offsetDays of [0, 30, 61.5, 62, 75, 100]) {
      const after = new Date(now.getTime() + offsetDays * DAY);
      const expected = scan.find((s) => s.start >= after)?.start.toISOString() ?? null;
      expect((await nextOpenTime(store, host, wide, after, now))?.toISOString() ?? null, `after +${offsetDays}d`).toBe(expected);
    }
  });

  it("a one-off meeting looks up to its last time, past the booking window", async () => {
    const store = fresh();
    const times = [new Date(now.getTime() + 3 * DAY), new Date(now.getTime() + 90 * DAY)];
    const { eventType } = await store.createOneOffMeeting("usr_priya", { name: "Review", durationMinutes: 30, location: { kind: "google_meet" }, times }, now);
    const { host } = await priyaCoaching(store);
    expect((await nextOpenTime(store, host, eventType, new Date(now.getTime() + 4 * DAY), now))?.toISOString()).toBe(times[1].toISOString());
    expect(await nextOpenTime(store, host, eventType, new Date(now.getTime() + 91 * DAY), now)).toBeNull();
  });
});
