import type pg from "pg";

// What staff can see. Host accounts only: plan, connections and counts. Never a client's name, email or answers,
// never a secret (integrations show provider and status only), and nothing here changes anything.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

export interface Overview {
  hosts: number; newHosts30d: number; closedHosts: number;
  paidHosts: { solo: number; duo: number }; pastDueHosts: number;
  bookings30d: number; activeMemberships: number; failedNotifications24h: number;
}

export async function overview(db: Db, now: Date): Promise<Overview> {
  const { rows: [r] } = await db.query(
    `select
       (select count(*) from users where deleted_at is null)::int as hosts,
       (select count(*) from users where deleted_at is null and created_at >= $1)::int as new_hosts,
       (select count(*) from users where deleted_at is not null)::int as closed_hosts,
       (select count(*) from subscriptions s join users u on u.id = s.user_id where u.deleted_at is null and s.plan = 'solo' and s.status in ('active','past_due'))::int as solo,
       (select count(*) from subscriptions s join users u on u.id = s.user_id where u.deleted_at is null and s.plan = 'duo' and s.status in ('active','past_due'))::int as duo,
       (select count(*) from subscriptions s join users u on u.id = s.user_id where u.deleted_at is null and s.plan <> 'free' and s.status in ('past_due','unpaid'))::int as past_due,
       (select count(*) from bookings where created_at >= $1 and status = 'confirmed')::int as bookings,
       (select count(*) from memberships where status = 'active' and not cancel_at_period_end)::int as memberships,
       (select count(*) from notifications where status = 'failed' and updated_at >= $2)::int as failed`,
    [new Date(now.getTime() - 30 * DAY), new Date(now.getTime() - DAY)]);
  return {
    hosts: r.hosts, newHosts30d: r.new_hosts, closedHosts: r.closed_hosts, paidHosts: { solo: r.solo, duo: r.duo }, pastDueHosts: r.past_due,
    bookings30d: r.bookings, activeMemberships: r.memberships, failedNotifications24h: r.failed,
  };
}

export interface HostRow {
  id: string; name: string | null; email: string; slug: string; plan: string; planStatus: string | null;
  razorpay: boolean; bookings: number; createdAt: Date; closedAt: Date | null;
}

export const HOSTS_PAGE = 50;

/** Hosts newest first, optionally filtered by part of their name, email or page address. */
export async function listHosts(db: Db, opts: { q?: string; page?: number } = {}): Promise<{ hosts: HostRow[]; total: number }> {
  const q = (opts.q ?? "").trim().slice(0, 100);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  // The search text is a parameter and its LIKE wildcards are escaped, so it can only ever match literally.
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = "($1::text is null or u.email::text ilike $1 or u.name ilike $1 or u.slug::text ilike $1)";
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    db.query(
      `select u.id, u.name, u.email, u.slug, u.created_at, u.deleted_at, coalesce(s.plan, 'free') as plan, s.status as plan_status,
         exists (select 1 from integrations i where i.user_id = u.id and i.provider = 'razorpay' and i.status = 'ok') as razorpay,
         (select count(*) from bookings b where b.host_id = u.id)::int as bookings
       from users u left join subscriptions s on s.user_id = u.id where ${where}
       order by u.created_at desc limit $2 offset $3`, [like, HOSTS_PAGE, (page - 1) * HOSTS_PAGE]),
    db.query(`select count(*)::int as total from users u where ${where}`, [like]),
  ]);
  return {
    total,
    hosts: rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, slug: r.slug, plan: r.plan, planStatus: r.plan_status, razorpay: r.razorpay,
      bookings: r.bookings, createdAt: r.created_at, closedAt: r.deleted_at,
    })),
  };
}

export interface HostDetail {
  id: string; name: string | null; email: string; slug: string; timezone: string; locale: string; createdAt: Date; closedAt: Date | null;
  subscription: { plan: string; interval: string | null; provider: string | null; status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean } | null;
  connections: { provider: string; status: string }[];
  calendars: { provider: string; status: string; lastSyncedAt: Date | null }[];
  counts: { eventTypes: number; bookings: number; upcoming: number; packagesSold: number; activeMembers: number; invoices: number };
  taxRegistered: boolean;
}

/** One host's account, for support. Connection rows carry provider and status only; credentials are never read. */
export async function hostDetail(db: Db, hostId: string, now: Date): Promise<HostDetail | null> {
  if (!UUID.test(hostId)) return null;
  const { rows: [u] } = await db.query("select id, name, email, slug, timezone, locale, created_at, deleted_at from users where id = $1", [hostId]);
  if (!u) return null;
  const [{ rows: [s] }, { rows: connections }, { rows: calendars }, { rows: [c] }] = await Promise.all([
    db.query("select plan, interval, provider, status, current_period_end, cancel_at_period_end from subscriptions where user_id = $1", [hostId]),
    db.query("select provider, status from integrations where user_id = $1 order by provider", [hostId]),
    db.query("select provider, status, last_synced_at from calendar_connections where user_id = $1 order by created_at", [hostId]),
    db.query(
      `select
         (select count(*) from event_types where user_id = $1 and kind <> 'one_off')::int as event_types,
         (select count(*) from bookings where host_id = $1)::int as bookings,
         (select count(*) from bookings where host_id = $1 and status = 'confirmed' and start_at > $2)::int as upcoming,
         (select count(*) from package_purchases where host_id = $1 and status = 'paid')::int as packages,
         (select count(*) from memberships where host_id = $1 and status = 'active' and not cancel_at_period_end)::int as members,
         (select count(*) from invoices where host_id = $1)::int as invoices,
         exists (select 1 from tax_profiles where user_id = $1) as tax`, [hostId, now]),
  ]);
  return {
    id: u.id, name: u.name, email: u.email, slug: u.slug, timezone: u.timezone, locale: u.locale, createdAt: u.created_at, closedAt: u.deleted_at,
    subscription: s ? { plan: s.plan, interval: s.interval, provider: s.provider, status: s.status, currentPeriodEnd: s.current_period_end, cancelAtPeriodEnd: s.cancel_at_period_end } : null,
    connections: connections.map((r) => ({ provider: r.provider, status: r.status })),
    calendars: calendars.map((r) => ({ provider: r.provider, status: r.status, lastSyncedAt: r.last_synced_at })),
    counts: { eventTypes: c.event_types, bookings: c.bookings, upcoming: c.upcoming, packagesSold: c.packages, activeMembers: c.members, invoices: c.invoices },
    taxRegistered: c.tax,
  };
}
