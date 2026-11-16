import type pg from "pg";
import { BillingApiError } from "../billing/providers";
import { NotFoundError } from "../data/types";
import { parsePrice, PRICE_INVALID } from "../event-types";
import { invoiceForMembershipGrant } from "../gst/invoices";
import { kickJobs } from "../jobs/kick";
import { PackageUnavailableError } from "../packages/packages";
import { TOTAL_MONTHS, type MembershipEvent, type MembershipProvider, type MembershipStatus } from "./provider";

// Memberships: a host sells "N sessions a month for ₹X", renewed automatically by a subscription on the host's own
// Razorpay account. Credits come only from a verified charge (applyMembershipEvent, called from the signed webhook),
// each charge adding one grant of N credits. A booking made through the member's link uses one credit of a grant; a
// cancelled booking gives it back, because "used" is counted from bookings and never stored.

type Db = Pick<pg.Pool, "query">;
type Client = Pick<pg.PoolClient, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MEMBERSHIP_TOKEN = /^m[0-9a-f]{48}$/;

/** A member's link token, which rides in the booking API's packageToken field (package tokens are 48 hex digits). */
export const isMembershipToken = (token: string) => MEMBERSHIP_TOKEN.test(token);

export type Rollover = "none" | "capped" | "unlimited";
export const MEMBERSHIP_LIMITS = { sessions: { min: 1, max: 60 }, rolloverCap: { min: 1, max: 600 }, maxEventTypes: 10 } as const;
/**
 * RBI: a recurring e-mandate debit above ₹15,000 needs the client's extra authentication (OTP / UPI PIN) every time, so
 * it can't renew silently. Allowed, but the host is warned.
 */
export const AFA_FREE_LIMIT_MINOR = 1_500_000;

export interface MembershipPlan {
  id: string; userId: string; name: string; sessions: number; priceMinor: number; rollover: Rollover; rolloverCap: number | null;
  provider: string; providerPlanId: string; active: boolean; createdAt: Date; eventTypeIds: string[];
}

export interface PlanInput { name: string; sessions: number; priceMinor: number; rollover: Rollover; rolloverCap: number | null; eventTypeIds: string[] }

export type PlanFormErrors = Partial<Record<"name" | "sessions" | "price" | "rollover" | "rolloverCap" | "eventTypeIds", string>>;

