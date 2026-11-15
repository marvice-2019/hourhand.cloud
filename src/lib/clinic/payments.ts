import type pg from "pg";

// The Clinic practice's one payment account: while a practitioner is in a live practice, guests pay through the
// practice owner's Razorpay. The rule lives in SQL (clinic_payment_account, migration 0034) so the payments trigger
// and the app agree.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whose Razorpay account takes this host's payments right now: the practice owner's, or the host's own. */
export async function paymentAccountFor(db: Db, hostId: string): Promise<string> {
  if (!UUID.test(hostId)) return hostId;
  const { rows: [r] } = await db.query("select clinic_payment_account($1) as id", [hostId]);
  return (r?.id as string | undefined) ?? hostId;
}

/** Is this person an accepted member (any role) of a practice that is live right now? */
export async function inLivePractice(db: Db, userId: string): Promise<boolean> {
  if (!UUID.test(userId)) return false;
  const { rows: [r] } = await db.query(
    "select 1 from practice_members m where m.user_id = $1 and m.accepted_at is not null and practice_is_live(m.practice_id)", [userId]);
  return Boolean(r);
}
