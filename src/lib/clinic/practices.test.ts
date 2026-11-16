// The Clinic plan's practice, roles and practitioner management, against real Postgres (only with TEST_DATABASE_URL).
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostPlan } from "../billing/account";
import { canActFor, inviteSeat, acceptSeat } from "../seats";
import { clientNoteAs, listPracticeBookings } from "./bookings";
import {
  acceptPracticeInvite, changeMember, createPractice, inviteMember, leavePractice, listMembers, pendingPracticeInvite, practiceBySlug,
  practiceContext, practitionerCount, practitionerLimit, removeMember, updatePractice,
} from "./practices";
import { allowed } from "./roles";
import { booking, eventType, freshDb, person, plan, type Person } from "./test-db";

const BASE = process.env.TEST_DATABASE_URL;
const now = new Date("2026-11-16T05:00:00Z");

describe("practice roles (rules)", () => {
  it("lets only the owner touch billing, owners and admins run the practice, and every member see who's in it", () => {
    expect(allowed("owner", "billing.manage")).toBe(true);
    expect(allowed("admin", "billing.manage")).toBe(false);
    expect(allowed("practitioner", "billing.manage")).toBe(false);
    for (const a of ["members.manage", "bookings.view_all", "invoices.view", "invoices.settings", "practice.edit"] as const) {
      expect(allowed("owner", a)).toBe(true);
      expect(allowed("admin", a)).toBe(true);
      expect(allowed("practitioner", a)).toBe(false);
    }
    expect(allowed("practitioner", "practice.view")).toBe(true);
    expect(allowed(null, "practice.view")).toBe(false);
  });
});