/** Checks the host's membership form. Price in rupees as typed. */
export function validatePlanForm(form: { name: string; sessions: string; price: string; rollover: string; rolloverCap: string; eventTypeIds: string[] }):
  { ok: true; value: PlanInput } | { ok: false; errors: PlanFormErrors } {
  const errors: PlanFormErrors = {};
  const whole = (raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null);
  const name = form.name.trim();
  if (name.length < 1 || name.length > 100) errors.name = "Give it a name, up to 100 characters.";
  const sessions = whole(form.sessions);
  const { sessions: s, rolloverCap: c, maxEventTypes } = MEMBERSHIP_LIMITS;
  if (sessions === null || sessions < s.min || sessions > s.max) errors.sessions = `Enter ${s.min} to ${s.max} sessions a month.`;
  const price = parsePrice(form.price);
  if (price === "invalid" || price === null) errors.price = PRICE_INVALID;
  const rollover = form.rollover as Rollover;
  if (!["none", "capped", "unlimited"].includes(rollover)) errors.rollover = "Pick what happens to unused sessions.";
  let rolloverCap: number | null = null;
  if (rollover === "capped") {
    rolloverCap = whole(form.rolloverCap);
    if (rolloverCap === null || rolloverCap < c.min || rolloverCap > c.max) errors.rolloverCap = `Enter ${c.min} to ${c.max} sessions.`;
  }
  const ids = [...new Set(form.eventTypeIds)];
  if (ids.length === 0 || ids.some((id) => !UUID.test(id))) errors.eventTypeIds = "Pick at least one event type the sessions can be booked for.";
  else if (ids.length > maxEventTypes) errors.eventTypeIds = `Pick up to ${maxEventTypes} event types.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, sessions: sessions!, priceMinor: price as number, rollover, rolloverCap, eventTypeIds: ids } };
}

const PLAN = `p.id, p.user_id, p.name, p.sessions, p.price_minor, p.rollover, p.rollover_cap, p.provider, p.provider_plan_id, p.active, p.created_at,
  array(select pe.event_type_id from membership_plan_event_types pe where pe.plan_id = p.id order by pe.event_type_id) as event_type_ids`;
const toPlan = (r: Record<string, unknown>): MembershipPlan => ({
  id: r.id as string, userId: r.user_id as string, name: r.name as string, sessions: r.sessions as number, priceMinor: r.price_minor as number,
  rollover: r.rollover as Rollover, rolloverCap: (r.rollover_cap as number | null) ?? null, provider: r.provider as string,
  providerPlanId: r.provider_plan_id as string, active: r.active as boolean, createdAt: r.created_at as Date, eventTypeIds: r.event_type_ids as string[],
});

async function inTx<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

export class MembershipProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "MembershipProviderError";
  }
}
const providerError = (what: string, error: unknown) =>
  new MembershipProviderError(`${what}: ${(error as Error).message}`, error instanceof BillingApiError && error.retryable);

/**
 * Creates the plan on the host's payment account first, then here. Only the host's own active one-on-one event types
 * can be linked; anything else is NotFound and nothing is created anywhere.
 */
export async function createMembershipPlan(deps: { pool: pg.Pool; provider: MembershipProvider }, hostId: string, input: PlanInput): Promise<MembershipPlan> {
  const { pool, provider } = deps;
  if (!UUID.test(hostId)) throw new NotFoundError("Event type");
  const { rows } = await pool.query(
    "select id from event_types where user_id = $1 and id = any($2::uuid[]) and active and kind = 'one_on_one'", [hostId, input.eventTypeIds]);
  if (rows.length !== input.eventTypeIds.length) throw new NotFoundError("Event type");
  let planId: string;
  try {
    ({ id: planId } = await provider.createPlan({ name: input.name, amountMinor: input.priceMinor, currency: "INR", notes: { hourhand_host: hostId } }));
  } catch (error) {
    throw providerError("Plan could not be created", error);
  }
  const id = await inTx(pool, async (client) => {
    const { rows: [p] } = await client.query(
      `insert into membership_plans (user_id, name, sessions, price_minor, rollover, rollover_cap, provider, provider_plan_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [hostId, input.name, input.sessions, input.priceMinor, input.rollover, input.rolloverCap, provider.name, planId]);
    await client.query("insert into membership_plan_event_types (plan_id, event_type_id) select $1, unnest($2::uuid[])", [p.id, input.eventTypeIds]);
    return p.id as string;
  });
  return (await planById(pool, id))!;
}

async function planById(db: Db, id: string): Promise<MembershipPlan | null> {
  const { rows: [r] } = await db.query(`select ${PLAN} from membership_plans p where p.id = $1`, [id]);
  return r ? toPlan(r) : null;
}

export async function listMembershipPlans(db: Db, hostId: string): Promise<MembershipPlan[]> {
  if (!UUID.test(hostId)) return [];
  return (await db.query(`select ${PLAN} from membership_plans p where p.user_id = $1 order by p.created_at`, [hostId])).rows.map(toPlan);
}

/** Taking a plan off sale stops new sign-ups; current members keep renewing until they cancel. */
export async function setPlanActive(db: Db, hostId: string, planId: string, active: boolean): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(planId)) throw new NotFoundError("Membership plan");
  const { rowCount } = await db.query("update membership_plans set active = $3 where id = $1 and user_id = $2", [planId, hostId, active]);
  if (!rowCount) throw new NotFoundError("Membership plan");
}

export interface PublicPlan { plan: MembershipPlan; host: { id: string; name: string; slug: string }; eventTypes: { id: string; name: string; slug: string; durationMinutes: number }[] }

