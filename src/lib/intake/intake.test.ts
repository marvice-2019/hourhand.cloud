import { describe, expect, it } from "vitest";
import { handleCreateBooking, handleGetSlots } from "../booking";
import { createMemoryStore } from "../data/memory-store";
import { buildSeed } from "../data/seed";
import type { CustomQuestion, QuestionDraft } from "../data/types";
import { validateQuestions } from "../event-types";
import { CATALOGS, LOCALES } from "../i18n/guest";
import { ANSWER_ERRORS, isFirstBooking, isIsoDate, resolveAnswers } from "./answers";
import { askedQuestionIds, isAsked, toIntakeQuestion } from "./conditions";
import { CONDITION_ERRORS, RANGE_ERROR } from "./questions";
import { looksHealthRelated } from "./sensitive";
import { STARTERS } from "./starters";
import { checkTemplate } from "./templates";
import { applyTemplateToDrafts, fromTemplate, toDrafts, toTemplateQuestions, type TemplateQuestion } from "./templates-shape";

const q = (id: string, kind: CustomQuestion["kind"], extra: Partial<CustomQuestion> = {}, position = 0): CustomQuestion =>
  ({ id, eventTypeId: "evt", label: `Label ${id}`, kind, required: false, choices: [], position, ...extra });

/** A therapy-style form: "Had therapy before?" yes -> "What worked?"; a first-booking-only emergency contact. */
const therapy = (): CustomQuestion[] => [
  q("before", "yes_no", { required: true }, 0),
  q("worked", "long_text", { required: true, showIf: { questionId: "before", values: ["yes"] } }, 1),
  q("topics", "multi_select", { choices: ["Sleep", "Stress", "Work"] }, 2),
  q("sleep", "short_text", { showIf: { questionId: "topics", values: ["Sleep"] } }, 3),
  q("contact", "short_text", { required: true, firstBookingOnly: true }, 4),
];

describe("conditions", () => {
  const qs = therapy().map(toIntakeQuestion);
  const byId = new Map(qs.map((x) => [x.id, x]));

  it("shows a follow-up only when the earlier answer matches", () => {
    expect(isAsked(byId.get("worked")!, byId, { before: "yes" }, null)).toBe(true);
    expect(isAsked(byId.get("worked")!, byId, { before: "no" }, null)).toBe(false);
    expect(isAsked(byId.get("worked")!, byId, {}, null)).toBe(false);
  });

  it("matches any ticked choice of a multi-select", () => {
    expect(isAsked(byId.get("sleep")!, byId, { topics: ["Work", "Sleep"] }, null)).toBe(true);
    expect(isAsked(byId.get("sleep")!, byId, { topics: ["Work"] }, null)).toBe(false);
  });

  it("hides first-booking-only questions for a returning client, and shows them while that is unknown", () => {
    expect(askedQuestionIds(qs, {}, false).has("contact")).toBe(false);
    expect(askedQuestionIds(qs, {}, true).has("contact")).toBe(true);
    expect(askedQuestionIds(qs, {}, null).has("contact")).toBe(true);
  });

  it("allows one level only: a question depending on a conditional one, or on a missing one, is never asked", () => {
    const chain = [q("a", "yes_no"), q("b", "yes_no", { showIf: { questionId: "a", values: ["yes"] } }), q("c", "short_text", { showIf: { questionId: "b", values: ["yes"] } })].map(toIntakeQuestion);
    const m = new Map(chain.map((x) => [x.id, x]));
    expect(isAsked(m.get("c")!, m, { a: "yes", b: "yes" }, null)).toBe(false);
    const orphan = toIntakeQuestion(q("d", "short_text", { showIf: { questionId: "gone", values: ["x"] } }));
    expect(isAsked(orphan, new Map([["d", orphan]]), {}, null)).toBe(false);
  });

  it("hides a follow-up of a first-booking-only question for a returning client, whatever was sent", () => {
    const list = [q("p", "yes_no", { firstBookingOnly: true }), q("c", "short_text", { showIf: { questionId: "p", values: ["yes"] } })].map(toIntakeQuestion);
    expect([...askedQuestionIds(list, { p: "yes" }, false)]).toEqual([]);
  });
});

