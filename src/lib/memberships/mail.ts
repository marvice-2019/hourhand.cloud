import type pg from "pg";
import { renderMembershipMail, type MembershipMailContext, type RenderedMail } from "../mail/templates";
import { creditsLeft } from "./memberships";

/** Renders a queued membership_guest / membership_host email (dedupe key membership:<id>:<what>:<ref>:<to>). */
export async function renderMembership(pool: pg.Pool, c: { kind: string; dedupe_key: string }, baseUrl: string, now: Date): Promise<RenderedMail | { skip: string }> {
  const m = /^membership:([0-9a-f-]{36}):(joined|renewed|payment_failed|halted|cancel_requested|ended):[^:]+:(guest|host)$/.exec(c.dedupe_key);
  if (!m) return { skip: "not a membership email" };
  const { rows: [r] } = await pool.query(
    `select m.id, m.status, m.cancel_at_period_end, m.paid_through, m.guest_name, m.guest_email, m.sessions, m.price_minor, m.token,
       p.name as plan_name, u.name as host_name, u.email as host_email, u.timezone
     from memberships m join membership_plans p on p.id = m.plan_id join users u on u.id = m.host_id where m.id = $1`, [m[1]]);
  if (!r) return { skip: "membership gone" };
  const left = await creditsLeft(pool, { id: r.id, status: r.status, cancelAtPeriodEnd: r.cancel_at_period_end, paidThrough: r.paid_through }, now);
  const ctx: MembershipMailContext = {
    what: m[2] as MembershipMailContext["what"], hostName: r.host_name, hostEmail: r.host_email, guestName: r.guest_name, guestEmail: r.guest_email,
    planName: r.plan_name, sessions: r.sessions, priceMinor: r.price_minor, creditsLeft: left, paidThrough: r.paid_through, timezone: r.timezone,
    memberUrl: `${baseUrl}/member/${r.token}`, dashboardUrl: `${baseUrl}/dashboard/memberships`,
  };
  return renderMembershipMail(m[3] as "guest" | "host", ctx);
}