/** A plan someone can join now: on sale, its host's account open, with the linked event types still bookable. */
export async function publicMembershipPlan(db: Db, planId: string): Promise<PublicPlan | null> {
  if (!UUID.test(planId)) return null;
  const { rows: [r] } = await db.query(
    `select ${PLAN}, u.name as host_name, u.slug as host_slug from membership_plans p join users u on u.id = p.user_id
     where p.id = $1 and p.active and u.deleted_at is null`, [planId]);
  if (!r) return null;
  const { rows: ets } = await db.query(
    `select e.id, e.name, e.slug, e.duration_minutes from membership_plan_event_types pe join event_types e on e.id = pe.event_type_id
     where pe.plan_id = $1 and e.active and e.kind = 'one_on_one' order by e.name`, [planId]);
  if (ets.length === 0) return null;
  return {
    plan: toPlan(r), host: { id: r.user_id, name: r.host_name, slug: r.host_slug },
    eventTypes: ets.map((e) => ({ id: e.id, name: e.name, slug: e.slug, durationMinutes: e.duration_minutes })),
  };
}

// ---------- Members ----------

export interface Membership {
  id: string; planId: string; planName: string; hostId: string; sessions: number; priceMinor: number; rollover: Rollover; rolloverCap: number | null;
  guestName: string; guestEmail: string; guestPhone: string | null; token: string; status: MembershipStatus; cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null; paidThrough: Date | null; failedPayments: number; lastFailureAt: Date | null; endedAt: Date | null;
  shortUrl: string | null; createdAt: Date; charges: number;
}

const MEMBERSHIP = `select m.id, m.plan_id, p.name as plan_name, m.host_id, m.sessions, m.price_minor, m.rollover, m.rollover_cap, m.guest_name, m.guest_email,
  m.guest_phone, m.token, m.status, m.cancel_at_period_end, m.current_period_end, m.paid_through, m.failed_payments, m.last_failure_at, m.ended_at,
  m.short_url, m.created_at, (select count(*)::int from membership_grants g where g.membership_id = m.id) as charges
  from memberships m join membership_plans p on p.id = m.plan_id`;
const toMembership = (r: Record<string, unknown>): Membership => ({
  id: r.id as string, planId: r.plan_id as string, planName: r.plan_name as string, hostId: r.host_id as string, sessions: r.sessions as number,
  priceMinor: r.price_minor as number, rollover: r.rollover as Rollover, rolloverCap: (r.rollover_cap as number | null) ?? null,
  guestName: r.guest_name as string, guestEmail: r.guest_email as string, guestPhone: (r.guest_phone as string | null) ?? null, token: r.token as string,
  status: r.status as MembershipStatus, cancelAtPeriodEnd: r.cancel_at_period_end as boolean, currentPeriodEnd: (r.current_period_end as Date | null) ?? null,
  paidThrough: (r.paid_through as Date | null) ?? null, failedPayments: r.failed_payments as number, lastFailureAt: (r.last_failure_at as Date | null) ?? null,
  endedAt: (r.ended_at as Date | null) ?? null, shortUrl: (r.short_url as string | null) ?? null, createdAt: r.created_at as Date, charges: r.charges as number,
});

/**
 * Whether the membership is still renewing. A renewing membership's credits are bounded only by their grants; one that
 * won't renew (payment failing, halted, cancelling, ended) can book only sessions that start before its paid month ends.
 */
export const isRenewing = (m: { status: string; cancelAtPeriodEnd: boolean }) => m.status === "active" && !m.cancelAtPeriodEnd;

export async function membershipByToken(db: Db, token: string): Promise<Membership | null> {
  if (!MEMBERSHIP_TOKEN.test(token)) return null;
  const { rows: [r] } = await db.query(`${MEMBERSHIP} where m.token = $1`, [token]);
  return r ? toMembership(r) : null;
}

/** Everyone who signed up and got as far as a provider subscription, newest first. */
export async function listMembers(db: Db, hostId: string): Promise<(Membership & { creditsLeft: number })[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(`${MEMBERSHIP} where m.host_id = $1 and m.status <> 'created' order by m.created_at desc limit 500`, [hostId]);
  const now = new Date();
  return Promise.all(rows.map(async (r) => {
    const m = toMembership(r);
    return { ...m, creditsLeft: await creditsLeft(db, m, now) };
  }));
}

interface GrantLeft { id: string; expiresAt: Date | null; left: number }

async function grantsLeft(db: Client, membershipId: string): Promise<GrantLeft[]> {
  const { rows } = await db.query(
    `select g.id, g.expires_at, g.credits - g.forfeited - (select count(*)::int from bookings b where b.membership_grant_id = g.id and b.status <> 'cancelled') as left
     from membership_grants g where g.membership_id = $1 order by g.expires_at nulls last, g.granted_at`, [membershipId]);
  return rows.map((r) => ({ id: r.id, expiresAt: r.expires_at, left: Math.max(0, r.left) }));
}

