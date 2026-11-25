import { randomBytes } from "node:crypto";
import type pg from "pg";
import { NotFoundError } from "../data/types";

// Routing forms. A host asks one short question on a shared link (/f/<token>) and lists 2 to 8 answers. Each answer
// either opens one of the host's booking types or shows a short note instead (for example "Please email me first").
// Guests answer with one tap and need no account; nothing they pick is stored.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{32}$/;

export const ROUTING_LIMITS = { minOptions: 2, maxOptions: 8, maxForms: 20, title: 80, question: 200, label: 80, message: 300 } as const;

/** Every error a host can see, in English; the dashboard shows each as its own line in the host's language. */
export const ROUTING_MESSAGES = {
  title: "Give the form a name (up to 80 characters).",
  question: "Write the question (up to 200 characters).",
  optionCount: "Add 2 to 8 answers.",
  optionLabel: "Keep each answer under 80 characters.",
  optionTarget: "Pick a booking type or write a note for each answer, not both.",
  optionMessage: "Keep each note under 300 characters.",
  eventType: "One of the booking types can't be booked any more. Pick another.",
  limit: "You can have up to 20 routing forms. Delete one to add another.",
} as const;

export class InvalidRoutingFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRoutingFormError";
  }
}

export interface RoutingOptionInput { label: string; eventTypeId: string | null; message: string | null }
export interface RoutingFormInput { title: string; question: string; active: boolean; options: RoutingOptionInput[] }

export interface RoutingOption { position: number; label: string; eventTypeId: string | null; message: string | null }
export interface RoutingForm { id: string; token: string; title: string; question: string; active: boolean; options: RoutingOption[] }

/** A booking type a guest can be sent to: active, and not a one-off link (those are used up by one booking). */
export interface RoutableEventType { id: string; name: string; slug: string }

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The form as it will be saved, or an InvalidRoutingFormError naming the first problem. Blank answer rows are dropped. */
export function checkRoutingForm(input: RoutingFormInput): RoutingFormInput {
  const title = squash(input.title);
  const question = squash(input.question);
  if (title.length < 1 || title.length > ROUTING_LIMITS.title) throw new InvalidRoutingFormError(ROUTING_MESSAGES.title);
  if (question.length < 1 || question.length > ROUTING_LIMITS.question) throw new InvalidRoutingFormError(ROUTING_MESSAGES.question);
  const options: RoutingOptionInput[] = [];
  for (const o of input.options) {
    const label = squash(o.label);
    const message = (o.message ?? "").trim() || null;
    const eventTypeId = o.eventTypeId?.trim() || null;
    // A row with no answer and no note is an empty row, whatever its booking-type picker happens to show.
    if (!label && !message) continue;
    if (label.length < 1 || label.length > ROUTING_LIMITS.label) throw new InvalidRoutingFormError(ROUTING_MESSAGES.optionLabel);
    if ((message === null) === (eventTypeId === null)) throw new InvalidRoutingFormError(ROUTING_MESSAGES.optionTarget);
    if (message !== null && message.length > ROUTING_LIMITS.message) throw new InvalidRoutingFormError(ROUTING_MESSAGES.optionMessage);
    if (eventTypeId !== null && !UUID.test(eventTypeId)) throw new InvalidRoutingFormError(ROUTING_MESSAGES.eventType);
    options.push({ label, eventTypeId, message });
  }
  if (options.length < ROUTING_LIMITS.minOptions || options.length > ROUTING_LIMITS.maxOptions) {
    throw new InvalidRoutingFormError(ROUTING_MESSAGES.optionCount);
  }
  return { title, question, active: input.active, options };
}

/** The host's booking types that a routing form can send guests to, in their own order. */
export async function routableEventTypes(db: Db, userId: string): Promise<RoutableEventType[]> {
  const { rows } = await db.query(
    `select id, name, slug from event_types where user_id = $1 and active and kind <> 'one_off' order by position, created_at`, [userId]);
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, slug: r.slug as string }));
}

async function optionsOf(db: Db, formIds: string[]): Promise<Map<string, RoutingOption[]>> {
  const out = new Map<string, RoutingOption[]>();
  if (formIds.length === 0) return out;
  const { rows } = await db.query(
    `select form_id, position, label, event_type_id, message from routing_form_options where form_id = any($1::uuid[]) order by form_id, position`, [formIds]);
  for (const r of rows) {
    const list = out.get(r.form_id as string) ?? [];
    list.push({ position: r.position as number, label: r.label as string, eventTypeId: (r.event_type_id as string | null) ?? null, message: (r.message as string | null) ?? null });
    out.set(r.form_id as string, list);
  }
  return out;
}

const toForm = (r: Record<string, unknown>, options: RoutingOption[]): RoutingForm => ({
  id: r.id as string, token: r.token as string, title: r.title as string, question: r.question as string, active: r.active as boolean, options,
});

export async function listRoutingForms(db: Db, userId: string): Promise<RoutingForm[]> {
  const { rows } = await db.query(
    "select id, token, title, question, active from routing_forms where user_id = $1 order by created_at", [userId]);
  const options = await optionsOf(db, rows.map((r) => r.id as string));
  return rows.map((r) => toForm(r, options.get(r.id as string) ?? []));
}

