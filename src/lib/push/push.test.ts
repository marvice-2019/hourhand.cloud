// Phone alerts. The rules are plain unit tests; everything that touches the database runs only with TEST_DATABASE_URL,
// against its own database <name>_push, dropped and recreated on every run.
import pg from "pg";
import webpush from "web-push";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import { queueBookingNotifications } from "../data/notifications";
import type { DataStore, EventType, User } from "../data/types";
import type { Mailer } from "../mail/mailer";
import { processDueNotifications } from "../jobs/worker";
import {
  bookingPushMessage, checkSubscription, countSubscriptions, isPushEndpoint, MAX_DEVICES, pushConfig, pushConfigError,
  removeSubscription, saveSubscription, sendToHost, testPushMessage, type PushDeps, type PushSubscriptionInput,
} from "./push";

const keys = webpush.generateVAPIDKeys();
const env = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:alerts@hourhand.test" };
const P256DH = `B${"a".repeat(86)}`;
const AUTH = "b".repeat(22);
const sub = (id: string): PushSubscriptionInput => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: P256DH, auth: AUTH } });

describe("pushConfig", () => {
  it("is off with no variables, and says what's wrong when some are set or malformed", () => {
    expect(pushConfig({})).toBeNull();
    expect(pushConfigError({})).toBeNull();
    expect(pushConfigError({ VAPID_PUBLIC_KEY: keys.publicKey })).toMatch(/all three/);
    expect(pushConfigError({ ...env, VAPID_SUBJECT: "alerts@hourhand.test" })).toMatch(/VAPID_SUBJECT/);
    expect(pushConfigError({ ...env, VAPID_PRIVATE_KEY: "short" })).toMatch(/VAPID_PRIVATE_KEY/);
    expect(pushConfig({ ...env, VAPID_PRIVATE_KEY: "short" })).toBeNull();
    expect(pushConfig(env)).toEqual({ publicKey: keys.publicKey, privateKey: keys.privateKey, subject: env.VAPID_SUBJECT });
  });
});

describe("isPushEndpoint", () => {
  it("takes the push services of Chrome, Firefox, Safari and Edge", () => {
    for (const u of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
      expect(isPushEndpoint(u), u).toBe(true);
    }
  });

  it("refuses anything else, so a made-up address can't point the server inside its own network", () => {
    for (const u of ["http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com.evil.test/x", "https://127.0.0.1/x",
      "https://user:pw@fcm.googleapis.com/x", "https://localhost/x", "not a url", `https://fcm.googleapis.com/${"x".repeat(1000)}`]) {
      expect(isPushEndpoint(u), u).toBe(false);
    }
  });

  it("checkSubscription wants a push address and both keys", () => {
    expect(checkSubscription(sub("a"))).toEqual(sub("a"));
    expect(checkSubscription({ ...sub("a"), endpoint: "https://10.0.0.1/x" })).toBeNull();
    expect(checkSubscription({ endpoint: sub("a").endpoint, keys: { p256dh: "x", auth: AUTH } })).toBeNull();
    expect(checkSubscription({ endpoint: sub("a").endpoint, keys: { p256dh: P256DH, auth: "bad key!" } })).toBeNull();
    expect(checkSubscription(null)).toBeNull();
  });
});

describe("bookingPushMessage", () => {
  const c = { bookingId: "b1", guestName: "Meera", eventName: "Coaching", startAt: new Date(Date.UTC(2031, 0, 7, 4, 0)), hostTimezone: "Asia/Kolkata", hostTimeFormat: "12h" as const, hostLocale: "en" };

  it("says who, what and when, in the host's time zone and language, and opens the booking", () => {
    const m = bookingPushMessage("booked_host", c);
    expect(m.title).toBe("New booking");
    expect(m.body).toBe("Meera · Coaching · Tue, 7 Jan, 9:30 am");
    expect(m).toMatchObject({ url: "/dashboard/bookings/b1", tag: "booking-b1" });
    expect(bookingPushMessage("cancelled_host", c).title).toBe("Booking cancelled");
    expect(bookingPushMessage("rescheduled_host", { ...c, hostTimeFormat: "24h" }).body).toContain("09:30");
    expect(bookingPushMessage("booked_host", { ...c, hostLocale: "ta" }).title).toBe("புதிய முன்பதிவு");
    expect(bookingPushMessage("booked_host", { ...c, hostLocale: "xx" }).title).toBe("New booking");
    expect(testPushMessage("hi").title).toBe("फ़ोन अलर्ट चालू हैं");
  });
});

const BASE = process.env.TEST_DATABASE_URL;

/** A push sender that records what it sends, or fails with the status it is told to. */
function fakePush(status?: (endpoint: string) => number | null) {
  const sent: { endpoint: string; payload: unknown }[] = [];
  const deps: PushDeps = {
    config: pushConfig(env)!,
    async send(s, payload) {
      const code = status?.(s.endpoint) ?? null;
      if (code) throw Object.assign(new Error(`status ${code}`), { statusCode: code });
      sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
    },
  };
  return { deps, sent };
}
const mailer: Mailer = { async send() { return { id: "fake" }; } };

