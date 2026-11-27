// B15: checkDay against the demo store agrees with the public booking page and names what blocks a time.
import { describe, expect, it } from "vitest";
import { checkDay, handleCreateBooking, handleGetSlots } from "./booking";
import { createMemoryStore } from "./data/memory-store";
import { buildSeed } from "./data/seed";

const now = new Date("2026-10-10T04:00:00Z");
const fresh = () => createMemoryStore(buildSeed(now));

async function priyaCoaching(store: ReturnType<typeof fresh>) {
  const found = await store.getPublicEventType("priya", "coaching");
  if (!found) throw new Error("seed has no priya/coaching");
  return found;
}

async function pageSlots(store: ReturnType<typeof fresh>, from: Date, to: Date): Promise<string[]> {
  const params = new URLSearchParams({ slug: "priya", event: "coaching", from: from.toISOString(), to: to.toISOString(), tz: "Asia/Kolkata" });
  return ((await handleGetSlots(store, params, now)).body as { slots: string[] }).slots;
}

describe("checkDay", () => {
  it("offers the same open times as the booking page, and names the booking that takes one", async () => {
    const store = fresh();
    const { host, eventType } = await priyaCoaching(store);
    const date = "2026-10-20";
    const before = await checkDay(store, host, eventType, date, now);
    expect(before.timezone).toBe("Asia/Kolkata");
    const open = before.starts.filter((v) => v.reason === null).map((v) => v.start.toISOString());
    expect(open.length).toBeGreaterThan(1);
    expect(open).toEqual(await pageSlots(store, new Date(`${date}T00:00:00+05:30`), new Date(`2026-10-21T00:00:00+05:30`)));

    const res = await handleCreateBooking(store, {
      slug: "priya", event: "coaching", start: open[0], name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata",
      answers: { q_goal: "Planning a career move." }, idempotencyKey: "key-check-day-1",
    }, now);
    expect(res.status).toBe(201);
    const after = await checkDay(store, host, eventType, date, now);
    const taken = after.starts.find((v) => v.start.toISOString() === open[0]);
    expect(taken?.reason).toBe("booking");
    expect(taken?.blocker?.bookingId).toBe((res.body as { bookingId: string }).bookingId);
  });
});
