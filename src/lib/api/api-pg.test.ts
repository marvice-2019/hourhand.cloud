import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { createRateLimiter } from "../rate-limit";
import { addEndpoint, deleteEndpoint } from "../webhooks/webhooks";
import { API_LIMIT, handleApiRequest } from "./http";
import { authenticateApiKey, createApiKey, deleteApiKey, hashApiKey, listApiKeys, MAX_API_KEYS } from "./keys";
import { getBooking, getMe, listBookings, listEventTypes, type ApiContext } from "./v1";

const BASE = process.env.TEST_DATABASE_URL;
const SITE = "https://hourhand.test";
const guest = { name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata", phone: null, answers: [] };

describe.skipIf(!BASE)("API keys and the read API (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let arun: User;
  let coaching: EventType;
  let slot = 0;
  const nextStart = () => new Date(Date.UTC(2032, 0, 6 + slot++, 4, 0));
  const book = (email = "meera@example.com") =>
    store.createBooking({ eventTypeId: coaching.id, startAt: nextStart(), idempotencyKey: `api-${Math.random()}`, invitee: { ...guest, email } });
  const ctx = (userId: string, now = new Date(Date.UTC(2032, 0, 1))): ApiContext => ({ db: pool, userId, base: SITE, now });
  const get = (key: string | null, answer: Parameters<typeof handleApiRequest>[2], limiter = createRateLimiter()) =>
    handleApiRequest(new Request(`${SITE}/api/v1/x`, { headers: key ? { authorization: `Bearer ${key}` } : {} }), { db: pool, base: SITE, limiter }, answer);

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_api`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const admin = new URL(BASE!);
    admin.pathname = "/postgres";
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    try {
      await client.query(`drop database if exists ${name} with (force)`);
      await client.query(`create database ${name}`);
    } finally {
      await client.end();
    }
    await migrate(u.toString());
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    arun = (await store.getUserBySlug("arun"))!;
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
    await pool.query("delete from calendar_connections");
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("keys", () => {
    it("are made once, listed without the key, kept only as a hash, and found by the whole key only", async () => {
      const made = await createApiKey(pool, priya.id, "  n8n  ");
      if (!made.ok) throw new Error("create failed");
      expect(made.key).toMatch(/^hh_[A-Za-z0-9_-]{43}$/);
      const [listed] = (await listApiKeys(pool, priya.id)).filter((k) => k.id === made.id);
      expect(listed).toMatchObject({ name: "n8n", prefix: made.key.slice(0, 7), lastUsedAt: null });
      expect(JSON.stringify(listed)).not.toContain(made.key);
      const { rows: [row] } = await pool.query("select key_hash from api_keys where id = $1", [made.id]);
      expect(Buffer.compare(row.key_hash, hashApiKey(made.key))).toBe(0);
      const now = new Date();
      expect(await authenticateApiKey(pool, `Bearer ${made.key}`, now)).toEqual({ keyId: made.id, userId: priya.id });
      expect(await authenticateApiKey(pool, `bearer ${made.key}`, now)).toEqual({ keyId: made.id, userId: priya.id });
      expect(await authenticateApiKey(pool, `Bearer ${made.key.slice(0, -1)}x`, now)).toBeNull();
      expect(await authenticateApiKey(pool, made.key, now)).toBeNull();
      expect(await authenticateApiKey(pool, null, now)).toBeNull();
      expect(await deleteApiKey(pool, priya.id, made.id)).toBe(true);
      expect(await authenticateApiKey(pool, `Bearer ${made.key}`, now)).toBeNull();
    });

    it("need a name of up to 60 characters, and stop at the limit per account", async () => {
      expect(await createApiKey(pool, priya.id, "   ")).toEqual({ ok: false, error: "name_missing" });
      expect(await createApiKey(pool, priya.id, "x".repeat(61))).toEqual({ ok: false, error: "name_too_long" });
      const made = [];
      for (let i = 0; i < MAX_API_KEYS; i++) made.push(await createApiKey(pool, priya.id, `key ${i}`));
      expect(made.every((m) => m.ok)).toBe(true);
      expect(await createApiKey(pool, priya.id, "one too many")).toEqual({ ok: false, error: "too_many" });
      expect((await createApiKey(pool, arun.id, "Arun's own")).ok).toBe(true);
      for (const m of made) if (m.ok) await deleteApiKey(pool, priya.id, m.id);
    });

    it("can't be removed by another host", async () => {
      const made = await createApiKey(pool, priya.id, "CRM");
      if (!made.ok) throw new Error("create failed");
      expect(await deleteApiKey(pool, arun.id, made.id)).toBe(false);
      expect(await deleteApiKey(pool, arun.id, "not-a-uuid")).toBe(false);
      expect((await listApiKeys(pool, priya.id)).some((k) => k.id === made.id)).toBe(true);
      await deleteApiKey(pool, priya.id, made.id);
    });

    it("note when they were last used, at most once a minute", async () => {
      const made = await createApiKey(pool, priya.id, "sheet");
      if (!made.ok) throw new Error("create failed");
      const t0 = new Date("2031-05-01T10:00:00Z");
      const lastUsed = async () => (await listApiKeys(pool, priya.id)).find((k) => k.id === made.id)!.lastUsedAt;
      await authenticateApiKey(pool, `Bearer ${made.key}`, t0);
      expect(await lastUsed()).toEqual(t0);
      await authenticateApiKey(pool, `Bearer ${made.key}`, new Date(t0.getTime() + 30_000));
      expect(await lastUsed()).toEqual(t0);
      const t2 = new Date(t0.getTime() + 61_000);
      await authenticateApiKey(pool, `Bearer ${made.key}`, t2);
      expect(await lastUsed()).toEqual(t2);
      await deleteApiKey(pool, priya.id, made.id);
    });
  });

  describe("HTTP", () => {
    it("answers 401 for no key, a bad key and a removed key, the same each time", async () => {
      const made = await createApiKey(pool, priya.id, "gone soon");
      if (!made.ok) throw new Error("create failed");
      await deleteApiKey(pool, priya.id, made.id);
      for (const key of [null, "hh_nope", made.key]) {
        const res = await get(key, getMe);
        expect(res.status).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toMatchObject({ error: "invalid_key" });
      }
    });

    it("answers 429 with retry-after once a key passes its limit for the minute", async () => {
      const made = await createApiKey(pool, priya.id, "busy");
      if (!made.ok) throw new Error("create failed");
      let t = 1_000_000;
      const limiter = createRateLimiter(() => t);
      for (let i = 0; i < API_LIMIT.max; i++) expect((await get(made.key, getMe, limiter)).status).toBe(200);
      const res = await get(made.key, getMe, limiter);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.json()).toMatchObject({ error: "rate_limited" });
      t += API_LIMIT.windowMs;
      expect((await get(made.key, getMe, limiter)).status).toBe(200);
      await deleteApiKey(pool, priya.id, made.id);
    });

    it("answers 503 on a server without the database", async () => {
      const res = await handleApiRequest(new Request(`${SITE}/api/v1/me`), { db: null, base: SITE }, getMe);
      expect(res.status).toBe(503);
    });

    it("answers as the key's owner, with JSON", async () => {
      const made = await createApiKey(pool, arun.id, "arun");
      if (!made.ok) throw new Error("create failed");
      const res = await get(made.key, getMe);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ id: arun.id, name: "Arun Iyer", slug: "arun", timezone: "Asia/Kolkata", booking_page: `${SITE}/arun` });
      await deleteApiKey(pool, arun.id, made.id);
    });
  });

  describe("answers", () => {
    it("lists the host's event types with their booking links, leaving one-off meetings out", async () => {
      await pool.query("update event_types set kind = 'one_off', hidden = true where user_id = $1 and slug <> 'coaching' and id = (select id from event_types where user_id = $1 and slug <> 'coaching' order by position limit 1)", [priya.id]);
      const { rows: [oneOff] } = await pool.query("select id from event_types where user_id = $1 and kind = 'one_off' limit 1", [priya.id]);
      const { status, body } = await listEventTypes(ctx(priya.id));
      expect(status).toBe(200);
      const data = (body as { data: Record<string, unknown>[] }).data;
      expect(data.find((e) => e.slug === "coaching")).toMatchObject({
        id: coaching.id, name: coaching.name, duration_minutes: coaching.durationMinutes, active: true, booking_url: `${SITE}/priya/coaching`,
      });
      if (oneOff) expect(data.some((e) => e.id === oneOff.id)).toBe(false);
      expect(data.every((e) => typeof e.booking_url === "string" && Object.keys(e).length === 9)).toBe(true);
      expect((await listEventTypes(ctx(arun.id))).body).not.toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ id: coaching.id })]) });
    });

    it("filters bookings by status and time, oldest start first", async () => {
      const a = await book();
      const b = await book();
      const c = await book();
      await store.cancelBooking(priya.id, b.id, "host");
      const ids = async (params: string, now?: Date) => {
        const r = await listBookings(ctx(priya.id, now), new URLSearchParams(params));
        expect(r.status).toBe(200);
        return (r.body as { data: { booking: { id: string } }[] }).data.map((d) => d.booking.id).filter((id) => [a.id, b.id, c.id].includes(id));
      };
      expect(await ids("")).toEqual([a.id, b.id, c.id]);
      expect(await ids("status=upcoming")).toEqual([a.id, c.id]);
      expect(await ids("status=cancelled")).toEqual([b.id]);
      expect(await ids("status=past")).toEqual([]);
      const afterA = new Date(new Date(a.endAt).getTime() + 60_000);
      expect(await ids("status=past", afterA)).toEqual([a.id]);
      expect(await ids("status=upcoming", afterA)).toEqual([c.id]);
      expect(await ids(`from=${new Date(b.startAt).toISOString()}`)).toEqual([b.id, c.id]);
      expect(await ids(`to=${new Date(b.startAt).toISOString()}`)).toEqual([a.id]);
      const arunsIds = ((await listBookings(ctx(arun.id), new URLSearchParams("limit=100"))).body as { data: { booking: { id: string } }[] }).data.map((d) => d.booking.id);
      expect(arunsIds.some((id) => [a.id, b.id, c.id].includes(id))).toBe(false);
    });

    it("pages with a cursor until there is no next page, with no booking twice", async () => {
      for (let i = 0; i < 5; i++) await book();
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const params = new URLSearchParams({ limit: "2", ...(cursor ? { cursor } : {}) });
        const { body } = await listBookings(ctx(priya.id), params);
        const page = body as { data: { booking: { id: string } }[]; next_cursor: string | null };
        expect(page.data.length).toBeLessThanOrEqual(2);
        seen.push(...page.data.map((d) => d.booking.id));
        cursor = page.next_cursor;
        pages++;
      } while (cursor && pages < 50);
      const { rows: [{ n }] } = await pool.query("select count(*)::int as n from bookings where host_id = $1", [priya.id]);
      expect(seen).toHaveLength(n);
      expect(new Set(seen).size).toBe(n);
      expect(pages).toBe(Math.ceil(n / 2));
    });

    it("refuses parameters it can't use, naming them", async () => {
      for (const [q, param] of [["status=soon", "status"], ["from=yesterday", "from"], ["to=", "to"], ["limit=0", "limit"], ["limit=101", "limit"], ["limit=2.5", "limit"],
        ["cursor=abc", "cursor"], ["from=2032-02-01T00:00:00Z&to=2032-01-01T00:00:00Z", "to"]] as const) {
        const r = await listBookings(ctx(priya.id), new URLSearchParams(q));
        expect(r, q).toEqual({ status: 400, body: expect.objectContaining({ error: "bad_request", param }) });
      }
    });

    it("gives one booking to its host and 404 to anyone else", async () => {
      const x = await book("guest-x@example.com");
      const mine = await getBooking(ctx(priya.id), x.id);
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ booking: { id: x.id, status: "confirmed" }, guest: { email: "guest-x@example.com" } });
      expect(await getBooking(ctx(arun.id), x.id)).toMatchObject({ status: 404, body: { error: "not_found" } });
      expect(await getBooking(ctx(priya.id), "nope")).toMatchObject({ status: 404 });
    });

    it("sends a booking in the same shape as a webhook's data, with no answers or notes", async () => {
      const ep = await addEndpoint(pool, priya.id, "https://hooks.example.com/api-parity", ["booking.created"], { key: Buffer.alloc(32, 7), lookup: async () => ["93.184.216.34"] });
      if (!ep.ok) throw new Error("add failed");
      const x = await book("parity@example.com");
      const { rows: [d] } = await pool.query("select payload from webhook_deliveries where endpoint_id = $1 and booking_id = $2", [ep.id, x.id]);
      const fromApi = await getBooking(ctx(priya.id), x.id);
      expect(fromApi.body).toEqual(d.payload.data);
      expect(Object.keys(fromApi.body as object).sort()).toEqual(["booking", "event_type", "guest"]);
      await deleteEndpoint(pool, priya.id, ep.id);
    });
  });
});
