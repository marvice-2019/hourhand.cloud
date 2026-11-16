// Zoom links against real Postgres, with an in-process fake of Zoom. Runs only with TEST_DATABASE_URL; uses its own
// database (<name>_zoom), dropped and recreated on every run.
import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { saveConnection } from "../calendar/connections";
import { eventIdFor, type EventInput, type GoogleClient } from "../calendar/google";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import type { Mail, Mailer } from "../mail/mailer";
import { MAX_ATTEMPTS, MEET_LINK_WAIT_SECONDS, processDueNotifications } from "../jobs/worker";
import { ZoomApiError, type ZoomClient, type ZoomMeetingInput, type ZoomTokens } from "./client";
import { disconnectZoom, saveZoomConnection, zoomAccessToken, zoomStatus, type ZoomDeps } from "./connection";
import { handleZoomWebhook } from "./webhook";

const BASE = process.env.TEST_DATABASE_URL;
const baseUrl = "https://hourhand.test";
const guest = { name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata", phone: null, answers: [] };
const HOUR = 3_600_000;
/** Zoom meeting ids are unique across every fake in the run, as real ones are. */
let nextMeetingId = 81_000_000_000;

/** Just enough of Zoom: rotating refresh tokens and meetings, with switches to make each call fail. */
function fakeZoom() {
  const s = {
    meetings: new Map<string, ZoomMeetingInput>(),
    refreshes: 0, creates: 0, updates: 0, deletes: 0,
    usedRefreshTokens: [] as string[],
    revoked: [] as string[],
    failRefresh: null as ZoomApiError | null,
    failCreate: null as ZoomApiError | null,
    /** Create answers 401 this many times, as Zoom does for an access token it ended early. */
    unauthorizedCreates: 0,
    createTokens: [] as string[],
  };
  const client = {
    authUrl: () => "https://zoom.test/oauth/authorize",
    async exchangeCode(): Promise<ZoomTokens> { throw new Error("not used"); },
    async refresh(rt: string): Promise<ZoomTokens> {
      if (s.failRefresh) throw s.failRefresh;
      // Zoom rotates: a refresh token works once.
      if (s.usedRefreshTokens.includes(rt)) throw new ZoomApiError("Zoom token endpoint 401 invalid_grant", { status: 401, revoked: true });
      s.usedRefreshTokens.push(rt);
      s.refreshes++;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: `at-${s.refreshes}`, refreshToken: `rt-${s.refreshes}`, expiresAt: new Date(Date.now() + HOUR), scope: "" };
    },
    async revoke(t: string) { s.revoked.push(t); },
    missingScopes: () => [],
    async me() { return { id: "zu-priya", email: "priya@zoom.test", accountId: "acc" }; },
    async createMeeting(t: string, m: ZoomMeetingInput) {
      s.createTokens.push(t);
      if (s.unauthorizedCreates > 0) { s.unauthorizedCreates--; throw new ZoomApiError("Zoom POST /users/me/meetings 401 (124)", { status: 401, code: 124, retryable: true }); }
      if (s.failCreate) throw s.failCreate;
      s.creates++;
      const id = String(nextMeetingId++);
      s.meetings.set(id, m);
      return { id, joinUrl: `https://zoom.us/j/${id}?pwd=pw${id.slice(-3)}` };
    },
    async updateMeeting(_t: string, id: string, m: ZoomMeetingInput) {
      if (!s.meetings.has(id)) return false;
      s.updates++;
      s.meetings.set(id, m);
      return true;
    },
    async deleteMeeting(_t: string, id: string) { s.deletes++; s.meetings.delete(id); },
  };
  return { client: client as unknown as ZoomClient, s };
}

/** Just enough of Google Calendar to see what location a booked event carries. */
function fakeGoogle() {
  const events = new Map<string, EventInput>();
  const g = {
    async busy(_t: string, ids: string[]) { return { busy: new Map(ids.map((id) => [id, []])), errors: new Map() }; },
    async insertEvent(_t: string, _c: string, e: EventInput) { const id = eventIdFor(e.bookingId); events.set(id, e); return { id, joinUrl: null, conferencePending: false }; },
    async getEvent(_t: string, _c: string, id: string) { return { id, joinUrl: null, conferencePending: false }; },
    async moveEvent(_t: string, _c: string, id: string) { return { id, joinUrl: null, conferencePending: false }; },
    async deleteEvent(_t: string, _c: string, id: string) { events.delete(id); },
  };
  return { google: g as unknown as GoogleClient, events };
}

