import type pg from "pg";
import { domainEntitled } from "../billing/addons";
import type { DnsCheck } from "./dns";

// Reading and writing custom_domains. Every write is scoped to one host's user_id; the dashboard never passes a row id
// it got from the browser.

type Db = Pick<pg.Pool, "query">;

export type DomainStatus = "pending" | "active" | "failed";

export interface CustomDomain {
  id: string;
  userId: string;
  domain: string;
  status: DomainStatus;
  lastCheckedAt: Date | null;
  verifiedAt: Date | null;
  lastError: string | null;
}

const COLS = "id, user_id, domain::text as domain, status, last_checked_at, verified_at, last_error";
const toDomain = (r: Record<string, unknown>): CustomDomain => ({
  id: r.id as string, userId: r.user_id as string, domain: r.domain as string, status: r.status as DomainStatus,
  lastCheckedAt: (r.last_checked_at as Date | null) ?? null, verifiedAt: (r.verified_at as Date | null) ?? null, lastError: (r.last_error as string | null) ?? null,
});

export async function getDomain(db: Db, userId: string): Promise<CustomDomain | null> {
  const { rows } = await db.query(`select ${COLS} from custom_domains where user_id = $1`, [userId]);
  return rows[0] ? toDomain(rows[0]) : null;
}

/**
 * Sets the host's one domain (replacing any earlier one, which then stops serving) as pending. "taken" when another
 * host already has it. Returns the domain it replaced, so its certificate config can be removed.
 */
export async function setDomain(db: Db, userId: string, domain: string, now = new Date()): Promise<{ result: "ok"; replaced: string | null } | { result: "taken" }> {
  const before = await getDomain(db, userId);
  if (before?.domain === domain) return { result: "ok", replaced: null };
  try {
    await db.query(
      `insert into custom_domains (user_id, domain, status, created_at, updated_at) values ($1, $2, 'pending', $3, $3)
       on conflict (user_id) do update set domain = excluded.domain, status = 'pending', last_checked_at = null, verified_at = null,
         last_error = null, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      [userId, domain, now]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return { result: "taken" };
    throw error;
  }
  return { result: "ok", replaced: before?.domain ?? null };
}

/** Removes the host's domain. Returns what was removed, or null when there was none. */
export async function removeDomain(db: Db, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ domain: string }>("delete from custom_domains where user_id = $1 returning domain::text as domain", [userId]);
  return rows[0]?.domain ?? null;
}

/**
 * Saves a DNS check. A pass makes the domain active. A definite miss (no record, or one pointing elsewhere) marks it
 * failed. A lookup that didn't answer only records the reason: a DNS hiccup must not take a live domain down.
 * Scoped to the domain as it was checked, so a check that raced a change of domain saves nothing.
 */
export async function recordCheck(db: Db, row: Pick<CustomDomain, "id" | "domain">, check: DnsCheck, now = new Date()): Promise<CustomDomain | null> {
  const status = check.ok ? "active" : check.transient ? null : "failed";
  const { rows } = await db.query(
    `update custom_domains set last_checked_at = $3, updated_at = $3,
       status = coalesce($4, status),
       verified_at = case when $4 = 'active' then coalesce(verified_at, $3) else verified_at end,
       last_error = $5
     where id = $1 and domain = $2 returning ${COLS}`,
    [row.id, row.domain, now, status, check.ok ? null : check.reason.slice(0, 500)]);
  return rows[0] ? toDomain(rows[0]) : null;
}

/** Domains whose last check is older than `olderThanMs` (never-checked first), for the scheduled re-check. */
export async function domainsDue(db: Db, now: Date, olderThanMs: number, limit = 50): Promise<CustomDomain[]> {
  const { rows } = await db.query(
    `select ${COLS} from custom_domains where last_checked_at is null or last_checked_at < $1
     order by last_checked_at nulls first limit $2`, [new Date(now.getTime() - olderThanMs), limit]);
  return rows.map(toDomain);
}

/** What the request router needs to know about a hostname. */
export interface DomainRoute {
  userId: string;
  slug: string;
  /** True when the domain may serve the host's pages right now; otherwise visitors go to hourhand.cloud/<slug>. */
  serving: boolean;
}

/**
 * The host behind a custom domain, or null when no host (that still has an account) has claimed it. It serves only
 * when DNS is verified, the add-on is live and the host is on a paid plan.
 */
export async function lookupDomainRoute(db: Db, host: string, now = new Date()): Promise<DomainRoute | null> {
  const { rows } = await db.query<{ user_id: string; slug: string; status: DomainStatus }>(
    `select d.user_id, u.slug::text as slug, d.status from custom_domains d join users u on u.id = d.user_id
     where d.domain = $1 and u.deleted_at is null`, [host]);
  const r = rows[0];
  if (!r) return null;
  return { userId: r.user_id, slug: r.slug, serving: r.status === "active" && (await domainEntitled(db, r.user_id, now)) };
}

/** Whose booking a manage link (/b/<token>) belongs to, or null. */
export async function bookingHostForToken(db: Db, token: string): Promise<string | null> {
  const { rows } = await db.query<{ host_id: string }>(
    "select host_id from invitees where manage_token = $1 limit 1", [token]);
  return rows[0]?.host_id ?? null;
}
