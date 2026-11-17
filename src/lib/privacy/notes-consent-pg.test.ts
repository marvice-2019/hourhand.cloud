// The consent log and sealed notes against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_privacy1).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { consentFor, listConsents } from "./consent";

const BASE = process.env.TEST_DATABASE_URL;
const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

describe.skipIf(!BASE)("consent log and sealed notes (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let arun: User;
  let coaching: EventType;
  const guest = { name: "Meera Iyer", email: "Meera@Example.com", timezone: "Asia/Kolkata", phone: "+919876543210", answers: [], locale: "ta", whatsappOptIn: true };
  const consent = consentFor({ hostName: "Priya", channel: "booking_page", whatsappOptIn: true, whatsappStatement: "WhatsApp please", questions: [], answers: [] });

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_privacy1`;
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
    store = createPgStore(pool, { noteKey: () => KEY });
    priya = (await store.getUserBySlug("priya"))!;
    arun = (await store.getUserBySlug("arun"))!;
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("records consent with each booking, every week of a series, in the same write", async () => {
    const first = await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-03-03T05:30:00Z"), idempotencyKey: "privacy-series-0001", weeks: 3, invitee: { ...guest, consent } });
    const rows = (await pool.query("select booking_id, invitee_id, email, purpose, granted, statement, notice_version, channel, locale from consent_records order by recorded_at, purpose")).rows;
    const weeks = (await store.listBookings(priya.id)).filter((b) => b.seriesId === first.id);
    expect(weeks).toHaveLength(3);
    expect(new Set(rows.map((r) => r.booking_id))).toEqual(new Set(weeks.map((w) => w.id)));
    expect(rows).toHaveLength(6); // booking + WhatsApp, per week
    const mine = rows.filter((r) => r.booking_id === first.id);
    expect(mine.map((r) => [r.purpose, r.granted, r.channel, r.locale, r.email])).toEqual([
      ["booking", true, "booking_page", "ta", "Meera@Example.com"], ["whatsapp_updates", true, "booking_page", "ta", "Meera@Example.com"]]);
    expect(mine[0].invitee_id).toBe(first.invitee.id);
    expect(mine[1].statement).toBe("WhatsApp please");
  });

  it("accepts a host-made booking's log (host_on_behalf) in the same write", async () => {
    const lines = consentFor({ hostName: "Priya", channel: "host_on_behalf", whatsappOptIn: false, whatsappStatement: "", questions: [], answers: [] });
    const b = await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-06-02T05:30:00Z"), idempotencyKey: "privacy-behalf-0001", invitee: { ...guest, email: "behalf@example.com", whatsappOptIn: false, consent: lines } });
    const { rows } = await pool.query("select purpose, granted, channel from consent_records where booking_id = $1", [b.id]);
    expect(rows).toEqual([{ purpose: "booking", granted: true, channel: "host_on_behalf" }]);
  });

  it("shows a client's log to their host only, any email case", async () => {
    expect((await listConsents(pool, priya.id, "meera@example.com")).map((c) => c.purpose).sort()).toEqual(["booking", "booking", "booking", "whatsapp_updates", "whatsapp_updates", "whatsapp_updates"]);
    expect(await listConsents(pool, arun.id, "meera@example.com")).toEqual([]);
    expect(await listConsents(pool, priya.id, "someone@else.com")).toEqual([]);
    expect(await listConsents(pool, "not-a-uuid", "meera@example.com")).toEqual([]);
  });

  it("records nothing new when a booking is moved, and nothing for a booking made without a log", async () => {
    const b = await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-04-07T05:30:00Z"), idempotencyKey: "privacy-move-0001", invitee: { ...guest, consent } });
    const before = (await pool.query("select count(*)::int as n from consent_records")).rows[0].n;
    await store.rescheduleBooking(priya.id, b.id, new Date("2031-04-08T05:30:00Z"), "privacy-move-0002");
    await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-04-09T05:30:00Z"), idempotencyKey: "privacy-nolog-0001", invitee: guest });
    expect((await pool.query("select count(*)::int as n from consent_records")).rows[0].n).toBe(before);
  });

  it("seals client notes at rest: no plaintext in the row, unreadable without the key or in another row", async () => {
    const secret = "Discussed panic attacks; trial CBT worksheet 3.";
    await store.saveClientNote(priya.id, "meera@example.com", secret);
    const { rows: [row] } = await pool.query("select note, note_sealed from client_notes where host_id = $1 and email = 'meera@example.com'", [priya.id]);
    expect(row.note).toBe("");
    expect(Buffer.isBuffer(row.note_sealed)).toBe(true);
    expect(row.note_sealed.toString("utf8")).not.toContain("panic");
    expect((await pool.query("select count(*)::int as n from client_notes where note like '%panic%' or encode(note_sealed, 'escape') like '%panic%'")).rows[0].n).toBe(0);
    expect(await store.getClientNote(priya.id, "MEERA@example.com")).toBe(secret);

    await expect(createPgStore(pool, { noteKey: () => OTHER_KEY }).getClientNote(priya.id, "meera@example.com")).rejects.toThrow();
    // A sealed note copied into another client's row doesn't open there.
    await pool.query("insert into client_notes (host_id, email, note, note_sealed) values ($1, 'ravi@example.com', '', $2)", [priya.id, row.note_sealed]);
    await expect(store.getClientNote(priya.id, "ravi@example.com")).rejects.toThrow();
    await pool.query("delete from client_notes where email = 'ravi@example.com'");
    expect(await store.getClientNote(arun.id, "meera@example.com")).toBe("");
  });

  it("seals a note written before sealing the first time its owner opens it", async () => {
    await pool.query("insert into client_notes (host_id, email, note) values ($1, 'legacy@example.com', 'Old plaintext note')", [priya.id]);
    expect(await store.getClientNote(priya.id, "legacy@example.com")).toBe("Old plaintext note");
    const { rows: [row] } = await pool.query("select note, note_sealed from client_notes where host_id = $1 and email = 'legacy@example.com'", [priya.id]);
    expect(row.note).toBe("");
    expect(row.note_sealed).not.toBeNull();
    expect(await store.getClientNote(priya.id, "legacy@example.com")).toBe("Old plaintext note");
  });

  it("keeps a sealed session note per booking, for that booking's host only", async () => {
    const b = await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-05-05T05:30:00Z"), idempotencyKey: "privacy-note-0001", invitee: guest });
    await store.saveBookingNote(priya.id, b.id, "Session 1: grounding exercise.");
    expect(await store.getBookingNote(priya.id, b.id)).toBe("Session 1: grounding exercise.");
    const { rows: [row] } = await pool.query("select note_sealed, host_id from booking_notes where booking_id = $1", [b.id]);
    expect(row.host_id).toBe(priya.id);
    expect(row.note_sealed.toString("utf8")).not.toContain("grounding");
    await expect(createPgStore(pool, { noteKey: () => OTHER_KEY }).getBookingNote(priya.id, b.id)).rejects.toThrow();

    expect(await store.getBookingNote(arun.id, b.id)).toBe("");
    await expect(store.saveBookingNote(arun.id, b.id, "Not mine")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await store.getBookingNote(priya.id, b.id)).toBe("Session 1: grounding exercise.");
    await store.saveBookingNote(priya.id, b.id, " ");
    expect((await pool.query("select count(*)::int as n from booking_notes where booking_id = $1", [b.id])).rows[0].n).toBe(0);
  });
});
