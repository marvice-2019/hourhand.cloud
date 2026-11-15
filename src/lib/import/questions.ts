import type { ImportedQuestion } from "./types";
import { text } from "./http";

export const MAX_QUESTIONS = 20;

/**
 * A question in Hourhand's terms. A choice question with fewer than two usable choices can't be saved as one, so it
 * becomes a short answer; `changedFrom` names the provider's kind when it only maps to the nearest Hourhand kind.
 */
export function question(rawLabel: unknown, kind: ImportedQuestion["kind"], required: boolean, rawChoices: unknown[], notes: string[],
  changedFrom?: string): ImportedQuestion | null {
  const label = text(rawLabel, 300);
  if (!label) return null;
  const isSelect = kind === "single_select" || kind === "multi_select";
  const choices = isSelect ? [...new Set(rawChoices.map((c) => text(c, 200)).filter(Boolean))].slice(0, 50) : [];
  if (isSelect && choices.length < 2) {
    notes.push(`"${label}" had fewer than two choices, so it is now a short answer.`);
    return { label, kind: "short_text", required, choices: [] };
  }
  if (changedFrom) notes.push(`"${label}" was a ${changedFrom} question; it is now a ${KIND_WORDS[kind]}.`);
  return { label, kind, required, choices };
}

const KIND_WORDS: Record<ImportedQuestion["kind"], string> = {
  short_text: "short answer", long_text: "long answer", phone: "phone number", single_select: "single choice",
  multi_select: "multiple choice", consent: "tick box", yes_no: "yes or no", date: "date", number: "number", email: "email address",
};

export function capQuestions(qs: ImportedQuestion[], notes: string[]): ImportedQuestion[] {
  if (qs.length <= MAX_QUESTIONS) return qs;
  notes.push(`Only the first ${MAX_QUESTIONS} questions came over.`);
  return qs.slice(0, MAX_QUESTIONS);
}
