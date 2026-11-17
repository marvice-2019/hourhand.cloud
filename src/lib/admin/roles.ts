import type pg from "pg";

// Hourhand staff. Two roles, checked on every admin page and action (never only in the layout):
//   admin        support: reads hosts' account details and the overview; changes nothing
//   super_admin  everything an admin can, plus granting and revoking staff, reading the audit log and giving hosts a
//                complimentary plan
// Super admins in SUPER_ADMIN_EMAILS are fixed by the server's environment: the app can't remove them.

type Db = Pick<pg.Pool, "query">;
type Env = Record<string, string | undefined>;

export type StaffRole = "admin" | "super_admin";
export type Permission = "view_overview" | "view_hosts" | "manage_staff" | "view_audit" | "manage_plans";

const GRANTS: Record<StaffRole, readonly Permission[]> = {
  admin: ["view_overview", "view_hosts"],
  super_admin: ["view_overview", "view_hosts", "manage_staff", "view_audit", "manage_plans"],
};

export const ROLE_NAMES: Record<StaffRole, string> = { admin: "Admin", super_admin: "Super admin" };

export function can(role: StaffRole | null, permission: Permission): boolean {
  return role !== null && GRANTS[role].includes(permission);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The super admins fixed by the environment, lower-cased. */
export function envSuperAdmins(env: Env = process.env): Set<string> {
  return new Set((env.SUPER_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => EMAIL.test(e)));
}

export interface Staff { userId: string; email: string; name: string | null; role: StaffRole; fromEnv: boolean; grantedAt: Date | null; grantedBy: string | null }

/** A signed-in account's staff role, or null for everyone else. A closed account has none. */
export async function staffRole(db: Db, user: { id: string; email: string }, env: Env = process.env): Promise<StaffRole | null> {
  const { rows: [r] } = await db.query(
    "select u.deleted_at, s.role from users u left join staff_roles s on s.user_id = u.id where u.id = $1", [user.id]);
  if (!r || r.deleted_at) return null;
  if (envSuperAdmins(env).has(user.email.toLowerCase())) return "super_admin";
  return (r.role as StaffRole | null) ?? null;
}

/** Everyone with a role: the environment's super admins (once they have an account) and those granted in the app. */
export async function listStaff(db: Db, env: Env = process.env): Promise<Staff[]> {
  const fixed = [...envSuperAdmins(env)];
  const { rows } = await db.query(
    `select u.id, u.email, u.name, s.role, s.granted_at, g.email as granted_by
     from users u left join staff_roles s on s.user_id = u.id left join users g on g.id = s.granted_by
     where u.deleted_at is null and (s.user_id is not null or lower(u.email::text) = any($1::text[]))
     order by u.email`, [fixed]);
  return rows.map((r) => {
    const fromEnv = fixed.includes(String(r.email).toLowerCase());
    return { userId: r.id, email: r.email, name: r.name, role: fromEnv ? "super_admin" : r.role, fromEnv, grantedAt: r.granted_at, grantedBy: r.granted_by };
  });
}

export type StaffChangeError = "not_allowed" | "no_account" | "fixed_by_env" | "self" | "bad_role";

export class StaffChangeRefused extends Error {
  constructor(readonly reason: StaffChangeError) {
    super(`Staff change refused: ${reason}`);
    this.name = "StaffChangeRefused";
  }
}

export interface Actor { id: string; email: string; role: StaffRole | null }

/**
 * Gives an existing Hourhand account a staff role (or changes it). Only a super admin can, and not to themselves, so
 * nobody raises their own access. The person must already have signed in once, so the role is tied to a real account.
 */
export async function grantRole(db: Db, actor: Actor, email: string, role: string, env: Env = process.env): Promise<Staff> {
  if (!can(actor.role, "manage_staff")) throw new StaffChangeRefused("not_allowed");
  if (role !== "admin" && role !== "super_admin") throw new StaffChangeRefused("bad_role");
  const target = email.trim().toLowerCase();
  if (envSuperAdmins(env).has(target)) throw new StaffChangeRefused("fixed_by_env");
  const { rows: [u] } = await db.query("select id, email, name from users where email = $1 and deleted_at is null", [target]);
  if (!u) throw new StaffChangeRefused("no_account");
  if (u.id === actor.id) throw new StaffChangeRefused("self");
  await db.query(
    `insert into staff_roles (user_id, role, granted_by) values ($1, $2, $3)
     on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by, granted_at = now()`, [u.id, role, actor.id]);
  await audit(db, actor, "staff.grant", "user", u.id, { email: u.email, role });
  return { userId: u.id, email: u.email, name: u.name, role, fromEnv: false, grantedAt: new Date(), grantedBy: actor.email };
}

/** Takes a staff role away. Only a super admin, never their own, never one fixed by the environment. */
export async function revokeRole(db: Db, actor: Actor, userId: string, env: Env = process.env): Promise<void> {
  if (!can(actor.role, "manage_staff")) throw new StaffChangeRefused("not_allowed");
  if (userId === actor.id) throw new StaffChangeRefused("self");
  const { rows: [u] } = await db.query("select email from users where id = $1", [userId]);
  if (u && envSuperAdmins(env).has(String(u.email).toLowerCase())) throw new StaffChangeRefused("fixed_by_env");
  const { rows: [gone] } = await db.query("delete from staff_roles where user_id = $1 returning role", [userId]);
  if (gone) await audit(db, actor, "staff.revoke", "user", userId, { email: u?.email ?? null, role: gone.role });
}

/** Records one staff action. Append-only: the app never edits or deletes these rows. */
export async function audit(db: Db, actor: { id: string; email: string }, action: string, targetType: string | null, targetId: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    "insert into admin_audit (actor_id, actor_email, action, target_type, target_id, detail) values ($1, $2, $3, $4, $5, $6)",
    [actor.id, actor.email, action, targetType, targetId, JSON.stringify(detail)]);
}

export interface AuditEntry { id: string; actorEmail: string; action: string; targetType: string | null; targetId: string | null; detail: Record<string, unknown>; at: Date }

export async function listAudit(db: Db, opts: { limit?: number; before?: string } = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const before = opts.before && /^\d+$/.test(opts.before) ? opts.before : null;
  const { rows } = await db.query(
    `select id, actor_email, action, target_type, target_id, detail, at from admin_audit
     where ($1::bigint is null or id < $1::bigint) order by id desc limit $2`, [before, limit]);
  return rows.map((r) => ({ id: String(r.id), actorEmail: r.actor_email, action: r.action, targetType: r.target_type, targetId: r.target_id, detail: r.detail, at: r.at }));
}
