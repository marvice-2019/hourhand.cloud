"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/Input";
import { focusRing } from "@/components/ui/focus";
import { t, type Locale } from "@/lib/i18n/guest";
import { CONSENT_YES, MULTI_SEP, visibleQuestionIds, type IntakeQuestion } from "@/lib/intake";

/** One answer per question, read from the booking form: a multi-select's ticks joined, a consent box as "yes" or "". */
export function readAnswers(form: HTMLFormElement | FormData, questions: Pick<IntakeQuestion, "id">[]): Record<string, string> {
  const data = form instanceof FormData ? form : new FormData(form);
  return Object.fromEntries(questions.map((q) => [q.id, data.getAll(`q_${q.id}`).map(String).filter(Boolean).join(MULTI_SEP)]));
}

/**
 * The host's intake questions, each with its proper control: text, a paragraph, a phone number, one choice (radios),
 * several choices (tick boxes) or a consent tick box. A question with a condition appears only once the question it
 * depends on is answered that way, and disappears (taking its answer with it) if that answer changes.
 */
export function IntakeFields({ questions, errors, locale }: { questions: IntakeQuestion[]; errors: Record<string, string>; locale: Locale }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const visible = visibleQuestionIds(questions, answers);
  const onChange = (e: React.ChangeEvent<HTMLElement>) => {
    const form = (e.target as HTMLInputElement).form;
    if (form) setAnswers(readAnswers(form, questions));
  };
  const optional = (q: IntakeQuestion) => (q.required ? q.label : t(locale, "optionalLabel", { label: q.label }));

  return (
    <>
      {questions.filter((q) => visible.has(q.id)).map((q) => {
        const id = `q_${q.id}`;
        const err = errors[`answers.${q.id}`];
        const described = err ? `${id}-error` : undefined;
        const error = err && <p id={`${id}-error`} className="mt-1 text-sm text-danger">{err}</p>;
        if (q.kind === "single_select" || q.kind === "multi_select") {
          const type = q.kind === "single_select" ? "radio" : "checkbox";
          return (
            <fieldset key={q.id} aria-describedby={described} aria-invalid={err ? true : undefined} aria-required={q.required || undefined} className="grid gap-1">
              <legend className="mb-1 text-sm font-semibold text-text">{optional(q)}</legend>
              {q.choices.map((c, i) => (
                <label key={c} className="flex min-h-11 items-center gap-3 text-text">
                  <input type={type} id={i === 0 ? id : undefined} name={id} value={c} onChange={onChange} className={`size-5 accent-accent ${focusRing}`} />
                  <span>{c}</span>
                </label>
              ))}
              {error}
            </fieldset>
          );
        }
        if (q.kind === "consent") {
          return (
            <div key={q.id}>
              <label className="flex min-h-11 items-start gap-3 text-text">
                <input type="checkbox" id={id} name={id} value={CONSENT_YES} onChange={onChange} aria-required={q.required || undefined}
                  aria-invalid={err ? true : undefined} aria-describedby={described} className={`mt-0.5 size-5 shrink-0 accent-accent ${focusRing}`} />
                <span>{optional(q)}</span>
              </label>
              {error}
            </div>
          );
        }
        return (
          <div key={q.id}>
            <Label htmlFor={id}>{optional(q)}</Label>
            {q.kind === "long_text" ? (
              <>
                <textarea
                  id={id} name={id} rows={4} required={q.required} onChange={onChange} aria-invalid={err ? true : undefined} aria-describedby={described}
                  className={`mt-1 block w-full rounded-md border bg-card p-3 text-base text-text ${err ? "border-danger" : "border-border-input"} ${focusRing}`}
                />
                {error}
              </>
            ) : (
              <Input id={id} name={id} required={q.required} error={err} onChange={onChange} {...(q.kind === "phone" ? { type: "tel", autoComplete: "tel", inputMode: "tel" as const } : {})} />
            )}
          </div>
        );
      })}
    </>
  );
}
