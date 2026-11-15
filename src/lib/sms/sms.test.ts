// Booking texts (roadmap 1.2): the texts and their limits, MSG91's request, and (with TEST_DATABASE_URL, own database
// <name>_sms) who gets a text, when, over which channel, and what delivery reports and the manage-page switch do.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { LIMITS } from "../billing/plans";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { processDueNotifications } from "../jobs/worker";
import type { Mail } from "../mail/mailer";
import { validateBookingRequest } from "../booking";
import type { WhatsAppConfig } from "../whatsapp-cloud";
import { handleWhatsAppWebhook } from "../whatsapp-webhook";
import { createHmac } from "node:crypto";
import { SMS_KINDS, smsConfig, smsNumber, type SmsConfig } from "./config";
import { handleSmsToggle, manageTokenForCode } from "./manage";
import { msg91Body, sendMsg91 } from "./msg91";
import { SmsError } from "./provider";
import { dltText, DLT_VAR_MAX, fillSms, isGsm, segments, smsLength } from "./templates";
import { checkSecret, handleSmsWebhook, parseReports } from "./webhook";

const BASE = process.env.TEST_DATABASE_URL;
const site = "https://hourhand.cloud";

const env = {
  SMS_PROVIDER: "msg91", MSG91_AUTH_KEY: "auth-key", MSG91_SENDER_ID: "HRHAND", MSG91_WEBHOOK_SECRET: "s3cret-for-reports",
  MSG91_TEMPLATE_BOOKED: "tpl-booked", MSG91_TEMPLATE_REMINDER: "tpl-reminder", MSG91_TEMPLATE_CANCELLED: "tpl-cancelled", MSG91_TEMPLATE_RESCHEDULED: "tpl-moved",
  MSG91_TEMPLATE_BOOKED_HI: "tpl-booked-hi", MSG91_API_BASE_URL: "https://msg91.test",
};
const cfg = smsConfig(env)!;

const ctx = (over: Partial<Parameters<typeof fillSms>[1]> = {}) => ({
  guestName: "Kiran Rao", hostName: "Priya Sharma", eventName: "Coaching", startAt: new Date("2031-01-06T10:00:00Z"),
  guestTimezone: "Asia/Kolkata", locale: "en", code: "AbCdEfGhJk12", ...over,
});

describe("SMS settings", () => {
  it("is on only with every setting, a six-letter header and the provider named", () => {
    expect(cfg).toMatchObject({ provider: "msg91", senderId: "HRHAND", baseUrl: "https://msg91.test", templates: { booked_guest: { en: "tpl-booked", hi: "tpl-booked-hi" }, reminder_guest: { en: "tpl-reminder" } } });
    expect(smsConfig({ ...env, SMS_PROVIDER: undefined })).toBeNull();
    expect(smsConfig({ ...env, SMS_PROVIDER: "twilio" })).toBeNull();
    for (const k of ["MSG91_AUTH_KEY", "MSG91_SENDER_ID", "MSG91_WEBHOOK_SECRET", "MSG91_TEMPLATE_BOOKED", "MSG91_TEMPLATE_REMINDER", "MSG91_TEMPLATE_CANCELLED", "MSG91_TEMPLATE_RESCHEDULED"]) {
      expect(smsConfig({ ...env, [k]: undefined }), k).toBeNull();
    }
    expect(smsConfig({ ...env, MSG91_SENDER_ID: "HRHAND1" })).toBeNull();
    expect(smsConfig({ ...env, NODE_ENV: "production" })!.baseUrl).toBe("https://control.msg91.com");
  });

  it("texts Indian mobiles only", () => {
    expect(smsNumber("+91 98765 43210")).toBe("919876543210");
    expect(smsNumber("098765 43210")).toBe("919876543210");
    expect(smsNumber("9876543210")).toBe("919876543210");
    expect(smsNumber("0091 98765 43210")).toBe("919876543210");
    expect(smsNumber("+91 22 2345 6789")).toBeNull(); // a landline
    expect(smsNumber("+44 7700 900123")).toBeNull();
    expect(smsNumber("+1 415 555 0100")).toBeNull();
    expect(smsNumber(null)).toBeNull();
  });
});

