import type { CustomQuestion, InviteeAnswer, QuestionDraft } from "./data/types";

// Intake forms: the questions a host asks on an event type, answered by the guest when they book. Shared by the booking
// page (which shows and hides questions as the guest answers) and the server (which checks the same rules again), so
// the two can never disagree about which questions applied.

/** What a guest's answer to a question looks like on the wire: one string; a multi-select's picks are joined by MULTI_SEP. */
export const MULTI_SEP = "\n";
/** A ticked consent question. */
export const CONSENT_YES = "yes";

export type IntakeQuestion = Pick<CustomQuestion, "id" | "label" | "kind" | "required" | "choices" | "showIf">;

/** Questions whose answers can decide whether a later question shows. */
export const canBeParent = (kind: CustomQuestion["kind"]) => kind === "single_select" || kind === "multi_select" || kind === "consent";

/** The answers a parent question can have, for "show only if it was …". */
export const parentOptions = (q: Pick<CustomQuestion, "kind" | "choices">): string[] => (q.kind === "consent" ? [CONSENT_YES] : q.choices);

/** A raw answer as the picks it stands for: a multi-select's list, or the one value. Empty answers pick nothing. */
export function picks(q: Pick<CustomQuestion, "kind">, raw: string | undefined): string[] {
  const v = (raw ?? "").trim();
  if (!v) return [];
  return q.kind === "multi_select" ? v.split(MULTI_SEP).map((s) => s.trim()).filter(Boolean) : [v];
}

/**
 * Which questions apply, given the answers so far. A question shows when it has no condition, or when the question it
 * depends on is itself showing and was answered with one of the listed answers. A condition pointing at a question that
 * no longer exists is ignored (the question shows), so a guest is never left unable to answer something required.
 */
export function visibleQuestionIds(questions: IntakeQuestion[], answers: Record<string, string>): Set<string> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const visible = new Set<string>();
  for (const q of questions) {
    const cond = q.showIf;
    const parent = cond ? byId.get(cond.questionId) : undefined;
    if (!cond || !parent) { visible.add(q.id); continue; }
    if (!visible.has(parent.id)) continue; // questions are in order, so a parent's visibility is already known
    if (picks(parent, answers[parent.id]).some((p) => cond.anyOf.includes(p))) visible.add(q.id);
  }
  return visible;
}

const PHONE = /^\+?[0-9 ()-]{7,20}$/;

/**
 * The guest's answers checked against the host's questions: required ones that show must be answered, choices must be
 * among the host's choices, a consent question is ticked or not. Answers to questions that don't show are dropped, so a
 * hidden question's leftover answer is never stored. Field errors are keyed `answers.<question id>`.
 */
export function checkAnswers(questions: IntakeQuestion[], raw: Record<string, string>):
  { ok: true; answers: InviteeAnswer[] } | { ok: false; fields: Record<string, string> } {
  const visible = visibleQuestionIds(questions, raw);
  const fields: Record<string, string> = {};
  const answers: InviteeAnswer[] = [];
  for (const q of questions) {
    if (!visible.has(q.id)) continue;
    const chosen = picks(q, raw[q.id]);
    const key = `answers.${q.id}`;
    if (chosen.length === 0) {
      if (q.required) fields[key] = q.kind === "consent" ? "Tick this to go on." : "This one is required.";
      continue;
    }
    if (q.kind === "single_select" || q.kind === "multi_select") {
      if (chosen.some((c) => !q.choices.includes(c)) || (q.kind === "single_select" && chosen.length > 1)) { fields[key] = "Pick from the choices given."; continue; }
      answers.push({ questionId: q.id, label: q.label, answer: [...new Set(chosen)].join(", ") });
    } else if (q.kind === "consent") {
      if (chosen[0] !== CONSENT_YES) { fields[key] = "Tick this to go on."; continue; }
      answers.push({ questionId: q.id, label: q.label, answer: "Yes" });
    } else if (q.kind === "phone") {
      if (!PHONE.test(chosen[0])) { fields[key] = "Enter a phone number with country code, like +91 98765 43210."; continue; }
      answers.push({ questionId: q.id, label: q.label, answer: chosen[0] });
    } else {
      answers.push({ questionId: q.id, label: q.label, answer: chosen[0] });
    }
  }
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, answers };
}

/**
 * The host's conditions as typed in the editor, checked: the question depended on must come earlier in the list and be a
 * choice or consent question, and the answers listed must be among its options. Returns an error per question (or
 * undefined), lined up with the list; the conditions themselves are cleaned (trimmed, deduplicated, unknown answers out).
 */
export function checkConditions(questions: readonly Pick<QuestionDraft, "kind" | "choices" | "showIf">[]): { errors: (string | undefined)[]; showIf: (QuestionDraft["showIf"])[] } {
  const errors: (string | undefined)[] = [];
  const showIf: QuestionDraft["showIf"][] = [];
  questions.forEach((q, i) => {
    const c = q.showIf ?? null;
    if (!c) { errors.push(undefined); showIf.push(null); return; }
    const parent = Number.isInteger(c.parent) && c.parent >= 0 && c.parent < i ? questions[c.parent] : undefined;
    if (!parent || !canBeParent(parent.kind)) { errors.push("A question can only depend on an earlier choice or tick-box question."); showIf.push(null); return; }
    const options = parentOptions({ kind: parent.kind, choices: parent.choices.map((x) => x.trim()).filter(Boolean) });
    const anyOf = [...new Set(c.anyOf.map((a) => a.trim()))].filter((a) => options.includes(a));
    if (anyOf.length === 0) { errors.push("Pick at least one answer that shows this question."); showIf.push(null); return; }
    errors.push(undefined);
    showIf.push({ parent: c.parent, anyOf });
  });
  return { errors, showIf };
}

/** Stored conditions (by question id) as editor drafts (by position). A condition on a question no longer in the list is dropped. */
export function toDraftConditions(questions: Pick<CustomQuestion, "id" | "showIf">[]): QuestionDraft["showIf"][] {
  const index = new Map(questions.map((q, i) => [q.id, i]));
  return questions.map((q, i) => {
    const parent = q.showIf ? index.get(q.showIf.questionId) : undefined;
    return q.showIf && parent !== undefined && parent < i ? { parent, anyOf: [...q.showIf.anyOf] } : null;
  });
}
