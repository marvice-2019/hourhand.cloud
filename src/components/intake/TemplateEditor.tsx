"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyTemplateTo, removeTemplate, saveTemplate } from "@/app/dashboard/event-types/templates/actions";
import type { QuestionErrors } from "@/lib/event-types";
import { fromTemplate, type TemplateQuestion } from "@/lib/intake/templates-shape";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { focusRing } from "../ui/focus";
import { Input, Label } from "../ui/Input";
import { QuestionListEditor, editableToDrafts, toEditable, type EditableQuestion } from "./QuestionListEditor";
import { useHostI18n } from "../HostI18nProvider";

export function TemplateEditor({ id, initialName, initialQuestions, eventTypes }: {
  id: string | null;
  initialName: string;
  initialQuestions: TemplateQuestion[];
  eventTypes: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { t } = useHostI18n();
  const [name, setName] = useState(initialName);
  const [questions, setQuestions] = useState<EditableQuestion[]>(() => { let n = 0; return toEditable(fromTemplate(initialQuestions, 0, null), () => `t-${n++}`); });
  const [errors, setErrors] = useState<QuestionErrors>([]);
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, startSaving] = useTransition();
  const [picked, setPicked] = useState<string[]>([]);
  const [applyMessage, setApplyMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [applying, startApplying] = useTransition();
  const [deleting, startDeleting] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  function save() {
    startSaving(async () => {
      const result = await saveTemplate(id, name, editableToDrafts(questions).map((q) => ({ ...q, id: null, templateId: null })));
      if (!result.ok) {
        setNameError(result.nameError); setFormError(result.formError); setErrors(result.questionErrors); setSaved(false);
        return;
      }
      setNameError(undefined); setFormError(undefined); setErrors([]); setDirty(false); setSaved(true);
      if (!id) router.replace(`/dashboard/event-types/templates/${result.id}`);
      else router.refresh();
    });
  }

  function apply() {
    if (!id) return;
    startApplying(async () => {
      const result = await applyTemplateTo(id, picked);
      if (!result.ok) { setApplyMessage({ ok: false, text: result.error }); return; }
      const n = result.applied;
      const applied = n === 1 ? t("intake.appliedOne") : t("intake.applied", { n });
      setApplyMessage({ ok: result.skipped === 0, text: result.skipped ? `${applied} ${t("intake.skipped", { n: result.skipped })}` : applied });
    });
  }

  return (
    <div className="mt-6 grid max-w-xl gap-6">
      <div>
        <Label htmlFor="tpl-name">{t("intake.name")}</Label>
        <Input id="tpl-name" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setDirty(true); setSaved(false); }} error={nameError} placeholder={t("intake.namePlaceholder")} />
      </div>
      <QuestionListEditor
        questions={questions} onChange={(next) => { setQuestions(next); setDirty(true); setSaved(false); }} errors={errors} onErrorsChange={setErrors}
        newKey={() => crypto.randomUUID()}
      />
      <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4">
        <Button onClick={save} loading={saving}>{id ? t("intake.saveTemplate") : t("intake.create")}</Button>
        <p role="status" className={`text-sm ${formError || errors.length ? "text-danger" : "text-text-muted"}`}>
          {formError ?? (errors.some((e) => Object.keys(e).length > 0) ? t("intake.fixMarked") : saved ? t("intake.savedApply") : "")}
        </p>
      </div>

      {id && (
        <Card className="grid gap-3">
          <h2 className="font-semibold text-text">{t("intake.useOn")}</h2>
          <p className="text-sm text-text-muted">{t("intake.useOnBody")}</p>
          {dirty && <p className="text-sm text-danger">{t("intake.saveFirst")}</p>}
          {eventTypes.length === 0 ? <p className="text-text-muted">{t("intake.noEventTypes")}</p> : (
            <fieldset>
              <legend className="sr-only">{t("intake.eventTypesLegend")}</legend>
              {eventTypes.map((e) => (
                <label key={e.id} className="flex min-h-11 items-center gap-3 text-text">
                  <input
                    type="checkbox" checked={picked.includes(e.id)} className={`size-5 accent-accent ${focusRing}`}
                    onChange={(ev) => setPicked((p) => (ev.target.checked ? [...p, e.id] : p.filter((x) => x !== e.id)))}
                  />
                  {e.name}
                </label>
              ))}
            </fieldset>
          )}
          <div><Button variant="secondary" onClick={apply} loading={applying} disabled={dirty || picked.length === 0}>{t("intake.apply")}</Button></div>
          {applyMessage && <p role="status" className={`text-sm ${applyMessage.ok ? "text-text-muted" : "text-danger"}`}>{applyMessage.text}</p>}
        </Card>
      )}

      {id && (
        <div className="border-t border-border pt-4">
          {!confirmDelete ? <Button variant="ghost" onClick={() => setConfirmDelete(true)}>{t("intake.delete")}</Button> : (
            <div className="grid gap-3">
              <p className="text-text">{t("intake.deleteConfirm")}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" loading={deleting} onClick={() => startDeleting(async () => { await removeTemplate(id); router.push("/dashboard/event-types/templates"); })}>{t("intake.yesDelete")}</Button>
                <Button variant="secondary" onClick={() => setConfirmDelete(false)}>{t("intake.keep")}</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
