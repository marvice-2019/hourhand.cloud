// The client portal against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_portal, dropped and
// recreated on every run): links, sessions, the request flow, and that a client only ever sees their own rows with one host.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { invoiceForPurchase, saveTaxProfile } from "../gst/invoices";
import { createRateLimiter } from "../rate-limit";
import { requestPortalLink, PORTAL_LINK_LIMITS, type RequestLinkDeps } from "./request";
import { clientBookings, clientInvoices, clientPurchases, consumeLink, createSession, endSession, isClient, issueLink, readSession } from "./store";
import { LINK_TTL_MS, portalKey, SESSION_TTL_MS } from "./tokens";

const BASE = process.env.TEST_DATABASE_URL;
const key = portalKey({ BETTER_AUTH_SECRET: "test-secret-0123456789abcdef" });
const DAY = 86_400_000;

const ASHA = "asha@client.test"; // a client of both Priya and Arun
const RAVI = "ravi@client.test"; // a client of Priya only
const NOBODY = "nobody@client.test"; // never booked anyone

describe.skipIf(!BASE)("client portal (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let arun: User;
  let coaching: EventType;
  let chat: EventType;
  const ids: Record<string, string> = {};
  const purchases: Record<string, { id: string; token: string }> = {};
  const invoices: Record<string, string> = {};
  const now = new Date();

  async function book(host: User, et: EventType, email: string, startAt: Date, k: string, tz = "Asia/Kolkata") {
    const b = await store.createBooking({
      eventTypeId: et.id, startAt, idempotencyKey: `portal-${k}`,
      invitee: { name: k, email, timezone: tz, phone: null, answers: [] },
    });
    expect(b.hostId).toBe(host.id);
    ids[k] = b.id;
    return b;
  }

  async function buy(host: User, et: EventType, email: string, k: string) {
    const { rows: [pkg] } = await pool.query(
      "insert into packages (user_id, event_type_id, name, sessions, price_minor, valid_days) values ($1, $2, $3, 5, 400000, 90) returning id", [host.id, et.id, `5 × ${et.name}`]);
    const { rows: [p] } = await pool.query(
      `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, idempotency_key, status, provider_payment_id, paid_at, expires_at)
       values ($1, $2, $3, 5, 400000, 90, $4, $5, $6, 'paid', $7, $8, $9) returning id, token`,
      [pkg.id, host.id, et.id, k, email, `portal-purchase-${k}`, `pay_${k}`, now, new Date(now.getTime() + 90 * DAY)]);
    purchases[k] = p;
    invoices[k] = (await invoiceForPurchase(pool, p.id, now))!;
    return p as { id: string; token: string };
  }

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_portal`;
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
    arun = (await store.getUserBySlug("arun"))!;
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
    chat = (await store.listEventTypes(arun.id)).find((e) => e.slug === "chat")!;

    // Far ahead of the seeded bookings so nothing overlaps.
    const at = (days: number, hour = 6) => new Date(Date.UTC(2031, 0, 1 + days, hour));
    await book(priya, coaching, ASHA, at(1), "asha-priya-1");
    await book(priya, coaching, "Asha@Client.Test", at(2), "asha-priya-2"); // same client, other case
    await book(priya, coaching, ASHA, new Date(Date.UTC(2025, 0, 2, 6)), "asha-priya-past");
    await book(priya, coaching, RAVI, at(3), "ravi-priya-1");
    await book(arun, chat, ASHA, at(4), "asha-arun-1");

    for (const host of [priya, arun]) {
      await saveTaxProfile(pool, host.id, { legalName: host.name, address: "1 MG Road, Bengaluru", stateCode: "29", gstin: "29ABCDE1234F1Z5", sac: "999293", rateBp: 1800, invoicePrefix: "HH" });
    }
    await buy(priya, coaching, ASHA, "asha-priya");
    await buy(priya, coaching, RAVI, "ravi-priya");
    await buy(arun, chat, ASHA, "asha-arun");
    // One of Asha's Priya bookings used her package.
    await pool.query("update bookings set package_purchase_id = $1 where id = $2", [purchases["asha-priya"].id, ids["asha-priya-1"]]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("magic links", () => {
    it("open once, and a second use is refused", async () => {
      const token = await issueLink(pool, key, priya.id, ASHA, now);
      expect(await consumeLink(pool, key, token, priya.id, now)).toEqual({ ok: true, hostId: priya.id, email: ASHA });
      expect(await consumeLink(pool, key, token, priya.id, now)).toEqual({ ok: false, reason: "used" });
    });

    it("of two requests racing with the same link, only one gets in", async () => {
      const token = await issueLink(pool, key, priya.id, ASHA, now);
      const results = await Promise.all(Array.from({ length: 5 }, () => consumeLink(pool, key, token, priya.id, now)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    it("expire after 15 minutes", async () => {
      const token = await issueLink(pool, key, priya.id, ASHA, now);
      expect(await consumeLink(pool, key, token, priya.id, new Date(now.getTime() + LINK_TTL_MS))).toEqual({ ok: false, reason: "expired" });
      // Still unused, so it opens inside its window.
      expect(await consumeLink(pool, key, token, priya.id, new Date(now.getTime() + LINK_TTL_MS - 1000))).toMatchObject({ ok: true });
    });

    it("are refused with a forged signature, or when the stored row was changed to another email", async () => {
      const token = await issueLink(pool, key, priya.id, ASHA, now);
      const [nonce, sig] = token.split(".");
      const forged = `${nonce}.${(sig[0] === "A" ? "B" : "A") + sig.slice(1)}`;
      expect(await consumeLink(pool, key, forged, priya.id, now)).toEqual({ ok: false, reason: "bad_signature" });
      await pool.query("update portal_links set email = $1 where used_at is null and email = $2", [RAVI, ASHA]);
      expect(await consumeLink(pool, key, token, priya.id, now)).toEqual({ ok: false, reason: "bad_signature" });
      expect(await consumeLink(pool, key, "not-a-token", priya.id, now)).toEqual({ ok: false, reason: "malformed" });
    });

    it("only open the portal of the host they were sent for", async () => {
      const token = await issueLink(pool, key, priya.id, ASHA, now);
      expect(await consumeLink(pool, key, token, arun.id, now)).toEqual({ ok: false, reason: "wrong_host" });
      expect(await consumeLink(pool, key, token, priya.id, now)).toMatchObject({ ok: true });
    });

    it("are stored only as hashes", async () => {
      const token = await issueLink(pool, key, priya.id, ASHA, now);
      const { rows } = await pool.query("select nonce_hash from portal_links");
      for (const r of rows) expect(token).not.toContain(r.nonce_hash);
      expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.nonce_hash))).toBe(true);
    });
  });

  describe("sessions", () => {
    it("last 30 days, on their own host only, and end on sign-out", async () => {
      const s = await createSession(pool, priya.id, ASHA, now);
      expect(s.expiresAt.getTime() - now.getTime()).toBe(SESSION_TTL_MS);
      expect(await readSession(pool, s.id, priya.id, now)).toEqual({ email: ASHA });
      expect(await readSession(pool, s.id, arun.id, now)).toBeNull();
      expect(await readSession(pool, s.id, priya.id, new Date(now.getTime() + SESSION_TTL_MS))).toBeNull();
      expect(await readSession(pool, "garbage", priya.id, now)).toBeNull();
      expect(await readSession(pool, undefined, priya.id, now)).toBeNull();
      await endSession(pool, s.id);
      expect(await readSession(pool, s.id, priya.id, now)).toBeNull();
    });
  });

  describe("asking for a link", () => {
    function deps(over: Partial<RequestLinkDeps> = {}) {
      const sent: { to: string; url: string }[] = [];
      const deferred: (() => Promise<void>)[] = [];
      const d: RequestLinkDeps = {
        db: pool, key, limiter: createRateLimiter(), now, send: async (to, url) => { sent.push({ to, url }); }, defer: (w) => { deferred.push(w); }, ...over,
      };
      return { d, sent, flush: async () => { for (const w of deferred.splice(0)) await w(); } };
    }
    const input = (host: User, email: string, ip = "203.0.113.7") => ({ host: { id: host.id, slug: host.slug }, email, ip, baseUrl: "https://hourhand.test", locale: "ta" as const });

    it("answers the same whether or not the email has booked, and emails a link only to a real client", async () => {
      const { d, sent, flush } = deps();
      const known = await requestPortalLink(d, input(priya, ASHA));
      const unknown = await requestPortalLink(d, input(priya, NOBODY));
      const otherHostsClient = await requestPortalLink(d, input(arun, RAVI)); // Ravi booked Priya, never Arun
      expect(known).toEqual({ status: "sent", email: ASHA });
      expect(unknown).toEqual({ status: "sent", email: NOBODY });
      expect(otherHostsClient).toEqual({ status: "sent", email: RAVI });
      // Nothing is looked up or sent before the answer goes back.
      expect(sent).toHaveLength(0);
      await flush();
      expect(sent.map((m) => m.to)).toEqual([ASHA]);
      const url = new URL(sent[0].url);
      expect(url.pathname).toBe("/priya/portal/open");
      expect(url.searchParams.get("lang")).toBe("ta");
      // The token rides in the fragment, which browsers never send to a server.
      expect(url.search).not.toContain(".");
      expect(await consumeLink(pool, key, decodeURIComponent(url.hash.slice(1)), priya.id, now)).toMatchObject({ ok: true, email: ASHA });
    });

    it("refuses a bad email without counting it against anyone", async () => {
      const { d } = deps();
      expect(await requestPortalLink(d, input(priya, "not an email"))).toEqual({ status: "invalid_email" });
    });

    it("limits links per email, the same for a client and a stranger", async () => {
      const { d } = deps();
      for (const email of [ASHA, NOBODY]) {
        for (let i = 0; i < PORTAL_LINK_LIMITS.perEmail.max; i++) expect((await requestPortalLink(d, input(priya, email, `198.51.100.${i}`))).status).toBe("sent");
        expect(await requestPortalLink(d, input(priya, email, "198.51.100.99"))).toEqual({ status: "too_many" });
      }
    });

    it("limits links per address, across many emails, until the window passes", async () => {
      let t = now.getTime();
      const { d } = deps({ limiter: createRateLimiter(() => t) });
      for (let i = 0; i < PORTAL_LINK_LIMITS.perIp.max; i++) expect((await requestPortalLink(d, input(priya, `sweep${i}@client.test`))).status).toBe("sent");
      expect(await requestPortalLink(d, input(priya, "sweep-next@client.test"))).toEqual({ status: "too_many" });
      t += PORTAL_LINK_LIMITS.perIp.windowMs;
      expect((await requestPortalLink(d, input(priya, "sweep-next@client.test"))).status).toBe("sent");
    });

    it("counts only real clients: a lapsed payment hold isn't one", async () => {
      expect(await isClient(pool, priya.id, ASHA)).toBe(true);
      expect(await isClient(pool, priya.id, "ASHA@client.test")).toBe(true);
      expect(await isClient(pool, arun.id, RAVI)).toBe(false);
      expect(await isClient(pool, priya.id, NOBODY)).toBe(false);
      const hold = await book(priya, coaching, "held@client.test", new Date(Date.UTC(2031, 0, 20, 6)), "held");
      await pool.query("update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system' where id = $1", [hold.id]);
      expect(await isClient(pool, priya.id, "held@client.test")).toBe(false);
    });
  });

  describe("isolation", () => {
    it("shows a client only their own bookings with this host, whatever case their email was typed in", async () => {
      const mine = (await clientBookings(pool, priya.id, ASHA)).map((b) => b.id).sort();
      expect(mine).toEqual([ids["asha-priya-1"], ids["asha-priya-2"], ids["asha-priya-past"]].sort());
      expect((await clientBookings(pool, priya.id, "ASHA@CLIENT.TEST")).map((b) => b.id).sort()).toEqual(mine);
      // Ravi never sees Asha's, and Asha's portal with Arun shows only Arun's booking.
      expect((await clientBookings(pool, priya.id, RAVI)).map((b) => b.id)).toEqual([ids["ravi-priya-1"]]);
      expect((await clientBookings(pool, arun.id, ASHA)).map((b) => b.id)).toEqual([ids["asha-arun-1"]]);
      expect(await clientBookings(pool, arun.id, RAVI)).toEqual([]);
      expect(await clientBookings(pool, priya.id, NOBODY)).toEqual([]);
    });

    it("never lets one client's rows reach another, for every client and host pair", async () => {
      const { rows } = await pool.query("select b.id, b.host_id, lower(i.email::text) as email from bookings b join invitees i on i.booking_id = b.id");
      for (const host of [priya, arun]) {
        for (const email of [ASHA, RAVI, NOBODY, "divya.menon@example.com"]) {
          const seen = new Set((await clientBookings(pool, host.id, email)).map((b) => b.id));
          for (const r of rows) {
            const own = r.host_id === host.id && r.email === email;
            if (!own) expect(seen.has(r.id), `${email}@${host.slug} saw ${r.id}`).toBe(false);
          }
        }
      }
    });

    it("shows package balances for the client's own packages with this host only", async () => {
      const mine = await clientPurchases(pool, priya.id, ASHA);
      expect(mine.map((p) => p.id)).toEqual([purchases["asha-priya"].id]);
      expect(mine[0]).toMatchObject({ sessions: 5, used: 1, onSale: true });
      expect((await clientPurchases(pool, priya.id, RAVI)).map((p) => p.id)).toEqual([purchases["ravi-priya"].id]);
      expect((await clientPurchases(pool, arun.id, ASHA)).map((p) => p.id)).toEqual([purchases["asha-arun"].id]);
      expect(await clientPurchases(pool, arun.id, RAVI)).toEqual([]);
    });

    it("lists only the invoices this host issued to this client", async () => {
      const mine = await clientInvoices(pool, priya.id, ASHA);
      expect(mine.map((v) => v.id)).toEqual([invoices["asha-priya"]]);
      expect(mine[0].token).toMatch(/^[0-9a-f]{48}$/);
      expect((await clientInvoices(pool, priya.id, RAVI)).map((v) => v.id)).toEqual([invoices["ravi-priya"]]);
      expect((await clientInvoices(pool, arun.id, ASHA)).map((v) => v.id)).toEqual([invoices["asha-arun"]]);
      expect(await clientInvoices(pool, arun.id, RAVI)).toEqual([]);
      expect(await clientInvoices(pool, priya.id, NOBODY)).toEqual([]);
    });

    it("a session is for one host and one email: signing in on Priya's portal gives nothing on Arun's", async () => {
      const token = await issueLink(pool, key, priya.id, RAVI, now);
      const opened = await consumeLink(pool, key, token, priya.id, now);
      expect(opened).toMatchObject({ ok: true, email: RAVI });
      const s = await createSession(pool, priya.id, RAVI, now);
      expect(await readSession(pool, s.id, arun.id, now)).toBeNull();
      const who = (await readSession(pool, s.id, priya.id, now))!;
      expect((await clientBookings(pool, priya.id, who.email)).every((b) => b.id === ids["ravi-priya-1"])).toBe(true);
    });

    it("refuses lookups with a malformed host id or email instead of widening them", async () => {
      expect(await clientBookings(pool, "' or 1=1 --", ASHA)).toEqual([]);
      expect(await clientBookings(pool, priya.id, "%")).toEqual([]);
      expect(await clientInvoices(pool, priya.id, "")).toEqual([]);
    });
  });

  it("keeps the expired-link sweep to links well past their end", async () => {
    await issueLink(pool, key, priya.id, ASHA, new Date(now.getTime() - 2 * DAY));
    const before = (await pool.query("select count(*)::int as n from portal_links where expires_at < $1", [new Date(now.getTime() - DAY)])).rows[0].n;
    expect(before).toBe(1);
    await issueLink(pool, key, priya.id, ASHA, now);
    const after = (await pool.query("select count(*)::int as n from portal_links where expires_at < $1", [new Date(now.getTime() - DAY)])).rows[0].n;
    expect(after).toBe(0);
  });
});
