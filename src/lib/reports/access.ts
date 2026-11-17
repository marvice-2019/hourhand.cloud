import { LIMITS, type Plan } from "../billing/plans";
import { clampToWindow, resolvePeriod, windowStart, type Period, type PeriodQuery } from "./period";

export interface ReportAccess {
  period: Period;
  /** The earliest instant the plan shows, or null for all history. */
  earliest: Date | null;
  canExport: boolean;
}

/**
 * The period a host may see for a query. Free sees the last 30 days (its default view) and can't export; paid plans
 * see everything and default to this month.
 */
export function reportAccess(q: PeriodQuery, timezone: string, plan: Plan, now: Date): ReportAccess {
  const { reportDays, reportExport } = LIMITS[plan];
  const limited = Number.isFinite(reportDays);
  const asked = limited && !q.period && !q.month ? { period: "last_30" } : q;
  const period = clampToWindow(resolvePeriod(asked, timezone, now), reportDays, now);
  return { period, earliest: limited ? windowStart(now, period.timezone, reportDays) : null, canExport: reportExport };
}