describe("resolveAnswers", () => {
  it("drops answers to hidden questions and never requires them", () => {
    const r = resolveAnswers(therapy(), { before: "no", worked: "crafted answer", topics: ["Work"], sleep: "crafted", contact: "Asha 98450 00000" }, { firstBooking: true });
    expect(r).toEqual({ ok: true, answers: [
      { questionId: "before", label: "Label before", answer: "No" },
      { questionId: "topics", label: "Label topics", answer: "Work" },
      { questionId: "contact", label: "Label contact", answer: "Asha 98450 00000" },
    ] });
  });

  it("requires a visible required follow-up", () => {
    expect(resolveAnswers(therapy(), { before: "yes", contact: "x" }, { firstBooking: true })).toEqual({ ok: false, fields: { "answers.worked": ANSWER_ERRORS.required } });
  });

  it("requires first-booking-only questions on a first booking, and drops them for a returning client", () => {
    expect(resolveAnswers(therapy(), { before: "no" }, { firstBooking: true })).toEqual({ ok: false, fields: { "answers.contact": ANSWER_ERRORS.required } });
    expect(resolveAnswers(therapy(), { before: "no", contact: "sent anyway" }, { firstBooking: false })).toEqual({ ok: true, answers: [{ questionId: "before", label: "Label before", answer: "No" }] });
    // While unknown, a left-out first-booking-only answer isn't an error yet; a badly formed one still is.
    expect(resolveAnswers(therapy(), { before: "no" }, { firstBooking: null }).ok).toBe(true);
  });

  it("checks yes/no, dates, number bounds, emails and ticked choices", () => {
    const qs = [
      q("yn", "yes_no", {}, 0), q("dob", "date", {}, 1), q("marks", "number", { minValue: 0, maxValue: 100 }, 2),
      q("age", "number", { minValue: 18 }, 3), q("mail", "email", {}, 4), q("pick", "multi_select", { choices: ["A", "B"] }, 5),
    ];
    expect(resolveAnswers(qs, { yn: "maybe", dob: "2026-02-30", marks: "101", age: "17", mail: "not-an-email", pick: ["A", "Z"] }, { firstBooking: true })).toEqual({ ok: false, fields: {
      "answers.yn": ANSWER_ERRORS.yesNo, "answers.dob": ANSWER_ERRORS.date, "answers.marks": "Enter a number from 0 to 100.",
      "answers.age": "Enter 18 or more.", "answers.mail": ANSWER_ERRORS.email, "answers.pick": ANSWER_ERRORS.choice,
    } });
    expect(resolveAnswers(qs, { yn: "yes", dob: "2008-02-29", marks: "87.5", age: "18", mail: "parent@example.com", pick: ["B", "A", "B"] }, { firstBooking: true })).toEqual({ ok: true, answers: [
      { questionId: "yn", label: "Label yn", answer: "Yes" }, { questionId: "dob", label: "Label dob", answer: "2008-02-29" },
      { questionId: "marks", label: "Label marks", answer: "87.5" }, { questionId: "age", label: "Label age", answer: "18" },
      { questionId: "mail", label: "Label mail", answer: "parent@example.com" }, { questionId: "pick", label: "Label pick", answer: "B, A" },
    ] });
    expect(resolveAnswers(qs, { marks: "1e2" }, { firstBooking: true })).toMatchObject({ ok: false, fields: { "answers.marks": "Enter a number from 0 to 100." } });
    expect(resolveAnswers(qs, { dob: "28/02/2026" }, { firstBooking: true }).ok).toBe(false);
    expect(resolveAnswers([q("t", "short_text")], { t: ["a", "list"] }, { firstBooking: true })).toEqual({ ok: false, fields: { "answers.t": ANSWER_ERRORS.text } });
  });

  it("knows real calendar dates", () => {
    expect(["2024-02-29", "1900-01-01", "2100-12-31"].every(isIsoDate)).toBe(true);
    expect(["2023-02-29", "1899-12-31", "2026-13-01", "2026-1-01", ""].some(isIsoDate)).toBe(false);
  });

  it("treats existing questions exactly as before: any text, required means non-empty, label copied, in order", () => {
    const legacy = [
      q("goal", "long_text", { required: true }, 0), q("co", "short_text", {}, 1), q("src", "single_select", { required: true, choices: ["Friend", "LinkedIn"] }, 2),
      q("ph", "phone", {}, 3), q("ok", "consent", { required: true }, 4), q("multi", "multi_select", { choices: ["A", "B"] }, 5),
    ];
    // What the booking handler did before intake forms, for comparison.
    const before = (answers: Record<string, string>) => {
      const missing = legacy.filter((x) => x.required && !answers[x.id]);
      if (missing.length > 0) return { ok: false, fields: Object.fromEntries(missing.map((x) => [`answers.${x.id}`, "This one is required."])) };
      return { ok: true, answers: legacy.filter((x) => answers[x.id]).map((x) => ({ questionId: x.id, label: x.label, answer: answers[x.id] })) };
    };
    const cases: Record<string, string>[] = [
      { goal: "Plan", src: "Not a listed choice", ok: "anything", ph: "call me", multi: "free text as before" },
      { goal: "Plan", src: "Friend", ok: "yes" },
      { goal: "", src: "", ok: "" },
      { co: "Acme" },
    ];
    for (const c of cases) expect(resolveAnswers(legacy, c, { firstBooking: true })).toEqual(before(c));
  });

  it("counts a client as returning only with a booking that isn't cancelled, under any letter case", () => {
    const b = (email: string, status = "confirmed", key = "k1") => ({ email, status, idempotencyKey: key, invitee: { email } });
    expect(isFirstBooking([b("Meera@Example.com")], "meera@example.com", "new")).toBe(false);
    expect(isFirstBooking([b("meera@example.com", "cancelled")], "meera@example.com", "new")).toBe(true);
    expect(isFirstBooking([b("meera@example.com", "confirmed", "same")], "meera@example.com", "same")).toBe(true);
    expect(isFirstBooking([b("asha@example.com")], "meera@example.com", "new")).toBe(true);
  });
});

