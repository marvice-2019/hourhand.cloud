import type { ImportedQuestion } from "./types";
import { text } from "./http";
import { importMessage, type ImportMessageCode } from "./messages";

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
    notes.push(importMessage("fewChoices", { label }));
    return { label, kind: "short_text", required, choices: [] };
  }
  if (changedFrom) notes.push(importMessage(NOW_KIND[kind], { label, from: changedFrom }));
  return { label, kind, required, choices };
}

/** The note for a question that became the nearest Hourhand kind. */
const NOW_KIND: Record<ImportedQuestion["kind"], ImportMessageCode> = {
  short_text: "nowShortText", long_text: "nowLongText", phone: "nowPhone", single_select: "nowSingleSelect",
  multi_select: "nowMultiSelect", consent: "nowConsent",
};

export function capQuestions(qs: ImportedQuestion[], notes: string[]): ImportedQuestion[] {
  if (qs.length <= MAX_QUESTIONS) return qs;
  notes.push(importMessage("questionsCapped", { max: MAX_QUESTIONS }));
  return qs.slice(0, MAX_QUESTIONS);
}