describe.skipIf(!BASE)("phone alerts (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let other: User;
  let coaching: EventType;
  let slot = 0;
  const guest = { name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata", phone: null, answers: [] };
  const book = () => store.createBooking({ eventTypeId: coaching.id, startAt: new Date(Date.UTC(2031, 0, 6 + slot++, 4, 0)), idempotencyKey: `push-${slot}-${Math.random()}`, invitee: guest });
  const pushRows = async (bookingId: string) =>
    (await pool.query("select kind, recipient, status, last_error from notifications where booking_id = $1 and channel = 'push' order by created_at", [bookingId])).rows;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_push`;
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
    other = (await pool.query("select id from users where id <> $1 limit 1", [priya.id])).rows[0];
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
    await pool.query("delete from calendar_connections");
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query("delete from push_subscriptions");
    await pool.query("update notifications set status = 'skipped' where status = 'queued'");
  });

  it("keeps one row per browser, moves a browser to the account that turned it on last, and caps devices", async () => {
    await saveSubscription(pool, priya.id, sub("a"), "Chrome on Android", new Date());
    await saveSubscription(pool, other.id, sub("a"), "Chrome on Android", new Date());
    expect(await countSubscriptions(pool, priya.id)).toBe(0);
    expect(await countSubscriptions(pool, other.id)).toBe(1);
    for (let i = 0; i < MAX_DEVICES + 2; i++) await saveSubscription(pool, priya.id, sub(`d${i}`), null, new Date(Date.UTC(2030, 0, 1, 0, i)));
    const { rows } = await pool.query("select endpoint from push_subscriptions where user_id = $1", [priya.id]);
    expect(rows).toHaveLength(MAX_DEVICES);
    expect(rows.map((r) => r.endpoint)).not.toContain(sub("d0").endpoint);
    await removeSubscription(pool, priya.id, sub("a").endpoint);
    expect(await countSubscriptions(pool, other.id)).toBe(1); // only the owner can turn a device off
  });

  it("queues a phone alert with the host's email only when alerts are set up and the host has a device", async () => {
    const before = await book();
    await queueBookingNotifications(pool, before.id, "booked", new Date(), { push: true });
    expect(await pushRows(before.id)).toEqual([]);
    await saveSubscription(pool, priya.id, sub("p1"), null, new Date());
    const off = await book();
    await queueBookingNotifications(pool, off.id, "booked", new Date(), { push: false });
    expect(await pushRows(off.id)).toEqual([]);
    const on = await book();
    await queueBookingNotifications(pool, on.id, "booked", new Date(), { push: true });
    expect(await pushRows(on.id)).toEqual([{ kind: "booked_host", recipient: priya.id, status: "queued", last_error: null }]);
    await queueBookingNotifications(pool, on.id, "cancelled", new Date(), { push: true });
    expect((await pushRows(on.id)).map((r) => [r.kind, r.status])).toEqual([["booked_host", "skipped"], ["cancelled_host", "queued"]]);
  });

  it("the worker sends it to every device, and drops a device whose push address is gone", async () => {
    await saveSubscription(pool, priya.id, sub("live"), null, new Date());
    await saveSubscription(pool, priya.id, sub("gone"), null, new Date());
    const b = await book();
    await queueBookingNotifications(pool, b.id, "booked", new Date(), { push: true });
    const { deps, sent } = fakePush((e) => (e.endsWith("/gone") ? 410 : null));
    await processDueNotifications(pool, mailer, { baseUrl: "https://hourhand.test", push: deps });
    expect(sent.map((s) => s.endpoint)).toEqual([sub("live").endpoint]);
    expect(sent[0].payload).toMatchObject({ title: "New booking", url: `/dashboard/bookings/${b.id}` });
    expect((await pushRows(b.id))[0].status).toBe("sent");
    expect(await countSubscriptions(pool, priya.id)).toBe(1);
  });

  it("retries when the push service is down, and skips when alerts are off here or no device is left", async () => {
    await saveSubscription(pool, priya.id, sub("busy"), null, new Date());
    const b = await book();
    await queueBookingNotifications(pool, b.id, "booked", new Date(), { push: true });
    await processDueNotifications(pool, mailer, { baseUrl: "https://hourhand.test", push: fakePush(() => 503).deps });
    expect(await pushRows(b.id)).toEqual([expect.objectContaining({ status: "queued", last_error: expect.stringContaining("503") })]);

    const c = await book();
    await queueBookingNotifications(pool, c.id, "booked", new Date(), { push: true });
    await processDueNotifications(pool, mailer, { baseUrl: "https://hourhand.test", push: null });
    expect((await pushRows(c.id))[0]).toMatchObject({ status: "skipped", last_error: "phone alerts are not set up on this server" });

    const d = await book();
    await queueBookingNotifications(pool, d.id, "booked", new Date(), { push: true });
    await pool.query("delete from push_subscriptions");
    await processDueNotifications(pool, mailer, { baseUrl: "https://hourhand.test", push: fakePush().deps });
    expect((await pushRows(d.id))[0]).toMatchObject({ status: "skipped", last_error: "no device has phone alerts on" });
  });

  it("sendToHost throws only when every device failed for a reason other than a gone address", async () => {
    await saveSubscription(pool, priya.id, sub("x"), null, new Date());
    await expect(sendToHost(pool, fakePush(() => 400).deps, priya.id, testPushMessage("en"), new Date())).rejects.toMatchObject({ retryable: false });
    await expect(sendToHost(pool, fakePush(() => 429).deps, priya.id, testPushMessage("en"), new Date())).rejects.toMatchObject({ retryable: true });
    expect(await sendToHost(pool, fakePush().deps, other.id, testPushMessage("en"), new Date())).toEqual({ sent: 0, removed: 0 });
  });
});
