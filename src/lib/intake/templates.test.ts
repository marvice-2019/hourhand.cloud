// Intake questions and templates against real Postgres. Runs only with TEST_DATABASE_URL; uses its own database
// (<name>_intake) so it can run beside the store's tests, and drops and recreates it on every run.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { handleCreateBooking } from "../booking";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { validateQuestions } from "../event-types";
import { ANSWER_ERRORS } from "./answers";
import { applyTemplate, checkTemplate, createFromStarter, createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate } from "./templates";
import { fromTemplate, type TemplateQuestion } from "./templates-shape";

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("intake templates (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let arun: User;
  let coaching: EventType;
  let intro: EventType;
  let day = 0;
  /** A fresh weekday morning far ahead, inside nobody's busy time (the booking window is checked by the handler only). */
  const nextStart = () => new Date(Date.UTC(2031, 2, 3 + 7 * day++, 5, 0));

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_intake`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const admin = new URL(BASE!);
    admin.pathname = "/postgres";
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    try {
      await client.query(`drop database if exists ${name} with (force)`);
      await client.query(`create database ${name}`);
    } finally {
      await client.end();
    }
    await migrate(u.toString());
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    arun = (await store.getUserBySlug("arun"))!;
    const types = await store.listEventTypes(priya.id);
    coaching = types.find((e) => e.slug === "coaching")!;
    intro = types.find((e) => e.slug === "intro")!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const therapy: TemplateQuestion[] = [
    { label: "Have you had therapy before?", kind: "yes_no", required: true, choices: [] },
    { label: "What worked, or didn't?", kind: "long_text", required: true, choices: [], showIf: { questionIndex: 0, values: ["yes"] } },
    { label: "Age", kind: "number", required: false, choices: [], minValue: 18, maxValue: 120 },
    { label: "Emergency contact", kind: "short_text", required: true, choices: [], firstBookingOnly: true },
  ];

  it("gives questions saved before intake forms the defaults that change nothing", async () => {
    const qs = await store.listCustomQuestions(priya.id, coaching.id);
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) expect(q).toMatchObject({ showIf: null, firstBookingOnly: false, minValue: null, maxValue: null, templateId: null });
    await expect(pool.query("insert into custom_questions (event_type_id, label, kind) values ($1, 'x', 'file_upload')", [coaching.id])).rejects.toThrow(/custom_questions_kind_check/);
  });

  it("stores a condition by question id and reads it back as it was saved", async () => {
    const checked = validateQuestions(fromTemplate(therapy, 0, null));
    if (!checked.ok) throw new Error("invalid");
    const saved = await store.saveQuestions(priya.id, intro.id, checked.value);
    const back = await store.listCustomQuestions(priya.id, intro.id);
    expect(back).toEqual(saved);
    expect(back[1].showIf).toEqual({ questionId: back[0].id, values: ["yes"] });
    expect(back[2]).toMatchObject({ kind: "number", minValue: 18, maxValue: 120 });
    expect(back[3].firstBookingOnly).toBe(true);
    await store.saveQuestions(priya.id, intro.id, []);
  });

  it("applies one template to several event types; editing it changes nothing until applied again, and past answers keep their labels", async () => {
    const checked = checkTemplate("Therapy intake", fromTemplate(therapy, 0, null));
    if (!checked.ok) throw new Error("invalid template");
    const tpl = await createTemplate(pool, priya.id, checked.name, checked.questions);
    const before = await store.listCustomQuestions(priya.id, coaching.id);

    expect(await applyTemplate(pool, store, priya.id, tpl.id, [coaching.id, intro.id])).toEqual({ applied: [coaching.id, intro.id], skipped: [] });
    const coachingQs = await store.listCustomQuestions(priya.id, coaching.id);
    const introQs = await store.listCustomQuestions(priya.id, intro.id);
    // The event type's own question stays first; the template's follow after it, linked to the template.
    expect(coachingQs.map((q) => q.label)).toEqual([...before.map((q) => q.label), ...therapy.map((q) => q.label)]);
    expect(introQs.map((q) => q.label)).toEqual(therapy.map((q) => q.label));
    expect(coachingQs.filter((q) => q.templateId === tpl.id)).toHaveLength(4);

    // A booking answers the questions as they are now.
    const answers = Object.fromEntries([
      ...before.map((q) => [q.id, "Plan"]),
      [coachingQs.find((q) => q.label === "Have you had therapy before?")!.id, "yes"],
      [coachingQs.find((q) => q.label === "What worked, or didn't?")!.id, "Talking it through"],
      [coachingQs.find((q) => q.label === "Emergency contact")!.id, "Asha 98450 00000"],
    ]);
    const start = nextStart();
    const booked = await store.createBooking({
      eventTypeId: coaching.id, startAt: start, idempotencyKey: `intake-tpl-${start.getTime()}`,
      invitee: { name: "Kiran", email: "kiran.intake@example.com", timezone: "Asia/Kolkata", phone: null,
        answers: coachingQs.filter((q) => answers[q.id]).map((q) => ({ questionId: q.id, label: q.label, answer: answers[q.id] })) },
    });

    // Edit the template: the event types keep their copies.
    const edited = therapy.map((q) => (q.label === "What worked, or didn't?" ? { ...q, label: "What helped, and what didn't?" } : q));
    await updateTemplate(pool, priya.id, tpl.id, "Therapy intake", edited);
    expect((await store.listCustomQuestions(priya.id, coaching.id)).map((q) => q.label)).toContain("What worked, or didn't?");

    // Apply again: the copies are replaced in place, nothing is duplicated, the event type's own question stays.
    await applyTemplate(pool, store, priya.id, tpl.id, [coaching.id, intro.id]);
    const after = await store.listCustomQuestions(priya.id, coaching.id);
    expect(after.map((q) => q.label)).toEqual([...before.map((q) => q.label), ...edited.map((q) => q.label)]);
    expect(after[0].id).toBe(before[0].id);

    // The earlier booking still shows the question as it was asked.
    const stored = (await store.getBooking(priya.id, booked.id))!.invitee.answers;
    expect(stored.map((a) => a.label)).toContain("What worked, or didn't?");
    expect(stored.map((a) => a.label)).not.toContain("What helped, and what didn't?");

    // Deleting the template leaves the copied questions where they are.
    expect(await deleteTemplate(pool, priya.id, tpl.id)).toBe(true);
    const left = await store.listCustomQuestions(priya.id, coaching.id);
    expect(left.map((q) => q.label)).toEqual(after.map((q) => q.label));
    expect(left.every((q) => q.templateId === null)).toBe(true);
    await store.saveQuestions(priya.id, coaching.id, before.map((q) => ({ id: q.id, label: q.label, kind: q.kind, required: q.required, choices: q.choices })));
    await store.saveQuestions(priya.id, intro.id, []);
  });

  it("keeps each host to their own templates", async () => {
    const tpl = await createTemplate(pool, priya.id, "Mine", therapy);
    expect(await getTemplate(pool, arun.id, tpl.id)).toBeNull();
    expect(await updateTemplate(pool, arun.id, tpl.id, "Taken", therapy)).toBeNull();
    expect(await deleteTemplate(pool, arun.id, tpl.id)).toBe(false);
    expect(await applyTemplate(pool, store, arun.id, tpl.id, [coaching.id])).toBeNull();
    // Priya's template applied by Priya to Arun's event type: the event type isn't hers, so it is skipped.
    const arunType = (await store.listEventTypes(arun.id))[0];
    expect(await applyTemplate(pool, store, priya.id, tpl.id, [arunType.id])).toEqual({ applied: [], skipped: [{ eventTypeId: arunType.id, reason: "not_found" }] });
    // A crafted template link to someone else's template isn't kept.
    await store.saveQuestions(arun.id, arunType.id, [{ id: null, label: "Q", kind: "short_text", required: false, choices: [], templateId: tpl.id }]);
    expect((await store.listCustomQuestions(arun.id, arunType.id))[0].templateId).toBeNull();
    expect((await listTemplates(pool, arun.id)).map((t) => t.id)).not.toContain(tpl.id);
    await store.saveQuestions(arun.id, arunType.id, []);
    await deleteTemplate(pool, priya.id, tpl.id);
  });

  it("copies a starter as an example until the host saves it", async () => {
    const made = (await createFromStarter(pool, priya.id, "tutoring"))!;
    expect(made).toMatchObject({ name: "Tutoring (example)", example: true });
    const saved = await updateTemplate(pool, priya.id, made.id, "Tutoring", made.questions);
    expect(saved?.example).toBe(false);
    expect(await createFromStarter(pool, priya.id, "nope")).toBeNull();
    await deleteTemplate(pool, priya.id, made.id);
  });

  it("asks first-booking-only questions once per client email through the booking handler", async () => {
    const own = await store.listCustomQuestions(priya.id, coaching.id);
    const checked = validateQuestions([
      ...own.map((q) => ({ id: q.id, label: q.label, kind: q.kind, required: q.required, choices: q.choices })),
      { id: null, label: "Emergency contact", kind: "short_text", required: true, choices: [], firstBookingOnly: true },
    ]);
    if (!checked.ok) throw new Error("invalid");
    const qs = await store.saveQuestions(priya.id, coaching.id, checked.value);
    const contact = qs[qs.length - 1].id;
    const base = Object.fromEntries(own.map((q) => [q.id, "Plan"]));
    const now = new Date();
    // Times the engine offers right now, from the slots handler's own source.
    const { freeSlots } = await import("../booking");
    const slots = await freeSlots(store, priya, coaching, new Date(now.getTime() + 2 * 86_400_000), new Date(now.getTime() + 30 * 86_400_000), now);
    let n = 0;
    const book = (email: string, answers: Record<string, string>) => handleCreateBooking(store, {
      slug: "priya", event: "coaching", start: slots[n * 8].toISOString(), name: "Client", email, timezone: "Asia/Kolkata", answers, idempotencyKey: `intake-first-${n++}-${now.getTime()}`,
    }, now);
    const email = `first.${now.getTime()}@example.com`;
    expect((await book(email, base)).body).toEqual({ error: "invalid_request", fields: { [`answers.${contact}`]: ANSWER_ERRORS.required } });
    expect((await book(email, { ...base, [contact]: "Asha" })).status).toBe(201);
    const again = await book(email.toUpperCase(), { ...base, [contact]: "ignored" });
    expect(again.status).toBe(201);
    const { manageToken } = again.body as { manageToken: string };
    expect((await store.getBookingByManageToken(manageToken))!.invitee.answers.map((a) => a.label)).not.toContain("Emergency contact");
    await store.saveQuestions(priya.id, coaching.id, own.map((q) => ({ id: q.id, label: q.label, kind: q.kind, required: q.required, choices: q.choices })));
  });
});
