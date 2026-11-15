import type pg from "pg";
import { RESERVED_SLUGS } from "../auth/slug";
import { allowed, ClinicAccessError, type PracticeAction, type PracticeRole } from "./roles";

// The Clinic plan's practice: one account, several practitioners, each with their own Hourhand account. Every function
// takes the signed-in person's own id and checks their role in the database before reading or changing anything.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;

/** Practitioners the Clinic price includes. */
export const INCLUDED_PRACTITIONERS = 3;
/** The most practitioners one practice can have. */
export const MAX_PRACTITIONERS = 10;
/** Invitation emails a practice can send in 24 hours: each carries the practice's name. */
export const PRACTICE_INVITES_PER_DAY = 10;
/** An invitation nobody accepted stops holding the address after this long. */
const STALE_INVITE_DAYS = 7;

export interface Practice { id: string; ownerId: string; slug: string; name: string; about: string | null }

export interface PracticeMember {
  id: string; email: string; userId: string | null; name: string | null; slug: string | null;
  role: PracticeRole; practises: boolean; active: boolean; accepted: boolean; position: number;
}

export interface PracticeContext { practice: Practice; role: PracticeRole; memberId: string; live: boolean }

export type ClinicError =
  | "not_live" | "invalid_name" | "invalid_slug" | "slug_taken" | "invalid_about" | "invalid_email" | "own_email" | "taken"
  | "already_in_practice" | "limit" | "too_many" | "not_found" | "owner_fixed" | "invalid_role";

export class ClinicActionError extends Error {
  constructor(readonly code: ClinicError) { super(`clinic: ${code}`); this.name = "ClinicActionError"; }
}

const toPractice = (r: Record<string, unknown>): Practice =>
  ({ id: r.id as string, ownerId: r.owner_id as string, slug: r.slug as string, name: r.name as string, about: (r.about as string | null) ?? null });

async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

/** Is the practice live: its owner on a paid Clinic subscription? Checked on every use, so a lapsed plan ends it at once. */
export async function isPracticeLive(db: Db, practiceId: string): Promise<boolean> {
  if (!UUID.test(practiceId)) return false;
  const { rows: [r] } = await db.query("select practice_is_live($1) as live", [practiceId]);
  return Boolean(r?.live);
}

/** The person's place in a practice (accepted memberships only), with their role. Null when they're in none. */
export async function practiceContext(db: Db, userId: string): Promise<PracticeContext | null> {
  if (!UUID.test(userId)) return null;
  const { rows: [r] } = await db.query(
    `select p.id, p.owner_id, p.slug, p.name, p.about, m.id as member_id, m.role, practice_is_live(p.id) as live
     from practice_members m join practices p on p.id = m.practice_id
     where m.user_id = $1 and m.accepted_at is not null`, [userId]);
  if (!r) return null;
  const role: PracticeRole = r.owner_id === userId ? "owner" : r.role;
  return { practice: toPractice(r), role, memberId: r.member_id, live: r.live };
}

/** The context, or ClinicAccessError when the person may not do `action`. */
export async function requirePracticeRole(db: Db, userId: string, action: PracticeAction): Promise<PracticeContext> {
  const ctx = await practiceContext(db, userId);
  if (!ctx || !allowed(ctx.role, action)) throw new ClinicAccessError(action);
  return ctx;
}

/** How many practitioners the owner's Clinic subscription pays for: 3 included plus each extra, at most 10. */
export async function practitionerLimit(db: Db, practiceId: string): Promise<number> {
  const { rows: [r] } = await db.query(
    "select s.extra_seats from practices p join subscriptions s on s.user_id = p.owner_id and s.plan = 'clinic' where p.id = $1", [practiceId]);
  return Math.min(MAX_PRACTITIONERS, INCLUDED_PRACTITIONERS + Math.max(0, Number(r?.extra_seats ?? 0)));
}

/** Practitioners taking a place: active, practising, accepted or still invited. */
export async function practitionerCount(db: Db, practiceId: string): Promise<number> {
  const { rows: [r] } = await db.query(
    "select count(*)::int as n from practice_members where practice_id = $1 and practises and active", [practiceId]);
  return r.n as number;
}