/** Credits a member can still book with right now. */
export async function creditsLeft(db: Client, m: Pick<Membership, "id" | "status" | "cancelAtPeriodEnd" | "paidThrough">, now: Date): Promise<number> {
  if (!isRenewing(m) && (!m.paidThrough || m.paidThrough <= now)) return 0;
  return (await grantsLeft(db, m.id)).filter((g) => !g.expiresAt || g.expiresAt > now).reduce((n, g) => n + g.left, 0);
}

/** The event types a member's credits can book, still active. */
export async function memberEventTypes(db: Db, planId: string): Promise<{ id: string; name: string; slug: string; durationMinutes: number }[]> {
  const { rows } = await db.query(
    `select e.id, e.name, e.slug, e.duration_minutes from membership_plan_event_types pe join event_types e on e.id = pe.event_type_id
     where pe.plan_id = $1 and e.active and e.kind = 'one_on_one' order by e.name`, [planId]);
  return rows.map((e) => ({ id: e.id, name: e.name, slug: e.slug, durationMinutes: e.duration_minutes }));
}

/** The sessions booked with a membership, cancelled ones included, soonest first. */
export async function memberSessions(db: Db, membershipId: string): Promise<{ id: string; startAt: Date; status: string; manageToken: string; timezone: string; eventName: string }[]> {
  const { rows } = await db.query(
    `select b.id, b.start_at, b.status, i.manage_token, i.timezone, e.name as event_name from bookings b join invitees i on i.booking_id = b.id
     join event_types e on e.id = b.event_type_id join membership_grants g on g.id = b.membership_grant_id
     where g.membership_id = $1 order by b.start_at`, [membershipId]);
  return rows.map((r) => ({ id: r.id, startAt: r.start_at, status: r.status, manageToken: r.manage_token, timezone: r.timezone, eventName: r.event_name }));
}

// ---------- Joining ----------

export interface JoinCheckout { provider: string; publicKey: string; subscriptionId: string; shortUrl: string | null }

/**
 * Starts a membership: a row here and a subscription on the host's account. The same request key returns the same
 * membership and subscription, so a retry never makes a second mandate. Nothing is granted until a charge is verified.
 */
export async function startMembership(
  deps: { pool: pg.Pool; provider: MembershipProvider },
  input: { planId: string; name: string; email: string; phone: string | null; idempotencyKey: string },
): Promise<{ token: string; status: MembershipStatus; checkout: JoinCheckout | null }> {
  const { pool, provider } = deps;
  const found = await publicMembershipPlan(pool, input.planId);
  if (!found) throw new NotFoundError("Membership plan");
  const { plan } = found;
  const { rows: [row] } = await pool.query(
    `insert into memberships (plan_id, host_id, sessions, price_minor, rollover, rollover_cap, guest_name, guest_email, guest_phone, idempotency_key, provider)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (idempotency_key) do update set updated_at = memberships.updated_at
     returning id, plan_id, token, status, provider_subscription_id, short_url`,
    [plan.id, plan.userId, plan.sessions, plan.priceMinor, plan.rollover, plan.rolloverCap, input.name, input.email, input.phone, input.idempotencyKey, provider.name]);
  if (row.plan_id !== plan.id) throw new NotFoundError("Membership plan"); // the same key for another plan is a mistake, not a retry
  const checkout = (subscriptionId: string, shortUrl: string | null): JoinCheckout => ({ provider: provider.name, publicKey: provider.publicKey, subscriptionId, shortUrl });
  if (row.status !== "created") return { token: row.token, status: row.status, checkout: null };
  if (row.provider_subscription_id) return { token: row.token, status: row.status, checkout: checkout(row.provider_subscription_id, row.short_url) };

  // Locked while the subscription is made, so a concurrent repeat waits and then reuses it.
  const made = await inTx(pool, async (client) => {
    const { rows: [locked] } = await client.query("select provider_subscription_id, short_url from memberships where id = $1 for update", [row.id]);
    if (locked.provider_subscription_id) return { id: locked.provider_subscription_id as string, shortUrl: locked.short_url as string | null };
    let sub;
    try {
      sub = await provider.createSubscription({ planId: plan.providerPlanId, totalCount: TOTAL_MONTHS, notes: { membership_id: row.id, hourhand_host: plan.userId } });
    } catch (error) {
      throw providerError("Membership could not start", error);
    }
    await client.query("update memberships set provider_subscription_id = $2, short_url = $3, updated_at = now() where id = $1", [row.id, sub.id, sub.shortUrl]);
    return { id: sub.id, shortUrl: sub.shortUrl };
  });
  return { token: row.token, status: "created", checkout: checkout(made.id, made.shortUrl) };
}

