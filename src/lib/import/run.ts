// Saves the ticked event types for one host. Each comes in switched off, so nothing is bookable until the host has
// looked it over (availability and integrations never come across).
import { isNamedError, type DataStore } from "../data/types";
import { IMPORT_MESSAGES } from "./messages";
import { planImport } from "./plan";
import type { ImportedEventType } from "./types";

export interface ImportOutcome {
  created: { id: string; name: string; slug: string; notes: string[] }[];
  failed: { name: string; error: string }[];
}

export async function importEventTypes(store: DataStore, userId: string, items: readonly ImportedEventType[]): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { created: [], failed: [] };
  const slugs = (await store.listEventTypes(userId)).map((e) => e.slug);
  for (const et of items) {
    // Plan one at a time against the slugs as they are now, so a link made meanwhile (another tab) is avoided too.
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const [plan] = planImport([et], slugs);
      if (!plan.ok) {
        outcome.failed.push({ name: plan.name, error: plan.error });
        break;
      }
      try {
        const created = await store.createEventType(userId, plan.draft);
        slugs.push(created.slug);
        await store.setEventTypeActive(userId, created.id, false);
        await store.saveQuestions(userId, created.id, plan.questions);
        outcome.created.push({ id: created.id, name: created.name, slug: created.slug, notes: plan.notes });
        saved = true;
      } catch (e) {
        if (!isNamedError(e, "SlugTakenError")) throw e;
        slugs.splice(0, slugs.length, ...(await store.listEventTypes(userId)).map((x) => x.slug));
        if (attempt === 2) outcome.failed.push({ name: et.name, error: IMPORT_MESSAGES.noFreeLink });
      }
    }
  }
  return outcome;
}
