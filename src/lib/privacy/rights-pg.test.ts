// Client export, erasure and guest requests against real Postgres (only with TEST_DATABASE_URL; own database <name>_privacy2).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { BookingWithInvitee, DataStore, EventType, User } from "../data/types";
import { processDueNotifications } from "../jobs/worker";
import type { Mail } from "../mail/mailer";
import { consentFor } from "./consent";
import { eraseClient, exportClient, exportHtml, listErasures, listRequests, openRequestsForToken, requestFromGuest, resolveRequest, RESPONSE_DAYS } from "./rights";

const BASE = process.env.TEST_DATABASE_URL;
const KEY = randomBytes(32);
const DAY = 86_400_000;
const now = new Date("2031-06-01T06:00:00Z");

describe.skipIf(!BASE)("client rights (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User, arun: User;
  let coaching: EventType, chat: EventType;
  let past: BookingWithInvitee, past2: BookingWithInvitee, ravisBooking: BookingWithInvitee, arunsBooking: BookingWithInvitee;
  let smallInvoice: string, bigInvoice: string;
  const meera = { name: "Meera Iyer", email: "Meera@Example.com", timezone: "Asia/Kolkata", phone: "+919876543210", answers: [{ questionId: "q", label: "Goal", answer: "Manage anxiety at work" }], guests: ["partner@example.com"], whatsappOptIn: true };
  const consent = consentFor({ hostName: "Priya", channel: "booking_page", whatsappOptIn: true, whatsappStatement: "WhatsApp please", questions: [], answers: [] });
  const count = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0].n as number;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_privacy2`;
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
    chat = (await store.listEventTypes(arun.id))[0];

    // Meera: two past sessions with Priya, paid, invoiced, a package, a waitlist entry, notes, messages.
    past = await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-05-05T05:30:00Z"), idempotencyKey: "rights-past-0001", invitee: { ...meera, consent } });
    past2 = await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-05-12T05:30:00Z"), idempotencyKey: "rights-past-0002", invitee: { ...meera, email: "meera@example.com", consent } });
    await pool.query("update bookings set cancel_reason = 'Meera said: feeling unwell' where id = $1", [past2.id]);
    // Ravi, another of Priya's clients, and Meera again as Arun's client: neither may be touched or exported.
    ravisBooking = await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-05-06T05:30:00Z"), idempotencyKey: "rights-ravi-0001", invitee: { ...meera, name: "Ravi", email: "ravi@example.com", phone: "+919800000000", answers: [{ questionId: "q", label: "Goal", answer: "Career" }], guests: [], consent } });
    arunsBooking = await store.createBooking({ eventTypeId: chat.id, startAt: new Date("2031-05-07T05:30:00Z"), idempotencyKey: "rights-arun-0001", invitee: { ...meera, consent } });

    const pay = async (b: BookingWithInvitee, amount: number) => (await pool.query(
      "insert into payments (booking_id, host_id, provider, provider_payment_id, amount_minor, currency, status, paid_at) values ($1, $2, 'razorpay', $3, $4, 'INR', 'paid', $5) returning id",
      [b.id, b.hostId, `pay_${b.id.slice(0, 8)}`, amount, now])).rows[0].id as string;
    const invoice = async (host: string, paymentId: string, n: number, taxable: number, buyer: string, email: string) => (await pool.query(
      `insert into invoices (host_id, kind, number, fy, seq, issued_at, payment_id, buyer_name, buyer_email, supplier, place_of_supply, description, sac, rate_bp, taxable_minor, cgst_minor, sgst_minor, igst_minor, total_minor)
       values ($1, 'invoice', $2, '2031', $3, $4, $5, $6, $7, '{"legalName":"Priya Coaching","gstin":"33AAAAA0000A1Z5"}', 'Tamil Nadu (33)', 'Coaching session', '999599', 1800, $8, $9, $9, 0, $8 + 2 * $9) returning id`,
      [host, `INV/2031/${n}`, n, now, paymentId, buyer, email, taxable, Math.round(taxable * 0.09)])).rows[0].id as string;
    smallInvoice = await invoice(priya.id, await pay(past, 236_000), 1, 200_000, "Meera Iyer", "meera@example.com");
    bigInvoice = await invoice(priya.id, await pay(past2, 7_080_000), 2, 6_000_000, "Meera Iyer", "meera@example.com");
    await invoice(priya.id, await pay(ravisBooking, 236_000), 3, 200_000, "Ravi", "ravi@example.com");

    const { rows: [pk] } = await pool.query("insert into packages (user_id, event_type_id, name, sessions, price_minor, valid_days) values ($1, $2, '5 sessions', 5, 1000000, 90) returning id", [priya.id, coaching.id]);
    await pool.query(
      `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, guest_phone, idempotency_key, status, provider_payment_id, paid_at, expires_at)
       values ($1, $2, $3, 5, 1000000, 90, 'Meera Iyer', 'meera@example.com', '+919876543210', 'rights-pkg-0001', 'paid', 'pay_pkg1', $4, $4::timestamptz + interval '90 days')`, [pk.id, priya.id, coaching.id, now]);
    await pool.query(
      `insert into waitlist (host_id, event_type_id, day, timezone, window_start, window_end, name, email) values ($1, $2, '2031-06-10', 'Asia/Kolkata', '2031-06-09T18:30:00Z', '2031-06-10T18:30:00Z', 'Meera Iyer', 'meera@example.com')`,
      [priya.id, coaching.id]);
    // Signed in to Priya's client portal, and to Arun's (which must survive Priya's erasure).
    for (const [host, tag] of [[priya.id, "p"], [arun.id, "a"]]) {
      await pool.query("insert into portal_sessions (id_hash, host_id, email, expires_at) values ($1, $2, 'meera@example.com', $3::timestamptz + interval '30 days')", [`sess-${tag}`, host, now]);
      await pool.query("insert into portal_links (nonce_hash, host_id, email, expires_at) values ($1, $2, 'meera@example.com', $3::timestamptz + interval '15 minutes')", [`link-${tag}`, host, now]);
    }
    await store.saveClientNote(priya.id, "meera@example.com", "Generalised anxiety; CBT plan.");
    await store.saveBookingNote(priya.id, past.id, "Session 1: breathing exercise.");
    await store.saveClientNote(priya.id, "ravi@example.com", "Ravi's note.");
    await store.saveClientNote(arun.id, "meera@example.com", "Arun's note about Meera.");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("exports everything about one client, notes only when asked, and nothing of anyone else", async () => {
    const x = (await exportClient(pool, priya.id, "MEERA@example.com", { includeNotes: true, key: () => KEY, now }))!;
    expect(x.bookings.map((b) => b.id)).toEqual([past.id, past2.id]);
    expect(x.bookings[0]).toMatchObject({ name: "Meera Iyer", phone: "+919876543210", answers: [{ question: "Goal", answer: "Manage anxiety at work" }], extraGuests: ["partner@example.com"], whatsappUpdates: true, sessionNote: "Session 1: breathing exercise." });
    expect(x.clientNote).toBe("Generalised anxiety; CBT plan.");
    expect(x.payments.map((p) => p.amountMinor).sort()).toEqual([236_000, 7_080_000]);
    expect(x.invoices.map((v) => v.number)).toEqual(["INV/2031/1", "INV/2031/2"]);
    expect(x.packagePurchases).toHaveLength(1);
    expect(x.waitlist).toHaveLength(1);
    expect(x.consentLog.map((c) => c.purpose).sort()).toEqual(["booking", "booking", "whatsapp_updates", "whatsapp_updates"]);
    expect(x.client.names).toEqual(["Meera Iyer"]);
    const text = JSON.stringify(x);
    for (const other of ["Ravi", "ravi@example.com", "INV/2031/3", "Arun's note", arunsBooking.id, ravisBooking.id]) expect(text).not.toContain(other);
    expect(exportHtml(x)).toContain("Session 1: breathing exercise.");

    const shared = (await exportClient(pool, priya.id, "meera@example.com", { includeNotes: false, key: () => KEY, now }))!;
    expect(shared.clientNote).toBeNull();
    expect(shared.bookings.every((b) => b.sessionNote === null)).toBe(true);
    expect(exportHtml(shared)).not.toContain("CBT plan");
    // Another host gets only their own booking with her; a stranger, nothing.
    expect((await exportClient(pool, arun.id, "meera@example.com", { includeNotes: true, key: () => KEY, now }))!.bookings.map((b) => b.id)).toEqual([arunsBooking.id]);
    expect(await exportClient(pool, priya.id, "nobody@example.com", { includeNotes: true, key: () => KEY, now })).toBeNull();
  });

  it("takes a guest's request from their manage link, emails the host without the guest's details, and shows the deadline", async () => {
    const r = (await requestFromGuest(pool, past.invitee.manageToken, "erasure", now))!;
    expect(r.created).toBe(true);
    expect(r.request.dueAt.getTime()).toBe(now.getTime() + RESPONSE_DAYS * DAY);
    const again = (await requestFromGuest(pool, past2.invitee.manageToken, "erasure", now))!;
    expect(again).toMatchObject({ created: false, request: { id: r.request.id } });
    expect((await requestFromGuest(pool, past.invitee.manageToken, "access", now))!.created).toBe(true);
    expect(await requestFromGuest(pool, "no-such-token-123", "access", now)).toBeNull();
    expect((await openRequestsForToken(pool, past2.invitee.manageToken)).map((x) => x.kind).sort()).toEqual(["access", "erasure"]);
    expect(await openRequestsForToken(pool, ravisBooking.invitee.manageToken)).toEqual([]);
    expect(await listRequests(pool, arun.id)).toEqual([]);

    const sent: Mail[] = [];
    // The booking emails queued above go first; run the worker until the queue is drained.
    while ((await processDueNotifications(pool, { async send(m) { sent.push(m); return { id: `m${sent.length}` }; } }, { baseUrl: "https://hourhand.test", now })).claimed > 0);
    const toHost = sent.filter((m) => m.to === priya.email && /data/.test(m.subject));
    expect(toHost.map((m) => m.subject).sort()).toEqual(["A client asked for a copy of their data", "A client asked you to delete their data"]);
    expect(toHost[0].text).toContain("Respond by");
    for (const m of toHost) expect(`${m.subject} ${m.text} ${m.html}`).not.toMatch(/Meera|meera@/i);

    const access = (await listRequests(pool, priya.id)).find((x) => x.kind === "access")!;
    expect(await resolveRequest(pool, arun.id, arun.id, access.id, "done", now)).toBe(false);
    expect(await resolveRequest(pool, priya.id, priya.id, access.id, "done", now)).toBe(true);
    expect(await resolveRequest(pool, priya.id, priya.id, access.id, "done", now)).toBe(false);
  });

  it("refuses to erase a client with an upcoming booking or a payment still settling", async () => {
    const soon = await store.createBooking({ eventTypeId: coaching.id, startAt: new Date("2031-06-20T05:30:00Z"), idempotencyKey: "rights-soon-0001", invitee: meera });
    await expect(eraseClient(pool, priya.id, priya.id, "meera@example.com", now)).rejects.toMatchObject({ reason: "upcoming" });
    await store.cancelBooking(priya.id, soon.id, "host");
    await pool.query("update payments set status = 'refund_pending' where booking_id = $1", [past.id]);
    await expect(eraseClient(pool, priya.id, priya.id, "meera@example.com", now)).rejects.toMatchObject({ reason: "payments_settling" });
    await pool.query("update payments set status = 'paid' where booking_id = $1", [past.id]);
    await expect(eraseClient(pool, priya.id, priya.id, "nobody@example.com", now)).rejects.toMatchObject({ reason: "not_found" });
    expect(await count("select count(*)::int as n from client_erasures")).toBe(0);
  });

  it("erases the client's personal data everywhere, keeps what GST law requires, and logs who and when only", async () => {
    const { erasureId } = await eraseClient(pool, priya.id, priya.id, "meera@example.com", now);
    const meeraRows = (sql: string) => count(sql, [priya.id]);
    // No trace of her email, name or phone left in Priya's data.
    expect(await meeraRows("select count(*)::int as n from invitees where host_id = $1 and (email = 'meera@example.com' or name like '%Meera%' or phone = '+919876543210' or answers::text like '%anxiety%' or cardinality(guests) > 0)")).toBe(0);
    const erased = await pool.query("select name, email, phone, answers, guests::text[] as guests, whatsapp_opt_in_at, manage_token from invitees where booking_id = any($1::uuid[])", [[past.id, past2.id]]);
    for (const r of erased.rows) expect(r).toMatchObject({ name: "Erased client", phone: null, answers: [], guests: [], whatsapp_opt_in_at: null });
    expect(erased.rows[0].email).toMatch(/^erased-.*@erased\.invalid$/);
    expect(erased.rows.map((r) => r.manage_token)).not.toContain(past.invitee.manageToken);
    expect(await store.getBookingByManageToken(past.invitee.manageToken)).toBeNull();
    expect(await meeraRows("select count(*)::int as n from bookings where host_id = $1 and cancel_reason like '%Meera%'")).toBe(0);
    expect(await meeraRows("select count(*)::int as n from client_notes where host_id = $1 and email = 'meera@example.com'")).toBe(0);
    expect(await count("select count(*)::int as n from booking_notes where booking_id = $1", [past.id])).toBe(0);
    expect(await meeraRows("select count(*)::int as n from waitlist where host_id = $1")).toBe(0);
    expect(await meeraRows("select count(*)::int as n from portal_sessions where host_id = $1")).toBe(0);
    expect(await meeraRows("select count(*)::int as n from portal_links where host_id = $1")).toBe(0);
    expect(await count("select count(*)::int as n from portal_sessions where host_id = $1 and email = 'meera@example.com'", [arun.id])).toBe(1);
    expect(await meeraRows("select count(*)::int as n from package_purchases where host_id = $1 and (guest_email = 'meera@example.com' or guest_name like '%Meera%' or guest_phone is not null)")).toBe(0);
    expect(await meeraRows("select count(*)::int as n from consent_records where host_id = $1 and email = 'meera@example.com'")).toBe(0);
    expect(await meeraRows("select count(*)::int as n from consent_records where host_id = $1 and email like 'erased-%'")).toBe(4); // that consent was given stays
    expect(await meeraRows("select count(*)::int as n from notifications where user_id = $1 and (lower(recipient) = 'meera@example.com' or recipient like '%9876543210%' or recipient = 'partner@example.com')")).toBe(0);
    expect(await meeraRows("select count(*)::int as n from data_requests where host_id = $1 and (email = 'meera@example.com' or status = 'open')")).toBe(0);

    // Bookings and payments stay; invoices keep the legal particulars, the name only at or above ₹50,000.
    expect(await count("select count(*)::int as n from bookings where id = any($1::uuid[])", [[past.id, past2.id]])).toBe(2);
    expect(await count("select count(*)::int as n from payments where booking_id = any($1::uuid[]) and status = 'paid'", [[past.id, past2.id]])).toBe(2);
    const inv = Object.fromEntries((await pool.query("select id, number, buyer_name, buyer_email, total_minor, place_of_supply, supplier from invoices where id = any($1::uuid[])", [[smallInvoice, bigInvoice]])).rows.map((r) => [r.id, r]));
    expect(inv[smallInvoice]).toMatchObject({ number: "INV/2031/1", buyer_name: "Erased client", place_of_supply: "Tamil Nadu (33)", total_minor: 236_000 });
    expect(inv[bigInvoice]).toMatchObject({ number: "INV/2031/2", buyer_name: "Meera Iyer", place_of_supply: "Tamil Nadu (33)" });
    expect(inv[smallInvoice].buyer_email).toMatch(/@erased\.invalid$/);
    expect(inv[bigInvoice].buyer_email).toMatch(/@erased\.invalid$/);
    const redactions = (await pool.query("select invoice_id, fields from invoice_redactions where erasure_id = $1", [erasureId])).rows;
    expect(Object.fromEntries(redactions.map((r) => [r.invoice_id, r.fields]))).toEqual({
      [smallInvoice]: ["buyer_name", "buyer_email", "token"], [bigInvoice]: ["buyer_email", "token"] });

    // The log: who and when, never whom.
    const log = await pool.query("select * from client_erasures");
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ id: erasureId, host_id: priya.id, actor_id: priya.id });
    expect(Object.keys(log.rows[0]).sort()).toEqual(["actor_id", "erased_at", "host_id", "id"]);
    expect(JSON.stringify(log.rows)).not.toMatch(/meera/i);
    expect(await listErasures(pool, priya.id)).toEqual([{ id: erasureId, erasedAt: now, actorName: priya.name }]);
    expect(await listErasures(pool, arun.id)).toEqual([]);

    // Nobody else was touched: Ravi, and Meera as Arun's client.
    expect((await store.getBooking(priya.id, ravisBooking.id))!.invitee).toMatchObject({ name: "Ravi", email: "ravi@example.com", phone: "+919800000000" });
    expect(await store.getClientNote(priya.id, "ravi@example.com")).toBe("Ravi's note.");
    expect((await store.getBooking(arun.id, arunsBooking.id))!.invitee).toMatchObject({ name: "Meera Iyer", email: "Meera@Example.com" });
    expect(await store.getClientNote(arun.id, "meera@example.com")).toBe("Arun's note about Meera.");
    expect((await pool.query("select buyer_name from invoices where number = 'INV/2031/3'")).rows[0].buyer_name).toBe("Ravi");
    expect(await exportClient(pool, priya.id, "meera@example.com", { includeNotes: true, key: () => KEY, now })).toBeNull();
  });
});
