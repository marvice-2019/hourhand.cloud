// The public practice page and the shared waitlist, against real Postgres (only with TEST_DATABASE_URL).
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isIanaTimeZone } from "../booking";
import { queueWaitlistFor } from "../waitlist";
import { renderClinicMail } from "./mail";
import { practicePage } from "./page";
import { acceptPracticeInvite, changeMember, createPractice, inviteMember, listMembers } from "./practices";
import { createService, linkEventType } from "./services";
import { joinPracticeWaitlist } from "./waitlist";
import { booking, eventType, freshDb, person, plan, type Person } from "./test-db";

const BASE = process.env.TEST_DATABASE_URL;
const now = new Date("2026-11-16T05:00:00Z");

describe.skipIf(!BASE)("practice page and shared waitlist (Postgres)", () => {
  let pool: pg.Pool;
  let owner: Person, dr2: Person, dr3: Person, dr4: Person, dr5: Person, desk: Person, stranger: Person;
  let therapy: string, couples: string;
  const et: Record<string, string> = {};
  const wait = (name: string, email: string, service: string, day: string) =>
    joinPracticeWaitlist(pool, { practice: "mindcare", service, day, timezone: "Asia/Kolkata", name, email }, now, isIanaTimeZone);
  const cancel = async (id: string) => {
    await pool.query("update bookings set status = 'cancelled', cancelled_at = $2, cancelled_by = 'guest' where id = $1", [id, now]);
    return queueWaitlistFor(pool, id, now);
  };
  const queued = async () => (await pool.query("select recipient, user_id, booking_id from notifications where kind = 'practice_waitlist_guest' order by recipient")).rows;

  beforeAll(async () => {
    pool = await freshDb(BASE!, "clinic_b");
    owner = await person(pool, "owner@clinic.test", "Dr Meera", "dr-meera");
    dr2 = await person(pool, "dr2@clinic.test", "Dr Arjun", "dr-arjun");
    dr3 = await person(pool, "dr3@clinic.test", "Dr Kavya", "dr-kavya");
    dr4 = await person(pool, "dr4@clinic.test", "Dr Sana", "dr-sana");
    dr5 = await person(pool, "dr5@clinic.test", "Dr Gone", "dr-gone");
    desk = await person(pool, "desk@clinic.test", "Front Desk", "front-desk");
    stranger = await person(pool, "s@else.test", "Stranger", "stranger");
    await plan(pool, owner.id, "clinic", "active", 3);
    await createPractice(pool, owner, { name: "MindCare", slug: "mindcare", about: "Therapy in Indiranagar" });
    for (const p of [dr2, dr3, dr5]) await inviteMember(pool, owner.id, p.email, "practitioner", now);
    await inviteMember(pool, owner.id, dr4.email, "practitioner", now); // never accepts
    await inviteMember(pool, owner.id, desk.email, "admin", now);
    for (const p of [dr2, dr3, dr5, desk]) expect(await acceptPracticeInvite(pool, p)).toBe(true);
    for (const p of [owner, dr2, dr3, dr4, dr5]) et[p.slug] = await eventType(pool, p.id, "Therapy 50", `therapy-${p.slug}`, { price: 150_000 });
    et.dr2Couples = await eventType(pool, dr2.id, "Couples", "couples");
    therapy = (await createService(pool, desk.id, { name: "Individual therapy", description: "" })).id;
    couples = (await createService(pool, owner.id, { name: "Couples therapy", description: "" })).id;
  });
  afterAll(async () => { await pool?.end(); });

  it("only practitioners link their own event types, to their own practice's services", async () => {
    for (const p of [owner, dr2, dr3, dr5]) await linkEventType(pool, p.id, et[p.slug], therapy);
    await linkEventType(pool, dr2.id, et.dr2Couples, couples);
    // Nobody links someone else's event type: not another practitioner, not an admin, not the owner.
    await expect(linkEventType(pool, dr3.id, et["dr-arjun"], couples)).rejects.toMatchObject({ code: "not_found" });
    await expect(linkEventType(pool, desk.id, et["dr-arjun"], couples)).rejects.toMatchObject({ code: "not_found" });
    await expect(linkEventType(pool, owner.id, et["dr-arjun"], couples)).rejects.toMatchObject({ code: "not_found" });
    // Someone outside the practice can't link into it.
    const own = await eventType(pool, stranger.id, "Mine", "mine");
    await expect(linkEventType(pool, stranger.id, own, therapy)).rejects.toMatchObject({ name: "ClinicAccessError" });
    // A practitioner can't define services.
    await expect(createService(pool, dr2.id, { name: "Rogue", description: "" })).rejects.toMatchObject({ name: "ClinicAccessError" });
  });

  it("lists only active practitioners: accepted, taking sessions, on the page, with an open account", async () => {
    await pool.query("update users set deleted_at = now() where id = $1", [dr5.id]);
    const dr3Row = (await listMembers(pool, owner.id)).find((m) => m.userId === dr3.id)!;
    await changeMember(pool, desk.id, dr3Row.id, { active: false });
    const page = (await practicePage(pool, "mindcare"))!;
    expect(page.practitioners.map((p) => p.name)).toEqual(["Dr Meera", "Dr Arjun"]); // not Kavya (off), Sana (invited), Gone (closed), Front Desk (admin)
    expect(page.services.map((s) => [s.name, s.offers.map((o) => o.practitioner.name)])).toEqual([
      ["Individual therapy", ["Dr Meera", "Dr Arjun"]], ["Couples therapy", ["Dr Arjun"]]]);
    // Hidden or inactive event types aren't offered.
    await pool.query("update event_types set hidden = true where id = $1", [et.dr2Couples]);
    expect((await practicePage(pool, "mindcare"))!.services.map((s) => s.name)).toEqual(["Individual therapy"]);
    await pool.query("update event_types set hidden = false where id = $1", [et.dr2Couples]);
    // No page unless the practice is live.
    await plan(pool, owner.id, "clinic", "paused", 3);
    expect(await practicePage(pool, "mindcare")).toBeNull();
    await plan(pool, owner.id, "clinic", "active", 3);
    expect(await practicePage(pool, "nobody-here")).toBeNull();
  });

  it("offers a freed slot to everyone waiting on that service and day, once, with that practitioner's link", async () => {
    expect(await wait("Asha", "asha@guest.test", "individual-therapy", "2026-11-20")).toEqual({ ok: true });
    expect(await wait("Bala", "bala@guest.test", "individual-therapy", "2026-11-20")).toEqual({ ok: true });
    expect(await wait("Chitra", "chitra@guest.test", "individual-therapy", "2026-11-21")).toEqual({ ok: true }); // another day
    expect(await wait("Dev", "dev@guest.test", "couples-therapy", "2026-11-20")).toEqual({ ok: true }); // another service
    expect(await wait("Asha", "asha@guest.test", "individual-therapy", "2026-11-20")).toEqual({ ok: true }); // twice: one entry
    expect((await pool.query("select count(*)::int as n from practice_waitlist")).rows[0].n).toBe(4);

    // 20 Nov, 11:00 IST, with Dr Arjun (individual therapy) frees up.
    const b = await booking(pool, dr2.id, et["dr-arjun"], new Date("2026-11-20T05:30:00Z"), { name: "Old client", email: "old@guest.test" });
    expect(await cancel(b)).toBe(2);
    expect(await queued()).toEqual([
      { recipient: "asha@guest.test", user_id: dr2.id, booking_id: b }, { recipient: "bala@guest.test", user_id: dr2.id, booking_id: b }]);

    // The email points at Dr Arjun's own booking link for that exact time.
    const n = (await pool.query("select kind, recipient, dedupe_key, booking_id from notifications where recipient = 'asha@guest.test'")).rows[0];
    const mail = await renderClinicMail(pool, n, "https://hourhand.cloud", now);
    expect("skip" in mail).toBe(false);
    expect((mail as { text: string }).text).toContain("https://hourhand.cloud/dr-arjun/therapy-dr-arjun?at=2026-11-20T05%3A30%3A00.000Z");
    expect((mail as { subject: string }).subject).toContain("Dr Arjun");

    // Another time on the same day with Dr Meera: those guests already heard, so nobody new.
    const b2 = await booking(pool, owner.id, et["dr-meera"], new Date("2026-11-20T08:30:00Z"), { name: "Other", email: "o@guest.test" });
    expect(await cancel(b2)).toBe(0);
  });

  it("doesn't offer a time from a practitioner who is off the page, from a past booking, or when the practice isn't live", async () => {
    // Dr Kavya is off the page: her freed time on Chitra's day isn't offered.
    await linkEventType(pool, dr3.id, et["dr-kavya"], therapy);
    const k = await booking(pool, dr3.id, et["dr-kavya"], new Date("2026-11-21T05:30:00Z"), { name: "K", email: "k@guest.test" });
    expect(await cancel(k)).toBe(0);
    // Not live: nothing.
    await plan(pool, owner.id, "clinic", "cancelled", 3);
    const m = await booking(pool, owner.id, et["dr-meera"], new Date("2026-11-21T06:30:00Z"), { name: "M", email: "m@guest.test" });
    expect(await cancel(m)).toBe(0);
    await plan(pool, owner.id, "clinic", "active", 3);
    // A booking in the past frees nothing.
    const past = await booking(pool, owner.id, et["dr-meera"], new Date("2026-11-10T05:30:00Z"), { name: "P", email: "p@guest.test" });
    expect(await cancel(past)).toBe(0);
    // Now Dr Meera frees a time on Chitra's day: Chitra hears.
    const m2 = await booking(pool, owner.id, et["dr-meera"], new Date("2026-11-21T09:30:00Z"), { name: "M2", email: "m2@guest.test" });
    expect(await cancel(m2)).toBe(1);
    expect((await queued()).map((r) => r.recipient)).toContain("chitra@guest.test");
  });

  it("refuses unknown services and days out of range, and caps joins per address across both waitlists", async () => {
    expect(await wait("X", "x@guest.test", "no-such-service", "2026-11-20")).toMatchObject({ ok: false, status: 404 });
    expect(await wait("X", "x@guest.test", "individual-therapy", "2026-11-01")).toMatchObject({ ok: false, status: 400 });
    // Four joins on the host waitlist plus one here use up the week's five.
    for (const day of ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"]) {
      await pool.query(
        `insert into waitlist (host_id, event_type_id, day, timezone, window_start, window_end, name, email, created_at)
         values ($1, $2, $3, 'Asia/Kolkata', $4, $5, 'Y', 'y@guest.test', $6)`, [owner.id, et["dr-meera"], day, now, new Date(now.getTime() + 1), now]);
    }
    expect(await wait("Y", "y@guest.test", "individual-therapy", "2026-11-26")).toEqual({ ok: true });
    expect(await wait("Y", "y@guest.test", "individual-therapy", "2026-11-27")).toMatchObject({ ok: false, status: 429 });
  });
});