export type PracticeInput = { name: string; slug: string; about: string };

export function validatePractice(input: PracticeInput): { ok: true; value: { name: string; slug: string; about: string | null } } | { ok: false; error: ClinicError } {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const about = input.about.trim().replace(/\r\n/g, "\n");
  if (name.length < 1 || name.length > 120) return { ok: false, error: "invalid_name" };
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) return { ok: false, error: "invalid_slug" };
  if (about.length > 2000) return { ok: false, error: "invalid_about" };
  return { ok: true, value: { name, slug, about: about || null } };
}

const slugTaken = (error: unknown) => (error as { code?: string }).code === "23505";

/**
 * Sets up a practice with the signed-in person as its owner (an admin who also practises unless they say otherwise).
 * Works from any plan, so a Duo or Solo host can set it up before switching; it goes live once they're on Clinic.
 * Their own account, event types, bookings and clients are untouched: the practice only adds rows.
 *
 * A Duo owner's accepted second person can come along as a practitioner or an admin (`bringSeat`). Their Duo seat row
 * stays; it simply stops granting anything once the owner is no longer on Duo.
 */
export async function createPractice(pool: pg.Pool, owner: { id: string; email: string }, input: PracticeInput,
  opts: { ownerPractises?: boolean; bringSeat?: "practitioner" | "admin" | "none" } = {}): Promise<Practice> {
  const v = validatePractice(input);
  if (!v.ok) throw new ClinicActionError(v.error);
  return inTx(pool, async (c) => {
    const { rows: [mine] } = await c.query("select 1 from practice_members where user_id = $1 or email = $2", [owner.id, owner.email]);
    if (mine) throw new ClinicActionError("already_in_practice");
    let practice: Practice;
    try {
      const { rows: [p] } = await c.query(
        "insert into practices (owner_id, slug, name, about) values ($1, $2, $3, $4) returning id, owner_id, slug, name, about",
        [owner.id, v.value.slug, v.value.name, v.value.about]);
      practice = toPractice(p);
    } catch (error) {
      if (slugTaken(error)) throw new ClinicActionError("slug_taken");
      throw error;
    }
    await c.query(
      `insert into practice_members (practice_id, email, user_id, role, practises, position, accepted_at)
       values ($1, $2, $3, 'admin', $4, 0, now())`, [practice.id, owner.email, owner.id, opts.ownerPractises ?? true]);
    if (opts.bringSeat && opts.bringSeat !== "none") {
      const { rows: [seat] } = await c.query(
        `select s.member_id, u.email from seats s join users u on u.id = s.member_id
         where s.owner_id = $1 and s.accepted_at is not null and u.deleted_at is null`, [owner.id]);
      if (seat) {
        const { rows: [elsewhere] } = await c.query("select 1 from practice_members where user_id = $1 or email = $2", [seat.member_id, seat.email]);
        if (!elsewhere) {
          await c.query(
            `insert into practice_members (practice_id, email, user_id, role, practises, position, accepted_at)
             values ($1, $2, $3, $4, $5, 1, now())`,
            [practice.id, seat.email, seat.member_id, opts.bringSeat, opts.bringSeat === "practitioner"]);
        }
      }
    }
    return practice;
  });
}

/** The practice page's name, slug and about text. Owner or admin. */
export async function updatePractice(db: Db, actorId: string, input: PracticeInput): Promise<void> {
  const ctx = await requirePracticeRole(db, actorId, "practice.edit");
  const v = validatePractice(input);
  if (!v.ok) throw new ClinicActionError(v.error);
  try {
    await db.query("update practices set name = $2, slug = $3, about = $4, updated_at = now() where id = $1",
      [ctx.practice.id, v.value.name, v.value.slug, v.value.about]);
  } catch (error) {
    if (slugTaken(error)) throw new ClinicActionError("slug_taken");
    throw error;
  }
}

