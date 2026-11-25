import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { addEndpoint, deleteEndpoint, endpointKey, MAX_ATTEMPTS, processWebhookDeliveries, queuePing, signature, type Sender } from "./webhooks";

const BASE = process.env.TEST_DATABASE_URL;
const guest = { name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata", phone: null, answers: [] };
const key = randomBytes(32);
const publicDns = async () => ["93.184.216.34"];

describe.skipIf(!BASE)("booking webhooks (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let coaching: EventType;
  let slot = 0;
  const nextStart = () => new Date(Date.UTC(2032, 0, 6 + slot++, 4, 0));
  const deliveries = async (endpointId: string) =>
    (await pool.query("select id, event, payload, status, attempts, booking_id from webhook_deliveries where endpoint_id = $1 order by created_at", [endpointId])).rows;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_webhooks`;
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
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
    await pool.query("delete from calendar_connections");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("queues a booking change in the booking's transaction, for the endpoints that want that event", async () => {
    const all = await addEndpoint(pool, priya.id, "https://hooks.example.com/all", ["booking.created", "booking.cancelled", "booking.rescheduled"], { key, lookup: publicDns });
    const cancelsOnly = await addEndpoint(pool, priya.id, "https://hooks.example.com/cancels", ["booking.cancelled"], { key, lookup: publicDns });
    if (!all.ok || !cancelsOnly.ok) throw new Error("add failed");
    const b = await store.createBooking({ eventTypeId: coaching.id, startAt: nextStart(), idempotencyKey: `wh-${Math.random()}`, invitee: guest });
    const [created] = await deliveries(all.id);
    expect(created).toMatchObject({ event: "booking.created", status: "queued", booking_id: b.id });
    expect(created.payload.data.booking.id).toBe(b.id);
    expect(created.payload.data.guest).toMatchObject({ name: "Meera Iyer", email: "meera@example.com" });
    expect(created.payload.data.event_type.slug).toBe("coaching");
    expect(await deliveries(cancelsOnly.id)).toHaveLength(0);
    await deleteEndpoint(pool, priya.id, all.id);
    await deleteEndpoint(pool, priya.id, cancelsOnly.id);
  });

  it("sends signed deliveries, retries failures, and gives up after the last attempt", async () => {
    const ep = await addEndpoint(pool, priya.id, "https://hooks.example.com/flaky", ["booking.created"], { key, lookup: publicDns });
    if (!ep.ok) throw new Error("add failed");
    await store.createBooking({ eventTypeId: coaching.id, startAt: nextStart(), idempotencyKey: `wh-${Math.random()}`, invitee: guest });
    const calls: { body: string; headers: Record<string, string> }[] = [];
    const failing: Sender = async (_url, body, headers) => { calls.push({ body, headers }); return { status: 500, error: null }; };
    let now = new Date();
    await processWebhookDeliveries(pool, now, failing, key);
    expect(calls).toHaveLength(1);
    const secret = await endpointKey(pool, priya.id, ep.id, key);
    const sig = calls[0].headers["Hourhand-Signature"];
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    expect(sig).toBe(signature(secret, calls[0].body, new Date(t * 1000)));
    expect(calls[0].headers["Hourhand-Event"]).toBe("booking.created");
    expect((await deliveries(ep.id))[0]).toMatchObject({ status: "queued", attempts: 1 });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      now = new Date(now.getTime() + 25 * 3_600_000);
      await processWebhookDeliveries(pool, now, failing, key);
    }
    expect((await deliveries(ep.id))[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    await processWebhookDeliveries(pool, new Date(now.getTime() + 25 * 3_600_000), failing, key);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    await deleteEndpoint(pool, priya.id, ep.id);
  });

  it("a test ping goes at once and a 2xx marks it sent", async () => {
    const ep = await addEndpoint(pool, priya.id, "https://hooks.example.com/ping", ["booking.created"], { key, lookup: publicDns });
    if (!ep.ok) throw new Error("add failed");
    await queuePing(pool, priya.id, ep.id, new Date());
    const ok: Sender = async () => ({ status: 204, error: null });
    expect((await processWebhookDeliveries(pool, new Date(), ok, key)).sent).toBe(1);
    expect((await deliveries(ep.id))[0]).toMatchObject({ event: "ping", status: "sent" });
    await deleteEndpoint(pool, priya.id, ep.id);
  });

  it("refuses private URLs, a sixth endpoint, and another host's endpoint", async () => {
    expect(await addEndpoint(pool, priya.id, "https://internal.example.com/x", ["booking.created"], { key, lookup: async () => ["10.0.0.5"] }))
      .toEqual({ ok: false, error: "private_address" });
    expect(await addEndpoint(pool, priya.id, "https://hooks.example.com/x", [], { key, lookup: publicDns })).toEqual({ ok: false, error: "no_events" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await addEndpoint(pool, priya.id, `https://hooks.example.com/${i}`, ["booking.created"], { key, lookup: publicDns });
      if (r.ok) ids.push(r.id);
    }
    expect(await addEndpoint(pool, priya.id, "https://hooks.example.com/6", ["booking.created"], { key, lookup: publicDns })).toEqual({ ok: false, error: "too_many" });
    const other = (await pool.query("select id from users where id <> $1 limit 1", [priya.id])).rows[0];
    expect(other).toBeTruthy();
    await expect(deleteEndpoint(pool, other.id, ids[0])).rejects.toThrow();
    await expect(queuePing(pool, other.id, ids[0], new Date())).rejects.toThrow();
    await expect(endpointKey(pool, other.id, ids[0], key)).rejects.toThrow();
    for (const id of ids) await deleteEndpoint(pool, priya.id, id);
  });
});
