import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./data/memory-store";
import { handleCreateBooking, freeSlots } from "./booking";
import { latestAnswers } from "./client-file";
import { validateQuestions } from "./event-types";
import { checkAnswers, checkConditions, toDraftConditions, visibleQuestionIds, type IntakeQuestion } from "./intake";

const q = (id: string, kind: IntakeQuestion["kind"], extra: Partial<IntakeQuestion> = {}): IntakeQuestion =>
  ({ id, label: `Q ${id}`, kind, required: false, choices: [], showIf: null, ...extra });

// A therapist's intake: first visit? -> if yes, what brings you; consent to share notes -> if ticked, GP's email.
const form = [
  q("first", "single_select", { required: true, choices: ["Yes", "No"] }),
  q("why", "long_text", { required: true, showIf: { questionId: "first", anyOf: ["Yes"] } }),
  q("topics", "multi_select", { choices: ["Sleep", "Stress", "Work"] }),
  q("sleepHours", "short_text", { required: true, showIf: { questionId: "topics", anyOf: ["Sleep"] } }),
  q("share", "consent"),
  q("gp", "short_text", { required: true, showIf: { questionId: "share", anyOf: ["yes"] } }),
  q("why2", "short_text", { required: true, showIf: { questionId: "why", anyOf: ["anything"] } }), // depends on a text question: never shows
];

describe("conditional questions", () => {
  it("show a question only once the one it depends on was answered that way", () => {
    expect([...visibleQuestionIds(form, {})]).toEqual(["first", "topics", "share"]);
    expect(visibleQuestionIds(form, { first: "Yes" }).has("why")).toBe(true);
    expect(visibleQuestionIds(form, { first: "No" }).has("why")).toBe(false);
    expect(visibleQuestionIds(form, { topics: "Work\nSleep" }).has("sleepHours")).toBe(true);
    expect(visibleQuestionIds(form, { share: "yes" }).has("gp")).toBe(true);
  });

  it("hide a whole chain when a question higher up is hidden", () => {
    const chain = [q("a", "single_select", { choices: ["x", "y"] }), q("b", "single_select", { choices: ["x", "y"], showIf: { questionId: "a", anyOf: ["x"] } }),
      q("c", "short_text", { showIf: { questionId: "b", anyOf: ["x"] } })];
    expect(visibleQuestionIds(chain, { a: "x", b: "x" }).has("c")).toBe(true);
    // b's stale answer can't keep c showing once a no longer shows b.
    expect(visibleQuestionIds(chain, { a: "y", b: "x" }).has("c")).toBe(false);
  });

  it("show a question whose condition points at a question that is gone, so a required one can still be answered", () => {
    expect(visibleQuestionIds([q("orphan", "short_text", { showIf: { questionId: "deleted", anyOf: ["x"] } })], {}).has("orphan")).toBe(true);
  });
});

describe("checking a guest's answers", () => {
  it("requires only the questions that show, and drops answers to hidden ones", () => {
    expect(checkAnswers(form, { first: "Yes" })).toEqual({ ok: false, fields: { "answers.why": "This one is required." } });
    const ok = checkAnswers(form, { first: "No", why: "left over from before", gp: "dr@example.com" });
    expect(ok).toEqual({ ok: true, answers: [{ questionId: "first", label: "Q first", answer: "No" }] });
  });

  it("takes only the host's choices, one for a single choice, and joins several", () => {
    expect(checkAnswers(form, { first: "Maybe" })).toMatchObject({ ok: false, fields: { "answers.first": expect.any(String) } });
    expect(checkAnswers(form, { first: "Yes\nNo", why: "x" })).toMatchObject({ ok: false });
    expect(checkAnswers(form, { first: "No", topics: "Stress\nWork\nStress" })).toMatchObject({ ok: true, answers: [{ answer: "No" }, { answer: "Stress, Work" }] });
    expect(checkAnswers(form, { first: "No", topics: "Gardening" })).toMatchObject({ ok: false, fields: { "answers.topics": expect.any(String) } });
  });

  it("records a ticked consent as Yes and refuses a required one left unticked", () => {
    expect(checkAnswers(form, { first: "No", share: "yes", gp: "dr@example.com" })).toMatchObject({ ok: true, answers: [{ answer: "No" }, { questionId: "share", answer: "Yes" }, { questionId: "gp" }] });
    expect(checkAnswers([q("terms", "consent", { required: true })], {})).toEqual({ ok: false, fields: { "answers.terms": "Tick this to go on." } });
    expect(checkAnswers([q("terms", "consent", { required: true })], { terms: "no" })).toMatchObject({ ok: false });
  });

  it("checks a phone answer looks like a phone number", () => {
    expect(checkAnswers([q("ph", "phone")], { ph: "call me" })).toMatchObject({ ok: false });
    expect(checkAnswers([q("ph", "phone")], { ph: "+91 98765 43210" })).toMatchObject({ ok: true });
  });
});

