// B17: a super admin's view of one host's customers. Real Postgres only (TEST_DATABASE_URL; its own database
// <name>_cust). The demo seed has bookings for two hosts, Priya and Arun.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import { hostBookings, hostClients, hostPayments } from "./customer-data";
import { csvCell, csvRow, signups } from "./signups";

const BASE = process.env.TEST_DATABASE_URL;

describe("CSV cells", () => {
  it("quotes every cell, doubles quotes, and stops a spreadsheet running a formula", () => {
    expect(csvCell('Meera "M" Iyer')).toBe('"Meera ""M"" Iyer"');
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(["+1", "-1", "@SUM(A1)", "\tx", "\rx"].map(csvCell)).toEqual(['"\'+1"', '"\'-1"', '"\'@SUM(A1)"', '"\'\tx"', '"\'\rx"']);
    expect(csvCell(null)).toBe('""');
    expect(csvCell(new Date("2026-11-27T00:00:00Z"))).toBe('"2026-11-27T00:00:00.000Z"');
    expect(csvRow(["a,b", 3])).toBe('"a,b","3"');
  });
});

describe.skipIf(!BASE)("customer data for super admins (Postgres)", () => {
  let pool: pg.Pool;
  let store: ReturnType<typeof createPgStore>;
  let priya: string;
  let arun: string;
  const SECRET = "very-secret-razorpay-key-secret-123";

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_cust`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const root = new URL(BASE!);
    root.pathname = "/postgres";
    const c = new pg.Client({ connectionString: root.toString() });
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
    const key = randomBytes(32);
    store = createPgStore(pool, { noteKey: () => key });
    priya = (await pool.query("select id from users where slug = 'priya'")).rows[0].id;
    arun = (await pool.query("select id from users where slug = 'arun'")).rows[0].id;
    const { rows: [b] } = await pool.query(
      "select b.id from bookings b join invitees i on i.booking_id = b.id where b.host_id = $1 and i.email = 'arjun.mehta@example.com'", [priya]);
    await pool.query("update invitees set answers = $2, phone = '+919876543210', guests = '{partner@example.com}' where booking_id = $1",
      [b.id, JSON.stringify([{ questionId: "q_goal", label: "What would you like to work on?", answer: "Planning a career move." }])]);
    await store.saveBookingNote(priya, b.id, "Wants to switch to product roles.");
    await store.saveClientNote(priya, "arjun.mehta@example.com", "Prefers mornings.");
    // A Razorpay key pair whose sealed blob holds a known secret: none of it may come back.
    await pool.query(
      "insert into integrations (user_id, provider, credentials_encrypted, public_id, mode, status) values ($1, 'razorpay', $2, 'rzp_live_abcdefgh1234', 'live', 'ok')",
      [priya, Buffer.from(JSON.stringify({ keyId: "rzp_live_abcdefgh1234", keySecret: SECRET }))]);
    await pool.query(
      "insert into payments (booking_id, host_id, provider, provider_payment_id, amount_minor, currency, status) values ($1, $2, 'razorpay', 'pay_test123', 150000, 'INR', 'paid')",
      [b.id, priya]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("lists a host's clients with their private note, and none of another host's", async () => {
    const { clients, total } = await hostClients(pool, store, priya);
    expect(clients.map((c) => c.email).sort()).toEqual(["arjun.mehta@example.com", "kabir.nair@example.com", "sara.thomas@example.co.uk"]);
    expect(total).toBe(3);
    expect(clients.find((c) => c.email === "arjun.mehta@example.com")).toMatchObject({ name: "Arjun Mehta", phone: "+919876543210", note: "Prefers mornings.", bookings: 1 });
    expect((await hostClients(pool, store, arun)).clients.map((c) => c.email)).toEqual(["divya.menon@example.com"]);
    expect((await hostClients(pool, store, priya, { q: "SARA" })).clients.map((c) => c.email)).toEqual(["sara.thomas@example.co.uk"]);
  });

  it("lists a host's bookings with answers and the private booking note, and filters by guest", async () => {
    const { bookings, total } = await hostBookings(pool, store, priya);
    expect(total).toBe(3);
    const arjun = bookings.find((b) => b.guestEmail === "arjun.mehta@example.com")!;
    expect(arjun.answers).toEqual([{ question: "What would you like to work on?", answer: "Planning a career move." }]);
    expect(arjun.note).toBe("Wants to switch to product roles.");
    // citext[] comes back from pg as a string unless cast; the page joins this list, so it must be a real array.
    expect(arjun.guests).toEqual(["partner@example.com"]);
    expect(bookings.every((b) => Array.isArray(b.guests))).toBe(true);
    expect(bookings.every((b) => b.guestEmail !== "divya.menon@example.com")).toBe(true);
    expect((await hostBookings(pool, store, priya, { q: "kabir" })).bookings.map((b) => b.status)).toEqual(["cancelled"]);
    expect(await hostBookings(pool, store, "not-a-uuid")).toEqual({ bookings: [], total: 0 });
  });

  it("shows payments and a masked gateway key, and nothing of the secret", async () => {
    const result = await hostPayments(pool, priya);
    expect(result.gateways).toEqual([expect.objectContaining({ provider: "razorpay", status: "ok", mode: "live", key: "rzp_live_••••1234" })]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("abcdefgh");
    expect(result.payments).toEqual([expect.objectContaining({ kind: "booking", guestEmail: "arjun.mehta@example.com", amountMinor: 150000, status: "paid", providerId: "pay_test123" })]);
    expect((await hostPayments(pool, arun)).payments).toEqual([]);
    expect((await hostPayments(pool, arun)).gateways).toEqual([]);
  });

  it("counts sign-ups per India day for 30 days", async () => {
    const s = await signups(pool, new Date());
    expect(s.days).toHaveLength(30);
    expect(s.days.reduce((n, d) => n + d.count, 0)).toBe((await pool.query("select count(*)::int as n from users where created_at > now() - interval '31 days'")).rows[0].n);
    expect(s.methods.length).toBeGreaterThan(0);
  });
});
