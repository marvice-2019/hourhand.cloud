// Server-side check of a guest's intake answers. Whatever the browser showed, only questions that are asked (see
// conditions.ts) are kept and can be required; answers to hidden questions are dropped, and each kept answer is checked
// for its kind. Kinds that existed before intake forms are checked exactly as before (any text up to 2000 characters).
import type { CustomQuestion, InviteeAnswer } from "../data/types";
import { askedQuestionIds, pickedValues, toIntakeQuestion, type IntakeQuestion, type RawAnswers } from "./conditions";

export const ANSWER_MAX = 2000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^-?\d{1,12}(\.\d{1,4})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const ANSWER_ERRORS = {
  required: "This one is required.",
  text: "Answer this one with text.",
  choice: "Pick from the choices given.",
  yesNo: "Answer yes or no.",
  date: "Enter a date as YYYY-MM-DD.",
  number: "Enter a number.",
  email: "Enter a valid email address.",
} as const;

export type AnswerResult = { ok: true; answers: InviteeAnswer[] } | { ok: false; fields: Record<string, string> };

/** A real calendar date between 1900 and 2100, as YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The range message for a number question, or the plain one when it has no bounds. */
export function numberError(q: Pick<IntakeQuestion, "minValue" | "maxValue">): string {
  if (q.minValue !== null && q.maxValue !== null) return `Enter a number from ${q.minValue} to ${q.maxValue}.`;
  if (q.minValue !== null) return `Enter ${q.minValue} or more.`;
  if (q.maxValue !== null) return `Enter ${q.maxValue} or less.`;
  return ANSWER_ERRORS.number;
}

/** The stored text for one asked, answered question, or the reason it isn't acceptable. */
function checkAnswer(q: IntakeQuestion, raw: string | string[]): { answer: string } | { error: string } {
  if (q.kind === "multi_select") {
    // Ticked boxes arrive as a list, each one of the choices. A single text answer is kept as before intake forms.
    if (!Array.isArray(raw)) return { answer: raw.trim() };
    const picked = [...new Set(pickedValues(raw))];
    if (picked.some((v) => !q.choices.includes(v))) return { error: ANSWER_ERRORS.choice };
    return { answer: picked.join(", ") };
  }
  if (Array.isArray(raw)) return { error: ANSWER_ERRORS.text };
  const value = raw.trim();
  switch (q.kind) {
    case "yes_no":
      if (value !== "yes" && value !== "no") return { error: ANSWER_ERRORS.yesNo };
      return { answer: value === "yes" ? "Yes" : "No" };
    case "date":
      return isIsoDate(value) ? { answer: value } : { error: ANSWER_ERRORS.date };
    case "number": {
      if (!NUMBER.test(value)) return { error: numberError(q) };
      const n = Number(value);
      if ((q.minValue !== null && n < q.minValue) || (q.maxValue !== null && n > q.maxValue)) return { error: numberError(q) };
      return { answer: value };
    }
    case "email":
      return EMAIL.test(value) && value.length <= 254 ? { answer: value } : { error: ANSWER_ERRORS.email };
    default:
      return { answer: value };
  }
}

/**
 * The answers to store, in question order with each label as asked, or the fields to fix.
 * `firstBooking`: true for a client's first booking with this host, false for a returning client. null checks
 * everything except whether a first-booking-only question was left out, for a first pass before that is looked up.
 */
export function resolveAnswers(stored: readonly CustomQuestion[], raw: RawAnswers, opts: { firstBooking: boolean | null }): AnswerResult {
  const questions = [...stored].sort((a, b) => a.position - b.position).map(toIntakeQuestion);
  const asked = askedQuestionIds(questions, raw, opts.firstBooking);
  const fields: Record<string, string> = {};
  const answers: InviteeAnswer[] = [];
  for (const q of questions) {
    if (!asked.has(q.id)) continue; // hidden: never required, and whatever was sent for it is dropped
    const value = raw[q.id];
    if (pickedValues(value).length === 0) {
      const required = q.required && (!q.firstBookingOnly || opts.firstBooking === true);
      if (required) fields[`answers.${q.id}`] = ANSWER_ERRORS.required;
      continue;
    }
    const checked = checkAnswer(q, value!);
    if ("error" in checked) fields[`answers.${q.id}`] = checked.error;
    else answers.push({ questionId: q.id, label: q.label, answer: checked.answer });
  }
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, answers };
}

/** True unless this email has a booking with the host already (cancelled ones don't count; nor does this same request). */
export function isFirstBooking(bookings: readonly { status: string; idempotencyKey: string; invitee: { email: string } }[], email: string, idempotencyKey: string): boolean {
  const e = email.trim().toLowerCase();
  return !bookings.some((b) => b.status !== "cancelled" && b.idempotencyKey !== idempotencyKey && b.invitee.email.trim().toLowerCase() === e);
}