// ---------- Bookings ----------

/**
 * Inside a booking's transaction: locks the membership and picks one credit per session start, soonest-expiring grant
 * first. Refuses a link that isn't a membership, an event type it doesn't cover, a start past what's paid for, or too
 * few credits. Returns the grant id for each start, in order.
 */
export async function takeMembershipCredits(client: Client, token: string, eventTypeId: string, starts: Date[]): Promise<string[]> {
  if (!MEMBERSHIP_TOKEN.test(token)) throw new PackageUnavailableError("not_found");
  const { rows: [m] } = await client.query(
    `select m.id, m.plan_id, m.status, m.cancel_at_period_end, m.paid_through from memberships m where m.token = $1 for update`, [token]);
  if (!m) throw new PackageUnavailableError("not_found");
  if (!m.paid_through) throw new PackageUnavailableError("unpaid");
  const { rows: [linked] } = await client.query("select 1 from membership_plan_event_types where plan_id = $1 and event_type_id = $2", [m.plan_id, eventTypeId]);
  if (!linked) throw new PackageUnavailableError("wrong_event");
  const renewing = isRenewing({ status: m.status, cancelAtPeriodEnd: m.cancel_at_period_end });
  const until = new Date(m.paid_through).getTime();
  if (!renewing && starts.some((s) => s.getTime() >= until)) throw new PackageUnavailableError("expired");
  const grants = await grantsLeft(client, m.id);
  const picked: string[] = new Array(starts.length);
  const order = starts.map((s, i) => ({ t: s.getTime(), i })).sort((a, b) => a.t - b.t);
  for (const { t, i } of order) {
    const fit = grants.find((g) => g.left > 0 && (!g.expiresAt || t < g.expiresAt.getTime()));
    // Credits left but none good that late (e.g. this month's credits for a session next month): expired, not used up.
    if (!fit) throw new PackageUnavailableError(grants.some((g) => g.left > 0) ? "expired" : "used_up");
    fit.left -= 1;
    picked[i] = fit.id;
  }
  return picked;
}

/** Records the grant each booking of a new booking (or weekly series) uses. `grantIds[i]` is for week i+1. */
export async function attachMembershipCredits(client: Client, firstBookingId: string, grantIds: string[]): Promise<void> {
  for (const [i, grantId] of grantIds.entries()) {
    await client.query(
      "update bookings set membership_grant_id = $2 where (id = $1 or series_id = $1) and coalesce(series_index, 1) = $3", [firstBookingId, grantId, i + 1]);
  }
}

/**
 * A moved membership session keeps its credit (the caller copies membership_grant_id to the new booking), but can't move
 * past what that credit is good for: its grant's end, or the paid month of a membership that won't renew.
 */
export async function checkMovedMembershipCredit(client: Client, newBookingId: string, startAt: Date): Promise<void> {
  const { rows: [g] } = await client.query(
    `select g.expires_at, m.status, m.cancel_at_period_end, m.paid_through from bookings b join membership_grants g on g.id = b.membership_grant_id
     join memberships m on m.id = g.membership_id where b.id = $1 for update of m`, [newBookingId]);
  if (!g) return;
  const t = startAt.getTime();
  if (g.expires_at && t >= new Date(g.expires_at).getTime()) throw new PackageUnavailableError("expired");
  if (!isRenewing({ status: g.status, cancelAtPeriodEnd: g.cancel_at_period_end }) && t >= new Date(g.paid_through).getTime()) throw new PackageUnavailableError("expired");
}

// ---------- Provider events ----------

export type MembershipMail = "joined" | "renewed" | "payment_failed" | "halted" | "cancel_requested" | "ended";

