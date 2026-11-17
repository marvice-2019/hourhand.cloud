// Checks on the intake parts of a question draft (condition, first-booking-only, number bounds, template link).
// Used by validateQuestions in src/lib/event-types.ts, so the editor, templates and the importer share one set of rules.
import type { QuestionDraft } from "../data/types";
import { CONDITION_KINDS, conditionOptions } from "./conditions";

/**
 * English messages for the intake checks, merged into EVENT_TYPE_MESSAGES in src/lib/event-types.ts. Each is a code the
 * dashboard shows in the host's language (host catalogue key "eventTypes.err" + the code with a capital first letter).
 */
export const INTAKE_QUESTION_MESSAGES = {
  conditionParent: "Pick an earlier yes/no or choice question to depend on.",
  conditionChain: "That question is itself shown only sometimes. Pick one that is always asked.",
  conditionValues: "Tick at least one answer that shows this question.",
  rangeNumbers: "Enter the limits as plain numbers, like 0 or 120.",
  rangeOrder: "The lowest number can't be above the highest.",
} as const;
type IntakeCode = keyof typeof INTAKE_QUESTION_MESSAGES;

export const CONDITION_ERRORS = {
  parent: INTAKE_QUESTION_MESSAGES.conditionParent,
  chain: INTAKE_QUESTION_MESSAGES.conditionChain,
  values: INTAKE_QUESTION_MESSAGES.conditionValues,
} as const;
export const RANGE_ERROR = INTAKE_QUESTION_MESSAGES.rangeOrder;
const BOUND = 1e12;

type Extra = Partial<Pick<QuestionDraft, "showIf" | "firstBookingOnly" | "minValue" | "maxValue" | "templateId">>;

const bound = (v: unknown): number | null | "bad" => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= BOUND ? n : "bad";
};

/**
 * The cleaned intake fields of the question at `index`, and what's wrong with them. `earlier` holds the already-cleaned
 * questions before it. Fields at their defaults are left out, so a plain question keeps exactly its old shape.
 */
export function checkIntakeFields(q: QuestionDraft, index: number, earlier: readonly QuestionDraft[]): { value: Extra; errors: { condition?: IntakeCode; range?: IntakeCode } } {
  const value: Extra = {};
  const errors: { condition?: IntakeCode; range?: IntakeCode } = {};

  if (q.firstBookingOnly === true) value.firstBookingOnly = true;
  if (typeof q.templateId === "string" && q.templateId) value.templateId = q.templateId;

  if (q.kind === "number") {
    const min = bound(q.minValue);
    const max = bound(q.maxValue);
    if (min === "bad" || max === "bad") errors.range = "rangeNumbers";
    else if (min !== null && max !== null && min > max) errors.range = "rangeOrder";
    else {
      if (min !== null) value.minValue = min;
      if (max !== null) value.maxValue = max;
    }
  }

  const cond = q.showIf;
  if (cond !== null && cond !== undefined) {
    const at = typeof cond === "object" ? cond.questionIndex : NaN;
    const parent = Number.isInteger(at) && at >= 0 && at < index ? earlier[at] : undefined;
    const values = Array.isArray(cond?.values) ? [...new Set(cond.values.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))] : [];
    if (!parent || !CONDITION_KINDS.includes(parent.kind)) errors.condition = "conditionParent";
    else if (parent.showIf) errors.condition = "conditionChain";
    else if (values.length === 0 || values.some((v) => !conditionOptions(parent).includes(v))) errors.condition = "conditionValues";
    else value.showIf = { questionIndex: at, values };
  }
  return { value, errors };
}
