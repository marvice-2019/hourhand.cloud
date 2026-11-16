import type { CalendarConnection, SyncStatus } from "./data/types";
import { isSyncStale } from "./slots";

const MIN = 60_000;

/** "none" means no calendar is connected yet: bookings still work (nothing to check against), so it isn't an outage. */
export type SyncSummaryStatus = SyncStatus | "none";

export interface SyncSummary {
  status: SyncSummaryStatus;
  /** Minutes since the oldest successful sync. Only set when status is "ok". */
  minutesAgo: number | null;
}

/**
 * One status for the header light, worst connection wins. No connection at all is "none", not "disconnected":
 * slots only pause when a connected calendar goes stale (isSyncStale), so a new host's bookings are open.
 */
export function summarizeSync(connections: Pick<CalendarConnection, "status" | "lastSyncedAt">[], now: Date): SyncSummary {
  if (connections.length === 0) return { status: "none", minutesAgo: null };
  if (connections.some((c) => c.status === "disconnected")) {
    return { status: "disconnected", minutesAgo: null };
  }
  if (isSyncStale(connections, now)) return { status: "degraded", minutesAgo: null };
  const oldest = Math.min(...connections.map((c) => c.lastSyncedAt?.getTime() ?? now.getTime()));
  return { status: "ok", minutesAgo: Math.max(0, Math.floor((now.getTime() - oldest) / MIN)) };
}