async function queueMail(client: Client, m: { id: string; host_id: string; guest_email: string; host_email: string }, what: MembershipMail, ref: string, now: Date, to: ("guest" | "host")[]): Promise<void> {
  for (const who of to) {
    await client.query(
      `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
       values (null, $1, 'email', $2, $3, $4, $5) on conflict (dedupe_key) do nothing`,
      [m.host_id, `membership_${who}`, who === "guest" ? m.guest_email : m.host_email, now, `membership:${m.id}:${what}:${ref}:${who}`]);
  }
}

const addMonth = (d: Date) => { const n = new Date(d); n.setUTCMonth(n.getUTCMonth() + 1); return n; };

export type EventOutcome = "granted" | "already_granted" | "updated" | "ignored" | "rejected";

/**
 * Applies one verified provider event to a membership, inside the caller's transaction (which also records the event
 * id, so a repeat delivery never gets here). A charge grants credits once per payment; status changes apply only if
 * no newer event already set the status, since deliveries can arrive out of order.
 */
export async function applyMembershipEvent(client: Client, hostId: string, e: MembershipEvent, now: Date): Promise<EventOutcome> {
  if (e.type === "other" || !e.subscriptionId) return "ignored";
  const { rows: [m] } = await client.query(
    `select m.*, u.email as host_email from memberships m join users u on u.id = m.host_id
     where m.host_id = $1 and m.provider_subscription_id = $2 for update of m`, [hostId, e.subscriptionId]);
  if (!m) return "ignored"; // a subscription on the host's account that isn't a Hourhand membership

  const newer = !m.status_event_at || e.createdAt.getTime() >= new Date(m.status_event_at).getTime();
  const setStatus = async (status: MembershipStatus | null, extra = "", params: unknown[] = []) => {
    if (!newer || !status) return;
    await client.query(`update memberships set status = $2, status_event_at = $3, updated_at = $4${extra} where id = $1`, [m.id, status, e.createdAt, now, ...params]);
  };

  switch (e.type) {
    case "charged": {
      const p = e.payment;
      // The amount comes from our own row: a payment of any other amount or currency never buys credits.
      if (!p || p.status !== "captured" || p.amount !== m.price_minor || p.currency !== m.currency) {
        await client.query("update memberships set last_error = $2, updated_at = $3 where id = $1",
          [m.id, `Charge not credited: ${p ? `${p.status} ${p.amount} ${p.currency}` : "no payment in the event"}`.slice(0, 500), now]);
        return "rejected";
      }
      const periodStart = e.currentStart ?? now;
      const periodEnd = e.currentEnd && e.currentEnd > periodStart ? e.currentEnd : addMonth(periodStart);
      const { rows: [g] } = await client.query(
        `insert into membership_grants (membership_id, host_id, provider_payment_id, amount_minor, period_start, period_end, credits, expires_at, granted_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (provider_payment_id) do nothing returning id`,
        [m.id, hostId, p.id, p.amount, periodStart, periodEnd, m.sessions, m.rollover === "none" ? periodEnd : null, now]);
      if (!g) return "already_granted";
      if (m.rollover === "capped") await capRollover(client, m.id, g.id, m.rollover_cap, now);
      const first = Number((await client.query("select count(*)::int as n from membership_grants where membership_id = $1", [m.id])).rows[0].n) === 1;
      await client.query(
        `update memberships set paid_through = greatest(coalesce(paid_through, $2), $2), current_period_start = $3, current_period_end = $2,
           last_error = null, updated_at = $4 where id = $1`, [m.id, periodEnd, periodStart, now]);
      await setStatus(e.status ?? "active");
      await invoiceForMembershipGrant(client, g.id, now);
      await queueMail(client, m, first ? "joined" : "renewed", g.id, now, first ? ["guest", "host"] : ["guest"]);
      return "granted";
    }
    case "pending":
      // A renewal failed; the provider retries. No credits until a charge goes through.
      await client.query("update memberships set failed_payments = failed_payments + 1, last_failure_at = $2, updated_at = $2 where id = $1", [m.id, now]);
      await setStatus(e.status ?? "pending");
      await queueMail(client, m, "payment_failed", e.eventId, now, ["guest", "host"]);
      return "updated";
    case "halted":
      await setStatus(e.status ?? "halted");
      await queueMail(client, m, "halted", e.eventId, now, ["guest", "host"]);
      return "updated";
    case "cancelled":
    case "completed":
      await setStatus(e.status ?? (e.type === "completed" ? "completed" : "cancelled"), ", ended_at = coalesce(ended_at, $3)");
      await queueMail(client, m, "ended", m.id, now, ["guest", "host"]);
      return "updated";
    default:
      // authenticated, activated, paused, resumed: the status says it all.
      await setStatus(e.status ?? (e.type === "activated" || e.type === "resumed" ? "active" : e.type === "paused" ? "paused" : "authenticated"));
      return "updated";
  }
}

