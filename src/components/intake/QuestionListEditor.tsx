"use client";

// Editing a list of intake questions: the event type editor's "Booking form" tab and the template editor both use it.
// Conditions are held by the other question's key while editing and sent as list positions (see toDrafts below).
import type { CustomQuestion, QuestionDraft } from "@/lib/data/types";
import type { QuestionErrors } from "@/lib/event-types";
import { CONDITION_KINDS, QUESTION_KINDS, conditionOptions } from "@/lib/intake/conditions";
import { looksHealthRelated } from "@/lib/intake/sensitive";
import type { HostKey } from "@/lib/i18n/host";
import { useHostI18n } from "../HostI18nProvider";
import { fromTemplate, type TemplateQuestion } from "@/lib/intake/templates-shape";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { focusRing } from "../ui/focus";
import { Input, Label } from "../ui/Input";

export const KIND_LABELS: Record<CustomQuestion["kind"], HostKey> = {
  short_text: "eventTypes.kindShort", long_text: "eventTypes.kindLong", single_select: "eventTypes.kindSelect", multi_select: "intake.kindMulti",
  yes_no: "intake.kindYesNo", date: "intake.kindDate", number: "intake.kindNumber", email: "intake.kindEmail", phone: "intake.kindPhone", consent: "intake.kindConsent",
};

export type EditableQuestion = Omit<QuestionDraft, "showIf"> & { key: string; cond: { key: string; values: string[] } | null };

/** Drafts (conditions by position) as editable questions (conditions by key). */
export function toEditable(drafts: readonly QuestionDraft[], newKey: () => string): EditableQuestion[] {
  const keys = drafts.map((q) => q.id ?? newKey());
  return drafts.map(({ showIf, ...q }, i) => ({
    ...q, key: keys[i],
    cond: showIf && keys[showIf.questionIndex] !== undefined ? { key: keys[showIf.questionIndex], values: [...showIf.values] } : null,
  }));
}

/** Editable questions as drafts for the server; a condition on a question no longer in the list is sent as invalid. */
export function editableToDrafts(questions: readonly EditableQuestion[]): QuestionDraft[] {
  const index = new Map(questions.map((q, i) => [q.key, i]));
  return questions.map((q) => ({
    id: q.id, label: q.label, kind: q.kind, required: q.required, choices: q.choices,
    showIf: q.cond ? { questionIndex: index.get(q.cond.key) ?? -1, values: q.cond.values } : null,
    firstBookingOnly: q.firstBookingOnly === true, minValue: q.minValue ?? null, maxValue: q.maxValue ?? null, templateId: q.templateId ?? null,
  }));
}

export interface TemplateOption { id: string; name: string; questions: TemplateQuestion[]; example?: boolean; starter?: boolean }

const fieldClasses = (invalid: boolean) =>
  `mt-1 block w-full rounded-md border bg-card px-3 text-base text-text ${invalid ? "border-danger" : "border-border-input"} ${focusRing}`;

const numberText = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const parseBound = (s: string): number | null => (s.trim() === "" ? null : Number(s));