describe("validateQuestions with intake fields", () => {
  const d = (label: string, kind: QuestionDraft["kind"], extra: Partial<QuestionDraft> = {}): QuestionDraft => ({ id: null, label, kind, required: false, choices: [], ...extra });

  it("keeps a plain question in exactly its old shape", () => {
    expect(validateQuestions([d("Company", "short_text")])).toEqual({ ok: true, value: [{ id: null, label: "Company", kind: "short_text", required: false, choices: [] }] });
  });

  it("accepts a condition on an earlier yes/no or choice question, with values it can take", () => {
    const r = validateQuestions([d("Before?", "yes_no"), d("What worked?", "long_text", { showIf: { questionIndex: 0, values: ["yes"] }, firstBookingOnly: true })]);
    expect(r).toMatchObject({ ok: true, value: [{}, { showIf: { questionIndex: 0, values: ["yes"] }, firstBookingOnly: true }] });
  });

  it("refuses a condition on a later, unsuitable or conditional question, or with values it can't take", () => {
    const r = validateQuestions([
      d("Name", "short_text"),
      d("Pick", "single_select", { choices: ["A", "B"] }),
      d("On text", "short_text", { showIf: { questionIndex: 0, values: ["x"] } }),
      d("On later", "short_text", { showIf: { questionIndex: 5, values: ["yes"] } }),
      d("Bad value", "short_text", { showIf: { questionIndex: 1, values: ["C"] } }),
      d("No values", "short_text", { showIf: { questionIndex: 1, values: [] } }),
      d("Child", "yes_no", { showIf: { questionIndex: 1, values: ["A"] } }),
      d("Grandchild", "short_text", { showIf: { questionIndex: 6, values: ["yes"] } }),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.condition)).toEqual([
      undefined, undefined, CONDITION_ERRORS.parent, CONDITION_ERRORS.parent, CONDITION_ERRORS.values, CONDITION_ERRORS.values, undefined, CONDITION_ERRORS.chain,
    ]);
  });

  it("checks number bounds and drops them from other kinds", () => {
    expect(validateQuestions([d("Marks", "number", { minValue: 100, maxValue: 0 })])).toEqual({ ok: false, errors: [{ range: RANGE_ERROR }] });
    expect(validateQuestions([d("Marks", "number", { minValue: 0, maxValue: 100 })])).toMatchObject({ ok: true, value: [{ minValue: 0, maxValue: 100 }] });
    const text = validateQuestions([d("Note", "short_text", { minValue: 1 })]);
    expect(text.ok && text.value[0]).not.toHaveProperty("minValue");
  });
});

