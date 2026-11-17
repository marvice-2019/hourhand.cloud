// A host's intake templates in Postgres (intake_templates). Every read and write is scoped to one host's user_id; the
// dashboard never trusts a template or event type id it got from the browser without that check.
import type pg from "pg";
import type { DataStore, QuestionDraft } from "../data/types";
import { checkQuestions, validateQuestions, type QuestionErrorCodes } from "../event-types";
import { applyTemplateToDrafts, TEMPLATE_MAX_QUESTIONS, toDrafts, toTemplateQuestions, type TemplateQuestion } from "./templates-shape";
import { starterByKey } from "./starters";

type Db = Pick<pg.Pool, "query">;

export interface IntakeTemplate {
  id: string;
  userId: string;
  name: string;
  questions: TemplateQuestion[];
  /** Made from a starter example and not yet saved by the host. */
  example: boolean;
  updatedAt: Date;
}

const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const COLS = "id, user_id, name, questions, example, updated_at";
const toTemplate = (r: Record<string, unknown>): IntakeTemplate => ({
  id: r.id as string, userId: r.user_id as string, name: r.name as string, questions: r.questions as TemplateQuestion[],
  example: r.example as boolean, updatedAt: r.updated_at as Date,
});

export type TemplateCheck =
  | { ok: true; name: string; questions: TemplateQuestion[] }
  | { ok: false; nameError?: "name"; formError?: "tooMany" | "empty"; questionCodes: QuestionErrorCodes };

/** The same checks as an event type's questions, plus a name and a cap. Errors are codes the dashboard translates. */
export function checkTemplate(name: unknown, questions: readonly QuestionDraft[]): TemplateCheck {
  const n = typeof name === "string" ? name.trim() : "";
  const nameError = n.length < 1 || n.length > 80 ? "name" as const : undefined;
  const list = Array.isArray(questions) ? questions : [];
  const formError = list.length > TEMPLATE_MAX_QUESTIONS ? "tooMany" as const : list.length === 0 ? "empty" as const : undefined;
  const checked = checkQuestions(list.map((q) => ({ ...q, id: null })));
  if (nameError || formError || !checked.ok) return { ok: false, nameError, formError, questionCodes: checked.ok ? [] : checked.codes };
  return { ok: true, name: n, questions: toTemplateQuestions(checked.value) };
}

export async function listTemplates(db: Db, userId: string): Promise<IntakeTemplate[]> {
  if (!isId(userId)) return [];
  const { rows } = await db.query(`select ${COLS} from intake_templates where user_id = $1 order by created_at, id`, [userId]);
  return rows.map(toTemplate);
}

export async function getTemplate(db: Db, userId: string, id: string): Promise<IntakeTemplate | null> {
  if (!isId(userId) || !isId(id)) return null;
  const { rows } = await db.query(`select ${COLS} from intake_templates where id = $1 and user_id = $2`, [id, userId]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

/** Saves checked questions as a new template. */
export async function createTemplate(db: Db, userId: string, name: string, questions: TemplateQuestion[], opts: { example?: boolean; now?: Date } = {}): Promise<IntakeTemplate> {
  const now = opts.now ?? new Date();
  const { rows } = await db.query(
    `insert into intake_templates (user_id, name, questions, example, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $5, $5) returning ${COLS}`,
    [userId, name, JSON.stringify(questions), opts.example === true, now]);
  return toTemplate(rows[0]);
}

/** A starter example copied into the host's own templates, marked as an example until they save it. */
export async function createFromStarter(db: Db, userId: string, key: string, now = new Date(), name?: string): Promise<IntakeTemplate | null> {
  const starter = starterByKey(key);
  if (!starter) return null;
  return createTemplate(db, userId, (name ?? `${starter.name} (example)`).slice(0, 80), starter.questions, { example: true, now });
}

/**
 * Replaces a template's name and questions. Event types it was applied to keep their copies until it is applied again,
 * and past bookings keep the labels they were asked with. Null when it isn't this host's.
 */
export async function updateTemplate(db: Db, userId: string, id: string, name: string, questions: TemplateQuestion[], now = new Date()): Promise<IntakeTemplate | null> {
  if (!isId(userId) || !isId(id)) return null;
  const { rows } = await db.query(
    `update intake_templates set name = $3, questions = $4::jsonb, example = false, updated_at = $5 where id = $1 and user_id = $2 returning ${COLS}`,
    [id, userId, name, JSON.stringify(questions), now]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

/** Deletes it; questions copied from it stay on their event types (their template link is cleared). */
export async function deleteTemplate(db: Db, userId: string, id: string): Promise<boolean> {
  if (!isId(userId) || !isId(id)) return false;
  const { rowCount } = await db.query("delete from intake_templates where id = $1 and user_id = $2", [id, userId]);
  return (rowCount ?? 0) > 0;
}

export type ApplyResult = { applied: string[]; skipped: { eventTypeId: string; reason: string }[] };

/**
 * Copies the template's current questions into each of the host's event types named. Questions an event type already got
 * from this template are replaced; its other questions stay. Each event type is saved on its own (one transaction each).
 */
export async function applyTemplate(db: Db, store: Pick<DataStore, "getEventType" | "listCustomQuestions" | "saveQuestions">, userId: string, templateId: string, eventTypeIds: readonly string[]): Promise<ApplyResult | null> {
  const template = await getTemplate(db, userId, templateId);
  if (!template) return null;
  const result: ApplyResult = { applied: [], skipped: [] };
  for (const eventTypeId of [...new Set(eventTypeIds)]) {
    const eventType = await store.getEventType(userId, eventTypeId);
    if (!eventType) { result.skipped.push({ eventTypeId, reason: "not_found" }); continue; }
    const merged = applyTemplateToDrafts(toDrafts(await store.listCustomQuestions(userId, eventTypeId)), template.questions, template.id);
    let checked = validateQuestions(merged);
    // A kept question whose condition no longer fits after the merge is asked always rather than blocking the rest.
    if (!checked.ok) {
      const errors = checked.errors;
      checked = validateQuestions(merged.map((q, i) => (errors[i]?.condition ? { ...q, showIf: null } : q)));
    }
    if (!checked.ok) { result.skipped.push({ eventTypeId, reason: "invalid" }); continue; }
    await store.saveQuestions(userId, eventTypeId, checked.value);
    result.applied.push(eventTypeId);
  }
  return result;
}
