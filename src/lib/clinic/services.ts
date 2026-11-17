import type pg from "pg";
import { ClinicActionError, practiceContext, requirePracticeRole } from "./practices";
import { ClinicAccessError } from "./roles";

// The practice's services, and which practitioner event types offer each. Owners and admins name the services;
// each practitioner links only their own event types (their hours, price and booking link stay theirs).

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PracticeService { id: string; name: string; slug: string; description: string | null; position: number }

export function serviceSlug(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return s || "service";
}

function validate(input: { name: string; description: string }): { name: string; description: string | null } {
  const name = input.name.trim();
  const description = input.description.trim();
  if (name.length < 1 || name.length > 120) throw new ClinicActionError("invalid_name");
  if (description.length > 1000) throw new ClinicActionError("invalid_about");
  return { name, description: description || null };
}

const toService = (r: Record<string, unknown>): PracticeService =>
  ({ id: r.id as string, name: r.name as string, slug: r.slug as string, description: (r.description as string | null) ?? null, position: r.position as number });

export async function listServices(db: Db, practiceId: string): Promise<PracticeService[]> {
  if (!UUID.test(practiceId)) return [];
  const { rows } = await db.query("select id, name, slug, description, position from practice_services where practice_id = $1 order by position, created_at", [practiceId]);
  return rows.map(toService);
}

/** Adds a service. Its slug comes from the name, made unique within the practice. Owner or admin. */
export async function createService(db: Db, actorId: string, input: { name: string; description: string }): Promise<PracticeService> {
  const ctx = await requirePracticeRole(db, actorId, "practice.edit");
  const v = validate(input);
  const base = serviceSlug(v.name);
  for (let n = 1; n <= 20; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 56)}-${n}`;
    const { rows: [r] } = await db.query(
      `insert into practice_services (practice_id, name, slug, description, position)
       values ($1, $2, $3, $4, (select coalesce(max(position), 0) + 1 from practice_services where practice_id = $1))
       on conflict (practice_id, slug) do nothing returning id, name, slug, description, position`, [ctx.practice.id, v.name, slug, v.description]);
    if (r) return toService(r);
  }
  throw new ClinicActionError("slug_taken");
}

export async function updateService(db: Db, actorId: string, serviceId: string, input: { name: string; description: string }): Promise<void> {
  const ctx = await requirePracticeRole(db, actorId, "practice.edit");
  const v = validate(input);
  if (!UUID.test(serviceId)) throw new ClinicActionError("not_found");
  const { rowCount } = await db.query("update practice_services set name = $3, description = $4 where id = $1 and practice_id = $2",
    [serviceId, ctx.practice.id, v.name, v.description]);
  if (!rowCount) throw new ClinicActionError("not_found");
}

/** Removes a service: its links and its waitlist go with it. The practitioners' event types stay. */
export async function deleteService(db: Db, actorId: string, serviceId: string): Promise<void> {
  const ctx = await requirePracticeRole(db, actorId, "practice.edit");
  if (!UUID.test(serviceId)) throw new ClinicActionError("not_found");
  const { rowCount } = await db.query("delete from practice_services where id = $1 and practice_id = $2", [serviceId, ctx.practice.id]);
  if (!rowCount) throw new ClinicActionError("not_found");
}

/**
 * Links one of the actor's own event types to a service of their practice, or unlinks it (serviceId null). Nobody can
 * link someone else's event type, admins included: event types belong to their practitioner.
 */
export async function linkEventType(db: Db, actorId: string, eventTypeId: string, serviceId: string | null): Promise<void> {
  const ctx = await practiceContext(db, actorId);
  if (!ctx) throw new ClinicAccessError("practice.view");
  if (!UUID.test(eventTypeId)) throw new ClinicActionError("not_found");
  const { rows: [et] } = await db.query("select 1 from event_types where id = $1 and user_id = $2", [eventTypeId, actorId]);
  if (!et) throw new ClinicActionError("not_found");
  if (serviceId === null) {
    await db.query("delete from practice_service_event_types where event_type_id = $1", [eventTypeId]);
    return;
  }
  if (!UUID.test(serviceId)) throw new ClinicActionError("not_found");
  const { rows: [s] } = await db.query("select 1 from practice_services where id = $1 and practice_id = $2", [serviceId, ctx.practice.id]);
  if (!s) throw new ClinicActionError("not_found");
  await db.query(
    `insert into practice_service_event_types (service_id, event_type_id) values ($1, $2)
     on conflict (event_type_id) do update set service_id = excluded.service_id`, [serviceId, eventTypeId]);
}

/** The actor's own event types and the service each is linked to, for their practice settings. */
export async function myServiceLinks(db: Db, actorId: string): Promise<{ eventTypeId: string; name: string; serviceId: string | null }[]> {
  if (!UUID.test(actorId)) return [];
  const { rows } = await db.query(
    `select e.id, e.name, l.service_id from event_types e left join practice_service_event_types l on l.event_type_id = e.id
     where e.user_id = $1 and e.kind <> 'one_off' order by e.position, e.created_at`, [actorId]);
  return rows.map((r) => ({ eventTypeId: r.id, name: r.name, serviceId: r.service_id ?? null }));
}