describe("the host's conditions", () => {
  const draft = (kind: IntakeQuestion["kind"], choices: string[] = [], showIf: { parent: number; anyOf: string[] } | null = null) =>
    ({ id: null, label: "x", kind, required: false, choices, showIf });

  it("must depend on an earlier choice or tick-box question, with answers among its options", () => {
    const { errors, showIf } = checkConditions([
      draft("single_select", ["A", "B"]),
      draft("short_text", [], { parent: 0, anyOf: [" A ", "A", "Z"] }), // cleaned to ["A"]
      draft("short_text", [], { parent: 1, anyOf: ["x"] }),             // parent is a text question
      draft("short_text", [], { parent: 4, anyOf: ["A"] }),             // parent comes later
      draft("consent"),
      draft("short_text", [], { parent: 4, anyOf: ["yes"] }),
      draft("short_text", [], { parent: 0, anyOf: ["Z"] }),             // no real answer left
    ]);
    expect(showIf).toEqual([null, { parent: 0, anyOf: ["A"] }, null, null, null, { parent: 4, anyOf: ["yes"] }, null]);
    expect(errors.map(Boolean)).toEqual([false, false, true, true, false, false, true]);
  });

  it("are refused by the event-type check with a message on the question", () => {
    const r = validateQuestions([draft("short_text", [], { parent: 0, anyOf: ["A"] })]);
    expect(r).toMatchObject({ ok: false, errors: [{ showIf: expect.any(String) }] });
  });

  it("round-trip between stored ids and editor positions", () => {
    const stored = [{ id: "p", showIf: null }, { id: "c", showIf: { questionId: "p", anyOf: ["A"] } }, { id: "o", showIf: { questionId: "gone", anyOf: ["A"] } }];
    expect(toDraftConditions(stored)).toEqual([null, { parent: 0, anyOf: ["A"] }, null]);
  });
});

describe("booking with conditional questions (memory store)", () => {
  it("saves conditions by position, enforces them at booking, and stores only the answers that applied", async () => {
    const store = createMemoryStore();
    const host = await store.getCurrentUser();
    const et = (await store.listEventTypes(host.id)).find((e) => e.slug === "intro")!;
    const saved = await store.saveQuestions(host.id, et.id, [
      { id: null, label: "First session?", kind: "single_select", required: true, choices: ["Yes", "No"], showIf: null },
      { id: null, label: "What brings you here?", kind: "long_text", required: true, choices: [], showIf: { parent: 0, anyOf: ["Yes"] } },
    ]);
    expect(saved[1].showIf).toEqual({ questionId: saved[0].id, anyOf: ["Yes"] });
    expect((await store.listCustomQuestions(host.id, et.id))[1].showIf).toEqual({ questionId: saved[0].id, anyOf: ["Yes"] });

    const now = new Date();
    const [slot] = await freeSlots(store, host, et, new Date(now.getTime() + 2 * 86_400_000), new Date(now.getTime() + 9 * 86_400_000), now);
    const book = (answers: Record<string, string>, key: string) => handleCreateBooking(store, {
      slug: host.slug, event: et.slug, start: slot.toISOString(), name: "Asha", email: "asha@example.com", timezone: "Asia/Kolkata", idempotencyKey: key, answers,
    }, now);
    expect(await book({ [saved[0].id]: "Yes" }, "intake-key-1")).toMatchObject({ status: 400, body: { fields: { [`answers.${saved[1].id}`]: expect.any(String) } } });
    const ok = await book({ [saved[0].id]: "No", [saved[1].id]: "typed before switching to No" }, "intake-key-2");
    expect(ok.status).toBe(201);
    const booking = (await store.listBookings(host.id)).find((b) => b.idempotencyKey === "intake-key-2")!;
    expect(booking.invitee.answers).toEqual([{ questionId: saved[0].id, label: "First session?", answer: "No" }]);
  });
});

describe("the client file's answers", () => {
  const b = (id: string, created: string, answers: [string, string][], extra = {}) => ({
    id, startAt: new Date(created), createdAt: new Date(created), status: "confirmed" as const, cancelledBy: null,
    invitee: { answers: answers.map(([label, answer]) => ({ questionId: label, label, answer })) }, ...extra,
  }) as unknown as Parameters<typeof latestAnswers>[0][number];

  it("keep the latest answer to each question, by its wording, skipping blanks and lapsed payment holds", () => {
    const answers = latestAnswers([
      b("old", "2026-01-01T00:00:00Z", [["Goal", "Sleep better"], ["Medication", "None"]]),
      b("new", "2026-03-01T00:00:00Z", [["goal ", "Run a 10k"], ["Medication", " "]]),
      b("lapsed", "2026-04-01T00:00:00Z", [["Goal", "never booked"]], { status: "cancelled", cancelledBy: "system" }),
    ]);
    expect(answers.map(({ label, answer, bookingId }) => ({ label, answer, bookingId }))).toEqual([
      { label: "goal ", answer: "Run a 10k", bookingId: "new" },
      { label: "Medication", answer: "None", bookingId: "old" },
    ]);
  });
});