describe.skipIf(!BASE)("practice (Postgres)", () => {
  let pool: pg.Pool;
  let owner: Person, asst: Person, dr2: Person, dr3: Person, dr4: Person, outsider: Person;
  const accept = async (p: Person) => expect(await acceptPracticeInvite(pool, p)).toBe(true);

  beforeAll(async () => {
    pool = await freshDb(BASE!, "clinic_a");
    owner = await person(pool, "owner@clinic.test", "Dr Meera", "dr-meera");
    asst = await person(pool, "asst@clinic.test", "Ravi", "ravi-asst");
    dr2 = await person(pool, "dr2@clinic.test", "Dr Arjun", "dr-arjun");
    dr3 = await person(pool, "dr3@clinic.test", "Dr Kavya", "dr-kavya");
    dr4 = await person(pool, "dr4@clinic.test", "Dr Sana", "dr-sana");
    outsider = await person(pool, "out@else.test", "Outsider", "outsider");
  });
  afterAll(async () => { await pool?.end(); });

  it("a Duo owner sets up a practice and keeps everything: their data, their plan, and their second person", async () => {
    await plan(pool, owner.id, "duo");
    await inviteSeat(pool, owner, asst.email, now);
    expect(await acceptSeat(pool, asst)).toBe(true);
    const et = await eventType(pool, owner.id, "Therapy session", "therapy");
    const b = await booking(pool, owner.id, et, new Date("2026-11-20T05:00:00Z"), { name: "Client A", email: "a@client.test" });
    await pool.query("insert into client_notes (host_id, email, note) values ($1, 'a@client.test', 'Owner private note')", [owner.id]);

    const practice = await createPractice(pool, owner, { name: "MindCare", slug: "mindcare", about: "" }, { bringSeat: "admin" });
    // Still Duo until they switch: nothing about their plan or their second person changed.
    expect(await hostPlan(pool, owner.id)).toBe("duo");
    expect(await canActFor(pool, asst.id, owner.id)).toBe(true);
    expect((await pool.query("select id from event_types where user_id = $1", [owner.id])).rows.map((r) => r.id)).toEqual([et]);
    expect((await pool.query("select id from bookings where host_id = $1", [owner.id])).rows.map((r) => r.id)).toEqual([b]);
    expect(await clientNoteAs(pool, owner.id, owner.id, "a@client.test")).toBe("Owner private note");

    expect((await practiceContext(pool, owner.id))).toMatchObject({ role: "owner", live: false, practice: { id: practice.id } });
    expect((await practiceContext(pool, asst.id))).toMatchObject({ role: "admin" });
    expect((await practiceBySlug(pool, "mindcare"))?.live).toBe(false);

    // Switching to Clinic makes it live; the owner's data is exactly where it was.
    await plan(pool, owner.id, "clinic");
    expect((await practiceBySlug(pool, "mindcare"))?.live).toBe(true);
    expect((await pool.query("select count(*)::int as n from bookings where host_id = $1", [owner.id])).rows[0].n).toBe(1);
  });

  it("refuses a slug a host already has, and a host can't later sign up with a practice's slug", async () => {
    await expect(updatePractice(pool, owner.id, { name: "MindCare", slug: "dr-arjun", about: "" })).rejects.toMatchObject({ code: "slug_taken" });
    await expect(pool.query("insert into users (email, name, slug) values ('x@y.test', 'X', 'mindcare')")).rejects.toMatchObject({ code: "23505" });
  });

  it("needs the practice live to invite, and counts practitioner places against what the plan pays for", async () => {
    // 3 places included; the owner practises, so two more practitioners fit.
    expect(await practitionerLimit(pool, (await practiceContext(pool, owner.id))!.practice.id)).toBe(3);
    await inviteMember(pool, owner.id, dr2.email, "practitioner", now);
    await inviteMember(pool, owner.id, dr3.email, "practitioner", now);
    await expect(inviteMember(pool, owner.id, dr4.email, "practitioner", now)).rejects.toMatchObject({ code: "limit" });
    // Admins who don't see clients don't take a place.
    await inviteMember(pool, owner.id, "frontdesk@clinic.test", "admin", now);
    expect((await pool.query("select count(*)::int as n from notifications where kind = 'practice_invite'")).rows[0].n).toBe(3);
    await plan(pool, owner.id, "clinic", "active", 1);
    await inviteMember(pool, owner.id, dr4.email, "practitioner", now);
    const id = (await practiceContext(pool, owner.id))!.practice.id;
    expect(await practitionerCount(pool, id)).toBe(4);
    // Never more than 10, whatever the subscription row says.
    await plan(pool, owner.id, "clinic", "active", 50);
    expect(await practitionerLimit(pool, id)).toBe(10);
    await plan(pool, owner.id, "clinic", "active", 1);

    // A paused plan isn't live: no invitations, and nobody can accept.
    await plan(pool, owner.id, "clinic", "paused", 1);
    expect(await pendingPracticeInvite(pool, dr2)).toBeNull();
    await expect(inviteMember(pool, owner.id, "late@x.test", "practitioner", now)).rejects.toMatchObject({ code: "not_live" });
    await plan(pool, owner.id, "clinic", "active", 1);

    await accept(dr2);
    await accept(dr3);
    await accept(dr4);
    expect((await practiceContext(pool, dr2.id))?.role).toBe("practitioner");
  });

  it("enforces roles on every action: a practitioner can't manage people, edit the page or see the practice's bookings", async () => {
    const members = await listMembers(pool, dr2.id); // any member may see who's in it
    const dr3Row = members.find((m) => m.userId === dr3.id)!;
    await expect(inviteMember(pool, dr2.id, "x@x.test", "practitioner", now)).rejects.toMatchObject({ name: "ClinicAccessError" });
    await expect(changeMember(pool, dr2.id, dr3Row.id, { active: false })).rejects.toMatchObject({ name: "ClinicAccessError" });
    await expect(removeMember(pool, dr2.id, dr3Row.id)).rejects.toMatchObject({ name: "ClinicAccessError" });
    await expect(updatePractice(pool, dr2.id, { name: "Hijacked", slug: "hijacked", about: "" })).rejects.toMatchObject({ name: "ClinicAccessError" });
    await expect(listPracticeBookings(pool, dr2.id, { from: new Date(0), to: new Date("2030-01-01") })).rejects.toMatchObject({ name: "ClinicAccessError" });
    // Someone outside the practice gets nothing at all.
    await expect(listMembers(pool, outsider.id)).rejects.toMatchObject({ name: "ClinicAccessError" });
    await expect(removeMember(pool, outsider.id, dr3Row.id)).rejects.toMatchObject({ name: "ClinicAccessError" });
    expect((await practiceBySlug(pool, "mindcare"))?.name).toBe("MindCare");
  });

  it("an admin manages people within their own practice only, and can't demote or remove the owner", async () => {
    const members = await listMembers(pool, asst.id);
    const ownerRow = members.find((m) => m.role === "owner")!;
    const dr3Row = members.find((m) => m.userId === dr3.id)!;
    await expect(changeMember(pool, asst.id, ownerRow.id, { role: "practitioner" })).rejects.toMatchObject({ code: "owner_fixed" });
    await expect(removeMember(pool, asst.id, ownerRow.id)).rejects.toMatchObject({ code: "owner_fixed" });
    await changeMember(pool, asst.id, dr3Row.id, { active: false });
    expect((await listMembers(pool, owner.id)).find((m) => m.id === dr3Row.id)?.active).toBe(false);
    // Another practice's admin can't reach into this one, even with the right member id.
    const other = await person(pool, "other@clinic2.test", "Other Owner", "other-owner");
    await plan(pool, other.id, "clinic");
    await createPractice(pool, other, { name: "Other Clinic", slug: "other-clinic", about: "" });
    await expect(changeMember(pool, other.id, dr3Row.id, { active: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(removeMember(pool, other.id, dr3Row.id)).rejects.toMatchObject({ code: "not_found" });
    // Putting dr3 back needs a free place: 4 paid, owner + dr2 + dr4 use 3.
    await changeMember(pool, asst.id, dr3Row.id, { active: true });
    await expect(changeMember(pool, asst.id, members.find((m) => m.email === "frontdesk@clinic.test")!.id, { practises: true })).rejects.toMatchObject({ code: "limit" });
  });

  it("shows admins every practitioner's bookings, without client notes or intake answers; notes stay with their practitioner", async () => {
    const et2 = await eventType(pool, dr2.id, "Counselling", "counselling");
    await booking(pool, dr2.id, et2, new Date("2026-11-21T05:00:00Z"), { name: "Client B", email: "b@client.test", answers: [{ label: "What brings you", answer: "private detail" }] });
    await pool.query("insert into client_notes (host_id, email, note) values ($1, 'b@client.test', 'Dr Arjun private note')", [dr2.id]);
    const rows = await listPracticeBookings(pool, asst.id, { from: new Date("2026-11-01"), to: new Date("2026-12-01") });
    expect(rows.map((r) => [r.practitioner.name, r.guests[0].name])).toEqual([["Dr Meera", "Client A"], ["Dr Arjun", "Client B"]]);
    expect(JSON.stringify(rows)).not.toMatch(/private/);
    // A practitioner can't read another practitioner's notes; the owner and admins can't either.
    await expect(clientNoteAs(pool, dr3.id, dr2.id, "b@client.test")).rejects.toMatchObject({ name: "ClinicAccessError" });
    await expect(clientNoteAs(pool, owner.id, dr2.id, "b@client.test")).rejects.toMatchObject({ name: "ClinicAccessError" });
    await expect(clientNoteAs(pool, asst.id, dr2.id, "b@client.test")).rejects.toMatchObject({ name: "ClinicAccessError" });
    expect(await clientNoteAs(pool, dr2.id, dr2.id, "b@client.test")).toBe("Dr Arjun private note");
  });

  it("lets a practitioner leave (their account stays theirs) but never the owner", async () => {
    await expect(leavePractice(pool, owner)).rejects.toMatchObject({ code: "owner_fixed" });
    await leavePractice(pool, dr4);
    expect(await practiceContext(pool, dr4.id)).toBeNull();
    expect((await pool.query("select 1 from users where id = $1", [dr4.id])).rowCount).toBe(1);
  });

  it("one practice per person: an invited address can't be taken by another practice", async () => {
    await expect(inviteMember(pool, "00000000-0000-4000-8000-000000000000", dr2.email, "practitioner", now)).rejects.toMatchObject({ name: "ClinicAccessError" });
    const other = (await pool.query("select id from users where slug = 'other-owner'")).rows[0].id as string;
    await expect(inviteMember(pool, other, dr2.email, "practitioner", now)).rejects.toMatchObject({ code: "taken" });
    await expect(createPractice(pool, dr2, { name: "Breakaway", slug: "breakaway", about: "" })).rejects.toMatchObject({ code: "already_in_practice" });
  });
});
