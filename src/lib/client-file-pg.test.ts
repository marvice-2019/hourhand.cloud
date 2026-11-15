// The client file against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_clientfile).
// Timeline completeness and order, host and client isolation, owner-only notes, note history, and paging a client
// with 200+ bookings.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/migrate";
import { seed } from "../../scripts/seed";
import { clientKey } from "./clients";
import { loadClientFile, type BookingEntry, type ClientFile, type PackageEntry } from "./client-file";
import { createPgStore } from "./data/pg-store";
import type { DataStore, EventType, User } from "./data/types";
import { gstinCheckChar } from "./gst/gst";
import { creditNoteForRefund, invoiceForPayment, invoiceForPurchase, invoicesCsv, listInvoices, saveTaxProfile } from "./gst/invoices";
import type { BookingEmailKind } from "./data/notifications";
import { renderBookingMail, renderInvoiceMail, type BookingMailContext } from "./mail/templates";

const BASE = process.env.TEST_DATABASE_URL;
const KEY = randomBytes(32);
const NOW = new Date("2031-06-15T06:00:00Z");
const DAY = 86_400_000;
const SECRET_CLIENT = "Client note: panic attacks, trial CBT worksheet 3";
const SECRET_SESSION = "Session note: grounding exercise, ask about sleep";

