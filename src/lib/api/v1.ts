// B14: the read-only API's answers (/api/v1). Every query is scoped to the key owner's own account.
import type pg from "pg";
import { BOOKING_PAYLOAD_COLUMNS, BOOKING_PAYLOAD_FROM, bookingPayload, type BookingPayload } from "./booking-payload";

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiAnswer = { status: number; body: unknown };
const ok = (body: unknown): ApiAnswer => ({ status: 200, body });
export const notFound = (): ApiAnswer => ({ status: 404, body: { error: "not_found", message: "No such item on this account." } });
const badRequest = (param: string, message: string): ApiAnswer => ({ status: 400, body: { error: "bad_request", param, message } });

export interface ApiContext { db: Db; userId: string; base: string; now: Date }

const trimSlash = (base: string) => base.replace(/\/+$/, "");

export async function getMe({ db, userId, base }: ApiContext): Promise<ApiAnswer> {
  const { rows: [u] } = await db.query("select id, name, slug, timezone from users where id = $1", [userId]);
  if (!u) return notFound();
  return ok({ id: u.id, name: u.name ?? null, slug: u.slug, timezone: u.timezone, booking_page: `${trimSlash(base)}/${u.slug}` });
}

export async function listEventTypes({ db, userId, base }: ApiContext): Promise<ApiAnswer> {
  const { rows } = await db.query(
    `select e.id, e.name, e.slug, e.duration_minutes, e.active, e.hidden, e.price_minor, e.currency, u.slug as user_slug
     from event_types e join users u on u.id = e.user_id
     where e.user_id = $1 and e.kind <> 'one_off' order by e.position, e.created_at, e.id`, [userId]);
  return ok({
    data: rows.map((r) => ({
      id: r.id, name: r.name, slug: r.slug, duration_minutes: r.duration_minutes, active: r.active, hidden: r.hidden,
      price_minor: r.price_minor ?? null, currency: r.currency ?? null, booking_url: `${trimSlash(base)}/${r.user_slug}/${r.slug}`,
    })),
  });
}

export const BOOKING_STATUSES = ["upcoming", "past", "cancelled", "all"] as const;
type StatusFilter = (typeof BOOKING_STATUSES)[number];
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface BookingsQuery { status: StatusFilter; from: Date | null; to: Date | null; limit: number; after: { start: Date; id: string } | null }