describe("SMS texts", () => {
  it("fills each template's three slots and fits one GSM segment in English", () => {
    for (const kind of SMS_KINDS) {
      const s = fillSms(kind, ctx(), site);
      expect(s.vars).toHaveLength(3);
      expect(s.vars).toEqual(expect.arrayContaining(["Coaching with Priya Sharma", "AbCdEfGhJk12"]));
      expect(isGsm(s.text)).toBe(true);
      expect(s.segments).toBe(1);
      expect(s.text).toContain("https://hourhand.cloud/m/AbCdEfGhJk12");
    }
    expect(fillSms("booked_guest", ctx(), site).text).toBe("Your Coaching with Priya Sharma is booked for Mon, 6 Jan, 3:30 pm IST. To change or cancel: https://hourhand.cloud/m/AbCdEfGhJk12");
  });

  it("cuts long names to DLT's 30 characters and the text to its segment budget, never the time or the code", () => {
    const long = ctx({ eventName: "Career strategy and leadership coaching session", hostName: "Dr. Priyadarshini Venkataraman-Iyer" });
    for (const kind of SMS_KINDS) {
      for (const locale of ["en", "hi"]) {
        const s = fillSms(kind, { ...long, locale }, site);
        for (const v of s.vars) expect(Array.from(v).length).toBeLessThanOrEqual(DLT_VAR_MAX);
        expect(s.vars).toContain("AbCdEfGhJk12");
        expect(s.segments).toBeLessThanOrEqual(locale === "hi" ? 3 : 1);
      }
    }
    // A name in another script turns the text Unicode: it gets three segments, not one.
    const u = fillSms("reminder_guest", ctx({ hostName: "प्रिया शर्मा", eventName: "करियर कोचिंग और लीडरशिप सत्र" }), site);
    expect(isGsm(u.text)).toBe(false);
    expect(u.segments).toBeLessThanOrEqual(3);
  });

  it("writes Hindi for Hindi guests and English for every other language", () => {
    const hi = fillSms("booked_guest", ctx({ locale: "hi" }), site);
    expect(hi.lang).toBe("hi");
    expect(hi.text.startsWith("आपका Priya Sharma के साथ Coaching")).toBe(true);
    expect(fillSms("booked_guest", ctx({ locale: "ta" }), site).lang).toBe("en");
  });

  it("counts segments the way networks bill them", () => {
    expect(segments("a".repeat(160))).toBe(1);
    expect(segments("a".repeat(161))).toBe(2);
    expect(smsLength("{}")).toBe(4); // GSM extension characters count two
    expect(segments("अ".repeat(70))).toBe(1);
    expect(segments("अ".repeat(71))).toBe(2);
    expect(segments("अ".repeat(201))).toBe(3);
  });

  it("matches the template texts docs/deploy.md tells the owner to register", () => {
    const doc = readFileSync(new URL("../../../docs/deploy.md", import.meta.url), "utf8");
    for (const kind of SMS_KINDS) for (const lang of ["en", "hi"] as const) expect(doc, `${kind}/${lang}`).toContain(dltText(kind, lang, site));
  });
});