export function QuestionListEditor({ questions, onChange, errors, onErrorsChange, templates = [], newKey }: {
  questions: EditableQuestion[];
  onChange: (next: EditableQuestion[]) => void;
  errors: QuestionErrors;
  onErrorsChange?: (next: QuestionErrors) => void;
  /** Templates and starter examples the host can add questions from. */
  templates?: TemplateOption[];
  newKey: () => string;
}) {
  const { t } = useHostI18n();
  const update = (index: number, patch: Partial<EditableQuestion>) => onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...questions];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange(next);
    onErrorsChange?.([]);
  };
  const remove = (index: number) => {
    const gone = questions[index].key;
    // Questions that depended on it lose their condition rather than pointing at nothing.
    onChange(questions.filter((_, i) => i !== index).map((q) => (q.cond?.key === gone ? { ...q, cond: null } : q)));
    onErrorsChange?.(errors.filter((_, i) => i !== index));
  };
  const add = () => onChange([...questions, { key: newKey(), id: null, label: "", kind: "short_text", required: false, choices: [], cond: null }]);
  const addFrom = (t: TemplateOption) => {
    const drafts = fromTemplate(t.questions, questions.length, t.starter ? null : t.id);
    const keys = drafts.map(() => newKey());
    const all = [...questions.map((q) => q.key), ...keys];
    onChange([...questions, ...drafts.map(({ showIf, ...d }, i) => ({
      ...d, key: keys[i], cond: showIf && all[showIf.questionIndex] ? { key: all[showIf.questionIndex], values: [...showIf.values] } : null,
    }))]);
  };
  const health = questions.some((q) => looksHealthRelated(q.label) || q.choices.some(looksHealthRelated));

  return (
    <div className="grid gap-4">
      {health && <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-text">{t("intake.healthNote")}</p>}
      {questions.length === 0 && <p className="text-text-muted">{t("eventTypes.noQuestions")}</p>}
      <ol className="grid gap-4">
        {questions.map((q, i) => {
          const e = errors[i] ?? {};
          const name = q.label.trim() || t("eventTypes.questionN", { n: i + 1 });
          const parents = questions.slice(0, i).filter((p) => CONDITION_KINDS.includes(p.kind) && !p.cond);
          const parent = q.cond ? questions.find((p) => p.key === q.cond!.key) : undefined;
          const options = parent ? conditionOptions({ kind: parent.kind, choices: parent.choices.map((c) => c.trim()).filter(Boolean) }) : [];
          return (
            <li key={q.key}>
              <Card className="grid gap-3">
                <div>
                  <Label htmlFor={`q-${q.key}-label`}>{t("eventTypes.questionN", { n: i + 1 })}</Label>
                  <Input id={`q-${q.key}-label`} value={q.label} maxLength={300} onChange={(ev) => update(i, { label: ev.target.value })} error={e.label} />
                </div>
                <div>
                  <Label htmlFor={`q-${q.key}-kind`}>{t("eventTypes.answerType")}</Label>
                  <select id={`q-${q.key}-kind`} value={q.kind} onChange={(ev) => update(i, { kind: ev.target.value as CustomQuestion["kind"] })} className={`h-11 ${fieldClasses(false)}`}>
                    {QUESTION_KINDS.map((k) => <option key={k} value={k}>{t(KIND_LABELS[k])}</option>)}
                  </select>
                </div>
                {(q.kind === "single_select" || q.kind === "multi_select") && (
                  <div>
                    <Label htmlFor={`q-${q.key}-choices`}>{t("eventTypes.choices")}</Label>
                    <textarea
                      id={`q-${q.key}-choices`} rows={3} value={q.choices.join("\n")} onChange={(ev) => update(i, { choices: ev.target.value.split("\n") })}
                      aria-invalid={e.choices ? true : undefined} aria-describedby={e.choices ? `q-${q.key}-choices-error` : undefined}
                      className={`py-2 ${fieldClasses(Boolean(e.choices))}`}
                    />
                    {e.choices && <p id={`q-${q.key}-choices-error`} className="mt-1 text-sm text-danger">{e.choices}</p>}
                  </div>
                )}
                {q.kind === "number" && (
                  <div className="flex flex-wrap gap-4">
                    <div>
                      <Label htmlFor={`q-${q.key}-min`}>{t("intake.lowest")}</Label>
                      <Input id={`q-${q.key}-min`} inputMode="decimal" className="max-w-32" placeholder={t("intake.noLimit")} value={numberText(q.minValue)}
                        onChange={(ev) => update(i, { minValue: parseBound(ev.target.value) })} />
                    </div>
                    <div>
                      <Label htmlFor={`q-${q.key}-max`}>{t("intake.highest")}</Label>
                      <Input id={`q-${q.key}-max`} inputMode="decimal" className="max-w-32" placeholder={t("intake.noLimit")} value={numberText(q.maxValue)}
                        onChange={(ev) => update(i, { maxValue: parseBound(ev.target.value) })} />
                    </div>
                    {e.range && <p className="w-full text-sm text-danger">{e.range}</p>}
                  </div>
                )}
                {(i > 0 || q.cond) && (
                  <div>
                    <Label htmlFor={`q-${q.key}-cond`}>{t("intake.whenToAsk")}</Label>
                    <select
                      id={`q-${q.key}-cond`} value={q.cond?.key ?? ""} aria-invalid={e.condition ? true : undefined}
                      aria-describedby={e.condition ? `q-${q.key}-cond-error` : `q-${q.key}-cond-hint`}
                      onChange={(ev) => update(i, { cond: ev.target.value ? { key: ev.target.value, values: [] } : null })}
                      className={`h-11 ${fieldClasses(Boolean(e.condition))}`}
                    >
                      <option value="">{t("intake.always")}</option>
                      {parents.map((p) => <option key={p.key} value={p.key}>{t("intake.onlyIf", { label: p.label.trim() || t("intake.earlierQuestion") })}</option>)}
                      {q.cond && !parents.some((p) => p.key === q.cond!.key) && <option value={q.cond.key}>{t("intake.unusableParent")}</option>}
                    </select>
                    {!e.condition && <p id={`q-${q.key}-cond-hint`} className="mt-1 text-sm text-text-muted">{t("intake.conditionHint")}</p>}
                    {q.cond && options.length > 0 && (
                      <fieldset className="mt-2">
                        <legend className="sr-only">{t("intake.conditionValues")}</legend>
                        <div className="flex flex-wrap gap-x-4">
                          {options.map((o) => (
                            <label key={o} className="inline-flex min-h-11 items-center gap-2 text-sm text-text">
                              <input
                                type="checkbox" checked={q.cond!.values.includes(o)} className={`size-5 accent-accent ${focusRing}`}
                                onChange={(ev) => update(i, { cond: { key: q.cond!.key, values: ev.target.checked ? [...q.cond!.values, o] : q.cond!.values.filter((v) => v !== o) } })}
                              />
                              {o === "yes" ? t("intake.yes") : o === "no" ? t("intake.no") : o}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                    {e.condition && <p id={`q-${q.key}-cond-error`} className="mt-1 text-sm text-danger">{e.condition}</p>}
                  </div>
                )}
                <label className="inline-flex min-h-11 items-center gap-2 text-sm text-text">
                  <input type="checkbox" checked={q.required} onChange={(ev) => update(i, { required: ev.target.checked })} className={`size-5 accent-accent ${focusRing}`} />
                  {t(q.cond ? "intake.requiredWhenAsked" : "eventTypes.required")}
                </label>
                <label className="inline-flex min-h-11 items-center gap-2 text-sm text-text">
                  <input type="checkbox" checked={q.firstBookingOnly === true} onChange={(ev) => update(i, { firstBookingOnly: ev.target.checked })} className={`size-5 accent-accent ${focusRing}`} />
                  {t("intake.firstBookingOnly")}
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("eventTypes.moveUpLabel", { name })}>{t("eventTypes.moveUp")}</Button>
                  <Button variant="secondary" size="sm" disabled={i === questions.length - 1} onClick={() => move(i, 1)} aria-label={t("eventTypes.moveDownLabel", { name })}>{t("eventTypes.moveDown")}</Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(i)} aria-label={t("eventTypes.removeLabel", { name })}>{t("common.remove")}</Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-end gap-3">
        <Button variant="secondary" onClick={add}>{t("eventTypes.addQuestion")}</Button>
        {templates.length > 0 && <AddFromTemplate templates={templates} onAdd={addFrom} />}
      </div>
    </div>
  );
}

function AddFromTemplate({ templates, onAdd }: { templates: TemplateOption[]; onAdd: (t: TemplateOption) => void }) {
  const { t: tr } = useHostI18n();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        const id = new FormData(ev.currentTarget).get("template");
        const t = templates.find((x) => x.id === id);
        if (t) onAdd(t);
      }}
    >
      <div>
        <Label htmlFor="add-template">{tr("intake.addFrom")}</Label>
        <select id="add-template" name="template" className={`h-11 ${fieldClasses(false)}`}>
          {templates.map((x) => <option key={x.id} value={x.id}>{x.starter ? tr("intake.starterOption", { name: x.name }) : x.example ? tr("intake.exampleOption", { name: x.name }) : x.name}</option>)}
        </select>
      </div>
      <Button type="submit" variant="secondary">{tr("intake.add")}</Button>
    </form>
  );
}
