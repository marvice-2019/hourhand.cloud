import { LIMITS, type Plan } from "../billing/plans";

export const WINDOWS = [7, 30, 90] as const;

/**
 * The window a host may see: the one asked for (7, 30 or 90 days) if their plan reaches that far, else the longest
 * their plan allows. `locked` lists the windows behind an upgrade.
 */
export function analyticsWindow(plan: Plan, asked: unknown): { days: number; locked: number[]; canExport: boolean } {
  const max = LIMITS[plan].analyticsDays;
  const n = Number(asked);
  // Nothing (or something out of reach) asked: 30 days where the plan has them, else 7.
  const days = (WINDOWS as readonly number[]).includes(n) && n <= max ? n : max >= 30 ? 30 : 7;
  return { days, locked: WINDOWS.filter((d) => d > max), canExport: LIMITS[plan].analyticsExport };
}