/** A page ends at a booking; the next page starts after its start time and id. */
export function encodeCursor(start: Date, id: string): string {
  return Buffer.from(`${start.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { start: Date; id: string } | null {
  const [iso, id, extra] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const start = new Date(iso ?? "");
  return extra === undefined && id && UUID.test(id) && !Number.isNaN(start.getTime()) ? { start, id } : null;
}

function parseTime(value: string | null): Date | null | undefined {
  if (value === null) return null;
  const d = new Date(value);
  return value.trim() && !Number.isNaN(d.getTime()) ? d : undefined;
}

/** Reads the query string. A value that can't be used is an error naming the parameter, never silently ignored. */
export function parseBookingsQuery(params: URLSearchParams): { ok: true; query: BookingsQuery } | { ok: false; answer: ApiAnswer } {
  const r = readBookingsQuery(params);
  return "body" in r ? { ok: false, answer: r } : { ok: true, query: r };
}

function readBookingsQuery(params: URLSearchParams): BookingsQuery | ApiAnswer {
  const status = params.get("status") ?? "all";
  if (!(BOOKING_STATUSES as readonly string[]).includes(status)) return badRequest("status", `Use one of: ${BOOKING_STATUSES.join(", ")}.`);
  const from = parseTime(params.get("from"));
  if (from === undefined) return badRequest("from", "Use an ISO 8601 time, like 2026-12-01T00:00:00Z.");
  const to = parseTime(params.get("to"));
  if (to === undefined) return badRequest("to", "Use an ISO 8601 time, like 2026-12-31T00:00:00Z.");
  if (from && to && from >= to) return badRequest("to", "Must be after from.");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return badRequest("limit", `Use a whole number from 1 to ${MAX_LIMIT}.`);
  const rawCursor = params.get("cursor");
  const after = rawCursor === null ? null : decodeCursor(rawCursor);
  if (rawCursor !== null && !after) return badRequest("cursor", "Pass next_cursor from the previous page as it came.");
  return { status: status as StatusFilter, from, to, limit, after };
}

export async function listBookings(ctx: ApiContext, params: URLSearchParams): Promise<ApiAnswer> {
  const parsed = parseBookingsQuery(params);
  if (!parsed.ok) return parsed.answer;
  const { query } = parsed;
  const where = ["b.host_id = $1"];
  const args: unknown[] = [ctx.userId];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (query.status === "upcoming") where.push(`b.status = 'confirmed' and b.end_at > ${arg(ctx.now)}`);
  if (query.status === "past") where.push(`b.status = 'confirmed' and b.end_at <= ${arg(ctx.now)}`);
  if (query.status === "cancelled") where.push("b.status = 'cancelled'");
  if (query.from) where.push(`b.start_at >= ${arg(query.from)}`);
  if (query.to) where.push(`b.start_at < ${arg(query.to)}`);
  if (query.after) where.push(`(b.start_at, b.id) > (${arg(query.after.start)}, ${arg(query.after.id)}::uuid)`);
  const { rows } = await ctx.db.query(
    `select ${BOOKING_PAYLOAD_COLUMNS} from ${BOOKING_PAYLOAD_FROM}
     where ${where.join(" and ")} order by b.start_at, b.id limit ${query.limit + 1}`, args);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const more = rows.length > query.limit && last;
  return ok({ data: page.map(bookingPayload), next_cursor: more ? encodeCursor(new Date(last.start_at), last.id) : null });
}

export async function getBooking({ db, userId }: ApiContext, id: string): Promise<ApiAnswer> {
  if (!UUID.test(id)) return notFound();
  const { rows: [r] } = await db.query(`select ${BOOKING_PAYLOAD_COLUMNS} from ${BOOKING_PAYLOAD_FROM} where b.id = $1 and b.host_id = $2`, [id, userId]);
  return r ? ok(bookingPayload(r) satisfies BookingPayload) : notFound();
}

// B24: paid questions (B19) and digital product orders (B20), oldest first, a page at a time, filtered by status.
export const QUESTION_STATUSES = ["pending", "open", "answered", "declined", "failed", "refund_pending", "refunded"] as const;
export const ORDER_STATUSES = ["pending", "paid", "failed", "refund_pending", "refunded"] as const;

interface SalesQuery { status: string | null; limit: number; after: { start: Date; id: string } | null }

function readSalesQuery(params: URLSearchParams, statuses: readonly string[]): SalesQuery | ApiAnswer {
  const raw = params.get("status") ?? "all";
  if (raw !== "all" && !statuses.includes(raw)) return badRequest("status", `Use all or one of: ${statuses.join(", ")}.`);
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return badRequest("limit", `Use a whole number from 1 to ${MAX_LIMIT}.`);
  const rawCursor = params.get("cursor");
  const after = rawCursor === null ? null : decodeCursor(rawCursor);
  if (rawCursor !== null && !after) return badRequest("cursor", "Pass next_cursor from the previous page as it came.");
  return { status: raw === "all" ? null : raw, limit, after };
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** One page of the host's rows, oldest first, with the cursor on (created_at, id). */
async function salesPage(
  ctx: ApiContext, params: URLSearchParams, statuses: readonly string[],
  sql: { columns: string; from: string; alias: string }, shape: (r: Record<string, unknown>) => unknown,
): Promise<ApiAnswer> {
  const q = readSalesQuery(params, statuses);
  if ("body" in q) return q;
  const { alias } = sql;
  const args: unknown[] = [ctx.userId];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const where = [`${alias}.host_id = $1`];
  if (q.status) where.push(`${alias}.status = ${arg(q.status)}`);
  if (q.after) where.push(`(${alias}.created_at, ${alias}.id) > (${arg(q.after.start)}, ${arg(q.after.id)}::uuid)`);
  const { rows } = await ctx.db.query(
    `select ${sql.columns} from ${sql.from} where ${where.join(" and ")} order by ${alias}.created_at, ${alias}.id limit ${q.limit + 1}`, args);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const more = rows.length > q.limit && last;
  return ok({ data: page.map(shape), next_cursor: more ? encodeCursor(new Date(last.created_at), last.id) : null });
}

export async function listQuestionsApi(ctx: ApiContext, params: URLSearchParams): Promise<ApiAnswer> {
  return salesPage(ctx, params, QUESTION_STATUSES, {
    columns: "q.id, q.status, q.guest_name, q.guest_email::text as guest_email, q.question, q.answer, q.price_minor, q.currency, q.due_at, q.answered_at, q.expired_at, q.created_at",
    from: "questions q", alias: "q",
  }, (r) => ({
    id: r.id, status: r.status, guest_name: r.guest_name, guest_email: r.guest_email, question: r.question, answer: r.answer ?? null,
    price_minor: r.price_minor, currency: r.currency, due_at: iso(r.due_at), answered_at: iso(r.answered_at),
    expired: r.expired_at != null, created_at: iso(r.created_at),
  }));
}

export async function listOrdersApi(ctx: ApiContext, params: URLSearchParams): Promise<ApiAnswer> {
  return salesPage(ctx, params, ORDER_STATUSES, {
    columns: "o.id, o.status, o.product_id, p.title as product_title, o.buyer_name, o.buyer_email::text as buyer_email, o.price_minor, o.currency, o.paid_at, o.download_count, o.created_at",
    from: "product_orders o join digital_products p on p.id = o.product_id", alias: "o",
  }, (r) => ({
    id: r.id, status: r.status, product_id: r.product_id, product_title: r.product_title, buyer_name: r.buyer_name, buyer_email: r.buyer_email,
    price_minor: r.price_minor, currency: r.currency, paid_at: iso(r.paid_at), downloads: r.download_count, created_at: iso(r.created_at),
  }));
}
