import type pg from "pg";
import { audit, can, type Actor } from "./roles";

// A super admin can put a host on a plan without billing: a complimentary Solo or Duo for pilots, partners or staff
// accounts, or back to Free. It never touches a host who is paying through Razorpay or Stripe (they manage that from
// their own Plan page), and every change is in the audit log. If the host later subscribes, billing replaces it.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompPlan = "free" | "solo" | "duo";
export type PlanChangeError = "not_allowed" | "not_found" | "paid_subscription" | "bad_plan";

export class PlanChangeRefused extends Error {
  constructor(readonly reason: PlanChangeError) {
    super(`Plan change refused: ${reason}`);
    this.name = "PlanChangeRefused";
  }
}

export async function setComplimentaryPlan(db: Db, actor: Actor, hostId: string, plan: string): Promise<void> {
  if (!can(actor.role, "manage_plans")) throw new PlanChangeRefused("not_allowed");
  if (plan !== "free" && plan !== "solo" && plan !== "duo") throw new PlanChangeRefused("bad_plan");
  if (!UUID.test(hostId)) throw new PlanChangeRefused("not_found");
  const { rows: [u] } = await db.query(
    `select u.email, s.plan, s.status, s.provider_subscription_id from users u left join subscriptions s on s.user_id = u.id
     where u.id = $1 and u.deleted_at is null`, [hostId]);
  if (!u) throw new PlanChangeRefused("not_found");
  // A live paid subscription belongs to the host and their payment provider; changing it here would bill them for
  // one plan while giving another.
  if (u.provider_subscription_id && u.plan !== "free" && u.status !== "cancelled") throw new PlanChangeRefused("paid_subscription");
  await db.query(
    `insert into subscriptions (user_id, plan, status) values ($1, $2, 'active')
     on conflict (user_id) do update set plan = $2, status = 'active', interval = null, provider = null, provider_subscription_id = null,
       current_period_end = null, cancel_at_period_end = false, updated_at = now()`, [hostId, plan]);
  await audit(db, actor, "host.plan", "user", hostId, { email: u.email, from: u.plan ?? "free", to: plan, complimentary: true });
}
