// 3.4 Book over WhatsApp: the parsing and message building, and (with TEST_DATABASE_URL, own database <name>_wab)
// whole conversations through the signed webhook against a fake WhatsApp server.
import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/migrate";
import { seed } from "../../scripts/seed";
import { freeSlotSeats } from "./booking";
import { createPgStore } from "./data/pg-store";
import type { DataStore, EventType, User } from "./data/types";
import { createRateLimiter } from "./rate-limit";
import {
  ASK_HOST, guessZone, hostWaLink, listMessage, MAX_SLOTS, parseInbound, setWhatsAppBooking, slotTitle, slugFromText, WHATSAPP_BOOKING_LIMIT,
} from "./whatsapp-booking";
import { STOP_REPLY, type WhatsAppConfig } from "./whatsapp-cloud";
import { handleWhatsAppWebhook } from "./whatsapp-webhook";

const BASE = process.env.TEST_DATABASE_URL;
const cfg: WhatsAppConfig = { phoneNumberId: "555", accessToken: "test-access", appSecret: "test-app-secret", verifyToken: "verify-me", baseUrl: "https://graph.test" };
const sign = (body: string) => `sha256=${createHmac("sha256", cfg.appSecret).update(body).digest("hex")}`;

describe("reading clients' messages", () => {
  it("finds the host slug in the pre-filled text, a typed request or a pasted link", () => {
    expect(slugFromText("Book with priya")).toBe("priya");
    expect(slugFromText("hi, I'd like to book with Priya-Raman please")).toBe("priya-raman");
    expect(slugFromText("book @arun")).toBe("arun");
    expect(slugFromText("saw https://hourhand.cloud/meena-yoga on insta")).toBe("meena-yoga");
    expect(slugFromText("hello")).toBeNull();
    expect(slugFromText("thanks, booked!")).toBeNull();
  });

  it("takes text and tapped list rows or buttons, with their time, and skips anything without a phone number", () => {
    const at = 1_800_000_000;
    const payload = { entry: [{ changes: [{ value: { messages: [
      { id: "w1", from: "919876543210", timestamp: String(at), type: "text", text: { body: "Book with priya" } },
      { id: "w2", from: "919876543210", timestamp: String(at), type: "interactive", interactive: { type: "list_reply", list_reply: { id: "zone", title: "Change time zone" } } },
      { id: "w3", from: "919876543210", timestamp: String(at), type: "interactive", interactive: { type: "button_reply", button_reply: { id: "et:x", title: "x" } } },
      { id: "w4", timestamp: String(at), type: "text", text: { body: "no phone, username only" } },
      { id: "w5", from: "919876543210", timestamp: String(at), type: "image" },
    ] } }] }] };
    expect(parseInbound(payload)).toEqual([
      { id: "w1", from: "919876543210", at: new Date(at * 1000), text: "Book with priya", replyId: null },
      { id: "w2", from: "919876543210", at: new Date(at * 1000), text: null, replyId: "zone" },
      { id: "w3", from: "919876543210", at: new Date(at * 1000), text: null, replyId: "et:x" },
    ]);
    expect(parseInbound({})).toEqual([]);
  });

  it("guesses the client's zone from the country code, longest code first", () => {
    expect(guessZone("919876543210")).toBe("Asia/Kolkata");
    expect(guessZone("971501234567")).toBe("Asia/Dubai");
    expect(guessZone("447700900123")).toBe("Europe/London");
    expect(guessZone("12025550123")).toBe("America/New_York");
    expect(guessZone("999123456")).toBeNull();
  });

  it("writes a slot as a short row title in the client's zone", () => {
    const start = new Date("2026-11-18T05:00:00Z");
    expect(slotTitle(start, "Asia/Kolkata")).toBe("Wed 18 Nov, 10:30 am");
    expect(slotTitle(start, "Europe/London")).toBe("Wed 18 Nov, 5:00 am");
    expect(slotTitle(start, "America/Los_Angeles")).toBe("Tue 17 Nov, 9:00 pm");
    expect(slotTitle(start, "Asia/Kolkata").length).toBeLessThanOrEqual(24);
  });

  it("keeps list messages inside WhatsApp's limits", () => {
    const m = listMessage("91", "x".repeat(5000), "A very long button label", [{ title: "A section title that is far too long", rows: [{ id: "a", title: "y".repeat(40), description: "z".repeat(100) }] }]);
    expect(m.interactive.body.text.length).toBe(4096);
    expect(m.interactive.action.button.length).toBeLessThanOrEqual(20);
    const [section] = m.interactive.action.sections;
    expect(section.title.length).toBeLessThanOrEqual(24);
    expect(section.rows[0].title.length).toBe(24);
    expect(section.rows[0].description!.length).toBe(72);
  });

  it("gives the host a wa.me link pre-filled with their slug, only once Hourhand's number is set", () => {
    expect(hostWaLink("priya", { WHATSAPP_DISPLAY_NUMBER: "+91 80000 12345" })).toBe("https://wa.me/918000012345?text=Book%20with%20priya");
    expect(hostWaLink("priya", {})).toBeNull();
  });
});

