"use client";

import { useActionState, useState } from "react";
import { saveRoutingFormAction, type RoutingFormState } from "@/app/dashboard/routing/actions";
import { useHostI18n } from "./HostI18nProvider";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";

const selectClasses = `mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;
const ROWS = 8;

export interface EditorOption { label: string; eventTypeId: string | null; message: string | null }

/** Create or edit a routing form: a heading, one question and up to 8 answer rows. Empty rows are skipped on save. */
export function RoutingFormEditor({ form, eventTypes }: {
  form: { id: string; title: string; question: string; active: boolean; options: EditorOption[] } | null;
  eventTypes: { id: string; name: string }[];
}) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState<RoutingFormState, FormData>(saveRoutingFormAction, { status: "idle" });
  const initial = Array.from({ length: ROWS }, (_, i) => form?.options[i]?.eventTypeId ?? (form?.options[i]?.message ? "" : eventTypes[0]?.id ?? ""));
  const [targets, setTargets] = useState<string[]>(initial);
  return (
    <form action={action} className="grid max-w-xl gap-4">
      {form && <input type="hidden" name="id" value={form.id} />}
      <div>
        <Label htmlFor="routing-title">{t("routing.heading")}</Label>
        <Input id="routing-title" name="title" required maxLength={80} defaultValue={form?.title} placeholder={t("routing.headingPlaceholder")} />
      </div>
      <div>
        <Label htmlFor="routing-question">{t("routing.question")}</Label>
        <Input id="routing-question" name="question" required maxLength={200} defaultValue={form?.question} placeholder={t("routing.questionPlaceholder")} />
      </div>
      <fieldset className="grid gap-4">
        <legend className="font-semibold text-text">{t("routing.answers")}</legend>
        <p className="text-sm text-text-muted">{t("routing.answersHint")}</p>
        {eventTypes.length === 0 && <p className="rounded-md bg-surface p-3 text-sm text-text" role="status">{t("routing.noEventTypes")}</p>}
        {targets.map((target, i) => (
          <div key={i} className="grid gap-2 rounded-md border border-border p-3">
            <div>
              <Label htmlFor={`routing-label-${i}`}>{t("routing.answerN", { n: i + 1 })}</Label>
              <Input id={`routing-label-${i}`} name={`label-${i}`} maxLength={80} defaultValue={form?.options[i]?.label} />
            </div>
            <div>
              <Label htmlFor={`routing-target-${i}`}>{t("routing.opensN", { n: i + 1 })}</Label>
              <select id={`routing-target-${i}`} name={`target-${i}`} className={selectClasses} value={target}
                onChange={(e) => setTargets(targets.map((v, j) => (j === i ? e.target.value : v)))}>
                {eventTypes.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                <option value="">{t("routing.showNote")}</option>
              </select>
            </div>
            {target === "" && (
              <div>
                <Label htmlFor={`routing-note-${i}`}>{t("routing.noteN", { n: i + 1 })}</Label>
                <Input id={`routing-note-${i}`} name={`note-${i}`} maxLength={300} defaultValue={form?.options[i]?.message ?? ""} placeholder={t("routing.notePlaceholder")} />
              </div>
            )}
          </div>
        ))}
      </fieldset>
      <label className="flex min-h-11 items-center gap-2 text-text">
        <input type="checkbox" name="active" defaultChecked={form ? form.active : true} className={`h-5 w-5 ${focusRing}`} />
        {t("routing.active")}
      </label>
      {state.status === "error" && <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">{state.message}</p>}
      <div>
        <Button type="submit" disabled={pending}>{pending ? t("routing.saving") : t(form ? "routing.save" : "routing.create")}</Button>
      </div>
    </form>
  );
}
