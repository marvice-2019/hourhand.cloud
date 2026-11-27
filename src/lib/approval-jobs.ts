import type pg from "pg";
import { LAPSED_REASON } from "./approval";
import { queueBookingNotifications } from "./data/notifications";
import { queueWaitlistFor } from "./waitlist";

/**
 * B9: ends the requests the host didn't answer in time. Each is cancelled by the system, its guest is told (with other
 * times to book), and anyone waiting on that day hears it's free. A request swept by a new booking first gets the same
 * treatment there (pg-store expireHolds), so whichever runs first does it, once.
 */
export async function lapseRequests(pool: pg.Pool, now: Date, limit = 50): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `update bookings set status = 'cancelled', cancelled_at = $1, cancelled_by = 'system', cancel_reason = $2, hold_expires_at = null
       where id in (select id from bookings where status = 'pending_approval' and hold_expires_at <= $1 order by hold_expires_at limit $3 for update skip locked)
       returning id`, [now, LAPSED_REASON, limit]);
    for (const r of rows) {
      await queueBookingNotifications(client, r.id as string, "lapsed", now);
      await queueWaitlistFor(client, r.id as string, now);
    }
    await client.query("commit");
    return rows.length;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
