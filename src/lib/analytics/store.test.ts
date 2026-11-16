// Booking analytics against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_analytics).
// The CSV, beacon and booking-safety tests at the top need no database.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { handleCreateBooking, handleGetSlots, type FunnelStep } from "../booking";
import { createMemoryStore } from "../data/memory-store";
import { buildSeed } from "../data/seed";
import { createRateLimiter } from "../rate-limit";
import { beaconKey, handleBeacon, BEACON_LIMIT } from "./beacon";
import { EMPTY_SOURCE } from "./source";
import { analyticsCsv, analyticsReport, csvCell, dayOf, resetSaltCache, rollupAnalytics, track, type AnalyticsReport } from "./store";

const BASE = process.env.TEST_DATABASE_URL;
const PERSON = "Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const OTHER_PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

describe("CSV export", () => {
  it("quotes and defuses cells a spreadsheet would run as formulas", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+91 98765")).toBe(`"'+91 98765"`);
    expect(csvCell("-1")).toBe(`"'-1"`);
    expect(csvCell("@sum")).toBe(`"'@sum"`);
    expect(csvCell("a,b")).toBe(`"a,b"`);
    expect(csvCell("line\nbreak")).toBe(`"line\nbreak"`);
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(null)).toBe("");
  });

  it("writes one line per source plus a total, with rates", () => {
    const r: AnalyticsReport = {
      days: 30, from: "2026-10-17", to: "2026-11-15", eventTypeId: null, profileViews: 3,
      funnel: { views: 20, slotClicks: 8, started: 5, completed: 4 },
      sources: [
        { channel: "whatsapp", channelLabel: "WhatsApp", source: "whatsapp", medium: "", campaign: "=cmd|' /c calc'!A1", embed: false, views: 10, slotClicks: 5, started: 3, completed: 3 },
        { channel: "embed", channelLabel: "Your website (embed)", source: "priya, coaching.in", medium: "", campaign: "", embed: true, views: 10, slotClicks: 3, started: 2, completed: 1 },
      ],
      byEventType: [],
    };
    expect(analyticsCsv(r).split("\r\n")).toEqual([
      "Channel,Source,Medium,Campaign,Embedded,Views,Slot clicks,Started,Completed,View to booking %,Started to booking %",
      `WhatsApp,whatsapp,,"'=cmd|' /c calc'!A1",no,10,5,3,3,30,100`,
      `Your website (embed),"priya, coaching.in",,,yes,10,3,2,1,10,50`,
      "Total,,,,,20,8,5,4,20,80",
      "",
    ]);
  });
});

describe("analytics never breaks a booking", () => {
  const now = new Date("2026-10-10T04:00:00Z");
  const good = (start: string, key: string) => ({
    slug: "priya", event: "coaching", start, name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata",
    answers: { q_goal: "Planning a career move." }, idempotencyKey: key,
  });
  const firstSlot = async (store: ReturnType<typeof createMemoryStore>) => {
    const params = new URLSearchParams({ slug: "priya", event: "coaching", from: now.toISOString(), to: new Date(now.getTime() + 14 * 86_400_000).toISOString() });
    return ((await handleGetSlots(store, params, now)).body as { slots: string[] }).slots[0];
  };

  it("reports a started and a completed step for a new booking, and nothing more for a repeat", async () => {
    const store = createMemoryStore(buildSeed(now));
    const steps: FunnelStep[] = [];
    const slot = await firstSlot(store);
    const res = await handleCreateBooking(store, good(slot, "key-analytics-1"), now, undefined, null, (s) => steps.push(s));
    expect(res.status).toBe(201);
    const { bookingId } = res.body as { bookingId: string };
    expect(steps.map((s) => s.kind)).toEqual(["booking_started", "booking_created"]);
    expect(steps[1].bookingId).toBe(bookingId);
    await handleCreateBooking(store, good(slot, "key-analytics-1"), now, undefined, null, (s) => steps.push(s));
    expect(steps).toHaveLength(2);
  });

  it("still books when the analytics reporter throws", async () => {
    const store = createMemoryStore(buildSeed(now));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleCreateBooking(store, good(await firstSlot(store), "key-analytics-2"), now, undefined, null, () => { throw new Error("analytics db down"); });
    expect(res.status).toBe(201);
    expect(error).toHaveBeenCalledWith("[analytics] funnel step not reported", expect.any(Error));
    error.mockRestore();
  });

  it("track() swallows a failing insert instead of rejecting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { query: async () => { throw new Error("connection refused"); } };
    await expect(track(broken, { headers: new Headers({ "user-agent": PERSON }), clientKey: "1.2.3.4" }, { hostId: "h", eventTypeId: null, kind: "view", source: EMPTY_SOURCE })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("[analytics] event not recorded", expect.any(Error));
    error.mockRestore();
    resetSaltCache();
  });
});

