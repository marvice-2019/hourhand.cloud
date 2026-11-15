import type pg from "pg";

// The times an open meeting poll holds on its host's calendar. Kept free of other imports: the data store reads it.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Proposed times of the host's open polls that hold their times, overlapping [from, to). A poll stops holding the moment
 * its deadline passes, even before the job runner has marked it closed, and once it is confirmed or cancelled.
 * `exceptPollId` leaves one poll's own holds out (its confirm check).
 */
export async function pollHolds(db: Db, hostId: string, from: Date, to: Date, now: Date, exceptPollId: string | null = null): Promise<{ start: Date; end: Date }[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(
    `select o.start_at, o.end_at from poll_options o join polls p on p.id = o.poll_id
      where p.user_id = $1 and p.status = 'open' and p.hold_times and p.deadline > $4 and o.end_at > $2 and o.start_at < $3
        and ($5::uuid is null or p.id <> $5::uuid)
      order by o.start_at`, [hostId, from, to, now, exceptPollId]);
  return rows.map((r) => ({ start: r.start_at as Date, end: r.end_at as Date }));
}
