// B9: booking requests the host approves (docs/specs/B9-approval.md). A request holds its slot like a payment hold, as
// status pending_approval until hold_expires_at.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** How long a request waits for the host at most. */
export const APPROVAL_WINDOW_MS = 48 * HOUR;

/** The cancel reason on a request the host never answered. Shared by the Postgres and in-memory sweeps. */
export const LAPSED_REASON = "Not confirmed in time";

/** The cancel reason on a request the host declined. */
export const DECLINED_REASON = "Request declined";

/**
 * When a request made at `now` for `start` stops holding the slot: 48 hours after booking or 1 hour before the start,
 * whichever comes first. A booking made inside that last hour holds until the start itself.
 */
export function approvalHoldUntil(now: Date, start: Date): Date {
  const latest = Math.min(now.getTime() + APPROVAL_WINDOW_MS, start.getTime() - HOUR);
  return new Date(latest > now.getTime() ? latest : start.getTime());
}