describe("slot-click beacon", () => {
  const found = { host: { id: "host-1" }, eventType: { id: "et-1" } };
  const store = { getPublicEventType: async (slug: string, event: string) => (slug === "priya" && event === "coaching" ? found : null) } as never;
  const ok = JSON.stringify({ kind: "slot_click", slug: "priya", event: "coaching", src: { utmSource: "whatsapp" } });
  const deps = (o: { body?: string; headers?: Record<string, string>; limiter?: ReturnType<typeof createRateLimiter> } = {}) => ({
    store, limiter: o.limiter ?? createRateLimiter(), clientKey: "203.0.113.9", db: { query: async () => ({ rows: [] }) } as never,
    headers: new Headers({ "user-agent": PERSON, host: "hourhand.cloud", origin: "https://hourhand.cloud", ...o.headers }), body: o.body ?? ok,
  });

  it("accepts a well-formed beacon for a real page", async () => {
    expect(await handleBeacon(deps())).toBeTypeOf("function");
  });
  it("ignores unknown pages, other kinds, bad JSON, big bodies, other sites, bots and opted-out guests", async () => {
    expect(await handleBeacon(deps({ body: JSON.stringify({ kind: "slot_click", slug: "nobody", event: "coaching" }) }))).toBeNull();
    expect(await handleBeacon(deps({ body: JSON.stringify({ kind: "booking_created", slug: "priya", event: "coaching" }) }))).toBeNull();
    expect(await handleBeacon(deps({ body: "{not json" }))).toBeNull();
    expect(await handleBeacon(deps({ body: JSON.stringify({ kind: "slot_click", slug: "priya", event: "coaching", pad: "x".repeat(3000) }) }))).toBeNull();
    expect(await handleBeacon(deps({ headers: { origin: "https://evil.example" } }))).toBeNull();
    expect(await handleBeacon(deps({ headers: { "user-agent": "curl/8.4.0" } }))).toBeNull();
    expect(await handleBeacon(deps({ headers: { dnt: "1" } }))).toBeNull();
    expect(await handleBeacon(deps({ headers: { "sec-gpc": "1" } }))).toBeNull();
  });
  it("rate-limits per hashed address", async () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < BEACON_LIMIT.max; i++) expect(await handleBeacon(deps({ limiter }))).not.toBeNull();
    expect(await handleBeacon(deps({ limiter }))).toBeNull();
    expect(beaconKey("203.0.113.9")).not.toContain("203.0.113.9");
  });
});