describe("templates", () => {
  const tpl: TemplateQuestion[] = [
    { label: "Seen a therapist before?", kind: "yes_no", required: true, choices: [] },
    { label: "What worked?", kind: "long_text", required: false, choices: [], showIf: { questionIndex: 0, values: ["yes"] } },
  ];

  it("adds a template's questions after the event type's own, moving conditions along", () => {
    const own: QuestionDraft[] = [{ id: "q1", label: "Goal", kind: "long_text", required: true, choices: [] }];
    const merged = applyTemplateToDrafts(own, tpl, "tpl-1");
    expect(merged.map((x) => [x.label, x.templateId ?? null, x.showIf?.questionIndex ?? null])).toEqual([
      ["Goal", null, null], ["Seen a therapist before?", "tpl-1", null], ["What worked?", "tpl-1", 1],
    ]);
    expect(validateQuestions(merged).ok).toBe(true);
  });

  it("replaces its earlier copies in place when applied again, and keeps a question that depended on one", () => {
    const first = applyTemplateToDrafts([{ id: "q1", label: "Goal", kind: "long_text", required: true, choices: [] }], tpl, "tpl-1");
    const withFollowUp: QuestionDraft[] = [...first.map((x, i) => ({ ...x, id: `id${i}` })), { id: "own", label: "Anything else?", kind: "short_text", required: false, choices: [], showIf: { questionIndex: 1, values: ["no"] } }];
    const edited: TemplateQuestion[] = [{ ...tpl[0], label: "Seen a therapist before?" }, { ...tpl[1], label: "What helped, and what didn't?" }];
    const again = applyTemplateToDrafts(withFollowUp, edited, "tpl-1");
    expect(again.map((x) => [x.label, x.showIf?.questionIndex ?? null])).toEqual([
      ["Goal", null], ["Seen a therapist before?", null], ["What helped, and what didn't?", 1], ["Anything else?", 1],
    ]);
    expect(validateQuestions(again).ok).toBe(true);
  });

  it("round-trips stored questions through drafts and template questions", () => {
    const stored = therapy().map((x, i) => ({ ...x, position: i }));
    const drafts = toDrafts(stored);
    expect(drafts[1].showIf).toEqual({ questionIndex: 0, values: ["yes"] });
    expect(toTemplateQuestions(drafts).every((x) => !("id" in x) && !("templateId" in x))).toBe(true);
    expect(fromTemplate(toTemplateQuestions(drafts), 3, null)[1].showIf).toEqual({ questionIndex: 3, values: ["yes"] });
  });

  it("ships starter examples that pass the same checks as the host's own questions", () => {
    expect(STARTERS.map((s) => s.key)).toEqual(["therapy", "coaching", "tutoring"]);
    for (const s of STARTERS) expect(checkTemplate(s.name, fromTemplate(s.questions, 0, null)), s.key).toMatchObject({ ok: true });
    expect(STARTERS.find((s) => s.key === "therapy")!.questions.some((x) => looksHealthRelated(x.label))).toBe(true);
    expect(STARTERS.find((s) => s.key === "tutoring")!.questions.some((x) => looksHealthRelated(x.label))).toBe(false);
  });

  it("refuses a template without a name or questions", () => {
    expect(checkTemplate(" ", [])).toMatchObject({ ok: false, nameError: "name", formError: "empty" });
  });
});