/** Everyone in the actor's practice, the owner first. Any member may see who else is in it; nothing private is included. */
export async function listMembers(db: Db, actorId: string): Promise<PracticeMember[]> {
  const ctx = await requirePracticeRole(db, actorId, "practice.view");
  const { rows } = await db.query(
    `select m.id, m.email, m.user_id, m.role, m.practises, m.active, m.accepted_at, m.position, u.name, u.slug
     from practice_members m left join users u on u.id = m.user_id and u.deleted_at is null
     where m.practice_id = $1 order by m.user_id = $2 desc, m.position, m.invited_at`, [ctx.practice.id, ctx.practice.ownerId]);
  return rows.map((r) => ({
    id: r.id, email: r.email, userId: r.user_id, name: r.name ?? null, slug: r.slug ?? null,
    role: r.user_id === ctx.practice.ownerId ? "owner" : r.role, practises: r.practises, active: r.active,
    accepted: r.accepted_at !== null, position: r.position,
  }));
}

/** Locks the practice row so two admins adding practitioners at once can't both take the last place. */
async function lockPractice(c: Db, practiceId: string): Promise<void> {
  await c.query("select 1 from practices where id = $1 for update", [practiceId]);
}

async function assertRoom(c: Db, practiceId: string, adding: number): Promise<void> {
  if (adding <= 0) return;
  const [count, limit] = await Promise.all([practitionerCount(c, practiceId), practitionerLimit(c, practiceId)]);
  if (count + adding > limit) throw new ClinicActionError("limit");
}

/**
 * Invites someone by email as a practitioner or an admin, and queues the invitation email in the same statement.
 * Needs the practice live, room for another practitioner, and the address free (one practice per person).
 */