/** One of the host's own forms; another host's form, or a malformed id, is simply not found. */
export async function routingFormForHost(db: Db, userId: string, id: string): Promise<RoutingForm | null> {
  if (!UUID.test(id)) return null;
  const { rows: [r] } = await db.query(
    "select id, token, title, question, active from routing_forms where id = $1 and user_id = $2", [id, userId]);
  if (!r) return null;
  return toForm(r, (await optionsOf(db, [r.id as string])).get(r.id as string) ?? []);
}

async function tx<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Every chosen booking type must be the host's own and still routable. */
async function checkTargets(db: Db, userId: string, options: RoutingOptionInput[]): Promise<void> {
  const ids = [...new Set(options.map((o) => o.eventTypeId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return;
  const { rows } = await db.query(
    `select id from event_types where id = any($1::uuid[]) and user_id = $2 and active and kind <> 'one_off'`, [ids, userId]);
  if (rows.length !== ids.length) throw new InvalidRoutingFormError(ROUTING_MESSAGES.eventType);
}

async function writeOptions(db: Db, formId: string, options: RoutingOptionInput[]): Promise<void> {
  await db.query("delete from routing_form_options where form_id = $1", [formId]);
  for (const [i, o] of options.entries()) {
    await db.query(
      "insert into routing_form_options (form_id, position, label, event_type_id, message) values ($1, $2, $3, $4, $5)",
      [formId, i + 1, o.label, o.eventTypeId, o.message]);
  }
}

export async function createRoutingForm(pool: pg.Pool, userId: string, input: RoutingFormInput): Promise<{ id: string; token: string }> {
  const form = checkRoutingForm(input);
  return tx(pool, async (db) => {
    // Lock the host's row so two saves at once can't both pass the count check.
    await db.query("select 1 from users where id = $1 for update", [userId]);
    const { rows: [{ n }] } = await db.query("select count(*)::int as n from routing_forms where user_id = $1", [userId]);
    if ((n as number) >= ROUTING_LIMITS.maxForms) throw new InvalidRoutingFormError(ROUTING_MESSAGES.limit);
    await checkTargets(db, userId, form.options);
    const token = randomBytes(16).toString("hex");
    const { rows: [r] } = await db.query(
      "insert into routing_forms (user_id, token, title, question, active) values ($1, $2, $3, $4, $5) returning id",
      [userId, token, form.title, form.question, form.active]);
    await writeOptions(db, r.id as string, form.options);
    return { id: r.id as string, token };
  });
}

export async function updateRoutingForm(pool: pg.Pool, userId: string, id: string, input: RoutingFormInput): Promise<void> {
  const form = checkRoutingForm(input);
  if (!UUID.test(id)) throw new NotFoundError("routing form");
  await tx(pool, async (db) => {
    const { rowCount } = await db.query(
      "update routing_forms set title = $3, question = $4, active = $5, updated_at = now() where id = $1 and user_id = $2",
      [id, userId, form.title, form.question, form.active]);
    if (!rowCount) throw new NotFoundError("routing form");
    await checkTargets(db, userId, form.options);
    await writeOptions(db, id, form.options);
  });
}

export async function deleteRoutingForm(db: Db, userId: string, id: string): Promise<void> {
  if (!UUID.test(id)) throw new NotFoundError("routing form");
  const { rowCount } = await db.query("delete from routing_forms where id = $1 and user_id = $2", [id, userId]);
  if (!rowCount) throw new NotFoundError("routing form");
}

/** What a guest sees: each answer either opens a booking page (`href`) or shows a note (`message`). */
export interface PublicRoutingForm {
  host: { name: string; locale: string };
  title: string;
  question: string;
  options: { position: number; label: string; href: string | null; message: string | null }[];
}

/**
 * The form behind a shared link, or null when there is no such form, it is switched off, or its host is gone.
 * An answer whose booking type was deleted or switched off since is left out, so a guest never reaches a dead page.
 */
export async function routingFormByToken(db: Db, token: string): Promise<PublicRoutingForm | null> {
  if (!TOKEN.test(token)) return null;
  const { rows: [r] } = await db.query(
    `select f.id, f.user_id, f.title, f.question, coalesce(u.name, '') as host_name, u.locale as host_locale, u.slug as host_slug
       from routing_forms f join users u on u.id = f.user_id
      where f.token = $1 and f.active and u.deleted_at is null`, [token]);
  if (!r) return null;
  const { rows } = await db.query(
    `select o.position, o.label, o.message, e.slug as event_slug
       from routing_form_options o
       left join event_types e on e.id = o.event_type_id and e.user_id = $2 and e.active and e.kind <> 'one_off'
      where o.form_id = $1 order by o.position`, [r.id, r.user_id]);
  const options = rows
    .map((o) => ({
      position: o.position as number,
      label: o.label as string,
      href: o.event_slug ? `/${encodeURIComponent(r.host_slug as string)}/${encodeURIComponent(o.event_slug as string)}` : null,
      message: (o.message as string | null) ?? null,
    }))
    .filter((o) => o.href !== null || o.message !== null);
  return { host: { name: r.host_name as string, locale: r.host_locale as string }, title: r.title as string, question: r.question as string, options };
}
