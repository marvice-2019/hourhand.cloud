// Moving questions between their three shapes: stored (conditions by question id), draft (conditions by list position,
// as the editor and saveQuestions use) and template (a draft without ids). Pure and browser-safe.
import type { CustomQuestion, QuestionDraft } from "../data/types";

/** A question as kept in a template: a draft with no id. Its condition points at a position in the same template. */
export type TemplateQuestion = Omit<QuestionDraft, "id" | "templateId">;

/** Most questions in one template. */
export const TEMPLATE_MAX_QUESTIONS = 40;

/** Stored questions as drafts, in position order; a condition whose question is gone is dropped. */
export function toDrafts(stored: readonly CustomQuestion[]): QuestionDraft[] {
  const ordered = [...stored].sort((a, b) => a.position - b.position);
  const index = new Map(ordered.map((q, i) => [q.id, i]));
  return ordered.map((q) => {
    const at = q.showIf ? index.get(q.showIf.questionId) : undefined;
    return {
      id: q.id, label: q.label, kind: q.kind, required: q.required, choices: [...q.choices],
      ...(at !== undefined ? { showIf: { questionIndex: at, values: [...q.showIf!.values] } } : {}),
      ...(q.firstBookingOnly ? { firstBookingOnly: true } : {}),
      ...(q.minValue !== null && q.minValue !== undefined ? { minValue: q.minValue } : {}),
      ...(q.maxValue !== null && q.maxValue !== undefined ? { maxValue: q.maxValue } : {}),
      ...(q.templateId ? { templateId: q.templateId } : {}),
    };
  });
}

/** Drafts as template questions: ids and template links dropped. */
export function toTemplateQuestions(drafts: readonly QuestionDraft[]): TemplateQuestion[] {
  return drafts.map((d) => {
    const rest: Partial<QuestionDraft> = { ...d, choices: [...d.choices] };
    delete rest.id;
    delete rest.templateId;
    return rest as TemplateQuestion;
  });
}

/**
 * A template's questions as new drafts placed after `offset` existing ones: conditions are moved along with them, and
 * each is linked to the template (when it has an id) so applying it again replaces them rather than adding copies.
 */
export function fromTemplate(questions: readonly TemplateQuestion[], offset: number, templateId: string | null): QuestionDraft[] {
  return questions.map((q) => ({
    ...q, id: null, choices: [...q.choices],
    showIf: q.showIf ? { questionIndex: q.showIf.questionIndex + offset, values: [...q.showIf.values] } : null,
    ...(templateId ? { templateId } : {}),
  }));
}

/**
 * An event type's questions after applying a template. The questions it already got from this template are replaced by
 * the template's current ones, in the same place (at the end the first time); everything else stays in order. A kept
 * question that depended on a replaced one follows the new question with the same label and kind, or loses its
 * condition when there is none.
 */
export function applyTemplateToDrafts(current: readonly QuestionDraft[], template: readonly TemplateQuestion[], templateId: string): QuestionDraft[] {
  const first = current.findIndex((q) => q.templateId === templateId);
  const at = first === -1 ? current.length : first;
  const before = current.map((q, i) => ({ q, i })).filter(({ q, i }) => i < at && q.templateId !== templateId);
  const after = current.map((q, i) => ({ q, i })).filter(({ q, i }) => i >= at && q.templateId !== templateId);
  const added = fromTemplate(template, before.length, templateId);
  const newPos = new Map([...before.map(({ i }, n) => [i, n] as const), ...after.map(({ i }, n) => [i, before.length + added.length + n] as const)]);
  const remap = (q: QuestionDraft, own: number): QuestionDraft => {
    if (!q.showIf) return q;
    let target = newPos.get(q.showIf.questionIndex);
    if (target === undefined) {
      const old = current[q.showIf.questionIndex];
      const match = old ? added.findIndex((a) => a.label === old.label && a.kind === old.kind) : -1;
      target = match >= 0 ? before.length + match : undefined;
    }
    return target !== undefined && target < own ? { ...q, showIf: { ...q.showIf, questionIndex: target } } : { ...q, showIf: null };
  };
  return [
    ...before.map(({ q }, n) => remap(q, n)),
    ...added,
    ...after.map(({ q }, n) => remap(q, before.length + added.length + n)),
  ];
}
