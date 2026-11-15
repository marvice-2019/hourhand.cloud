"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { saveTemplate } from "@/app/dashboard/event-types/templates/actions";
import { Button } from "../ui/Button";
import { Input, Label } from "../ui/Input";
import { editableToDrafts, type EditableQuestion } from "./QuestionListEditor";

/** Saves the questions as they are in the editor (saved or not) as a new intake template. */
export function SaveAsTemplate({ questions }: { questions: EditableQuestion[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saving, start] = useTransition();
  if (questions.length === 0) return null;
  if (!open) {
    return (
      <div>
        <Button variant="ghost" onClick={() => { setOpen(true); setSavedId(null); }}>Save these questions as a template</Button>
        {savedId && (
          <p role="status" className="text-sm text-text-muted">
            Template saved. <Link href={`/dashboard/event-types/templates/${savedId}`} className="font-semibold text-accent underline">Open it</Link> to use it on other event types.
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
      setError(result.nameError ?? result.formError ?? "Some questions need a fix first. Save the event type to see which.");
    });
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor="tpl-name">Template name</Label>
      <Input id="tpl-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} error={error ?? undefined} placeholder="New client intake" />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={saving} onClick={save}>Save template</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