describe("guest words for intake", () => {
  it("has every new key in every language (parity itself is checked in guest.test.ts)", () => {
    const keys = ["answerYes", "answerNo", "chooseOne", "firstBookingHint", "errRequired", "errChoice", "errDate", "errNumber", "errNumberRange", "errNumberMin", "errNumberMax", "errYesNo"];
    for (const locale of LOCALES) for (const k of keys) expect((CATALOGS[locale] as Record<string, string>)[k], `${locale}.${k}`).toBeTruthy();
  });
});

describe("booking with intake questions (memory store)", () => {
  const now = new Date("2026-10-10T04:00:00Z");
  const DAY = 86_400_000;

  async function setup() {
    const store = createMemoryStore(buildSeed(now));
    const saved = validateQuestions([
      { id: "q_goal", label: "What would you like to work on?", kind: "long_text", required: true, choices: [] },
      { id: null, label: "Had therapy before?", kind: "yes_no", required: true, choices: [] },
      { id: null, label: "What worked, or didn't?", kind: "long_text", required: true, choices: [], showIf: { questionIndex: 1, values: ["yes"] } },
      { id: null, label: "Emergency contact", kind: "short_text", required: true, choices: [], firstBookingOnly: true },
    ]);
    if (!saved.ok) throw new Error("invalid setup");
    const qs = await store.saveQuestions("usr_priya", "evt_coaching", saved.value);
    const params = new URLSearchParams({ slug: "priya", event: "coaching", from: now.toISOString(), to: new Date(now.getTime() + 14 * DAY).toISOString() });
    const slots = ((await handleGetSlots(store, params, now)).body as { slots: string[] }).slots;
    const [goal, before, worked, contact] = qs.map((x) => x.id);
    let n = 0;
    const book = (email: string, answers: Record<string, string | string[]>, start = slots[n * 8]) =>
      handleCreateBooking(store, { slug: "priya", event: "coaching", start, name: "Client", email, timezone: "Asia/Kolkata", answers, idempotencyKey: `intake-key-${n++}` }, now);
    const answersOf = async (manageToken: string) => (await store.getBookingByManageToken(manageToken))!.invitee.answers.map((a) => [a.label, a.answer]);
    return { store, slots, book, answersOf, ids: { goal, before, worked, contact } };
  }

  it("drops a crafted answer to a hidden question and books", async () => {
    const { book, answersOf, ids } = await setup();
    const res = await book("first.client@example.com", { [ids.goal]: "Sleep", [ids.before]: "no", [ids.worked]: "crafted", [ids.contact]: "Asha" });
    expect(res.status).toBe(201);
    expect(await answersOf((res.body as { manageToken: string }).manageToken)).toEqual([
      ["What would you like to work on?", "Sleep"], ["Had therapy before?", "No"], ["Emergency contact", "Asha"],
    ]);
  });

  it("refuses a crafted request that skips a required question the answers make visible", async () => {
    const { book, ids } = await setup();
    const res = await book("first.client@example.com", { [ids.goal]: "Sleep", [ids.before]: "yes", [ids.contact]: "Asha" });
    expect(res).toEqual({ status: 400, body: { error: "invalid_request", fields: { [`answers.${ids.worked}`]: ANSWER_ERRORS.required } } });
  });

  it("asks first-booking-only questions once per client email, in any letter case", async () => {
    const { book, answersOf, ids } = await setup();
    expect((await book("new.client@example.com", { [ids.goal]: "Sleep", [ids.before]: "no" })).body).toEqual({ error: "invalid_request", fields: { [`answers.${ids.contact}`]: ANSWER_ERRORS.required } });
    expect((await book("new.client@example.com", { [ids.goal]: "Sleep", [ids.before]: "no", [ids.contact]: "Asha" })).status).toBe(201);
    const second = await book("New.Client@Example.com", { [ids.goal]: "Follow-up", [ids.before]: "no", [ids.contact]: "sent again" });
    expect(second.status).toBe(201);
    expect(await answersOf((second.body as { manageToken: string }).manageToken)).toEqual([["What would you like to work on?", "Follow-up"], ["Had therapy before?", "No"]]);
    expect((await book("someone.else@example.com", { [ids.goal]: "Sleep", [ids.before]: "no" })).status).toBe(400);
  });

  it("checks a left-out first-booking answer only after the slot check, so a bad time says nothing about the email", async () => {
    const { book, ids } = await setup();
    const res = await book("probe@example.com", { [ids.goal]: "Sleep", [ids.before]: "no" }, "2026-10-10T04:07:00.000Z");
    expect(res.status).toBe(409);
  });

  it("logs consent only for tick boxes the guest was actually shown", async () => {
    const store = createMemoryStore(buildSeed(now));
    const saved = validateQuestions([
      { id: "q_goal", label: "What would you like to work on?", kind: "long_text", required: true, choices: [] },
      { id: null, label: "Had therapy before?", kind: "yes_no", required: true, choices: [] },
      { id: null, label: "I agree my previous therapist may be contacted", kind: "consent", required: false, choices: [], showIf: { questionIndex: 1, values: ["yes"] } },
      { id: null, label: "I understand this isn't an emergency service", kind: "consent", required: false, choices: [], firstBookingOnly: true },
    ]);
    if (!saved.ok) throw new Error("invalid setup");
    const qs = await store.saveQuestions("usr_priya", "evt_coaching", saved.value);
    const seen: { invitee: { consent?: { statement: string; granted: boolean }[] } }[] = [];
    const create = store.createBooking.bind(store);
    store.createBooking = (input) => { seen.push(input as (typeof seen)[number]); return create(input); };
    const params = new URLSearchParams({ slug: "priya", event: "coaching", from: now.toISOString(), to: new Date(now.getTime() + 14 * DAY).toISOString() });
    const slots = ((await handleGetSlots(store, params, now)).body as { slots: string[] }).slots;
    const book = (start: string, key: string, answers: Record<string, string>) =>
      handleCreateBooking(store, { slug: "priya", event: "coaching", start, name: "C", email: "consent.client@example.com", timezone: "Asia/Kolkata", answers, idempotencyKey: key }, now);
    const hostLines = () => (seen.at(-1)!.invitee.consent ?? []).filter((l) => l.statement !== "" && qs.some((q) => q.label === l.statement)).map((l) => [l.statement, l.granted]);

    // First booking, answered "no": the conditional tick box is hidden, so it isn't logged as declined.
    expect((await book(slots[0], "consent-key-1", { [qs[0].id]: "Sleep", [qs[1].id]: "no", [qs[2].id]: "Yes", [qs[3].id]: "Yes" })).status).toBe(201);
    expect(hostLines()).toEqual([["I understand this isn't an emergency service", true]]);
    // A returning client isn't shown the first-booking tick box either.
    expect((await book(slots[8], "consent-key-2", { [qs[0].id]: "Again", [qs[1].id]: "yes", [qs[2].id]: "Yes" })).status).toBe(201);
    expect(hostLines()).toEqual([["I agree my previous therapist may be contacted", true]]);
  });

  it("still refuses a badly formed answer up front", async () => {
    const { book, ids } = await setup();
    expect((await book("probe@example.com", { [ids.goal]: "Sleep", [ids.before]: "perhaps" }, "2026-10-10T04:07:00.000Z")).status).toBe(400);
  });
});
