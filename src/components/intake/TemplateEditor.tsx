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

export function TemplateEditor({ id, initialName, initialQuestions, eventTypes }: {
  id: string | null;
  initialName: string;
  initialQuestions: TemplateQuestion[];
  eventTypes: { id: string; name: string }[];
}) {
  const router = useRouter();
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
      setApplyMessage({
        ok: result.skipped === 0,
        text: `Applied to ${n} event ${n === 1 ? "type" : "types"}.${result.skipped ? ` ${result.skipped} couldn't take these questions; open them to check.` : ""}`,
      });
    });
  }

  return (
    <div className="mt-6 grid max-w-xl gap-6">
      <div>
        <Label htmlFor="tpl-name">Name</Label>
        <Input id="tpl-name" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setDirty(true); setSaved(false); }} error={nameError} placeholder="New client intake" />
      </div>
      <QuestionListEditor
        questions={questions} onChange={(next) => { setQuestions(next); setDirty(true); setSaved(false); }} errors={errors} onErrorsChange={setErrors}
        newKey={() => crypto.randomUUID()}
      />
      <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4">
        <Button onClick={save} loading={saving}>{id ? "Save template" : "Create template"}</Button>
        <p role="status" className={`text-sm ${formError || errors.length ? "text-danger" : "text-text-muted"}`}>
          {formError ?? (errors.some((e) => Object.keys(e).length > 0) ? "Some questions need a fix. They're marked above." : saved ? "Saved. Event types change only when you apply it." : "")}
        </p>
      </div>

      {id && (
        <Card className="grid gap-3">
          <h2 className="font-semibold text-text">Use on event types</h2>
          <p className="text-sm text-text-muted">
            Copies the saved questions into each event type you tick, after its own questions. Applying again replaces the copies
            from this template and keeps everything else. Bookings already made keep the questions as they were asked.
          </p>
          {dirty && <p className="text-sm text-danger">Save your changes first; applying uses the saved template.</p>}
          {eventTypes.length === 0 ? <p className="text-text-muted">You have no event types yet.</p> : (
            <fieldset>
              <legend className="sr-only">Event types</legend>
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
          <div><Button variant="secondary" onClick={apply} loading={applying} disabled={dirty || picked.length === 0}>Apply to ticked event types</Button></div>
          {applyMessage && <p role="status" className={`text-sm ${applyMessage.ok ? "text-text-muted" : "text-danger"}`}>{applyMessage.text}</p>}
        </Card>
      )}

      {id && (
        <div className="border-t border-border pt-4">
          {!confirmDelete ? <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete template</Button> : (
            <div className="grid gap-3">
              <p className="text-text">Delete this template? Event types keep the questions already copied from it.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" loading={deleting} onClick={() => startDeleting(async () => { await removeTemplate(id); router.push("/dashboard/event-types/templates"); })}>Yes, delete it</Button>
                <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Keep it</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
