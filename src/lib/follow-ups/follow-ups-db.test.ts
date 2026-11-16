// Follow-ups against real Postgres: queueing and timing, the worker's skips, group seats, feedback links and opt-outs.
// Runs only with TEST_DATABASE_URL, in its own database (<name>_followups), recreated on every run.
import { NextRequest } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import type { Mail, Mailer } from "../mail/mailer";
import { processDueNotifications } from "../jobs/worker";
import {
  FOLLOW_UPS_OFF, rebookPrefill, applyOptOut, feedbackPage, getFollowUpSettings, listFeedback, saveFollowUpSettings, submitFeedback, type FollowUpSettings,
} from "./follow-ups";
import { feedbackToken, linkKey, optOutToken, rebookToken } from "./tokens";

const BASE = process.env.TEST_DATABASE_URL;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const baseUrl = "https://hourhand.test";
const ENC = "cd".repeat(32);

function fakeMailer() {
  const sent: Mail[] = [];
  const mailer: Mailer = { async send(mail) { sent.push(mail); return { id: `fake-${sent.length}` }; } };
  return { mailer, sent };
}

describe.skipIf(!BASE)("follow-ups (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let coaching: EventType;
  let intro: EventType;
  let yoga: EventType;
  let slot = 0;
  let n = 0;
  const key = linkKey(ENC);
  const ALL_ON: FollowUpSettings = { thankYou: true, feedback: true, reviewAsk: true, packageNudge: true, delayHours: 2 };
  /** A fresh slot far in the future for each booking, so they never overlap. */
  const nextStart = () => new Date(Date.UTC(2032, 0, 5 + slot++, 4, 0));
  const book = (et: EventType = coaching, startAt = nextStart(), guest = { name: "Meera Iyer", email: `meera${++n}@example.com` }, locale: "en" | "ta" = "en") =>
    store.createBooking({ eventTypeId: et.id, startAt, idempotencyKey: `fu-${slot}-${n}-${Math.random()}`, invitee: { ...guest, timezone: "Asia/Kolkata", phone: null, answers: [], locale } });
  const followUps = async (bookingId: string) =>
    (await pool.query("select recipient, status, send_at, last_error, dedupe_key from notifications where booking_id = $1 and kind = 'follow_up_guest'", [bookingId])).rows;
  /** Only follow-ups are left in the queue, so a worker run sends nothing else. */
  const onlyFollowUps = () => pool.query("update notifications set status = 'skipped' where status = 'queued' and kind <> 'follow_up_guest'");
  const run = async (now: Date) => {
    const { mailer, sent } = fakeMailer();
    const result = await processDueNotifications(pool, mailer, { baseUrl, now });
    return { result, sent };
  };

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = ENC;
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_followups`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    // For the one-click route, which reads its database the way the app does.
    process.env.HOURHAND_DATA = "postgres";
    process.env.DATABASE_URL = u.toString();
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
    const types = await store.listEventTypes(priya.id);
    coaching = types.find((e) => e.slug === "coaching")!;
    intro = types.find((e) => e.slug === "intro")!;
    yoga = await store.createEventType(priya.id, {
      name: "Morning yoga", slug: "yoga", description: null, durationMinutes: 60, minNoticeMinutes: 0, bookingWindowDays: 365,
      startIncrementMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, dailyLimit: 1, hidden: false, cancelCutoffMinutes: 0,
      priceMinor: null, currency: intro.currency, maxRepeats: 1, depositMinor: null, redirectUrl: null, weeklyLimit: null, cancelPolicy: null,
      seatLimit: 3, location: null,
    });
    await pool.query("delete from calendar_connections");
    await pool.query("insert into profiles (user_id, reviews_url) values ($1, 'https://g.page/r/priya/review') on conflict (user_id) do update set reviews_url = excluded.reviews_url", [priya.id]);
  });

  afterAll(async () => {
    await pool?.end();
    await (globalThis as { __hourhandPool?: pg.Pool }).__hourhandPool?.end();
  });

  beforeEach(async () => {
    await pool.query("update notifications set status = 'skipped' where status = 'queued'");
    await pool.query("delete from follow_up_settings");
    await pool.query("delete from follow_up_opt_outs");
  });

  describe("off by default", () => {
    it("existing event types have no follow-ups after the migration, and their bookings queue none", async () => {
      expect((await pool.query("select count(*)::int as n from follow_up_settings")).rows[0].n).toBe(0);
      expect(await getFollowUpSettings(pool, priya.id, coaching.id)).toEqual(FOLLOW_UPS_OFF);
      const b = await book();
      expect(await followUps(b.id)).toEqual([]);
    });
  });

  describe("scheduling and timing", () => {
    it("queues one follow-up for the session's end plus 2 hours by default", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book();
      const [row, ...rest] = await followUps(b.id);
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({ recipient: b.invitee.email, status: "queued", dedupe_key: `booking:${b.id}:follow_up_guest` });
      expect(new Date(row.send_at).getTime()).toBe(b.endAt.getTime() + 2 * HOUR);
    });

    it.each([1, 24] as const)("sends %i hours after the end when the host picks it, and moves ones already queued", async (hours) => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book();
      await saveFollowUpSettings(pool, priya.id, coaching.id, { ...ALL_ON, delayHours: hours }, new Date());
      expect(new Date((await followUps(b.id))[0].send_at).getTime()).toBe(b.endAt.getTime() + hours * HOUR);
      const later = await book();
      expect(new Date((await followUps(later.id))[0].send_at).getTime()).toBe(later.endAt.getTime() + hours * HOUR);
    });

    it("switching on covers upcoming bookings made before, not only new ones", async () => {
      const b = await book();
      expect(await followUps(b.id)).toEqual([]);
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      expect(await followUps(b.id)).toHaveLength(1);
    });

    it("sends nothing early, then the email at the chosen time, and never a second one", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book();
      await onlyFollowUps();
      expect((await run(new Date(b.endAt.getTime() + HOUR))).sent).toHaveLength(0);
      const { sent } = await run(new Date(b.endAt.getTime() + 2 * HOUR));
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(b.invitee.email);
      expect(sent[0].subject).toBe(`Thanks for your ${coaching.name} with ${priya.name}`);
      expect(sent[0].text).toMatch(new RegExp(`${baseUrl}/b/feedback/f\\.${b.id}\\.\\d+\\.[A-Za-z0-9_-]{24}\\?r=5`));
      expect(sent[0].text).toMatch(new RegExp(`${baseUrl}/priya/coaching\\?rebook=r\\.${b.id}\\.\\d+\\.[A-Za-z0-9_-]{24}\\s`));
      // No guest details in any link: not the address, not the name, not a ?name=/&email= prefill.
      for (const body of [sent[0].text, sent[0].html]) {
        expect(body).not.toContain(b.invitee.email);
        expect(body).not.toContain(encodeURIComponent(b.invitee.email));
        expect(body).not.toMatch(/[?&](name|email)=/);
      }
      expect(sent[0].text).toContain(`${baseUrl}/b/stop/o.${priya.id}.`);
      // Queueing again (a retried transaction, a re-save) and running again send nothing more.
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      expect((await run(new Date(b.endAt.getTime() + 3 * HOUR))).sent).toHaveLength(0);
      expect((await followUps(b.id)).map((r) => r.status)).toEqual(["sent"]);
    });

    it("writes the email in the language the guest booked in", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book(coaching, nextStart(), { name: "Kiran", email: "kiran@example.com" }, "ta");
      await onlyFollowUps();
      const { sent } = await run(new Date(b.endAt.getTime() + 2 * HOUR));
      expect(sent[0].subject).toBe(`${priya.name} உடன் உங்கள் ${coaching.name}-க்கு நன்றி`);
      expect(sent[0].text).toContain("lang=ta");
    });
  });

  describe("skips", () => {
    const sendTime = (b: { endAt: Date }) => new Date(b.endAt.getTime() + 2 * HOUR);

    it("a cancelled booking", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book();
      await store.cancelBooking(priya.id, b.id, "guest");
      await onlyFollowUps();
      expect((await run(sendTime(b))).sent).toHaveLength(0);
      expect((await followUps(b.id))[0]).toMatchObject({ status: "skipped", last_error: "booking cancelled" });
    });

    it("a no-show", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book();
      await pool.query("update invitees set no_show_at = $2 where booking_id = $1", [b.id, b.endAt]);
      await onlyFollowUps();
      expect((await run(sendTime(b))).sent).toHaveLength(0);
      expect((await followUps(b.id))[0]).toMatchObject({ status: "skipped", last_error: "guest marked as a no-show" });
    });

    it("a guest who opted out of this host's follow-ups (and only this host's)", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book();
      expect(await applyOptOut(pool, key, optOutToken(key, priya.id, b.invitee.email.toUpperCase()), new Date())).toBe(true);
      expect((await followUps(b.id))[0]).toMatchObject({ status: "skipped", last_error: "guest opted out of this host's follow-ups" });
      // A booking made after opting out queues, but is skipped when it would send.
      const again = await book(coaching, nextStart(), { name: "Meera Iyer", email: b.invitee.email });
      await onlyFollowUps();
      expect((await run(sendTime(again))).sent).toHaveLength(0);
      expect((await followUps(again.id))[0].last_error).toBe("guest opted out of this host's follow-ups");
      expect(await applyOptOut(pool, key, `${optOutToken(key, priya.id, "x@example.com")}x`, new Date())).toBe(false);
    });

    it("one already sent (the dedupe key) and ones switched off since", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book();
      await saveFollowUpSettings(pool, priya.id, coaching.id, FOLLOW_UPS_OFF, new Date());
      expect((await followUps(b.id))[0]).toMatchObject({ status: "skipped", last_error: "follow-ups switched off" });
      // Switched back on before it was due: it returns, once.
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      expect((await followUps(b.id)).map((r) => r.status)).toEqual(["queued"]);
    });
  });

  describe("one-click unsubscribe (RFC 8058)", () => {
    const call = async (method: "POST" | "GET", token: string) => {
      const { POST, GET } = await import("../../app/api/follow-ups/stop/[token]/route");
      const req = new NextRequest(`${baseUrl}/api/follow-ups/stop/${token}`, method === "POST"
        ? { method, body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } } : { method });
      return (method === "POST" ? POST : GET)(req, { params: Promise.resolve({ token }) });
    };

    it("the email names the endpoint in its headers, and one POST there opts the guest out with no page", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, ALL_ON, new Date());
      const b = await book();
      const later = await book(coaching, nextStart(), { name: "Meera Iyer", email: b.invitee.email });
      await onlyFollowUps();
      const { sent } = await run(new Date(b.endAt.getTime() + 2 * HOUR));
      const header = sent[0].headers?.["List-Unsubscribe"] ?? "";
      expect(sent[0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      const token = /^<https:\/\/hourhand\.test\/api\/follow-ups\/stop\/(o\.[^>]+)>$/.exec(header)?.[1];
      expect(token).toBeTruthy();
      // A link scanner's GET changes nothing: it is sent to the page with the button.
      const get = await call("GET", token!);
      expect(get.status).toBe(303);
      expect(get.headers.get("location")).toBe(`${baseUrl}/b/stop/${token}`);
      expect((await pool.query("select 1 from follow_up_opt_outs where host_id = $1", [priya.id])).rowCount).toBe(0);
      const post = await call("POST", token!);
      expect(post.status).toBe(200);
      expect((await pool.query("select email from follow_up_opt_outs where host_id = $1", [priya.id])).rows.map((r) => r.email)).toEqual([b.invitee.email]);
      expect((await followUps(later.id))[0]).toMatchObject({ status: "skipped", last_error: "guest opted out of this host's follow-ups" });
      expect((await call("POST", token!)).status).toBe(200); // a repeat is fine
    });

    it("refuses a forged token", async () => {
      const forged = optOutToken(linkKey("ef".repeat(32)), priya.id, "someone@example.com");
      expect((await call("POST", forged)).status).toBe(404);
      expect((await pool.query("select 1 from follow_up_opt_outs")).rowCount).toBe(0);
    });
  });

  describe("rebook links", () => {
    it("fill the booking form from the earlier booking, only on that booking's host's own pages", async () => {
      const b = await book(coaching, nextStart(), { name: "Kiran Rao", email: "kiran.rao@example.com" });
      const token = rebookToken(key, b.id, new Date());
      expect(await rebookPrefill(pool, key, token, priya.id, new Date())).toEqual({ name: "Kiran Rao", email: "kiran.rao@example.com" });
      const { rows: [arun] } = await pool.query("select id from users where slug = 'arun'");
      expect(await rebookPrefill(pool, key, token, arun.id, new Date())).toBeNull();
      expect(await rebookPrefill(pool, linkKey("ef".repeat(32)), token, priya.id, new Date())).toBeNull();
      expect(await rebookPrefill(pool, key, token, priya.id, new Date(Date.now() + 181 * DAY))).toBeNull();
    });

    it("the feedback page's rebook button uses the token too", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, { ...FOLLOW_UPS_OFF, thankYou: true, feedback: true }, new Date());
      const b = await book();
      const page = await feedbackPage(pool, key, feedbackToken(key, b.id, new Date()), "", new Date());
      expect(page.state).toBe("form");
      const url = "rebookUrl" in page ? page.rebookUrl : null;
      expect(url).toMatch(/^\/priya\/coaching\?rebook=r\./);
      expect(url).not.toMatch(/email|name=/);
    });
  });

  describe("group classes", () => {
    it("each seat gets its own follow-up, to its own guest", async () => {
      await saveFollowUpSettings(pool, priya.id, yoga.id, { ...FOLLOW_UPS_OFF, thankYou: true, delayHours: 1 }, new Date());
      const start = new Date("2032-03-02T04:30:00Z");
      const seats = [await book(yoga, start, { name: "A", email: "seat-a@example.com" }), await book(yoga, start, { name: "B", email: "seat-b@example.com" })];
      await onlyFollowUps();
      const { sent } = await run(new Date(seats[0].endAt.getTime() + HOUR));
      expect(sent.map((m) => m.to).sort()).toEqual(["seat-a@example.com", "seat-b@example.com"]);
      // The other seat cancelling doesn't touch the remaining seat's (already sent) follow-up.
      expect((await followUps(seats[1].id)).map((r) => r.status)).toEqual(["sent"]);
    });
  });

  describe("package nudge", () => {
    it("offers to book the last session at 1 left, and to buy again at none left", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, { ...FOLLOW_UPS_OFF, packageNudge: true }, new Date());
      const { rows: [pk] } = await pool.query(
        "insert into packages (user_id, event_type_id, name, sessions, price_minor, valid_days) values ($1, $2, '3 sessions', 3, 300000, 365) returning id", [priya.id, coaching.id]);
      const { rows: [pp] } = await pool.query(
        `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, idempotency_key, status, provider_payment_id, paid_at, expires_at)
         values ($1, $2, $3, 3, 300000, 365, 'Meera', 'pk@example.com', 'pk-1', 'paid', 'pay_1', now(), '2033-01-01') returning id, token`, [pk.id, priya.id, coaching.id]);
      const sessions = [await book(), await book()];
      await pool.query("update bookings set package_purchase_id = $1 where id = any($2)", [pp.id, sessions.map((s) => s.id)]);
      await onlyFollowUps();
      const first = (await run(new Date(sessions[0].endAt.getTime() + 2 * HOUR))).sent;
      expect(first[0].text).toContain("You have 1 session left in 3 sessions.");
      expect(first[0].text).toContain(`Book your last session: ${baseUrl}/p/${pp.token}`);
      expect(first[0].text).toContain(`Buy 3 sessions again: ${baseUrl}/pkg/${pk.id}`);
      const third = await book();
      await pool.query("update bookings set package_purchase_id = $1 where id = $2", [pp.id, third.id]);
      await onlyFollowUps();
      const last = (await run(new Date(third.endAt.getTime() + 2 * HOUR))).sent.find((m) => m.text.includes("used all"));
      expect(last?.text).toContain("You've used all your sessions in 3 sessions.");
    });
  });

  describe("feedback links", () => {
    const now = new Date("2032-06-01T00:00:00Z");

    it("save one answer per booking: the second submit reads as already sent", async () => {
      const b = await book();
      const token = feedbackToken(key, b.id, now);
      expect(await feedbackPage(pool, key, token, "", now)).toMatchObject({ state: "form", hostName: priya.name });
      const saved = await submitFeedback(pool, key, token, { rating: "5", comment: "<b>Lovely</b>" }, "", now);
      expect(saved).toMatchObject({ status: "saved", rating: 5 });
      expect(await submitFeedback(pool, key, token, { rating: "1", comment: "changed my mind" }, "", now)).toMatchObject({ status: "already" });
      expect(await feedbackPage(pool, key, token, "", now)).toMatchObject({ state: "answered", rating: 5 });
      const mine = (await listFeedback(pool, priya.id)).entries.find((e) => e.bookingId === b.id);
      expect(mine).toMatchObject({ rating: 5, comment: "<b>Lovely</b>" }); // stored as plain text; escaped where shown
    });

    it("refuse expired and forged links, and bookings that were cancelled", async () => {
      const b = await book();
      const token = feedbackToken(key, b.id, now);
      expect(await submitFeedback(pool, key, token, { rating: "4", comment: null }, "", new Date(now.getTime() + 31 * DAY))).toEqual({ status: "expired" });
      expect(await submitFeedback(pool, key, token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), { rating: "4", comment: null }, "", now)).toEqual({ status: "invalid" });
      expect(await submitFeedback(pool, linkKey("ef".repeat(32)), token, { rating: "4", comment: null }, "", now)).toEqual({ status: "invalid" });
      await store.cancelBooking(priya.id, b.id, "guest");
      expect(await submitFeedback(pool, key, token, { rating: "4", comment: null }, "", now)).toEqual({ status: "invalid" });
      expect((await pool.query("select count(*)::int as n from booking_feedback where booking_id = $1", [b.id])).rows[0].n).toBe(0);
    });

    it("offer the Google review link after every rating when the ask is on, worded by the rating", async () => {
      await saveFollowUpSettings(pool, priya.id, coaching.id, { ...FOLLOW_UPS_OFF, feedback: true, reviewAsk: true }, new Date());
      const low = await book(), high = await book();
      const r2 = await submitFeedback(pool, key, feedbackToken(key, low.id, now), { rating: "2", comment: null }, "", now);
      const r5 = await submitFeedback(pool, key, feedbackToken(key, high.id, now), { rating: "5", comment: null }, "", now);
      expect(r2).toMatchObject({ status: "saved", review: { url: "https://g.page/r/priya/review", wording: "reviewLow" } });
      expect(r5).toMatchObject({ status: "saved", review: { url: "https://g.page/r/priya/review", wording: "reviewHigh" } });
      // Ask off: no review link at all.
      await saveFollowUpSettings(pool, priya.id, coaching.id, { ...FOLLOW_UPS_OFF, feedback: true }, new Date());
      const other = await book();
      expect(await submitFeedback(pool, key, feedbackToken(key, other.id, now), { rating: "5", comment: null }, "", now)).toMatchObject({ review: null });
    });

    it("rejects a bad rating or an over-long comment without using up the link", async () => {
      const b = await book();
      const token = feedbackToken(key, b.id, now);
      expect(await submitFeedback(pool, key, token, { rating: "7", comment: null }, "", now)).toMatchObject({ status: "bad_input", field: "rating" });
      expect(await submitFeedback(pool, key, token, { rating: "3", comment: "x".repeat(2001) }, "", now)).toMatchObject({ status: "bad_input", field: "comment" });
      expect(await submitFeedback(pool, key, token, { rating: "3", comment: "ok" }, "", now)).toMatchObject({ status: "saved" });
    });
  });

  it("settings can only be saved for the host's own event type", async () => {
    const { rows: [arun] } = await pool.query("select id from users where slug = 'arun'");
    await expect(saveFollowUpSettings(pool, arun.id, coaching.id, ALL_ON, new Date())).rejects.toThrow(/Event type/);
  });
});
