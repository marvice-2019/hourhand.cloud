// Turns imported event types into drafts through the same checks the editor uses, with slugs made unique.
import type { EventTypeDraft, QuestionDraft } from "../data/types";
import { NEW_EVENT_TYPE_FORM, slugify, validateEventType, validateQuestions, type EventTypeForm } from "../event-types";
import { IMPORT_MESSAGES, importMessage } from "./messages";
import type { ImportedEventType } from "./types";

/** `base`, or base-2, base-3 … the first one not in `taken`, within the 60-character limit. */
export function uniqueSlug(raw: string, name: string, taken: ReadonlySet<string>): string {
  const base = slugify(raw) || slugify(name) || "event";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 60 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function toImportForm(et: ImportedEventType, slug: string): EventTypeForm {
  const d = NEW_EVENT_TYPE_FORM;
  return {
    ...d,
    name: et.name,
    slug,
    durationMinutes: String(et.durationMinutes),
    description: et.description ?? "",
    locationKind: et.location?.kind ?? "",
    locationValue: et.location?.value ?? "",
    minNoticeMinutes: et.minNoticeMinutes === null ? d.minNoticeMinutes : String(et.minNoticeMinutes),
    startIncrementMinutes: et.startIncrementMinutes === null ? d.startIncrementMinutes : String(et.startIncrementMinutes),
    bufferBeforeMinutes: String(et.bufferBeforeMinutes),
    bufferAfterMinutes: String(et.bufferAfterMinutes),
    hidden: et.hidden,
    seats: et.seatLimit === null ? "" : String(et.seatLimit),
  };
}

export type PlannedImport =
  | { ok: true; sourceId: string; draft: EventTypeDraft; questions: QuestionDraft[]; notes: string[] }
  | { ok: false; sourceId: string; name: string; error: string };

/** Plans each event type in order; each planned slug is taken before the next one is picked. */
export function planImport(items: readonly ImportedEventType[], existingSlugs: readonly string[]): PlannedImport[] {
  const taken = new Set(existingSlugs.map((s) => s.toLowerCase()));
  return items.map((et) => {
    const slug = uniqueSlug(et.slug, et.name, taken);
    const details = validateEventType(toImportForm(et, slug), [...taken]);
    const questions = validateQuestions(et.questions.map((q) => ({ id: null, ...q })));
    if (!details.ok) {
      return { ok: false, sourceId: et.sourceId, name: et.name, error: Object.values(details.errors).filter(Boolean).join(" ") || IMPORT_MESSAGES.notValid };
    }
    if (!questions.ok) {
      return { ok: false, sourceId: et.sourceId, name: et.name, error: IMPORT_MESSAGES.questionInvalid };
    }
    taken.add(details.value.slug);
    const notes = slug === slugify(et.slug) || !et.slug ? et.notes : [...et.notes, importMessage("slugMoved", { from: slugify(et.slug) || et.slug, to: slug })];
    return { ok: true, sourceId: et.sourceId, draft: details.value, questions: questions.value, notes };
  });
}
