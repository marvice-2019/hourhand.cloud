import type pg from "pg";
import { audit, can, type Actor } from "./roles";

// Super admins approve, decline and suspend host accounts. A host who isn't approved can still sign in and set up,
// but their booking pages are hidden and take no new bookings (the public lookups check review_status). Nothing here
// deletes an account or touches billing, every change is in the audit log, and the host is emailed about each one.

type Db = Pick<pg.Pool, "query">;

export type ReviewStatus = "pending" | "approved" | "declined" | "suspended";
export type ReviewAction = "approve" | "decline" | "suspend" | "reactivate";

/** The status each action leaves the host in, for the email that tells them (rendered only while it still holds). */
export const reviewTarget = (action: ReviewAction): ReviewStatus => MOVES[action].to;

/** Which action moves which status: anything else is refused, so a click on a stale page can't skip a step. */
const MOVES: Record<ReviewAction, { from: readonly ReviewStatus[]; to: ReviewStatus }> = {
  approve: { from: ["pending", "declined"], to: "approved" },
  decline: { from: ["pending"], to: "declined" },
  suspend: { from: ["approved"], to: "suspended" },
  reactivate: { from: ["suspended"], to: "approved" },
};

export const REVIEW_ACTIONS = Object.keys(MOVES) as ReviewAction[];

/** The actions a super admin can take on a host in this status, in the order the buttons show. */
export const actionsFor = (status: ReviewStatus): ReviewAction[] => REVIEW_ACTIONS.filter((a) => MOVES[a].from.includes(status));

export type ReviewRefusal = "not_allowed" | "self" | "no_account" | "closed" | "bad_action" | "bad_transition";

export class HostReviewRefused extends Error {
  constructor(readonly reason: ReviewRefusal) {
    super(`Host review refused: ${reason}`);
    this.name = "HostReviewRefused";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Moves one host's account to its new review status and logs it. Returns the new status. */
export async function setHostReview(db: Db, actor: Actor, hostId: string, action: string, now = new Date()): Promise<ReviewStatus> {
  if (!can(actor.role, "review_hosts")) throw new HostReviewRefused("not_allowed");
  if (!(action in MOVES)) throw new HostReviewRefused("bad_action");
  if (!UUID.test(hostId)) throw new HostReviewRefused("no_account");
  if (hostId === actor.id) throw new HostReviewRefused("self");
  const move = MOVES[action as ReviewAction];
  // One conditional update, so two staff clicking at once can't both apply a move from the same starting status.
  const { rows: [r] } = await db.query(
    `update users set review_status = $2, reviewed_at = $4, reviewed_by = $5
     where id = $1 and deleted_at is null and review_status = any($3::text[]) returning email`,
    [hostId, move.to, move.from, now, actor.id]);
  if (!r) {
    const { rows: [u] } = await db.query("select deleted_at from users where id = $1", [hostId]);
    throw new HostReviewRefused(!u ? "no_account" : u.deleted_at ? "closed" : "bad_transition");
  }
  await audit(db, actor, `host.${action}`, "user", hostId, { email: r.email, status: move.to });
  // The host hears about it (B22): one email per move, rendered when sent and skipped if a later move overtook it.
  await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     values (null, $1, 'email', 'account_review_host', $2, $3, $4) on conflict (dedupe_key) do nothing`,
    [hostId, r.email, now, `account_review:${hostId}:${action}:${now.toISOString()}`]);
  return move.to;
}

const REQUIRE_APPROVAL = "require_host_approval";

/** Whether new sign-ups wait for a super admin before their booking pages go live. Off unless switched on. */
export async function getRequireApproval(db: Db): Promise<boolean> {
  const { rows: [r] } = await db.query("select value from platform_settings where key = $1", [REQUIRE_APPROVAL]);
  return r?.value === "1";
}

export async function setRequireApproval(db: Db, actor: Actor, on: boolean): Promise<void> {
  if (!can(actor.role, "review_hosts")) throw new HostReviewRefused("not_allowed");
  await db.query(
    `insert into platform_settings (key, value, updated_by) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [REQUIRE_APPROVAL, on ? "1" : "0", actor.id]);
  await audit(db, actor, on ? "settings.require_approval.on" : "settings.require_approval.off", null, null);
}

/** For a brand-new account: waits for approval when the switch is on. Runs right after the user row is made. */
export async function markForReviewIfRequired(db: Db, userId: string): Promise<void> {
  if (await getRequireApproval(db)) await db.query("update users set review_status = 'pending' where id = $1 and review_status = 'approved' and reviewed_at is null", [userId]);
}

/** A host's own review status, for the notice on their dashboard. Closed or unknown accounts read as approved. */
export async function reviewStatusOf(db: Db, userId: string): Promise<ReviewStatus> {
  if (!UUID.test(userId)) return "approved";
  const { rows: [r] } = await db.query("select review_status from users where id = $1", [userId]);
  return (r?.review_status as ReviewStatus | undefined) ?? "approved";
}

/** Open accounts waiting for a super admin. */
export async function countPending(db: Db): Promise<number> {
  const { rows: [r] } = await db.query("select count(*)::int as n from users where review_status = 'pending' and deleted_at is null");
  return r.n;
}