/**
 * Capped rollover: after a new month's grant, unused credits from earlier months are kept up to the cap in total and
 * the rest are forfeited, oldest first.
 */
async function capRollover(client: Client, membershipId: string, newGrantId: string, cap: number, now: Date): Promise<void> {
  const older = (await grantsLeft(client, membershipId)).filter((g) => g.id !== newGrantId && g.left > 0 && (!g.expiresAt || g.expiresAt > now));
  let excess = older.reduce((n, g) => n + g.left, 0) - cap;
  for (const g of older) {
    if (excess <= 0) break;
    const drop = Math.min(excess, g.left);
    await client.query("update membership_grants set forfeited = forfeited + $2 where id = $1", [g.id, drop]);
    excess -= drop;
  }
}

/** Records a verified event and applies it, once per event id. */
export async function receiveMembershipEvent(pool: pg.Pool, hostId: string, e: MembershipEvent, eventType: string, now: Date): Promise<EventOutcome | "duplicate"> {
  const outcome = await inTx(pool, async (client) => {
    const { rowCount } = await client.query(
      "insert into membership_events (host_id, event_id, type, received_at) values ($1, $2, $3, $4) on conflict do nothing", [hostId, e.eventId, eventType, now]);
    if (!rowCount) return "duplicate" as const;
    return applyMembershipEvent(client, hostId, e, now);
  });
  if (outcome === "granted" || outcome === "updated") kickJobs();
  return outcome;
}

// ---------- Cancelling ----------

export type CancelOutcome = "cancelling" | "cancelled" | "already";

/**
 * The client stops their membership from their link. A paid month runs to its end (the provider cancels at cycle end)
 * and its credits stay bookable until then; before any month is paid, or when renewals have stopped, it ends now.
 */
export async function cancelMembership(deps: { pool: pg.Pool; provider: MembershipProvider }, token: string, now: Date): Promise<CancelOutcome> {
  const { pool, provider } = deps;
  const m = await membershipByToken(pool, token);
  if (!m) throw new NotFoundError("Membership");
  if (m.cancelAtPeriodEnd || ["cancelled", "completed", "expired"].includes(m.status)) return "already";
  // Never authenticated: nothing to stop at the provider (its link just goes unused).
  const atPeriodEnd = m.status === "active" || m.status === "pending";
  if (m.status !== "created") {
    const { rows: [s] } = await pool.query("select provider_subscription_id from memberships where id = $1", [m.id]);
    try {
      if (s.provider_subscription_id) await provider.cancel(s.provider_subscription_id, atPeriodEnd);
    } catch (error) {
      throw providerError("Membership could not be cancelled", error);
    }
  }
  const outcome = await inTx(pool, async (client) => {
    const { rows: [row] } = await client.query(
      "select m.id, m.host_id, m.guest_email, u.email as host_email from memberships m join users u on u.id = m.host_id where m.id = $1 for update of m", [m.id]);
    if (atPeriodEnd) {
      await client.query("update memberships set cancel_at_period_end = true, cancel_requested_at = $2, updated_at = $2 where id = $1", [m.id, now]);
    } else {
      await client.query(
        "update memberships set status = 'cancelled', status_event_at = $2, cancel_requested_at = $2, ended_at = $2, updated_at = $2 where id = $1", [m.id, now]);
    }
    await queueMail(client, row, "cancel_requested", m.id, now, ["guest", "host"]);
    return atPeriodEnd ? "cancelling" as const : "cancelled" as const;
  });
  kickJobs();
  return outcome;
}