type Sent = { to: string; type: string; text?: { body: string }; interactive?: Interactive };
type Interactive = {
  type: string; body: { text: string };
  action: { button?: string; sections?: { title: string; rows: { id: string; title: string; description?: string }[] }[]; parameters?: { display_text: string; url: string } };
};

describe.skipIf(!BASE)("Book over WhatsApp (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let coaching: EventType;
  let n = 0;
  let sent: Sent[] = [];
  let clock = Date.now();
  let limiter = createRateLimiter(() => clock);
  const fakeFetch = (async (url: string, init: RequestInit) => {
    expect(String(url)).toBe("https://graph.test/v23.0/555/messages");
    sent.push(JSON.parse(String(init.body)));
    return Response.json({ messages: [{ id: `wamid.${sent.length}` }] });
  }) as unknown as typeof fetch;

  const IN = "919876543210";
  /** One client message through the signed webhook. `ageMs`: how long ago the client sent it. */
  async function say(what: { text?: string; tap?: string }, opts: { from?: string; ageMs?: number; id?: string } = {}) {
    n++;
    const ts = Math.floor((Date.now() - (opts.ageMs ?? 0)) / 1000);
    const message = what.text !== undefined
      ? { id: opts.id ?? `wamid.in${n}`, from: opts.from ?? IN, timestamp: String(ts), type: "text", text: { body: what.text } }
      : { id: opts.id ?? `wamid.in${n}`, from: opts.from ?? IN, timestamp: String(ts), type: "interactive", interactive: { type: "list_reply", list_reply: { id: what.tap, title: "-" } } };
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
    const before = sent.length;
    const res = await handleWhatsAppWebhook(pool, cfg, raw, sign(raw), fakeFetch, { limiter, baseUrl: "https://hourhand.test" });
    expect(res.status).toBe(200);
    return sent.slice(before);
  }
  const rows = (m: Sent) => m.interactive!.action.sections!.flatMap((s) => s.rows);
  const plan = (p: string) => pool.query("insert into subscriptions (user_id, plan, status) values ($1, $2, 'active') on conflict (user_id) do update set plan = $2, status = 'active'", [priya.id, p]);
  const bookingCount = async () => Number((await pool.query("select count(*) from bookings")).rows[0].count);

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_wab`;
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
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    sent = [];
    clock = Date.now();
    limiter = createRateLimiter(() => clock);
    await pool.query("delete from whatsapp_booking_sessions");
    await pool.query("delete from whatsapp_booking_counts");
    await pool.query("delete from whatsapp_opt_outs");
    await pool.query("update calendar_connections set last_synced_at = now(), status = 'ok'");
    await setWhatsAppBooking(pool, priya.id, true);
    await plan("solo");
  });

  it("slug in the text: event types, then free times in the client's zone, then a booking link with that time", async () => {
    const [types] = await say({ text: "Book with priya" });
    expect(types).toMatchObject({ to: IN, type: "interactive", interactive: { type: "list" } });
    expect(rows(types).map((r) => r.title)).toEqual(["45-min coaching session", "Free 15-min intro call"]);
    expect(rows(types)[0]).toMatchObject({ id: `et:${coaching.id}`, description: "45 min · Free" });

    const [times] = await say({ tap: `et:${coaching.id}` });
    const expected = (await freeSlotSeats(store, priya, coaching, new Date(), new Date(Date.now() + 30 * 86_400_000), new Date())).slice(0, MAX_SLOTS);
    const slotRows = times.interactive!.action.sections![0].rows;
    expect(times.interactive!.action.sections![0].title).toBe("Times (IST)");
    expect(slotRows).toHaveLength(MAX_SLOTS);
    expect(slotRows.map((r) => r.id)).toEqual(expected.map((s) => `slot:${coaching.id}:${s.start.getTime()}`));
    expect(slotRows.map((r) => r.title)).toEqual(expected.map((s) => slotTitle(s.start, "Asia/Kolkata")));
    expect(rows(times)).toHaveLength(10);
    expect(rows(times).at(-1)).toMatchObject({ id: "zone", title: "Change time zone" });

    const pick = expected[2].start;
    const [link] = await say({ tap: `slot:${coaching.id}:${pick.getTime()}` });
    expect(link.interactive).toMatchObject({ type: "cta_url", action: { parameters: { display_text: "Book this time", url: `https://hourhand.test/priya/coaching?at=${encodeURIComponent(pick.toISOString())}` } } });
    expect(link.interactive!.body.text).toMatch(/IST/);

    const counts = (await pool.query("select inbound, replies, links from whatsapp_booking_counts where host_id = $1", [priya.id])).rows;
    expect(counts).toEqual([{ inbound: 3, replies: 3, links: 1 }]);
  });

  it("guesses the zone from the number, and lets the client change it", async () => {
    const uk = "447700900123";
    await say({ text: "book with priya" }, { from: uk });
    const [times] = await say({ tap: `et:${coaching.id}` }, { from: uk });
    const first = Number(rows(times)[0].id.split(":")[2]);
    expect(rows(times)[0].title).toBe(slotTitle(new Date(first), "Europe/London"));

    const [zones] = await say({ tap: "zone" }, { from: uk });
    expect(rows(zones).map((r) => r.id)).toContain("tz:America/New_York");
    const [ny] = await say({ tap: "tz:America/New_York" }, { from: uk });
    expect(rows(ny)[0].title).toBe(slotTitle(new Date(first), "America/New_York"));

    await say({ tap: "zone" }, { from: uk });
    const [bad] = await say({ text: "Mars/Olympus" }, { from: uk });
    expect(bad.interactive!.body.text).toMatch(/didn't recognise/);
    const [tokyo] = await say({ text: "Asia/Tokyo" }, { from: uk });
    expect(rows(tokyo)[0].title).toBe(slotTitle(new Date(first), "Asia/Tokyo"));
  });

  it("no slug: asks which coach or tutor, then matches the slug they reply with", async () => {
    const [ask] = await say({ text: "Hi" });
    expect(ask).toMatchObject({ type: "text", text: { body: ASK_HOST } });
    const [types] = await say({ text: "priya" });
    expect(rows(types).map((r) => r.id)).toContain(`et:${coaching.id}`);
  });

  it("unknown slug: a polite help message, and nobody else's name is ever listed", async () => {
    const [help] = await say({ text: "book with nobody-here" });
    expect(help.type).toBe("text");
    expect(help.text!.body).toMatch(/couldn't find "nobody-here"/);
    expect(help.text!.body).not.toMatch(/priya|arun/i);
  });

  it("a host who hasn't turned it on, or whose plan lacks it, is never offered", async () => {
    await setWhatsAppBooking(pool, priya.id, false);
    const [off] = await say({ text: "Book with priya" });
    expect(off.type).toBe("text");
    expect(off.text!.body).toMatch(/couldn't find "priya"/);

    await setWhatsAppBooking(pool, priya.id, true);
    await plan("free");
    const [free] = await say({ text: "Book with priya" });
    expect(free.text!.body).toMatch(/couldn't find "priya"/);

    // Turned off mid-conversation: a tapped row from an old list gets the opening question, not times.
    await plan("solo");
    await say({ text: "Book with priya" });
    await setWhatsAppBooking(pool, priya.id, false);
    const [later] = await say({ tap: `et:${coaching.id}` });
    expect(later).toMatchObject({ type: "text", text: { body: ASK_HOST } });
  });

  it("answers only inside the 24-hour service window, and only once per message", async () => {
    expect(await say({ text: "Book with priya" }, { ageMs: 25 * 3_600_000 })).toEqual([]);
    expect(await say({ text: "Book with priya" }, { ageMs: 23 * 3_600_000 })).toHaveLength(1);
    expect(await say({ text: "Book with priya" }, { id: "wamid.dup" })).toHaveLength(1);
    expect(await say({ text: "Book with priya" }, { id: "wamid.dup" })).toEqual([]);
  });

  it("STOP still opts out with one confirmation, and an opted-out number gets no booking replies", async () => {
    const stop = await say({ text: "STOP" });
    expect(stop).toEqual([expect.objectContaining({ type: "text", text: { body: STOP_REPLY } })]);
    expect((await pool.query("select phone from whatsapp_opt_outs")).rows).toEqual([{ phone: IN }]);
    expect(await say({ text: "Book with priya" })).toEqual([]);
  });

  it("stops answering a phone that sends too much, then answers again after the window", async () => {
    let answered = 0;
    for (let i = 0; i < WHATSAPP_BOOKING_LIMIT.max + 5; i++) answered += (await say({ text: "Book with priya" })).length;
    expect(answered).toBe(WHATSAPP_BOOKING_LIMIT.max);
    expect((await say({ text: "Book with priya" }, { from: "919000000001" })).length).toBe(1); // other phones unaffected
    clock += WHATSAPP_BOOKING_LIMIT.windowMs;
    expect(await say({ text: "Book with priya" })).toHaveLength(1);
  });

  it("re-checks the time before sending a link, and never books anything itself", async () => {
    const before = await bookingCount();
    await say({ text: "Book with priya" });
    const [times] = await say({ tap: `et:${coaching.id}` });
    const first = Number(rows(times)[0].id.split(":")[2]);
    // Someone books the first time on the web meanwhile.
    await store.createBooking({
      eventTypeId: coaching.id, startAt: new Date(first), idempotencyKey: "wab-taken",
      invitee: { name: "Meera", email: "meera@example.in", timezone: "Asia/Kolkata", phone: null, answers: [], whatsappOptIn: false },
    });
    const after = await say({ tap: `slot:${coaching.id}:${first}` });
    expect(after[0].text!.body).toMatch(/just gone/);
    expect(rows(after[1]).map((r) => r.id)).not.toContain(`slot:${coaching.id}:${first}`);
    const second = Number(rows(after[1])[0].id.split(":")[2]);
    const [link] = await say({ tap: `slot:${coaching.id}:${second}` });
    expect(link.interactive!.type).toBe("cta_url");
    expect(await bookingCount()).toBe(before + 1); // only the web booking above
  });

  it("keeps no message text: sessions hold routing only, and old ones are deleted", async () => {
    await say({ text: "Book with priya, my number is private" });
    const { rows: [s] } = await pool.query("select * from whatsapp_booking_sessions");
    expect(Object.values(s).some((v) => typeof v === "string" && v.includes("private"))).toBe(false);
    await pool.query("update whatsapp_booking_sessions set updated_at = now() - interval '2 days'");
    await say({ text: "hi" }, { from: "919000000002" });
    expect((await pool.query("select phone from whatsapp_booking_sessions")).rows).toEqual([{ phone: "919000000002" }]);
  });
});
