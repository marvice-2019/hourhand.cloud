// Which intake questions a guest is asked. Pure and browser-safe: the booking form uses it to show and hide questions as
// the guest answers, and the server uses the same rules (src/lib/intake/answers.ts) to drop hidden answers and to decide
// what is required. The browser only hides and shows; the server decides.
import type { CustomQuestion, QuestionCondition } from "../data/types";

export type QuestionKind = CustomQuestion["kind"];

/** Every kind, in the order the editor offers them. */
export const QUESTION_KINDS: readonly QuestionKind[] = [
  "short_text", "long_text", "single_select", "multi_select", "yes_no", "date", "number", "email", "phone", "consent",
];

/** Kinds whose answer can decide whether a later question is asked. */
export const CONDITION_KINDS: readonly QuestionKind[] = ["single_select", "multi_select", "yes_no"];

/** The values a yes/no answer is sent as. Stored for the host as "Yes" and "No". */
export const YES_NO = ["yes", "no"] as const;

/** What the booking form needs to know about a question. */
export interface IntakeQuestion {
  id: string;
  label: string;
  kind: QuestionKind;
  required: boolean;
  choices: string[];
  showIf: QuestionCondition | null;
  firstBookingOnly: boolean;
  minValue: number | null;
  maxValue: number | null;
}

/** A raw answer as sent: text, or the ticked choices of a multi-select. */
export type RawAnswer = string | string[];
export type RawAnswers = Record<string, RawAnswer | undefined>;

/** The stored question in the shape the form and the rules use, with absent fields given their defaults. */
export function toIntakeQuestion(q: Pick<CustomQuestion, "id" | "label" | "kind" | "required" | "choices"> & Partial<CustomQuestion>): IntakeQuestion {
  return {
    id: q.id, label: q.label, kind: q.kind, required: q.required, choices: [...(q.choices ?? [])],
    showIf: q.showIf && q.showIf.values.length > 0 ? { questionId: q.showIf.questionId, values: [...q.showIf.values] } : null,
    firstBookingOnly: q.firstBookingOnly === true, minValue: q.minValue ?? null, maxValue: q.maxValue ?? null,
  };
}

/** The values a condition can match for a question of this kind: its choices, or yes and no. */
export function conditionOptions(q: Pick<CustomQuestion, "kind" | "choices">): string[] {
  if (q.kind === "yes_no") return [...YES_NO];
  if (q.kind === "single_select" || q.kind === "multi_select") return q.choices;
  return [];
}

/** The answer as a list of picked values (one for most kinds, any number for a multi-select). Blank is no answer. */
export function pickedValues(raw: RawAnswer | undefined): string[] {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

/**
 * Whether a question is asked. `firstBooking` is true for a client's first booking with this host, false for a
 * returning client, and null while that isn't known (the browser never knows): first-booking-only questions then show.
 * One level only: a condition looks at an earlier question, which is itself shown only if it has no condition of its own
 * (validateQuestions refuses a chain). A hidden question's answer never counts, so a child of a hidden question is hidden.
 */
export function isAsked(q: IntakeQuestion, byId: ReadonlyMap<string, IntakeQuestion>, answers: RawAnswers, firstBooking: boolean | null): boolean {
  if (q.firstBookingOnly && firstBooking === false) return false;
  if (!q.showIf) return true;
  const parent = byId.get(q.showIf.questionId);
  // A condition on a question that no longer exists, or one that is itself conditional, hides the question: the safe
  // side for intake (never ask something the host meant only for some clients).
  if (!parent || parent.showIf) return false;
  if (parent.firstBookingOnly && firstBooking === false) return false;
  const picked = pickedValues(answers[parent.id]);
  return picked.some((v) => q.showIf!.values.includes(v));
}

/** The ids of the questions asked, given the answers so far. */
export function askedQuestionIds(questions: readonly IntakeQuestion[], answers: RawAnswers, firstBooking: boolean | null): Set<string> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return new Set(questions.filter((q) => isAsked(q, byId, answers, firstBooking)).map((q) => q.id));
}