describe.skipIf(!BASE)("client file (Postgres)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let arun: User;
  let coaching: EventType;
  let arunChat: EventType;
  let n = 0;

  /** A booking straight into the tables, so tests control status, no-show and time exactly. */
  async function book(host: User, et: EventType, email: string, startAt: Date, opts: { status?: "confirmed" | "cancelled"; cancelledBy?: "guest" | "host" | "system"; noShow?: boolean; answers?: unknown; name?: string; phone?: string | null; purchaseId?: string } = {}): Promise<string> {
    const status = opts.status ?? "confirmed";
    const end = new Date(startAt.getTime() + 30 * 60_000);
    const { rows: [b] } = await pool.query(
      `insert into bookings (event_type_id, host_id, start_at, end_at, buffered_start, buffered_end, status, idempotency_key, cancelled_at, cancelled_by, package_purchase_id)
       values ($1, $2, $3, $4, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [et.id, host.id, startAt, end, status, `cf-${++n}-${randomUUID()}`, status === "cancelled" ? startAt : null, status === "cancelled" ? opts.cancelledBy ?? "guest" : null, opts.purchaseId ?? null]);
    await pool.query(
      `insert into invitees (booking_id, host_id, name, email, timezone, phone, answers, no_show_at) values ($1, $2, $3, $4, 'Asia/Kolkata', $5, $6, $7)`,
      [b.id, host.id, opts.name ?? "Meera Iyer", email, opts.phone ?? null, JSON.stringify(opts.answers ?? []), opts.noShow ? end : null]);
    return b.id as string;
  }

  async function pay(host: User, bookingId: string, amount: number, opts: { kind?: "payment" | "deposit"; status?: string; refunded?: number; paidAt?: Date } = {}): Promise<string> {
    const status = opts.status ?? "paid";
    const { rows: [p] } = await pool.query(
      `insert into payments (booking_id, host_id, provider, provider_payment_id, amount_minor, currency, status, refunded_minor, paid_at, refunded_at, kind)
       values ($1, $2, 'razorpay', $3, $4, 'INR', $5, $6, $7, $8, $9) returning id`,
      [bookingId, host.id, `pay_${randomUUID()}`, amount, status, opts.refunded ?? 0, opts.paidAt ?? NOW, status === "refunded" ? NOW : null, opts.kind ?? "payment"]);
    return p.id as string;
  }

  async function purchase(host: User, et: EventType, email: string, opts: { status?: "paid" | "pending" | "failed"; paidAt?: Date; sessions?: number } = {}): Promise<string> {
    const { rows: [k] } = await pool.query(
      `insert into packages (user_id, event_type_id, name, sessions, price_minor, valid_days) values ($1, $2, '5 sessions', $3, 500000, 180) returning id`,
      [host.id, et.id, opts.sessions ?? 5]);
    const status = opts.status ?? "paid";
    const paidAt = opts.paidAt ?? NOW;
    const { rows: [p] } = await pool.query(
      `insert into package_purchases (package_id, host_id, event_type_id, sessions, price_minor, valid_days, guest_name, guest_email, idempotency_key, status, provider_payment_id, paid_at, expires_at, created_at)
       values ($1, $2, $3, $4, 500000, 180, 'Meera Iyer', $5, $6, $7, $8, $9, $10, $11) returning id`,
      [k.id, host.id, et.id, opts.sessions ?? 5, email, `pp-${randomUUID()}`, status, status === "paid" ? `pay_${randomUUID()}` : null,
        status === "paid" ? paidAt : null, status === "paid" ? new Date(paidAt.getTime() + 180 * DAY) : null, paidAt]);
    return p.id as string;
  }

  const file = (host: User, email: string, owner = true, cursor?: string | null, limit?: number) =>
    loadClientFile(pool, store, host.id, clientKey(email), { owner }, { now: NOW, cursor, limit });

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_clientfile`;
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
    arunChat = (await store.listEventTypes(arun.id))[0];
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("one client's timeline", () => {
    const email = "meera@example.com";
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      const gstin = "29AAPFU0939F1Z" + gstinCheckChar("29AAPFU0939F1Z");
      await saveTaxProfile(pool, priya.id, { legalName: "Priya Coaching LLP", address: "12 MG Road, Bengaluru", stateCode: "29", gstin, sac: "999293", rateBp: 1800, invoicePrefix: "PRS" });
      // Past: a paid session that was refunded in part, a no-show with a kept deposit, a guest cancellation, a lapsed hold.
      ids.paid = await book(priya, coaching, "Meera@Example.com", new Date(NOW.getTime() - 30 * DAY), {
        answers: [{ questionId: "q1", label: "What brings you here?", answer: "Stress at work" }, { questionId: "q2", label: "Topics", answer: ["sleep", "focus"] }, { questionId: "q3", label: "First time?", answer: true }],
        phone: "+919876543210",
      });
      const payId = await pay(priya, ids.paid, 200000, { status: "refunded", refunded: 50000, paidAt: new Date(NOW.getTime() - 31 * DAY) });
      await invoiceForPayment(pool, payId, new Date(NOW.getTime() - 31 * DAY));
      await creditNoteForRefund(pool, payId, NOW);
      ids.noShow = await book(priya, coaching, email, new Date(NOW.getTime() - 20 * DAY), { noShow: true });
      await pay(priya, ids.noShow, 50000, { kind: "deposit" });
      ids.cancelled = await book(priya, coaching, email, new Date(NOW.getTime() - 10 * DAY), { status: "cancelled", cancelledBy: "guest" });
      ids.lapsed = await book(priya, coaching, email, new Date(NOW.getTime() - 9 * DAY), { status: "cancelled", cancelledBy: "system" });
      // A paid package with one session booked from it, an unpaid one, and a failed one.
      ids.pkg = await purchase(priya, coaching, email, { paidAt: new Date(NOW.getTime() - 5 * DAY) });
      await invoiceForPurchase(pool, ids.pkg, new Date(NOW.getTime() - 5 * DAY));
      ids.pending = await purchase(priya, coaching, email, { status: "pending", paidAt: new Date(NOW.getTime() - 4 * DAY) });
      await purchase(priya, coaching, email, { status: "failed", paidAt: new Date(NOW.getTime() - 3 * DAY) });
      // Upcoming: one from the package, one later.
      ids.fromPkg = await book(priya, coaching, email, new Date(NOW.getTime() + 2 * DAY), { purchaseId: ids.pkg });
      ids.later = await book(priya, coaching, email, new Date(NOW.getTime() + 9 * DAY), { name: "Meera S. Iyer" });  // the latest booking: its name is shown
      // Someone else with Priya, and Meera with Arun: neither may show up.
      ids.otherClient = await book(priya, coaching, "ravi@example.com", new Date(NOW.getTime() - 15 * DAY));
      ids.otherHost = await book(arun, arunChat, email, new Date(NOW.getTime() - 12 * DAY));
      await pay(arun, ids.otherHost, 99900);
    });

    it("lists every booking and package in time order, newest first, with answers, payments, refunds and invoices", async () => {
      const f = (await file(priya, email))!;
      expect(f.entries.map((e) => [e.kind, e.id])).toEqual([
        ["booking", ids.later], ["booking", ids.fromPkg], ["package", ids.pending], ["package", ids.pkg],
        ["booking", ids.cancelled], ["booking", ids.noShow], ["booking", ids.paid],
      ]);
      expect(f.nextCursor).toBeNull();
      const paid = f.entries.find((e) => e.id === ids.paid) as BookingEntry;
      expect(paid.answers).toEqual([{ label: "What brings you here?", answer: "Stress at work" }, { label: "Topics", answer: "sleep, focus" }, { label: "First time?", answer: "Yes" }]);
      expect(paid.payments.map((p) => [p.kind, p.status, p.amountMinor, p.refundedMinor])).toEqual([["payment", "refunded", 200000, 50000]]);
      expect(paid.invoices.map((v) => v.kind)).toEqual(["invoice", "credit_note"]);
      const noShow = f.entries.find((e) => e.id === ids.noShow) as BookingEntry;
      expect(noShow.noShowAt).not.toBeNull();
      expect(noShow.payments.map((p) => p.kind)).toEqual(["deposit"]);
      expect((f.entries.find((e) => e.id === ids.cancelled) as BookingEntry).cancelledBy).toBe("guest");
      const pkg = f.entries.find((e) => e.id === ids.pkg) as PackageEntry;
      expect([pkg.status, pkg.sessions, pkg.used, pkg.remaining, pkg.invoices.length]).toEqual(["paid", 5, 1, 4, 1]);
      expect((f.entries.find((e) => e.id === ids.fromPkg) as BookingEntry).packagePurchaseId).toBe(ids.pkg);
    });

    it("sums up the client in the header", async () => {
      const h = (await file(priya, "MEERA@example.com"))!.header;
      expect(h.name).toBe("Meera S. Iyer");
      expect(h.email.toLowerCase()).toBe(email);
      expect(h.phone).toBe("+919876543210");
      expect([h.sessions, h.upcoming, h.noShows, h.cancelled]).toEqual([4, 2, 1, 1]);
      expect(h.firstAt).toEqual(new Date(NOW.getTime() - 30 * DAY));
      expect(h.lastAt).toEqual(new Date(NOW.getTime() - 20 * DAY));
      expect(h.nextAt).toEqual(new Date(NOW.getTime() + 2 * DAY));
      // ₹2,000 less ₹500 refunded, the ₹500 deposit kept for the no-show, the ₹5,000 package (not the unpaid one).
      expect(h.lifetimePaidMinor).toBe(150000 + 50000 + 500000);
    });

    it("keeps hosts and clients apart", async () => {
      const mine = (await file(priya, email))!;
      expect(mine.entries.map((e) => e.id)).not.toContain(ids.otherClient);
      expect(mine.entries.map((e) => e.id)).not.toContain(ids.otherHost);
      const theirs = (await file(arun, email))!;
      expect(theirs.entries.map((e) => e.id)).toEqual([ids.otherHost]);
      expect(theirs.header.lifetimePaidMinor).toBe(99900);
      const ravi = (await file(priya, "ravi@example.com"))!;
      expect(ravi.entries.map((e) => e.id)).toEqual([ids.otherClient]);
      // A host can't open a client who only booked someone else.
      expect(await file(arun, "ravi@example.com")).toBeNull();
      expect(await loadClientFile(pool, store, "not-a-uuid", clientKey(email), { owner: true }, { now: NOW })).toBeNull();
      expect(await loadClientFile(pool, store, priya.id, "not-a-key", { owner: true }, { now: NOW })).toBeNull();
    });

    it("gives the owner their notes and history, and anyone acting for them neither", async () => {
      await store.saveClientNote(priya.id, email, SECRET_CLIENT);
      await store.saveBookingNote(priya.id, ids.paid, SECRET_SESSION);
      await store.saveBookingNote(arun.id, ids.otherHost, "Arun's own note");
      const owner = (await file(priya, email))!;
      expect(owner.notes!.client).toBe(SECRET_CLIENT);
      expect(owner.notes!.sessions).toEqual({ [ids.paid]: SECRET_SESSION });
      expect(owner.notes!.clientHistory).toHaveLength(1);
      expect(owner.notes!.sessionHistory[ids.paid]).toHaveLength(1);

      // A Duo second person: the timeline, never a note. The note methods aren't even called.
      const called: string[] = [];
      const guarded = new Proxy(store, { get: (t, p) => {
        if (typeof p === "string" && /note/i.test(p)) called.push(p);
        return Reflect.get(t, p);
      } });
      const acting = (await loadClientFile(pool, guarded, priya.id, clientKey(email), { owner: false }, { now: NOW }))!;
      expect(acting.notes).toBeNull();
      expect(called).toEqual([]);
      expect(acting.entries).toHaveLength(owner.entries.length);
      const json = JSON.stringify(acting);
      expect(json).not.toContain("panic");
      expect(json).not.toContain("grounding");
      // Arun's note on his own booking with Meera never reaches Priya's file.
      expect(JSON.stringify(owner)).not.toContain("Arun's own note");
    });

    it("never puts notes in emails or invoice exports", async () => {
      const f = (await file(priya, email))!;
      const b = f.entries.find((e) => e.id === ids.paid) as BookingEntry;
      const kinds: BookingEmailKind[] = ["booked_guest", "booked_host", "reminder_guest", "cancelled_guest", "cancelled_host", "rescheduled_guest", "rescheduled_host", "late_host"];
      for (const kind of kinds) {
        const m = renderBookingMail(kind, {
          bookingId: b.id, eventName: "Coaching", hostName: priya.name, hostEmail: priya.email, guestName: "Meera", guestEmail: email, guestTimezone: "Asia/Kolkata",
          hostTimezone: priya.timezone, hostTimeFormat: "12h", startAt: b.startAt, endAt: b.endAt, location: null, joinUrl: null, cancelledBy: null, cancelReason: null,
          answers: b.answers.map((a, i) => ({ questionId: `q${i}`, ...a })), previousStartAt: null, issuedAt: NOW, manageUrl: "https://example.test/m",
          dashboardUrl: "https://example.test/d", locale: "en",
        } satisfies BookingMailContext);
        expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/panic|grounding/);
      }
      const invoices = await listInvoices(pool, priya.id);
      expect(invoicesCsv(invoices)).not.toMatch(/panic|grounding/);
      for (const v of invoices) {
        const m = renderInvoiceMail({ kind: v.kind, number: v.number, supplierName: v.supplier.legalName, supplierEmail: priya.email, totalMinor: v.totalMinor, description: v.description, url: "https://example.test/i", originalNumber: v.originalNumber });
        expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/panic|grounding/);
      }
    });
  });

  it("never lets code that mails, queues or exports read the note tables", () => {
    // Emails are built by the job worker from queries in these folders; exports and reports likewise. None may touch notes.
    const roots = ["src/lib/mail", "src/lib/jobs", "src/lib/gst", "src/lib/earnings.ts", "src/lib/portal", "src/app/api"];
    const files = roots.flatMap(function walk(p: string): string[] {
      try {
        return statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : /\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) ? [p] : [];
      } catch {
        return [];
      }
    });
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/client_notes|booking_notes|note_revisions|getClientNote|getBookingNote|listBookingNotes|privacy\/notes|note-history/);
  });

  describe("note history", () => {
    const email = "hist@example.com";
    let bookingId: string;
    beforeAll(async () => {
      bookingId = await book(priya, coaching, email, new Date(NOW.getTime() - 40 * DAY));
    });

    it("records who and when for each change, not the text, and nothing for an unchanged save", async () => {
      await store.saveClientNote(priya.id, email, "First version");
      await store.saveClientNote(priya.id, email, "First version");
      await store.saveClientNote(priya.id, email, "Second version");
      await store.saveClientNote(priya.id, email, "  ");
      await store.saveClientNote(priya.id, email, "");
      const revs = await store.listNoteRevisions(priya.id, { email: "HIST@example.com" });
      expect(revs.map((r) => [r.action, r.actorId, r.actorName, r.text])).toEqual([
        ["cleared", priya.id, priya.name, null], ["saved", priya.id, priya.name, null], ["saved", priya.id, priya.name, null]]);
      expect(revs[0].at.getTime()).toBeGreaterThanOrEqual(revs[2].at.getTime());
      const { rows } = await pool.query("select text_sealed from note_revisions where host_id = $1 and email = $2", [priya.id, email]);
      expect(rows.every((r) => r.text_sealed === null)).toBe(true);
      expect(await store.listNoteRevisions(arun.id, { email })).toEqual([]);
    });

    it("keeps sealed versions while the owner chooses to, and deletes them when they stop", async () => {
      await store.setKeepNoteVersions(priya.id, true);
      expect(await store.getKeepNoteVersions(priya.id)).toBe(true);
      await store.saveBookingNote(priya.id, bookingId, "v1 private");
      await store.saveBookingNote(priya.id, bookingId, "v2 private");
      const revs = await store.listNoteRevisions(priya.id, { bookingIds: [bookingId] });
      expect(revs.map((r) => r.text)).toEqual(["v2 private", "v1 private"]);
      const { rows } = await pool.query("select text_sealed from note_revisions where booking_id = $1", [bookingId]);
      expect(rows).toHaveLength(2);
      for (const r of rows) expect((r.text_sealed as Buffer).toString("utf8")).not.toContain("private");
      // Another host's key or another row can't open them.
      await expect(createPgStore(pool, { noteKey: () => randomBytes(32) }).listNoteRevisions(priya.id, { bookingIds: [bookingId] })).rejects.toThrow();
      expect(await store.listNoteRevisions(arun.id, { bookingIds: [bookingId] })).toEqual([]);

      await store.setKeepNoteVersions(priya.id, false);
      const after = await store.listNoteRevisions(priya.id, { bookingIds: [bookingId] });
      expect(after.map((r) => [r.action, r.text])).toEqual([["saved", null], ["saved", null]]);
      expect((await pool.query("select count(*)::int as n from note_revisions where host_id = $1 and text_sealed is not null", [priya.id])).rows[0].n).toBe(0);
      expect(await store.getBookingNote(priya.id, bookingId)).toBe("v2 private");
    });

    it("records nothing when someone else's booking is written to", async () => {
      await expect(store.saveBookingNote(arun.id, bookingId, "x")).rejects.toMatchObject({ name: "NotFoundError" });
      expect((await pool.query("select count(*)::int as n from note_revisions where booking_id = $1 and host_id = $2", [bookingId, arun.id])).rows[0].n).toBe(0);
      expect((await store.listNoteRevisions(priya.id, { bookingIds: [bookingId] })).every((r) => r.actorId === priya.id)).toBe(true);
    });
  });

  describe("a client with 230 bookings", () => {
    const email = "regular@example.com";
    const all: string[] = [];
    beforeAll(async () => {
      const first = new Date("2025-01-01T04:30:00Z").getTime();
      const { rows } = await pool.query(
        `insert into bookings (event_type_id, host_id, start_at, end_at, buffered_start, buffered_end, status, idempotency_key)
         select $1, $2, to_timestamp($3 / 1000.0) + g * interval '2 days', to_timestamp($3 / 1000.0) + g * interval '2 days' + interval '30 minutes',
                to_timestamp($3 / 1000.0) + g * interval '2 days', to_timestamp($3 / 1000.0) + g * interval '2 days' + interval '30 minutes', 'confirmed', 'bulk-' || g
         from generate_series(0, 229) g returning id, start_at`, [coaching.id, priya.id, first]);
      await pool.query(
        `insert into invitees (booking_id, host_id, name, email, timezone, answers) select unnest($1::uuid[]), $2, 'Regular', $3, 'Asia/Kolkata', '[]'`,
        [rows.map((r) => r.id), priya.id, email]);
      all.push(...rows.sort((a, b) => b.start_at - a.start_at).map((r) => r.id));
      // A package bought at exactly the same moment as one booking: the order and cursor must still hold.
      const tie = rows.find((r) => r.id === all[100])!;
      const pid = await purchase(priya, coaching, email, { paidAt: tie.start_at });
      all.splice(100, 0, pid);  // same time: package sorts before the booking (kind descending)
    });

    it("pages through everything, newest first, with nothing skipped or repeated", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      const started = Date.now();
      do {
        const f: ClientFile = (await file(priya, email, true, cursor))!;
        expect(f.entries.length).toBeLessThanOrEqual(25);
        seen.push(...f.entries.map((e) => e.id));
        cursor = f.nextCursor;
        pages++;
      } while (cursor);
      const ms = Date.now() - started;
      expect(pages).toBe(10);
      expect(seen).toHaveLength(231);
      expect(new Set(seen).size).toBe(231);
      expect(seen).toEqual(all);
      expect((await file(priya, email))!.header.sessions).toBe(230);
      // Ten pages in well under a second on a laptop Postgres; a generous bound so CI noise doesn't flake.
      expect(ms).toBeLessThan(5000);
      console.log(`client file: 231 entries in ${pages} pages, ${ms} ms`);
    });

    it("ignores a tampered cursor and starts from the newest", async () => {
      const f = (await file(priya, email, true, "not-a-cursor"))!;
      expect(f.entries[0].id).toBe(all[0]);
      const big = (await file(priya, email, true, null, 10_000))!;
      expect(big.entries).toHaveLength(100);
    });
  });
});
