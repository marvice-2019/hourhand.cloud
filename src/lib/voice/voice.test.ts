// The phone receptionist's tools and webhooks against real Postgres (only with TEST_DATABASE_URL; uses its own
// database <name>_voice, dropped and recreated on every run). ElevenLabs, Razorpay, email and WhatsApp are fakes.
import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { freeSlots, type PaymentDeps } from "../booking";
import { createPgStore } from "../data/pg-store";
import type { DataStore, User } from "../data/types";
import type { Mail } from "../mail/mailer";
import { keyPairAuth } from "../payments/host-razorpay";
import { razorpayOrders } from "../payments/razorpay-orders";
import { createRateLimiter } from "../rate-limit";
import { agentConfig } from "./agent-config";
import { mintToolKey } from "./auth";
import { DEFAULT_RATES } from "./cost";
import { closeCall, listMessages, rotateKey, saveVoiceSettings } from "./store";
import { handleVoiceTool, SLOTS_PER_ANSWER, type VoiceDeps } from "./tools";
import { handleCallStart, handlePostCall, type WebhookDeps } from "./webhooks";

const BASE = process.env.TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 9);
const MIN = 60_000;
const DAY = 86_400_000;
const TZ = "Asia/Kolkata";

describe.skipIf(!BASE)("phone receptionist (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let meera: User; // the host under test, on Duo
  let ravi: User; // another host, also on Duo
  let solo: User; // a host on Solo: no voice
  const plans = new Map<string, string>();
  const mail: Mail[] = [];
  const whatsapp: { to: string; template: string }[] = [];
  const orders = { creates: 0, fail: false };
  let paymentsOn = true;
  let conv = 0;
  const nextConv = () => `conv_${++conv}_${Math.random().toString(36).slice(2, 8)}`;

  const mailer = { async send(m: Mail) { mail.push(m); return { id: `m${mail.length}` }; } };
  const auth = keyPairAuth("rzp_test_voice1234", "k");
  const fakeFetch = (async (url: string, init: RequestInit) => {
    if (url.includes("graph.fake")) {
      const b = JSON.parse(String(init.body));
      whatsapp.push({ to: b.to, template: b.template?.name });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${whatsapp.length}` }] }), { status: 200 });
    }
    if (orders.fail) return new Response(JSON.stringify({ error: { code: "SERVER_ERROR" } }), { status: 500 });
    orders.creates += 1;
    const b = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: `order_voice_${orders.creates}`, amount: b.amount, currency: b.currency, status: "created" }), { status: 200 });
  }) as unknown as typeof fetch;

  const payments = (): PaymentDeps => ({
    pool, authFor: async () => (paymentsOn ? auth : null), ordersFor: (a) => razorpayOrders(a, { baseUrl: "https://rp.fake", fetchImpl: fakeFetch }),
    planFor: async (id) => (plans.get(id) ?? "free") as "free",
  });
  const deps = (over: Partial<VoiceDeps> = {}): VoiceDeps => ({
    pool, store, key: KEY, planFor: async (id) => plans.get(id) ?? "free", payments: payments(), mailer,
    whatsapp: { phoneNumberId: "1", accessToken: "t", appSecret: "a", verifyToken: "v", baseUrl: "https://graph.fake" },
    limiter: createRateLimiter(), baseUrl: "https://hourhand.test", fetchFn: fakeFetch, ...over,
  });
  const hooks = (): WebhookDeps => ({ pool, store, planFor: async (id) => plans.get(id) ?? "free", mailer, rates: DEFAULT_RATES, baseUrl: "https://hourhand.test" });

  const keyFor = (u: User, v = 1) => mintToolKey(KEY, u.id, v);
  const call = (u: User, tool: string, body: Record<string, unknown>, now = new Date(), d = deps()) =>
    handleVoiceTool(d, tool, keyFor(u), { conversation_id: body.conversation_id ?? nextConv(), caller_phone: "+919876500001", ...body }, now);

  async function host(slug: string, plan: string): Promise<User> {
    const { rows: [u] } = await pool.query("insert into users (email, name, slug, timezone) values ($1, $2, $3, $4) returning id", [`${slug}@example.in`, `Dr ${slug}`, slug, TZ]);
    const { rows: [s] } = await pool.query("insert into availability_schedules (user_id, name, timezone, is_default) values ($1, 'Hours', $2, true) returning id", [u.id, TZ]);
    for (let d = 0; d < 7; d++) {
      await pool.query("insert into availability_rules (schedule_id, kind, weekday, intervals) values ($1, 'weekly', $2, $3)", [s.id, d, JSON.stringify([{ from: "09:00", to: "17:00" }])]);
    }
    plans.set(u.id, plan);
    return (await store.getUser(u.id))!;
  }
  async function service(u: User, slug: string, extra: { price?: number; hidden?: boolean; policy?: string } = {}) {
    await pool.query(
      "insert into event_types (user_id, name, slug, duration_minutes, price_minor, currency, hidden, cancellation_policy) values ($1, $2, $3, 60, $4, $5, $6, $7)",
      [u.id, `${slug} session`, slug, extra.price ?? null, extra.price ? "INR" : null, extra.hidden ?? false, extra.policy ?? null]);
    return (await store.listEventTypes(u.id)).find((e) => e.slug === slug)!;
  }
  /** The first offered start a few days out (clear of minimum notice), as get_free_slots would give it. */
  async function firstSlot(u: User, slug: string, now = new Date(), dayOffset = 3): Promise<string> {
    const r = await call(u, "get_free_slots", { service: slug, from_date: new Date(now.getTime() + dayOffset * DAY).toISOString().slice(0, 10), days: 1 }, now);
    return (r.body as { slots: { start: string }[] }).slots[0].start;
  }

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_voice`;
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
    store = createPgStore(pool);
    meera = await host("meera", "duo");
    ravi = await host("ravi", "duo");
    solo = await host("solo", "solo");
    await service(meera, "consult", { policy: "Cancel 24 hours ahead for a full refund." });
    await service(meera, "therapy", { price: 150_000 });
    await service(meera, "private", { hidden: true });
    await service(ravi, "ravi-only");
    for (const h of [meera, ravi, solo]) await saveVoiceSettings(pool, h.id, { enabled: true, monthlyMinuteCap: 100, agentId: `agent_${h.slug}`, publicNote: `${h.slug}'s clinic, MG Road` });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => {
    mail.length = 0;
    whatsapp.length = 0;
    paymentsOn = true;
    orders.fail = false;
  });

  describe("tool auth per host", () => {
    it("refuses a missing, forged or revoked key", async () => {
      const body = { conversation_id: nextConv() };
      expect((await handleVoiceTool(deps(), "get_services", null, body, new Date())).status).toBe(401);
      expect((await handleVoiceTool(deps(), "get_services", `${keyFor(meera)}x`, body, new Date())).status).toBe(401);
      const temp = await host("temp", "duo");
      await saveVoiceSettings(pool, temp.id, { enabled: true });
      const old = keyFor(temp, 1);
      expect((await handleVoiceTool(deps(), "get_services", old, body, new Date())).status).toBe(200);
      const v = await rotateKey(pool, temp.id);
      expect((await handleVoiceTool(deps(), "get_services", old, { conversation_id: nextConv() }, new Date())).status).toBe(401);
      expect((await handleVoiceTool(deps(), "get_services", keyFor(temp, v), { conversation_id: nextConv() }, new Date())).status).toBe(200);
    });

    it("tells the agent to end the call when voice is off or the plan doesn't include it", async () => {
      const r = await call(solo, "get_services", {});
      expect(r).toMatchObject({ status: 403, body: { error: "voice_off", end_call: true } });
      await saveVoiceSettings(pool, ravi.id, { enabled: false });
      expect(await call(ravi, "get_services", {})).toMatchObject({ status: 403, body: { error: "voice_off" } });
      await saveVoiceSettings(pool, ravi.id, { enabled: true });
    });

    it("stops when the add-on has lapsed, at call start and in every tool", async () => {
      const lapsed = deps({ hasAddon: async () => false });
      expect(await call(meera, "get_services", {}, new Date(), lapsed)).toMatchObject({ status: 403, body: { error: "voice_off", end_call: true } });
      const r = await handleCallStart({ ...hooks(), hasAddon: async () => false }, "init", "Bearer init", { agent_id: "agent_meera" }, new Date());
      expect((r.body as { dynamic_variables: Record<string, string> }).dynamic_variables.voice_allowed).toBe("no");
      expect((await call(meera, "get_services", {}, new Date(), deps({ hasAddon: async () => true }))).status).toBe(200);
    });

    it("answers unknown tools with 404", async () => {
      expect((await call(meera, "delete_everything", {})).status).toBe(404);
    });
  });

  describe("no cross-host data", () => {
    it("lists only the host's own public services, with its public note", async () => {
      const r = await call(meera, "get_services", {});
      const body = r.body as { services: { service: string; cancellation_policy: string | null; price: string | null }[]; about: string };
      expect(body.services.map((s) => s.service).sort()).toEqual(["consult", "therapy"]);
      expect(body.services.find((s) => s.service === "therapy")!.price).toBe("₹1,500");
      expect(body.services.find((s) => s.service === "consult")!.cancellation_policy).toMatch(/24 hours/);
      expect(body.about).toBe("meera's clinic, MG Road");
    });

    it("can't see or book another host's service", async () => {
      expect((await call(meera, "get_free_slots", { service: "ravi-only" })).body).toMatchObject({ error: "unknown_service" });
      expect((await call(meera, "get_free_slots", { service: "private" })).body).toMatchObject({ error: "unknown_service" });
    });

    it("refuses a conversation id that belongs to another host", async () => {
      const id = nextConv();
      expect((await call(ravi, "get_services", { conversation_id: id })).status).toBe(200);
      expect(await call(meera, "get_services", { conversation_id: id })).toMatchObject({ status: 403, body: { error: "unauthorized" } });
    });

    it("keeps each host's messages to itself", async () => {
      await call(ravi, "take_message", { name: "Asha", message: "Please call me about Friday", reason: "requested" });
      const forMeera = await listMessages(pool, meera.id);
      expect(forMeera.some((m) => m.callerName === "Asha")).toBe(false);
      expect((await listMessages(pool, ravi.id)).some((m) => m.callerName === "Asha")).toBe(true);
    });
  });

  describe("slot offers", () => {
    it("are the slot engine's own free times, a few at a time", async () => {
      const now = new Date();
      const from = new Date(now.getTime() + 2 * DAY).toISOString().slice(0, 10);
      const r = await call(meera, "get_free_slots", { service: "consult", from_date: from, days: 2 }, now);
      const et = (await store.listEventTypes(meera.id)).find((e) => e.slug === "consult")!;
      const startIst = new Date(`${from}T00:00:00+05:30`);
      const engine = await freeSlots(store, meera, et, startIst, new Date(startIst.getTime() + 2 * DAY), now);
      const body = r.body as { slots: { start: string; spoken: string }[]; more: boolean };
      expect(engine.length).toBeGreaterThan(SLOTS_PER_ANSWER);
      expect(body.slots.map((s) => s.start)).toEqual(engine.slice(0, SLOTS_PER_ANSWER).map((d) => d.toISOString()));
      expect(body.more).toBe(true);
      expect(body.slots[0].spoken).toMatch(/9:00 am$/);
    });
  });

  describe("booking", () => {
    it("won't book before the details are read back to the caller", async () => {
      const start = await firstSlot(meera, "consult");
      const r = await call(meera, "create_booking", { service: "consult", start, name: "Kiran", email: "kiran@example.in" });
      expect(r.body).toMatchObject({ error: "confirm_first" });
      expect((await store.listBookings(meera.id)).some((b) => b.startAt.toISOString() === start)).toBe(false);
    });

    it("books a free service as source=voice, once per call, and confirms by email", async () => {
      const start = await firstSlot(meera, "consult");
      const conversation_id = nextConv();
      const req = { conversation_id, service: "consult", start, name: "Kiran Rao", email: "kiran@example.in", confirmed_with_caller: true };
      const r = await call(meera, "create_booking", req);
      expect(r).toMatchObject({ status: 201, body: { status: "booked", confirmation_sent_by: ["email"] } });
      const again = await call(meera, "create_booking", req);
      expect(again.status).toBe(201);
      const mine = (await store.listBookings(meera.id)).filter((b) => b.startAt.toISOString() === start && b.status === "confirmed");
      expect(mine).toHaveLength(1);
      const { rows: [b] } = await pool.query("select source from bookings where id = $1", [mine[0].id]);
      expect(b.source).toBe("voice");
      const { rows: n } = await pool.query("select kind, recipient from notifications where booking_id = $1 and kind = 'booked_guest'", [mine[0].id]);
      expect(n).toEqual([{ kind: "booked_guest", recipient: "kiran@example.in" }]);
      const { rows: [c] } = await pool.query("select outcome, booking_id from voice_calls where conversation_id = $1", [conversation_id]);
      expect(c).toEqual({ outcome: "booked", booking_id: mine[0].id });
    });

    it("needs an email or a yes to WhatsApp, and without email confirms on WhatsApp only", async () => {
      const start = await firstSlot(meera, "consult", new Date(), 4);
      const base = { service: "consult", start, name: "Sunil", confirmed_with_caller: true, phone: "+91 98765 00002" };
      expect((await call(meera, "create_booking", base)).body).toMatchObject({ error: "need_contact" });
      const r = await call(meera, "create_booking", { ...base, whatsapp_ok: true });
      expect(r.body).toMatchObject({ status: "booked", confirmation_sent_by: ["whatsapp"] });
      const b = (await store.listBookings(meera.id)).find((x) => x.startAt.toISOString() === start && x.invitee.name === "Sunil")!;
      expect(b.invitee.email).toBe("919876500002@voice.invalid");
      expect(b.invitee.whatsappOptIn).toBe(true);
      const { rows } = await pool.query("select channel from notifications where booking_id = $1 and kind = 'booked_guest'", [b.id]);
      expect(rows.map((x) => x.channel)).not.toContain("email");
    });

    it("offers the next times when the slot went meanwhile", async () => {
      const start = await firstSlot(meera, "consult", new Date(), 5);
      await call(meera, "create_booking", { service: "consult", start, name: "First", email: "first@example.in", confirmed_with_caller: true });
      const r = await call(meera, "create_booking", { service: "consult", start, name: "Second", email: "second@example.in", confirmed_with_caller: true });
      const body = r.body as { error: string; slots: { start: string }[]; attempts_left: number };
      expect(body.error).toBe("slot_taken");
      expect(body.slots.length).toBeGreaterThan(0);
      expect(body.slots.map((s) => s.start)).not.toContain(start);
      expect(body.attempts_left).toBe(1);
    });
  });

  describe("paid services", () => {
    it("hold the slot 15 minutes and send a payment link instead of booking unpaid", async () => {
      const now = new Date();
      const start = await firstSlot(meera, "therapy", now, 6);
      const r = await call(meera, "create_booking", { service: "therapy", start, name: "Lata", email: "lata@example.in", phone: "+919876500003", whatsapp_ok: true, confirmed_with_caller: true }, now);
      expect(r).toMatchObject({ status: 201, body: { status: "payment_link_sent", sent_by: ["email", "whatsapp"], amount: "₹1,500", hold_minutes: 15 } });
      const b = (await store.listBookings(meera.id)).find((x) => x.startAt.toISOString() === start)!;
      expect(b.status).toBe("pending_payment");
      expect(b.holdExpiresAt!.getTime() - now.getTime()).toBe(15 * MIN);
      const link = mail.find((m) => m.to === "lata@example.in")!;
      expect(link.text).toContain(`https://hourhand.test/v/pay/${b.invitee.manageToken}`);
      expect(whatsapp).toEqual([{ to: "919876500003", template: "hh_voice_pay_link" }]);
      // No confirmation goes out while it is unpaid.
      expect((await pool.query("select 1 from notifications where booking_id = $1 and kind = 'booked_guest'", [b.id])).rowCount).toBe(0);

      // Held: not offered to anyone else; released: offered again.
      const et = (await store.listEventTypes(meera.id)).find((e) => e.slug === "therapy")!;
      const at = new Date(start);
      const offered = async (when: Date) => (await freeSlots(store, meera, et, at, new Date(at.getTime() + MIN), when)).length;
      expect(await offered(new Date(now.getTime() + 14 * MIN))).toBe(0);
      expect(await offered(new Date(now.getTime() + 16 * MIN))).toBe(1);
    });

    it("hands off with a message when payments aren't set up, booking nothing", async () => {
      paymentsOn = false;
      const start = await firstSlot(meera, "therapy", new Date(), 7);
      const conversation_id = nextConv();
      const r = await call(meera, "create_booking", { conversation_id, service: "therapy", start, name: "Neha", email: "neha@example.in", confirmed_with_caller: true });
      expect(r.body).toMatchObject({ error: "payment_issue", handoff: true, message_taken: true });
      expect((await store.listBookings(meera.id)).some((b) => b.startAt.toISOString() === start)).toBe(false);
      expect((await listMessages(pool, meera.id))[0]).toMatchObject({ reason: "payment_issue", callerName: "Neha" });
      expect(mail.some((m) => m.to === meera.email && m.subject.includes("Neha"))).toBe(true);
    });
  });

  describe("guardrails", () => {
    it("hand the caller to the host after 2 failed attempts, leaving one message", async () => {
      const conversation_id = nextConv();
      const first = await call(meera, "get_free_slots", { conversation_id, service: "nope" });
      expect(first.body).toMatchObject({ error: "unknown_service", attempts_left: 1 });
      expect(first.body).not.toHaveProperty("handoff");
      const second = await call(meera, "get_free_slots", { conversation_id, service: "nope" });
      expect(second.body).toMatchObject({ handoff: true, say: expect.stringMatching(/take a message/) });
      await call(meera, "get_free_slots", { conversation_id, service: "nope" });
      const { rows } = await pool.query(
        "select m.reason from voice_messages m join voice_calls c on c.id = m.call_id where c.conversation_id = $1", [conversation_id]);
      expect(rows).toEqual([{ reason: "handoff" }]);
      expect(mail.filter((m) => m.to === meera.email)).toHaveLength(1);
    });

    it("refuse clinical advice: the question becomes an out-of-scope message for the host", async () => {
      const r = await call(meera, "take_message", { name: "Ramesh", message: "Should I stop taking my tablet before the session?", reason: "requested" });
      expect(r.body).toMatchObject({ status: "message_taken", say: expect.stringMatching(/can't give medical or therapy advice/) });
      expect((await listMessages(pool, meera.id))[0]).toMatchObject({ callerName: "Ramesh", reason: "out_of_scope" });
    });

    it("give emergency numbers and flag the host urgently on a crisis", async () => {
      const r = await call(meera, "take_message", { name: "Anon", message: "I don't want to live, I want to end my life", reason: "requested" }, new Date(), deps({ mailer }));
      expect(r.body).toMatchObject({ urgent: true, say: expect.stringMatching(/112.*14416/) });
      expect(mail.find((m) => m.to === meera.email)!.subject).toMatch(/^URGENT/);
    });
  });

  describe("minute cap", () => {
    const sign = (secret: string, body: string, now: Date) => {
      const t = Math.floor(now.getTime() / 1000);
      return `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    };
    const postCall = (agent: string, conversation: string, secs: number, now: Date, secret = "whsec") => {
      const body = JSON.stringify({ type: "post_call_transcription", data: { agent_id: agent, conversation_id: conversation, metadata: { call_duration_secs: secs, start_time_unix_secs: Math.floor(now.getTime() / 1000) - secs, phone_call: { external_number: "+919876500009" } } } });
      return handlePostCall(hooks(), "whsec", body, sign(secret, body, now), now);
    };

    it("records each call's length and cost from the signed post-call webhook, and rejects bad signatures", async () => {
      const now = new Date();
      const id = nextConv();
      expect((await postCall("agent_ravi", id, 180, now, "wrong")).status).toBe(401);
      expect((await postCall("agent_ravi", id, 180, now)).status).toBe(200);
      expect((await postCall("agent_ravi", id, 180, now)).status).toBe(200); // a retry changes nothing
      const { rows } = await pool.query("select duration_secs, cost_paise, caller_phone from voice_calls where conversation_id = $1", [id]);
      expect(rows).toEqual([{ duration_secs: 180, cost_paise: 2704, caller_phone: "+919876500009" }]);
    });

    it("warns at 80% once, then stops at the cap: tools refuse and new calls get one line", async () => {
      const capped = await host("capped", "duo");
      await service(capped, "chat");
      await saveVoiceSettings(pool, capped.id, { enabled: true, monthlyMinuteCap: 10, agentId: "agent_capped" });
      const now = new Date();
      await postCall("agent_capped", nextConv(), 7 * 60, now);
      expect(mail.filter((m) => m.to === capped.email)).toHaveLength(0);
      await postCall("agent_capped", nextConv(), 60, now); // 8 of 10 minutes
      await postCall("agent_capped", nextConv(), 30, now);
      const warnings = mail.filter((m) => m.to === capped.email);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].subject).toMatch(/80%/);

      expect((await call(capped, "get_services", {})).status).toBe(200);
      const start = (await handleCallStart(hooks(), "init", "Bearer init", { agent_id: "agent_capped", caller_id: "+919876500010" }, now)).body as { dynamic_variables: Record<string, string> };
      expect(start.dynamic_variables).toMatchObject({ voice_allowed: "yes", host_name: "Dr capped", recording: "off", recording_rule: expect.stringMatching(/not recorded/) });
      expect(start.dynamic_variables.opening_en).toMatch(/automated assistant/);
      // ElevenLabs wants every variable the agent defines back from this webhook.
      const defined = agentConfig({ hostName: "x", hostSlug: "x", recordingEnabled: false }).conversation_config.agent.dynamic_variables.dynamic_variable_placeholders;
      expect(Object.keys(start.dynamic_variables).sort()).toEqual(Object.keys(defined).sort());

      await closeCall(pool, { hostId: capped.id, conversationId: nextConv(), callerPhone: null, startedAt: now, durationSecs: 90, costPaise: 0 }); // 10 min
      expect(await call(capped, "get_services", {})).toMatchObject({ status: 403, body: { error: "cap_reached", end_call: true } });
      const after = (await handleCallStart(hooks(), "init", "Bearer init", { agent_id: "agent_capped" }, now)).body as { dynamic_variables: Record<string, string> };
      expect(after.dynamic_variables).toMatchObject({ voice_allowed: "no" });
      expect(after.dynamic_variables.opening_en).toMatch(/isn't available/);
      expect((await handleCallStart(hooks(), "init", "Bearer nope", { agent_id: "agent_capped" }, now)).status).toBe(401);
    });

    it("tells callers about recording only when the host turned it on", async () => {
      await saveVoiceSettings(pool, ravi.id, { recordingEnabled: true });
      const r = (await handleCallStart(hooks(), "init", "Bearer init", { agent_id: "agent_ravi" }, new Date())).body as { dynamic_variables: Record<string, string> };
      expect(r.dynamic_variables).toMatchObject({ recording: "on", opening_en: expect.stringMatching(/recorded/), opening_hi: expect.stringMatching(/रिकॉर्ड/) });
      await saveVoiceSettings(pool, ravi.id, { recordingEnabled: false });
    });
  });
});
