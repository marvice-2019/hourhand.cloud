// B12: GET /dashboard/bookings/export. Real route on the in-memory store; only the session, auth switch and plan are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@/lib/data/memory-store";
import { buildSeed } from "@/lib/data/seed";
import type { Plan } from "@/lib/billing/plans";

const store = createMemoryStore(buildSeed(new Date()));
const state = {
  ctx: null as null | { host: { id: string; timezone: string }; actor: { id: string }; acting: boolean },
  plan: "solo" as Plan,
};

vi.mock("@/lib/data", () => ({ store }));
vi.mock("@/lib/auth/session", () => ({ getHostContext: async () => state.ctx }));
vi.mock("@/lib/auth/auth", () => ({ authEnabled: () => true }));
vi.mock("@/lib/data/pg-store", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/billing/account", () => ({ hostPlan: async () => state.plan }));

async function get(query = "") {
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/dashboard/bookings/export${query}`));
}

describe("downloading bookings (B12)", () => {
  let host: { id: string; timezone: string };
  beforeEach(async () => {
    const u = (await store.getUserBySlug("priya"))!;
    host = { id: u.id, timezone: u.timezone };
    state.ctx = { host, actor: { id: u.id }, acting: false };
    state.plan = "solo";
  });

  it("refuses when signed out", async () => {
    state.ctx = null;
    expect((await get()).status).toBe(401);
  });

  it("refuses on the free plan", async () => {
    state.plan = "free";
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "plan_required" });
  });

  it("refuses a second person managing someone else's account", async () => {
    state.ctx = { host, actor: { id: "usr_second" }, acting: true };
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "owner_only" });
  });

  it("sends the owner's matching bookings as CSV", async () => {
    const seeded = await store.listBookings(host.id);
    const res = await get("?view=all");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="bookings-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toMatch(/^Date,Start,End,Time zone,Event type,Guest name/);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length - 1).toBeLessThanOrEqual(seeded.length);
    const nobody = (await (await get("?q=no-such-guest-anywhere")).text()).trim().split("\r\n");
    expect(nobody).toHaveLength(1);
  });
});
