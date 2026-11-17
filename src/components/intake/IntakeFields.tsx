"use client";

// The host's intake questions on the guest booking form. Questions with a condition appear only once the earlier answer
// matches; the server applies the same rules and is the one that decides (src/lib/intake/answers.ts).
import { Fragment } from "react";
import { Input, Label } from "@/components/ui/Input";
import { focusRing } from "@/components/ui/focus";
import { t, type GuestKey, type Locale } from "@/lib/i18n/guest";
import { askedQuestionIds, pickedValues, type IntakeQuestion, type RawAnswers } from "@/lib/intake/conditions";

const fieldName = (q: Pick<IntakeQuestion, "id">) => `q_${q.id}`;

/** The answers currently in the form, by question id: ticked choices as a list for a multi-select. */
export function readAnswers(form: HTMLFormElement, questions: readonly IntakeQuestion[]): RawAnswers {
  const data = new FormData(form);
  const out: RawAnswers = {};
  for (const q of questions) {
    if (q.kind === "multi_select") out[q.id] = data.getAll(fieldName(q)).map(String);
    else {
      const v = data.get(fieldName(q));
      if (v !== null) out[q.id] = String(v);
    }
  }
  return out;
}

/** What to send: answers to the questions asked right now, and nothing for hidden ones. */
export function answersToSend(questions: readonly IntakeQuestion[], answers: RawAnswers): Record<string, string | string[]> {
  const asked = askedQuestionIds(questions, answers, null);
  const out: Record<string, string | string[]> = {};
  for (const q of questions) {
    if (!asked.has(q.id)) continue;
    const v = answers[q.id];
    out[q.id] = q.kind === "multi_select" ? pickedValues(v) : typeof v === "string" ? v : "";
  }
  return out;
}

/** The guest's-language message for a field the server refused, worked out from the question and what was entered. */
export function answerErrorMessage(locale: Locale, q: IntakeQuestion, value: RawAnswers[string]): string {
  if (pickedValues(value).length === 0) return t(locale, "errRequired");
  const key: Partial<Record<IntakeQuestion["kind"], GuestKey>> = { date: "errDate", email: "errEmail", yes_no: "errYesNo", multi_select: "errChoice" };
  if (q.kind === "number") {
    if (q.minValue !== null && q.maxValue !== null) return t(locale, "errNumberRange", { min: q.minValue, max: q.maxValue });
    if (q.minValue !== null) return t(locale, "errNumberMin", { min: q.minValue });
    if (q.maxValue !== null) return t(locale, "errNumberMax", { max: q.maxValue });
    return t(locale, "errNumber");
  }
  return t(locale, key[q.kind] ?? "errAnswer");
}

const boxClasses = (err: boolean) => `mt-1 block w-full rounded-md border bg-card text-base text-text ${err ? "border-danger" : "border-border-input"} ${focusRing}`;

export function IntakeFields({ questions, answers, errors, locale, hostName }: {
  questions: readonly IntakeQuestion[];
  /** The answers so far, so conditional questions show as soon as they apply. */
  answers: RawAnswers;
  errors: Record<string, string>;
  locale: Locale;
  hostName: string;
}) {
  const asked = askedQuestionIds(questions, answers, null);
  const shown = questions.filter((q) => asked.has(q.id));
  // The first-booking note is shown once, above the first such question; each of them points to it for screen readers.
  const firstOnly = shown.find((q) => q.firstBookingOnly);
  const hintId = "intake-first-booking";
  return (
    <>
      {shown.map((q) => {
        const id = fieldName(q);
        const err = errors[`answers.${q.id}`];
        const label = q.required ? q.label : t(locale, "optionalLabel", { label: q.label });
        const describedBy = [q.firstBookingOnly ? hintId : "", err ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
        const note = q === firstOnly && <p key={hintId} id={hintId} className="rounded-md bg-surface p-3 text-sm text-text">{t(locale, "firstBookingHint", { host: hostName })}</p>;
        const error = err && <p id={`${id}-error`} className="mt-1 text-sm text-danger">{err}</p>;

        if (q.kind === "yes_no" || q.kind === "multi_select" || (q.kind === "single_select" && q.choices.length > 0 && q.choices.length <= 4)) {
          const options = q.kind === "yes_no" ? [{ value: "yes", text: t(locale, "answerYes") }, { value: "no", text: t(locale, "answerNo") }] : q.choices.map((c) => ({ value: c, text: c }));
          return (
            <Fragment key={q.id}>{note}<fieldset aria-describedby={describedBy} aria-invalid={err ? true : undefined}>
              <legend className="text-sm font-semibold text-text">{label}</legend>
              <div className="mt-1 grid gap-1">
                {options.map((o) => (
                  <label key={o.value} className="flex min-h-11 items-center gap-3 text-text">
                    <input type={q.kind === "multi_select" ? "checkbox" : "radio"} name={id} value={o.value} className={`size-5 accent-accent ${focusRing}`} />
                    <span>{o.text}</span>
                  </label>
                ))}
              </div>
              {error}
            </fieldset></Fragment>
          );
        }
        if (q.kind === "consent") {
          return (
            <Fragment key={q.id}>{note}<div>
              <label className="flex min-h-11 items-start gap-3 text-text">
                <input id={id} type="checkbox" name={id} value="Yes" aria-invalid={err ? true : undefined} aria-describedby={describedBy} className={`mt-1 size-5 shrink-0 accent-accent ${focusRing}`} />
                <span>{label}</span>
              </label>
              {error}
            </div></Fragment>
          );
        }
        return (
          <Fragment key={q.id}>{note}<div>
            <Label htmlFor={id}>{label}</Label>
            {q.kind === "long_text" ? (
              <textarea id={id} name={id} rows={4} maxLength={2000} aria-invalid={err ? true : undefined} aria-describedby={describedBy} className={`p-3 ${boxClasses(Boolean(err))}`} />
            ) : q.kind === "single_select" ? (
              <select id={id} name={id} defaultValue="" aria-invalid={err ? true : undefined} aria-describedby={describedBy} className={`h-11 px-3 ${boxClasses(Boolean(err))}`}>
                <option value="">{t(locale, "chooseOne")}</option>
                {q.choices.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <Input
                id={id} name={id} aria-describedby={q.firstBookingOnly ? hintId : undefined} error={err}
                {...(q.kind === "date" ? { type: "date", min: "1900-01-01", max: "2100-12-31" }
                  : q.kind === "number" ? { type: "text", inputMode: "decimal" as const }
                  : q.kind === "email" ? { type: "email", autoComplete: "off" }
                  : q.kind === "phone" ? { type: "tel" }
                  : { maxLength: 2000 })}
              />
            )}
            {q.kind === "long_text" || q.kind === "single_select" ? error : null}
          </div></Fragment>
        );
      })}
    </>
  );
}