describe("MSG91", () => {
  const msg = (locale = "en") => ({ to: "919876543210", kind: "booked_guest" as const, filled: fillSms("booked_guest", ctx({ locale }), site) });

  it("sends the template id for the language with VAR1..VAR3, and no shortener", () => {
    expect(msg91Body(cfg, msg())).toEqual({ template_id: "tpl-booked", short_url: "0", recipients: [{ mobiles: "919876543210", VAR1: "Coaching with Priya Sharma", VAR2: "Mon, 6 Jan, 3:30 pm IST", VAR3: "AbCdEfGhJk12" }] });
    expect(msg91Body(cfg, msg("hi")).template_id).toBe("tpl-booked-hi");
  });

  it("returns the request id, retries 5xx, 429 and network errors, and gives up on a 4xx", async () => {
    const answer = (status: number, body: object) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
    let seen: RequestInit | undefined;
    const ok = (async (url: string, init: RequestInit) => { seen = init; expect(url).toBe("https://msg91.test/api/v5/flow"); return Response.json({ type: "success", message: "req-1" }); }) as unknown as typeof fetch;
    expect(await sendMsg91(cfg, msg(), ok)).toEqual({ id: "req-1" });
    expect((seen!.headers as Record<string, string>).authkey).toBe("auth-key");
    const fails = async (f: typeof fetch) => sendMsg91(cfg, msg(), f).then(() => null, (e: SmsError) => e);
    expect(await fails(answer(503, {}))).toMatchObject({ retryable: true, message: "MSG91 503" });
    expect(await fails(answer(429, {}))).toMatchObject({ retryable: true });
    expect(await fails(answer(401, { type: "error", message: "bad key 919876543210" }))).toMatchObject({ retryable: false, message: "MSG91 401 (error)" });
    expect(await fails(answer(200, { type: "error", message: "template mismatch" }))).toMatchObject({ retryable: false });
    expect(await fails((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).toMatchObject({ retryable: true });
  });
});

describe("delivery reports", () => {
  it("needs the shared secret", () => {
    expect(checkSecret("s3cret-for-reports", "s3cret-for-reports")).toBe(true);
    expect(checkSecret("s3cret-for-reports", "s3cret-for-report")).toBe(false);
    expect(checkSecret("s3cret-for-reports", null)).toBe(false);
  });

  it("reads one report or a list, and skips what it can't read", () => {
    expect(parseReports([{ requestId: "r1", telNum: "919876543210", status: 1, deliveryTime: "2031-01-06 10:00:05" }, { status: 2 }, "x"]))
      .toEqual([{ requestId: "r1", number: "919876543210", status: 1, reason: null, at: new Date("2031-01-06 10:00:05") }]);
    expect(parseReports({ requestId: "r2", status: "17", failureReason: "Blocked" })).toMatchObject([{ requestId: "r2", status: 17, reason: "Blocked" }]);
  });
});

describe("booking form", () => {
  const body = { slug: "priya", event: "coaching", start: "2031-01-06T10:00:00Z", name: "Kiran", email: "k@example.in", timezone: "Asia/Kolkata", idempotencyKey: "key-12345678" };
  it("takes the SMS tick only with an Indian mobile", () => {
    expect(validateBookingRequest({ ...body, phone: "+91 98765 43210", smsOptIn: true })).toMatchObject({ ok: true, value: { smsOptIn: true } });
    expect(validateBookingRequest({ ...body, phone: "+44 7700 900123", smsOptIn: true })).toMatchObject({ ok: false, fields: { smsOptIn: expect.any(String) } });
    expect(validateBookingRequest({ ...body, phone: "+44 7700 900123" })).toMatchObject({ ok: true, value: { smsOptIn: false } });
  });

  it("gives texts to paid plans only", () => {
    expect([LIMITS.free.smsPerMonth, LIMITS.solo.smsPerMonth, LIMITS.duo.smsPerMonth]).toEqual([0, 100, 200]);
  });
});

describe.skipIf(!BASE)("SMS sending (Postgres)", () => {
  const wa: WhatsAppConfig = { phoneNumberId: "555", accessToken: "wa-token", appSecret: "wa-secret", verifyToken: "verify", baseUrl: "https://graph.test" };
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let coaching: EventType;
  let n = 0;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let msg91: () => Response = () => Response.json({ type: "success", message: `req-${calls.length}` });
  let meta: () => Response = () => Response.json({ messages: [{ id: `wamid.${calls.length}` }] });
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return String(url).startsWith("https://msg91.test") ? msg91() : meta();
  }) as unknown as typeof fetch;
  const texts = () => calls.filter((c) => c.url.startsWith("https://msg91.test"));
  const mailer = { async send(m: Mail) { void m; return { id: "mail" }; } };
  const run = (opts: { whatsapp?: WhatsAppConfig | null; sms?: SmsConfig | null; now?: Date } = {}) =>
    processDueNotifications(pool, mailer, { baseUrl: site, now: opts.now ?? new Date(), whatsapp: opts.whatsapp ?? null, sms: opts.sms === undefined ? cfg : opts.sms, fetch: fakeFetch });
  const plan = (p: string) => pool.query("insert into subscriptions (user_id, plan, status) values ($1, $2, 'active') on conflict (user_id) do update set plan = $2, status = 'active'", [priya.id, p]);
  const book = async (o: { phone?: string | null; sms?: boolean; wa?: boolean; days?: number; locale?: string } = {}) => {
    n++;
    return store.createBooking({
      eventTypeId: coaching.id, startAt: new Date(Date.now() + (o.days ?? 3) * 86_400_000 + n * 3 * 3_600_000), idempotencyKey: `sms-${n}`,
      invitee: { name: "Kiran Rao", email: `kiran${n}@example.in`, timezone: "Asia/Kolkata", phone: o.phone === undefined ? "+91 98765 43210" : o.phone, answers: [], locale: o.locale ?? "en", smsOptIn: o.sms ?? true, whatsappOptIn: o.wa ?? false },
    });
  };
  const rows = async (bookingId: string, channel = "sms") =>
    (await pool.query("select kind, recipient, status, last_error, provider_message_id, delivered_at from notifications where booking_id = $1 and channel = $2 order by kind", [bookingId, channel])).rows;
  /** The first slot for the seeded host and event, as fillSms makes it. */
  const slot1 = (locale: string) => fillSms("booked_guest", ctx({ hostName: priya.name, eventName: coaching.name, locale }), site).vars[0];
  const setEnv = (on: boolean) => { for (const [k, v] of Object.entries(env)) { if (on) process.env[k] = v; else delete process.env[k]; } };
  const due = (bookingId: string) => pool.query("update notifications set send_at = now() - interval '1 second' where booking_id = $1 and status = 'queued'", [bookingId]);

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_sms`;
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
    await pool.query("delete from calendar_connections");
  });

  afterAll(async () => {
    setEnv(false);
    for (const k of ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]) delete process.env[k];
    await pool?.end();
  });

  beforeEach(async () => {
    calls.length = 0;
    msg91 = () => Response.json({ type: "success", message: `req-${calls.length}` });
    meta = () => Response.json({ messages: [{ id: `wamid.${calls.length}` }] });
    setEnv(true);
    for (const k of ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]) delete process.env[k];
    await pool.query("delete from notifications");
    await pool.query("delete from sms_opt_outs");
    await pool.query("delete from whatsapp_opt_outs");
    await plan("solo");
  });

  it("queues the confirmation and the day-ahead reminder for a guest who ticked it, and sends the confirmation through MSG91", async () => {
    const b = await book();
    expect((await rows(b.id)).map((r) => [r.kind, r.recipient, r.status])).toEqual([["booked_guest", "919876543210", "queued"], ["reminder_guest", "919876543210", "queued"]]);
    await run();
    expect(texts()).toHaveLength(1);
    const code = (await pool.query("select sms_code from invitees where booking_id = $1", [b.id])).rows[0].sms_code as string;
    expect(code).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(texts()[0].body).toMatchObject({ template_id: "tpl-booked", recipients: [{ mobiles: "919876543210", VAR1: slot1("en"), VAR3: code }] });
    expect((await rows(b.id)).find((r) => r.kind === "booked_guest")).toMatchObject({ status: "sent", provider_message_id: "req-1" });
    // The short link opens the manage page.
    expect(await manageTokenForCode(pool, code)).toBe(b.invitee.manageToken);
    expect(await manageTokenForCode(pool, "nope")).toBeNull();
  });

  it("queues nothing without the tick, without a phone, for a number outside India, a DLT-blocked number, or with SMS off", async () => {
    expect(await rows((await book({ sms: false })).id)).toEqual([]);
    expect(await rows((await book({ phone: null })).id)).toEqual([]);
    expect(await rows((await book({ phone: "+44 7700 900123" })).id)).toEqual([]);
    await pool.query("insert into sms_opt_outs (phone, source) values ('919876543210', 'dlt')");
    expect(await rows((await book()).id)).toEqual([]);
    await pool.query("delete from sms_opt_outs");
    setEnv(false);
    expect(await rows((await book()).id)).toEqual([]);
  });

  it("prefers WhatsApp when the guest ticked both, and never sends both", async () => {
    for (const [k, v] of Object.entries({ WHATSAPP_PHONE_NUMBER_ID: "555", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_APP_SECRET: "wa-secret", WHATSAPP_VERIFY_TOKEN: "v" })) process.env[k] = v;
    const b = await book({ wa: true });
    expect(await rows(b.id)).toEqual([]);
    expect((await rows(b.id, "whatsapp")).map((r) => r.kind)).toEqual(["booked_guest", "reminder_guest"]);
    await run({ whatsapp: wa });
    expect(texts()).toHaveLength(0);
    // A text that somehow sits beside a sent WhatsApp message is dropped when it comes up.
    await pool.query(`insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key) values ($1, $2, 'sms', 'booked_guest', '919876543210', now() - interval '1 second', $3)`,
      [b.id, priya.id, `booking:${b.id}:sms:booked_guest`]);
    await run({ whatsapp: wa });
    expect(texts()).toHaveLength(0);
    expect((await rows(b.id))[0]).toMatchObject({ status: "skipped", last_error: "sent on WhatsApp instead" });
  });

  it("falls back to a text when the WhatsApp message can't go: refused, or reported failed", async () => {
    for (const [k, v] of Object.entries({ WHATSAPP_PHONE_NUMBER_ID: "555", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_APP_SECRET: "wa-secret", WHATSAPP_VERIFY_TOKEN: "v" })) process.env[k] = v;
    const b = await book({ wa: true });
    meta = () => Response.json({ error: { code: 131026 } }, { status: 400 }); // not on WhatsApp
    await run({ whatsapp: wa });
    expect((await rows(b.id, "whatsapp")).find((r) => r.kind === "booked_guest")).toMatchObject({ status: "failed" });
    expect((await rows(b.id)).map((r) => [r.kind, r.status])).toEqual([["booked_guest", "queued"]]);
    await run({ whatsapp: wa });
    expect(texts()).toHaveLength(1);
    expect((await rows(b.id))[0]).toMatchObject({ status: "sent" });

    // A message Meta took but later reported undelivered.
    const c = await book({ wa: true });
    meta = () => Response.json({ messages: [{ id: "wamid.late" }] });
    await run({ whatsapp: wa });
    const report = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.late", status: "failed", errors: [{ code: 131026 }] }] } }] }] });
    const sig = `sha256=${createHmac("sha256", "wa-secret").update(report).digest("hex")}`;
    expect((await handleWhatsAppWebhook(pool, wa, report, sig, fakeFetch)).status).toBe(200);
    expect((await rows(c.id)).map((r) => [r.kind, r.status])).toEqual([["booked_guest", "queued"]]);
  });

  it("drops a text that isn't covered by the plan, and stops at the monthly allowance (email still goes)", async () => {
    await plan("free");
    const b = await book();
    await run();
    expect(texts()).toHaveLength(0);
    expect((await rows(b.id))[0]).toMatchObject({ status: "skipped", last_error: "the host's plan doesn't include SMS" });
    expect((await pool.query("select status from notifications where booking_id = $1 and kind = 'booked_guest' and channel = 'email'", [b.id])).rows[0].status).toBe("sent");

    await plan("solo");
    await pool.query(
      `insert into notifications (user_id, channel, kind, recipient, send_at, status, sent_at, dedupe_key)
       select $1, 'sms', 'booked_guest', '91', now(), 'sent', now(), 'filler:' || g from generate_series(1, 99) g`, [priya.id]);
    const c = await book();
    const d = await book();
    await run();
    expect(texts()).toHaveLength(1); // the 100th
    expect((await rows(d.id))[0]).toMatchObject({ status: "skipped", last_error: "monthly SMS limit reached (100)" });
    void c;
    await plan("duo");
    const e = await book();
    await run();
    expect((await rows(e.id))[0]).toMatchObject({ status: "sent" });
  });

  it("retries when MSG91 is down, and gives up when it refuses", async () => {
    const b = await book();
    msg91 = () => Response.json({}, { status: 502 });
    await run();
    expect((await rows(b.id))[0]).toMatchObject({ status: "queued", last_error: "MSG91 502" });
    msg91 = () => Response.json({ type: "error", message: "Invalid template" }, { status: 400 });
    await due(b.id);
    await run();
    expect((await rows(b.id))[0]).toMatchObject({ status: "failed", last_error: "MSG91 400 (error)" });
  });

  it("delivery reports: needs the secret, stamps delivery, records failures, and opts out DND-blocked numbers", async () => {
    const b = await book();
    await run();
    const ok = JSON.stringify([{ requestId: "req-1", telNum: "919876543210", status: 1, deliveryTime: "2031-01-06T10:00:05Z" }]);
    expect((await handleSmsWebhook(pool, cfg, ok, "wrong")).status).toBe(401);
    expect((await handleSmsWebhook(pool, cfg, ok, null)).status).toBe(401);
    expect((await handleSmsWebhook(pool, null, ok, "s3cret-for-reports")).status).toBe(503);
    expect((await handleSmsWebhook(pool, cfg, "{", "s3cret-for-reports")).status).toBe(400);
    expect((await handleSmsWebhook(pool, cfg, ok, "s3cret-for-reports")).status).toBe(200);
    expect((await rows(b.id)).find((r) => r.kind === "booked_guest")).toMatchObject({ status: "sent", delivered_at: new Date("2031-01-06T10:00:05Z") });

    const blocked = JSON.stringify({ requestId: "req-1", telNum: "919876543210", status: 17, failureReason: "Blocked number" });
    await handleSmsWebhook(pool, cfg, blocked, "s3cret-for-reports");
    expect((await rows(b.id)).map((r) => [r.kind, r.status, r.last_error])).toEqual([
      ["booked_guest", "failed", "SMS delivery failed (MSG91 status 17: Blocked number)"],
      ["reminder_guest", "skipped", "number is blocked for texts (DLT opt-out)"],
    ]);
    expect((await pool.query("select phone, source from sms_opt_outs")).rows).toEqual([{ phone: "919876543210", source: "dlt" }]);
    expect(await rows((await book()).id)).toEqual([]);
  });

  it("the manage-page switch turns texts off and on again", async () => {
    const b = await book();
    const token = b.invitee.manageToken;
    expect((await handleSmsToggle(pool, token, { on: "yes" }, new Date())).status).toBe(400);
    expect((await handleSmsToggle(pool, "nope", { on: false }, new Date())).status).toBe(404);
    expect(await handleSmsToggle(pool, token, { on: false }, new Date())).toEqual({ status: 200, body: { on: false } });
    expect((await rows(b.id)).map((r) => r.status)).toEqual(["skipped", "skipped"]);
    await due(b.id);
    await run();
    expect(texts()).toHaveLength(0);
    // A text queued anyway (say, a WhatsApp fallback) is dropped while the switch is off.
    await pool.query(`insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key) values ($1, $2, 'sms', 'cancelled_guest', '919876543210', now() - interval '1 second', 'x-off')`, [b.id, priya.id]);
    await run();
    expect(texts()).toHaveLength(0);
    expect((await pool.query("select last_error from notifications where dedupe_key = 'x-off'")).rows[0].last_error).toBe("guest turned off text messages");

    await handleSmsToggle(pool, token, { on: true }, new Date());
    expect((await rows(b.id)).find((r) => r.kind === "reminder_guest")).toMatchObject({ status: "queued" });

    // Turned on later by a guest who didn't tick it: the day-ahead reminder is queued.
    const c = await book({ sms: false });
    expect(await rows(c.id)).toEqual([]);
    await handleSmsToggle(pool, c.invitee.manageToken, { on: true }, new Date());
    expect((await rows(c.id)).map((r) => [r.kind, r.status])).toEqual([["reminder_guest", "queued"]]);
    // A foreign number can't turn texts on.
    const d = await book({ phone: "+44 7700 900123", sms: false });
    expect((await handleSmsToggle(pool, d.invitee.manageToken, { on: true }, new Date())).status).toBe(409);
  });

  it("tells the guest by text when the booking is cancelled or moved, and keeps the tick across a move", async () => {
    const b = await book();
    await run();
    const moved = await store.rescheduleBooking(priya.id, b.id, new Date(Date.now() + 9 * 86_400_000), "sms-move-1", "host");
    expect((await rows(moved.id)).map((r) => r.kind)).toEqual(["reminder_guest", "rescheduled_guest"]);
    await run();
    expect(texts().map((t) => t.body.template_id)).toEqual(["tpl-booked", "tpl-moved"]);
    await store.cancelBooking(priya.id, moved.id, "host");
    expect((await rows(moved.id)).map((r) => [r.kind, r.status])).toEqual([["cancelled_guest", "queued"], ["reminder_guest", "skipped"], ["rescheduled_guest", "sent"]]);
    await run();
    expect(texts().map((t) => t.body.template_id)).toEqual(["tpl-booked", "tpl-moved", "tpl-cancelled"]);
  });

  it("sends Hindi on the Hindi template, and English where no Hindi template is set up", async () => {
    const b = await book({ locale: "hi" });
    await run();
    expect(texts()[0].body).toMatchObject({ template_id: "tpl-booked-hi", recipients: [{ VAR1: slot1("hi") }] });
    await store.cancelBooking(priya.id, b.id, "host");
    await run();
    expect(texts()[1].body).toMatchObject({ template_id: "tpl-cancelled", recipients: [{ VAR1: slot1("en") }] });
  });
});