describe.skipIf(!BASE)("analytics (Postgres)", () => {
  let pool: pg.Pool;
  let host: string;
  let other: string;
  let coaching: string;
  let intro: string;
  const now = new Date("2026-11-15T10:00:00Z");
  const ctx = (o: { ua?: string; ip?: string; extra?: Record<string, string> } = {}) => ({ headers: new Headers({ "user-agent": o.ua ?? PERSON, ...o.extra }), clientKey: o.ip ?? "198.51.100.7" });
  const daysAgo = (n: number, h = 10) => new Date(Date.UTC(2026, 10, 15 - n, h));
  const count = async (where = "true", params: unknown[] = []) => Number((await pool.query(`select count(*) from analytics_events where ${where}`, params)).rows[0].count);
  let k = 0;
  const booking = async (status = "confirmed", by: string | null = null) => {
    k += 1;
    const start = new Date(Date.UTC(2026, 11, 1, k));
    const end = new Date(start.getTime() + 3_600_000);
    const { rows: [b] } = await pool.query(
      `insert into bookings (event_type_id, host_id, start_at, end_at, buffered_start, buffered_end, status, idempotency_key, cancelled_at, cancelled_by, hold_expires_at)
       values ($1, $2, $3, $4, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [coaching, host, start, end, status, `an-${k}`, status === "cancelled" ? start : null, by, status === "pending_payment" ? end : null]);
    return b.id as string;
  };

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_analytics`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const admin = new URL(BASE!);
    admin.pathname = "/postgres";
    const c = new pg.Client({ connectionString: admin.toString() });
    await c.connect();
    try {
      await c.query(`drop database if exists ${name} with (force)`);
      await c.query(`create database ${name}`);
    } finally {
      await c.end();
    }
    await migrate(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    host = (await pool.query("insert into users (email, name, slug) values ('an@example.com', 'An Host', 'anhost') returning id")).rows[0].id;
    other = (await pool.query("insert into users (email, name, slug) values ('an2@example.com', 'Other', 'anothr') returning id")).rows[0].id;
    const et = async (u: string, nm: string, slug: string) => (await pool.query("insert into event_types (user_id, name, slug, duration_minutes) values ($1, $2, $3, 60) returning id", [u, nm, slug])).rows[0].id;
    coaching = await et(host, "Coaching", "coaching");
    intro = await et(host, "Intro", "intro");
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query("truncate analytics_events, analytics_daily, analytics_rollups, analytics_salts");
    resetSaltCache();
  });

  it("counts a visitor's view once a day per page, and again on a new day", async () => {
    const view = (o: Parameters<typeof ctx>[0] = {}, at = now, eventTypeId: string | null = coaching) =>
      track(pool, ctx(o), { hostId: host, eventTypeId, kind: "view", source: { ...EMPTY_SOURCE, utmSource: "whatsapp" } }, at);
    await view();
    await view({}, new Date(now.getTime() + 3_600_000)); // same visitor, an hour later: not again
    await view({}, now, intro); // same visitor, another page: counted
    await view({ ip: "198.51.100.8" }); // another address
    await view({ ua: OTHER_PERSON }); // another browser on the same address
    expect(await count("kind = 'view'")).toBe(4);
    await view({}, daysAgo(-1)); // tomorrow: a fresh salt, so a fresh count
    expect(await count("kind = 'view'")).toBe(5);
    // The two days' hashes for the same person differ, and only tomorrow's salt is left.
    const { rows } = await pool.query("select distinct visitor_hash from analytics_events where event_type_id = $1 and user_id = $2 order by 1", [coaching, host]);
    expect(rows.length).toBe(4);
    expect(Number((await pool.query("select count(*) from analytics_salts")).rows[0].count)).toBe(1);
  });

  it("stores no address or browser string", async () => {
    await track(pool, ctx({ ip: "198.51.100.77" }), { hostId: host, eventTypeId: coaching, kind: "view", source: EMPTY_SOURCE }, now);
    const { rows: [r] } = await pool.query("select row_to_json(e)::text as row from analytics_events e");
    expect(r.row).not.toContain("198.51.100.77");
    expect(r.row).not.toContain("Android");
    expect(r.row).toMatch(/"visitor_hash":"[0-9a-f]{32}"/);
  });

  it("skips guests with Do Not Track or Global Privacy Control, and bots", async () => {
    const input = { hostId: host, eventTypeId: coaching, kind: "view" as const, source: EMPTY_SOURCE };
    await track(pool, ctx({ extra: { dnt: "1" } }), input, now);
    await track(pool, ctx({ extra: { "sec-gpc": "1" } }), input, now);
    await track(pool, ctx({ ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }), input, now);
    await track(pool, ctx({ ua: "WhatsApp/2.23.20.0 A" }), input, now);
    expect(await count()).toBe(0);
    await track(pool, ctx(), input, now);
    expect(await count()).toBe(1);
  });

  async function funnelDay(at: Date) {
    const confirmed = await booking();
    const lapsed = await booking("cancelled", "system");
    const cancelledLater = await booking("cancelled", "guest");
    const step = (kind: "view" | "slot_click" | "booking_started", ip: string, source = EMPTY_SOURCE, et: string | null = coaching) =>
      track(pool, ctx({ ip }), { hostId: host, eventTypeId: et, kind, source }, at);
    const wa = { ...EMPTY_SOURCE, utmSource: "whatsapp", utmCampaign: "diwali" };
    const site = { ...EMPTY_SOURCE, refDomain: "priyacoaching.in", embed: true };
    for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) await step("view", ip, wa);
    await step("slot_click", "10.0.0.1", wa);
    await step("slot_click", "10.0.0.2", wa);
    await step("booking_started", "10.0.0.1", wa);
    await step("booking_started", "10.0.0.2", wa);
    await step("view", "10.0.0.4", site);
    await step("slot_click", "10.0.0.4", site);
    await step("booking_started", "10.0.0.4", site);
    await step("view", "10.0.0.5", EMPTY_SOURCE, null); // profile page
    const created = (id: string, source: typeof wa) => track(pool, ctx(), { hostId: host, eventTypeId: coaching, kind: "booking_created", bookingId: id, source }, at);
    await created(confirmed, wa);
    await created(cancelledLater, wa); // booked, then cancelled by the guest: still a booking that came in
    await created(lapsed, site); // a payment hold that lapsed: never a booking
    await created(confirmed, wa); // a repeat: counted once
    // Another host's traffic never shows in this host's report.
    await track(pool, ctx({ ip: "10.9.9.9" }), { hostId: other, eventTypeId: null, kind: "view", source: wa }, at);
  }

  it("reports the funnel and sources, the same before and after the rollup, then prunes on schedule", async () => {
    await funnelDay(daysAgo(5));
    const before = await analyticsReport(pool, host, { days: 7 }, now);
    expect(before.funnel).toEqual({ views: 4, slotClicks: 3, started: 3, completed: 2 });
    expect(before.profileViews).toBe(1);
    expect(before.sources.map((s) => [s.channel, s.source, s.campaign, s.embed, s.views, s.completed])).toEqual([
      ["whatsapp", "whatsapp", "diwali", false, 3, 2],
      ["embed", "priyacoaching.in", "", true, 1, 0],
    ]);
    expect(before.byEventType).toEqual([{ eventTypeId: coaching, name: "Coaching", views: 4, slotClicks: 3, started: 3, completed: 2 }]);
    expect((await analyticsReport(pool, host, { days: 7, eventTypeId: intro }, now)).funnel).toEqual({ views: 0, slotClicks: 0, started: 0, completed: 0 });
    expect((await analyticsReport(pool, other, { days: 7 }, now)).profileViews).toBe(1);

    // Today and yesterday stay raw; the day five days ago is rolled once, and reads the same.
    await funnelDay(now);
    const r1 = await rollupAnalytics(pool, now);
    expect(r1.rolledDays).toEqual([dayOf(daysAgo(5))]);
    expect((await rollupAnalytics(pool, now)).rolledDays).toEqual([]);
    const after = await analyticsReport(pool, host, { days: 7 }, now);
    expect(after.funnel).toEqual({ views: 8, slotClicks: 6, started: 6, completed: 4 });
    expect((await analyticsReport(pool, host, { days: 3 }, now)).funnel).toEqual({ views: 4, slotClicks: 3, started: 3, completed: 2 });
    // A booking cancelled after its day was rolled still counts: the total was frozen with it in.
    expect(Number((await pool.query("select sum(completed) from analytics_daily where user_id = $1", [host])).rows[0].sum)).toBe(2);

    // 91 days on: the raw rows of the old day are gone, its totals stay; 731 days on, the totals go too.
    const later = new Date(daysAgo(5).getTime() + 91 * 86_400_000);
    await rollupAnalytics(pool, later);
    expect(await count("day = $1", [dayOf(daysAgo(5))])).toBe(0);
    expect(Number((await pool.query("select count(*) from analytics_daily where day = $1", [dayOf(daysAgo(5))])).rows[0].count)).toBeGreaterThan(0);
    expect(Number((await pool.query("select count(*) from analytics_salts where day < $1", [dayOf(later)])).rows[0].count)).toBe(0);
    await rollupAnalytics(pool, new Date(daysAgo(5).getTime() + 731 * 86_400_000));
    expect(Number((await pool.query("select count(*) from analytics_daily where day = $1", [dayOf(daysAgo(5))])).rows[0].count)).toBe(0);
  });

  it("windows the report by day", async () => {
    await funnelDay(daysAgo(10));
    expect((await analyticsReport(pool, host, { days: 7 }, now)).funnel.views).toBe(0);
    expect((await analyticsReport(pool, host, { days: 30 }, now)).funnel.views).toBe(4);
  });
});