function recordingMailer() {
  const sent: Mail[] = [];
  const mailer: Mailer = { async send(m) { sent.push(m); return { id: `m-${sent.length}` }; } };
  return { mailer, sent };
}

describe.skipIf(!BASE)("Zoom links (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let zoomCall: EventType;
  let zoomClass: EventType;
  const key = randomBytes(32);
  let slot = 0;
  const nextStart = () => new Date(Date.UTC(2033, 0, 5 + slot++, 4, 0));

  const connectZoom = (expiresAt = new Date(Date.now() + HOUR), refreshToken = "rt-0") =>
    saveZoomConnection(pool, key, priya.id, { id: "zu-priya", email: "priya@zoom.test", accountId: "acc" }, { accessToken: "at-0", refreshToken, expiresAt, scope: "meeting:write:meeting" });
  const book = (et = zoomCall, startAt = nextStart()) => store.createBooking({ eventTypeId: et.id, startAt, idempotencyKey: `zoom-${slot}-${Math.random()}`, invitee: guest });
  const queue = async (bookingId: string) =>
    (await pool.query("select kind, channel, status, attempts, last_error from notifications where booking_id = $1 order by kind", [bookingId])).rows;
  const job = async (bookingId: string, kind: string) => (await queue(bookingId)).find((q) => q.kind === kind);
  const booking = async (id: string) => (await pool.query("select join_url, zoom_meeting_id, status from bookings where id = $1", [id])).rows[0];
  const integration = async () => (await pool.query("select * from integrations where user_id = $1 and provider = 'zoom'", [priya.id])).rows[0];
  const alerts = async () => (await pool.query(
    "select status, recipient from notifications where kind = 'zoom_alert_host' and dedupe_key like 'zoom:' || (select id from integrations where user_id = $1 and provider = 'zoom') || ':%'", [priya.id])).rows;
  const bookedMails = (sent: Mail[]) => sent.filter((m) => m.to === guest.email && m.subject.startsWith("Booked"));
  const run = (zoom: ZoomDeps | null, mailer = recordingMailer().mailer, now?: Date, google?: GoogleClient) =>
    processDueNotifications(pool, mailer, { baseUrl, zoom, now, calendar: google ? { providers: { google }, key } : null });
  /** Hold the Zoom job as if another worker had it, so the confirmation sees a link still coming. */
  const holdZoomJob = (bookingId: string) =>
    pool.query("update notifications set locked_until = now() + interval '1 hour' where booking_id = $1 and channel = 'video'", [bookingId]);

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_zoom`;
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
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    const coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
    const make = async (name: string, slug: string, group: boolean) => {
      const { rows: [et] } = await pool.query(
        `insert into event_types (user_id, name, slug, duration_minutes, booking_window_days, kind, seat_limit)
         select user_id, $2, $3, duration_minutes, booking_window_days, $4, $5 from event_types where id = $1 returning id`,
        [coaching.id, name, slug, group ? "group" : "one_on_one", group ? 10 : null]);
      await pool.query("insert into event_locations (event_type_id, kind, value, position) values ($1, 'zoom', null, 0)", [et.id]);
      return (await store.listEventTypes(priya.id)).find((e) => e.id === et.id)!;
    };
    zoomCall = await make("Zoom call", "zoom-call", false);
    zoomClass = await make("Zoom class", "zoom-class", true);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from calendar_connections");
    await pool.query("delete from integrations where provider = 'zoom'");
    await pool.query("update notifications set status = 'skipped' where status = 'queued'");
  });

  describe("connecting", () => {
    it("stores the tokens sealed, and a reconnect clears an outage", async () => {
      const id = await connectZoom();
      const row = await integration();
      expect(row).toMatchObject({ id, status: "ok", public_id: "zu-priya", account_email: "priya@zoom.test" });
      expect(row.credentials_encrypted.toString("utf8")).not.toContain("rt-0");
      await pool.query("update integrations set status = 'disconnected', alert_sent_at = now(), last_error = 'x' where id = $1", [id]);
      expect(await connectZoom()).toBe(id);
      expect(await integration()).toMatchObject({ status: "ok", alert_sent_at: null, last_error: null });
      expect(await zoomStatus(pool, priya.id)).toEqual({ state: "connected", email: "priya@zoom.test" });
    });

    it("disconnecting revokes the grant and removes the tokens; bookings keep their link", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      const b = await book();
      await run({ client, key });
      const link = (await booking(b.id)).join_url;
      expect(link).toMatch(/^https:\/\/zoom\.us\/j\//);
      await disconnectZoom(pool, { client, key }, priya.id);
      expect(s.revoked).toEqual(["at-0"]);
      expect(await integration()).toBeUndefined();
      expect((await store.getBooking(priya.id, b.id))!.joinUrl).toBe(link);
    });
  });

  describe("tokens", () => {
    it("refreshes an expiring token once, even with two callers at once, and stores the rotated refresh token", async () => {
      const { client, s } = fakeZoom();
      await connectZoom(new Date(Date.now() + 30_000));
      const deps = { client, key };
      const [a, b] = await Promise.all([zoomAccessToken(pool, deps, priya.id), zoomAccessToken(pool, deps, priya.id)]);
      expect([a, b]).toEqual(["at-1", "at-1"]);
      expect(s.refreshes).toBe(1);
      // The next refresh uses the rotated token: the old one would be refused.
      await pool.query("update integrations set updated_at = now()"); // no-op; the stored token is what matters
      expect(await zoomAccessToken(pool, deps, priya.id, new Date(Date.now() + 2 * HOUR))).toBe("at-2");
      expect(s.usedRefreshTokens).toEqual(["rt-0", "rt-1"]);
    });

    it("a refused refresh disconnects Zoom and emails the host once", async () => {
      const { client, s } = fakeZoom();
      await connectZoom(new Date(Date.now() - 1000));
      s.failRefresh = new ZoomApiError("Zoom token endpoint 401 invalid_grant", { status: 401, revoked: true });
      const b1 = await book();
      const b2 = await book();
      await run({ client, key });
      // The first job fails; the other sees the connection is gone and doesn't call Zoom again.
      const jobs = [await job(b1.id, "zoom_create"), await job(b2.id, "zoom_create")].map((j) => `${j.status}: ${j.last_error}`).sort();
      expect(jobs).toEqual([expect.stringMatching(/^failed: Zoom token endpoint 401/), "skipped: Zoom is not connected"]);
      expect(await integration()).toMatchObject({ status: "disconnected" });
      expect((await integration()).credentials_encrypted.length).toBe(0);
      expect(await alerts()).toHaveLength(1);
      const { mailer, sent } = recordingMailer();
      await run({ client, key }, mailer);
      const alert = sent.find((m) => m.subject.startsWith("Reconnect Zoom"));
      expect(alert?.text).toContain("keep their Zoom links");
      expect(await alerts()).toEqual([expect.objectContaining({ status: "sent" })]);
      // New Zoom bookings no longer queue a meeting; the guest's confirmation isn't held.
      const b3 = await book();
      expect(await job(b3.id, "zoom_create")).toBeUndefined();
    });

    it("an access token Zoom refuses (401) is refreshed once and the call retried", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      s.unauthorizedCreates = 1;
      const b = await book();
      await run({ client, key });
      expect(s.createTokens).toEqual(["at-0", "at-1"]);
      expect(await job(b.id, "zoom_create")).toMatchObject({ status: "sent" });
    });
  });

  describe("booking lifecycle", () => {
    it("makes a meeting per booking with the decided settings; the confirmation waits for it and carries the link", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      const b = await book();
      expect(b.locationKind).toBe("zoom");
      expect(await job(b.id, "zoom_create")).toMatchObject({ channel: "video", status: "queued" });
      const { mailer, sent } = recordingMailer();
      await run({ client, key }, mailer);
      await run({ client, key }, mailer); // the runner goes round again for a confirmation the Zoom job released
      const after = (await store.getBooking(priya.id, b.id))!;
      expect(after.joinUrl).toMatch(/^https:\/\/zoom\.us\/j\/\d+\?pwd=/);
      const [m] = [...s.meetings.values()];
      expect(m).toMatchObject({ topic: "Zoom call with Meera Iyer", durationMinutes: zoomCall.durationMinutes, timeZone: priya.timezone });
      expect(m.start.toISOString()).toBe(b.startAt.toISOString());
      const confirmations = bookedMails(sent);
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0].text).toContain(after.joinUrl!);
    });

    it("holds the confirmation while the Zoom job runs, and never longer than the video-link limit", async () => {
      const { client } = fakeZoom();
      await connectZoom();
      const b = await book();
      await holdZoomJob(b.id);
      const { mailer, sent } = recordingMailer();
      await run({ client, key }, mailer);
      expect(bookedMails(sent)).toHaveLength(0);
      expect(await job(b.id, "booked_guest")).toMatchObject({ status: "queued", last_error: "waiting for the video link" });
      await run({ client, key }, mailer, new Date(Date.now() + (MEET_LINK_WAIT_SECONDS + 5) * 1000));
      expect(bookedMails(sent)).toHaveLength(1);
    });

    it("a reschedule moves the same meeting, and a cancellation deletes it", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      const b = await book();
      await run({ client, key });
      const first = await booking(b.id);
      const newStart = nextStart();
      const moved = await store.rescheduleBooking(priya.id, b.id, newStart, `zoom-move-${slot}`);
      const { mailer, sent } = recordingMailer();
      await run({ client, key }, mailer);
      await run({ client, key }, mailer);
      expect(s.creates).toBe(1);
      expect(s.updates).toBe(1);
      expect(s.meetings.get(first.zoom_meeting_id)!.start.toISOString()).toBe(newStart.toISOString());
      expect(await booking(moved.id)).toMatchObject({ zoom_meeting_id: first.zoom_meeting_id, join_url: first.join_url });
      expect(sent.find((m) => m.to === guest.email && m.text.includes(first.join_url))).toBeTruthy();

      await store.cancelBooking(priya.id, moved.id, "guest");
      await run({ client, key });
      expect(s.meetings.size).toBe(0);
      expect(await job(moved.id, "zoom_delete")).toMatchObject({ status: "sent" });
    });

    it("a move whose meeting was deleted in Zoom makes a new one", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      const b = await book();
      await run({ client, key });
      s.meetings.clear();
      const moved = await store.rescheduleBooking(priya.id, b.id, nextStart(), `zoom-move-${slot}`);
      await run({ client, key });
      expect(s.creates).toBe(2);
      expect((await booking(moved.id)).join_url).not.toBe((await booking(b.id)).join_url);
    });

    it("the host's calendar event carries the Zoom link", async () => {
      const { client } = fakeZoom();
      const { google, events } = fakeGoogle();
      await connectZoom();
      await saveConnection(pool, key, priya.id, "google", { accessToken: "at", refreshToken: "rt", expiresAt: new Date(Date.now() + HOUR), scope: "", email: "priya@gmail.com" },
        [{ id: "priya@gmail.com", name: "Priya", primary: true, accessRole: "owner" }], new Date());
      const b = await book();
      await run({ client, key }, undefined, undefined, google);
      await run({ client, key }, undefined, undefined, google);
      const link = (await booking(b.id)).join_url;
      expect(events.get(eventIdFor(b.id))!.location).toBe(`Zoom: ${link}`);
    });

    it("cancelling while the meeting is still being made waits for it, then deletes it", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      const b = await book();
      await holdZoomJob(b.id);
      await store.cancelBooking(priya.id, b.id, "guest");
      await run({ client, key });
      expect(await job(b.id, "zoom_delete")).toMatchObject({ status: "queued", last_error: "another Zoom write is running" });
      // The running create finishes (simulated: its worker wrote the meeting), then the delete removes it.
      const made = await client.createMeeting("at", { topic: "t", start: b.startAt, durationMinutes: 30, timeZone: "UTC" });
      await pool.query("update bookings set zoom_meeting_id = $2, join_url = $3 where id = $1", [b.id, made.id, made.joinUrl]);
      await pool.query("update notifications set status = 'sent', locked_until = null where booking_id = $1 and kind = 'zoom_create'", [b.id]);
      await run({ client, key }, undefined, new Date(Date.now() + 30_000));
      expect(s.meetings.size).toBe(0);
    });

    it("seats of one group class share one meeting; it's deleted when the last seat cancels", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      const at = nextStart();
      const a = await book(zoomClass, at);
      const b = await book(zoomClass, at);
      await run({ client, key });
      expect(s.creates).toBe(1);
      const [ma, mb] = [await booking(a.id), await booking(b.id)];
      expect(ma.zoom_meeting_id).toBe(mb.zoom_meeting_id);
      expect(ma.join_url).toBe(mb.join_url);
      expect([...s.meetings.values()][0].topic).toBe("Zoom class");
      await store.cancelBooking(priya.id, a.id, "guest");
      await run({ client, key });
      expect(await job(a.id, "zoom_delete")).toMatchObject({ status: "skipped", last_error: "another booking still uses this Zoom meeting" });
      expect(s.meetings.size).toBe(1);
      await store.cancelBooking(priya.id, b.id, "guest");
      await run({ client, key });
      expect(s.meetings.size).toBe(0);
    });
  });

  describe("failures", () => {
    it("a failing Zoom retries in the background; the confirmation goes without the link instead of waiting", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      s.failCreate = new ZoomApiError("Zoom POST /users/me/meetings 503", { status: 503, retryable: true });
      const b = await book();
      const { mailer, sent } = recordingMailer();
      await run({ client, key }, mailer);
      await run({ client, key }, mailer);
      expect(bookedMails(sent)).toHaveLength(1);
      expect(await job(b.id, "zoom_create")).toMatchObject({ status: "queued", attempts: 1 });
      // Zoom recovers: the next attempt (a minute later) makes the meeting.
      s.failCreate = null;
      await run({ client, key }, mailer, new Date(Date.now() + 2 * 60_000));
      expect(await job(b.id, "zoom_create")).toMatchObject({ status: "sent" });
      expect((await booking(b.id)).join_url).toMatch(/zoom\.us/);
    });

    it("gives up cleanly after the last attempt, and a non-retryable error fails at once", async () => {
      const { client, s } = fakeZoom();
      await connectZoom();
      s.failCreate = new ZoomApiError("Zoom POST /users/me/meetings 503", { status: 503, retryable: true });
      const b = await book();
      let at = Date.now();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await run({ client, key }, undefined, new Date(at));
        at += 3 * HOUR;
      }
      expect(await job(b.id, "zoom_create")).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
      expect((await booking(b.id)).join_url).toBeNull();
      expect(await integration()).toMatchObject({ status: "ok" }); // an outage isn't a revoked grant

      s.failCreate = new ZoomApiError("Zoom POST /users/me/meetings 400 (3161)", { status: 400, code: 3161 });
      const c = await book();
      await run({ client, key });
      expect(await job(c.id, "zoom_create")).toMatchObject({ status: "failed", attempts: 1 });
    });

    it("without Zoom configured on the server, Zoom jobs are skipped and the confirmation isn't held up", async () => {
      await connectZoom();
      const b = await book();
      const { mailer, sent } = recordingMailer();
      await run(null, mailer);
      await run(null, mailer);
      expect(await job(b.id, "zoom_create")).toMatchObject({ status: "skipped", last_error: "Zoom is not configured on this server" });
      expect(bookedMails(sent)).toHaveLength(1);
    });
  });

  describe("deauthorization webhook", () => {
    const secret = "zoom-webhook-secret";
    const signed = (body: object, now = new Date()) => {
      const raw = JSON.stringify(body);
      const ts = String(Math.floor(now.getTime() / 1000));
      return { raw, headers: { timestamp: ts, signature: `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}` } };
    };

    it("answers Zoom's endpoint check", async () => {
      const { raw, headers } = signed({ event: "endpoint.url_validation", payload: { plainToken: "abc" } });
      const reply = await handleZoomWebhook(pool, secret, raw, headers);
      expect(reply).toEqual({ status: 200, body: { plainToken: "abc", encryptedToken: createHmac("sha256", secret).update("abc").digest("hex") } });
    });

    it("a signed app_deauthorized disconnects the host's Zoom once and emails them; bookings keep their link", async () => {
      const { client } = fakeZoom();
      await connectZoom();
      const b = await book();
      await run({ client, key });
      const link = (await booking(b.id)).join_url;
      const event = { event: "app_deauthorized", event_ts: Date.now(), payload: { account_id: "acc", user_id: "zu-priya", signature: "sig-1", deauthorization_time: new Date().toISOString(), client_id: "cid" } };
      const { raw, headers } = signed(event);
      expect(await handleZoomWebhook(pool, secret, raw, headers)).toMatchObject({ status: 200, body: { disconnected: 1 } });
      expect(await integration()).toMatchObject({ status: "disconnected" });
      expect(await alerts()).toHaveLength(1);
      // Zoom retries the same notification: nothing more happens.
      expect(await handleZoomWebhook(pool, secret, raw, headers)).toMatchObject({ status: 200, body: { duplicate: true } });
      expect(await alerts()).toHaveLength(1);
      expect((await booking(b.id)).join_url).toBe(link);
      // A cancel now leaves the meeting in Zoom (there's no grant to delete it with) and the booking as it was.
      await store.cancelBooking(priya.id, b.id, "guest");
      await run({ client, key });
      expect(await job(b.id, "zoom_delete")).toMatchObject({ status: "skipped" });
    });

    it("refuses a request with a bad signature", async () => {
      await connectZoom();
      const { raw, headers } = signed({ event: "app_deauthorized", payload: { user_id: "zu-priya", signature: "sig-2" } });
      expect((await handleZoomWebhook(pool, "wrong-secret", raw, headers)).status).toBe(401);
      expect(await integration()).toMatchObject({ status: "ok" });
    });
  });
});
