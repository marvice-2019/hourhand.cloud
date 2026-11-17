"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { saveTemplate } from "@/app/dashboard/event-types/templates/actions";
import { Button } from "../ui/Button";
import { Input, Label } from "../ui/Input";
import { editableToDrafts, type EditableQuestion } from "./QuestionListEditor";
import { useHostI18n } from "../HostI18nProvider";

/** Saves the questions as they are in the editor (saved or not) as a new intake template. */
export function SaveAsTemplate({ questions }: { questions: EditableQuestion[] }) {
  const { t, tNodes } = useHostI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saving, start] = useTransition();
  if (questions.length === 0) return null;
  if (!open) {
    return (
      <div>
        <Button variant="ghost" onClick={() => { setOpen(true); setSavedId(null); }}>{t("intake.saveAs")}</Button>
        {savedId && (
          <p role="status" className="text-sm text-text-muted">
            {tNodes("intake.savedOpen", { link: <Link key="open" href={`/dashboard/event-types/templates/${savedId}`} className="font-semibold text-accent underline">{t("intake.openIt")}</Link> })}
          </p>
        )}
      </div>
    );
  }

  function save() {
    start(async () => {
      // Template questions are copies: not linked to this event type's own.
      const result = await saveTemplate(null, name, editableToDrafts(questions).map((q) => ({ ...q, id: null, templateId: null })));
      if (result.ok) { setSavedId(result.id); setOpen(false); setName(""); setError(null); return; }
      setError(result.nameError ?? result.formError ?? t("intake.fixFirst"));
    });
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor="tpl-name">{t("intake.templateName")}</Label>
      <Input id="tpl-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} error={error ?? undefined} placeholder={t("intake.namePlaceholder")} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={saving} onClick={save}>{t("intake.saveTemplate")}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}