export async function inviteMember(pool: pg.Pool, actorId: string, rawEmail: string, role: "admin" | "practitioner", now: Date): Promise<void> {
  const email = rawEmail.trim();
  if (role !== "admin" && role !== "practitioner") throw new ClinicActionError("invalid_role");
  if (!EMAIL.test(email) || email.length > 254) throw new ClinicActionError("invalid_email");
  const ctx = await requirePracticeRole(pool, actorId, "members.manage");
  if (!ctx.live) throw new ClinicActionError("not_live");
  await inTx(pool, async (c) => {
    await lockPractice(c, ctx.practice.id);
    const { rows: [sent] } = await c.query(
      "select count(*)::int as n from notifications where kind = 'practice_invite' and dedupe_key like $1 and send_at > $2::timestamptz - interval '1 day'",
      [`practice:${ctx.practice.id}:%`, now]);
    if (sent.n >= PRACTICE_INVITES_PER_DAY) throw new ClinicActionError("too_many");
    // Another practice's invitation that was never accepted only holds the address for a week.
    await c.query(
      `delete from practice_members where email = $1 and practice_id <> $2 and accepted_at is null
         and invited_at < $3::timestamptz - make_interval(days => ${STALE_INVITE_DAYS})`, [email, ctx.practice.id, now]);
    const { rows: [existing] } = await c.query("select practice_id, accepted_at from practice_members where email = $1", [email]);
    if (existing && existing.practice_id !== ctx.practice.id) throw new ClinicActionError("taken");
    if (existing?.accepted_at) throw new ClinicActionError("already_in_practice");
    if (!existing) await assertRoom(c, ctx.practice.id, role === "practitioner" ? 1 : 0);
    try {
      await c.query(
        `with m as (
           insert into practice_members (practice_id, email, role, practises, invited_at, position)
           values ($1, $2, $3, $4, $5, (select coalesce(max(position), 0) + 1 from practice_members where practice_id = $1))
           on conflict (email) do update set invited_at = excluded.invited_at
             where practice_members.practice_id = excluded.practice_id and practice_members.accepted_at is null
           returning id, email)
         insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
         select null, $6, 'email', 'practice_invite', m.email, $5, $7 || m.id || ':' || $8 from m on conflict (dedupe_key) do nothing`,
        [ctx.practice.id, email, role, role === "practitioner", now, ctx.practice.ownerId, `practice:${ctx.practice.id}:`, now.toISOString().slice(0, 10)]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ClinicActionError("taken");
      throw error;
    }
  });
}

/** An invitation waiting for this person (by their verified sign-in email), from a practice that is live. */
export async function pendingPracticeInvite(db: Db, user: { id: string; email: string }): Promise<{ practiceId: string; practiceName: string; role: "admin" | "practitioner" } | null> {
  const { rows: [r] } = await db.query(
    `select p.id, p.name, m.role from practice_members m join practices p on p.id = m.practice_id
     where m.email = $1 and m.accepted_at is null and p.owner_id <> $2 and practice_is_live(p.id)`, [user.email, user.id]);
  return r ? { practiceId: r.id, practiceName: r.name, role: r.role } : null;
}

/** Accepts the waiting invitation. False when there's none (withdrawn, or the practice isn't live). */
export async function acceptPracticeInvite(db: Db, user: { id: string; email: string }): Promise<boolean> {
  const invite = await pendingPracticeInvite(db, user);
  if (!invite) return false;
  const { rowCount } = await db.query(
    `update practice_members set user_id = $1, accepted_at = now()
     where email = $2 and practice_id = $3 and accepted_at is null
       and not exists (select 1 from practice_members x where x.user_id = $1)`, [user.id, user.email, invite.practiceId]);
  return Boolean(rowCount);
}

/** Declines an invitation, or leaves the practice. The owner can't leave their own practice. */
export async function leavePractice(db: Db, user: { id: string; email: string }): Promise<void> {
  const ctx = await practiceContext(db, user.id);
  if (ctx?.role === "owner") throw new ClinicActionError("owner_fixed");
  await db.query("delete from practice_members where user_id = $1 or (email = $2 and accepted_at is null)", [user.id, user.email]);
}

async function targetIn(c: Db, ctx: PracticeContext, memberId: string): Promise<{ id: string; user_id: string | null; role: string; practises: boolean; active: boolean }> {
  if (!UUID.test(memberId)) throw new ClinicActionError("not_found");
  const { rows: [m] } = await c.query(
    "select id, user_id, role, practises, active from practice_members where id = $1 and practice_id = $2", [memberId, ctx.practice.id]);
  if (!m) throw new ClinicActionError("not_found");
  return m;
}

export type MemberChange = { role?: "admin" | "practitioner"; practises?: boolean; active?: boolean };

/**
 * Changes a member's role, whether they take sessions, or whether they're on the practice page. Owner or admin, within
 * their own practice. The owner stays an admin; only their own "I take sessions" can change.
 */
export async function changeMember(pool: pg.Pool, actorId: string, memberId: string, change: MemberChange): Promise<void> {
  const ctx = await requirePracticeRole(pool, actorId, "members.manage");
  if (change.role !== undefined && change.role !== "admin" && change.role !== "practitioner") throw new ClinicActionError("invalid_role");
  await inTx(pool, async (c) => {
    await lockPractice(c, ctx.practice.id);
    const m = await targetIn(c, ctx, memberId);
    if (m.user_id === ctx.practice.ownerId && (change.role !== undefined || change.active === false)) throw new ClinicActionError("owner_fixed");
    const role = change.role ?? m.role;
    // A practitioner always practises; making someone a practitioner turns it on.
    const practises = role === "practitioner" ? true : change.practises ?? m.practises;
    const active = change.active ?? m.active;
    const before = m.practises && m.active ? 1 : 0;
    const after = practises && active ? 1 : 0;
    await assertRoom(c, ctx.practice.id, after - before);
    await c.query("update practice_members set role = $2, practises = $3, active = $4 where id = $1", [m.id, role, practises, active]);
  });
}

/** Removes someone (or withdraws their invitation). Their own account and everything in it stays theirs. */
export async function removeMember(db: Db, actorId: string, memberId: string): Promise<void> {
  const ctx = await requirePracticeRole(db, actorId, "members.manage");
  const m = await targetIn(db, ctx, memberId);
  if (m.user_id === ctx.practice.ownerId) throw new ClinicActionError("owner_fixed");
  await db.query("delete from practice_members where id = $1 and practice_id = $2", [m.id, ctx.practice.id]);
}

/** A practice by its page's slug, or null. */
export async function practiceBySlug(db: Db, slug: string): Promise<(Practice & { live: boolean }) | null> {
  if (!SLUG.test(slug.toLowerCase())) return null;
  const { rows: [r] } = await db.query(
    "select id, owner_id, slug, name, about, practice_is_live(id) as live from practices where slug = $1", [slug]);
  return r ? { ...toPractice(r), live: r.live } : null;
}
