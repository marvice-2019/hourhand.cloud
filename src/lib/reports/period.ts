import { TZDate } from "@date-fns/tz";

// Report periods, bounded at midnight in the host's own time zone. The year runs April to March (the Indian financial
// year), and so do quarters (Q1 = April to June). Pure functions: no clock, no database.

export const PERIOD_KINDS = ["last_30", "this_month", "last_month", "this_quarter", "last_quarter", "this_fy", "last_fy", "custom"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const PERIOD_LABELS: Record<PeriodKind, string> = {
  last_30: "Last 30 days", this_month: "This month", last_month: "Last month", this_quarter: "This quarter", last_quarter: "Last quarter",
  this_fy: "This financial year", last_fy: "Last financial year", custom: "Custom dates",
};

export interface Period {
  kind: PeriodKind;
  /** Inclusive start and exclusive end, as instants. */
  from: Date;
  to: Date;
  /** The same bounds as calendar dates in the host's zone; `last` is the final day shown (inclusive). */
  first: string;
  last: string;
  timezone: string;
  /** True when the plan's window cut the start short. */
  clamped: boolean;
}

/** The longest custom range, so one request can't ask for a decade of rows. */
export const MAX_DAYS = 731;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Midnight at the start of y-m-d (month 0-based, overflow allowed) in `tz`. */
const midnight = (y: number, m: number, d: number, tz: string) => new Date(+new TZDate(y, m, d, tz));

/** The calendar date ("2026-11-15") an instant falls on in `tz`. */
export function localDate(at: Date, tz: string): string {
  const z = new TZDate(at, tz);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, "0")}-${String(z.getDate()).padStart(2, "0")}`;
}

/** The month ("2026-11") an instant falls in, in `tz`. */
export const localMonth = (at: Date, tz: string) => localDate(at, tz).slice(0, 7);

function parseDate(s: string | undefined): [number, number, number] | null {
  const m = s ? DATE.exec(s) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const check = new Date(Date.UTC(y, mo, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo && check.getUTCDate() === d ? [y, mo, d] : null;
}

/** A valid IANA zone, else India time (every host has one, but a bad value mustn't break the page). */
export function safeZone(tz: string | null | undefined): string {
  try {
    if (tz) {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return tz;
    }
  } catch { /* fall through */ }
  return "Asia/Kolkata";
}

function build(kind: PeriodKind, from: Date, to: Date, tz: string): Period {
  return { kind, from, to, first: localDate(from, tz), last: localDate(new Date(to.getTime() - 1), tz), timezone: tz, clamped: false };
}

export interface PeriodQuery { period?: string; from?: string; to?: string; month?: string }

/**
 * The period a query asks for, in the host's zone. A bare `month=YYYY-MM` (the monthly email's link) is that month.
 * Anything unreadable falls back to this month; ranges never run past today or longer than MAX_DAYS.
 */
export function resolvePeriod(q: PeriodQuery, timezone: string, now: Date): Period {
  const tz = safeZone(timezone);
  const t = new TZDate(now, tz);
  const [y, m, d] = [t.getFullYear(), t.getMonth(), t.getDate()];
  const tomorrow = midnight(y, m, d + 1, tz);
  const fyStart = m >= 3 ? y : y - 1;
  const qStart = m - (m % 3); // January, April, July or October: financial-year quarters line up with calendar ones
  const kind = (PERIOD_KINDS as readonly string[]).includes(q.period ?? "") ? (q.period as PeriodKind) : undefined;

  const month = q.month ? MONTH.exec(q.month) : null;
  if (!kind && month) {
    const from = midnight(Number(month[1]), Number(month[2]) - 1, 1, tz);
    if (from < tomorrow) {
      const end = midnight(Number(month[1]), Number(month[2]), 1, tz);
      return build("custom", from, end < tomorrow ? end : tomorrow, tz);
    }
  }
  switch (kind) {
    case "last_30": return build(kind, midnight(y, m, d - 29, tz), tomorrow, tz);
    case "last_month": return build(kind, midnight(y, m - 1, 1, tz), midnight(y, m, 1, tz), tz);
    case "this_quarter": return build(kind, midnight(y, qStart, 1, tz), tomorrow, tz);
    case "last_quarter": return build(kind, midnight(y, qStart - 3, 1, tz), midnight(y, qStart, 1, tz), tz);
    case "this_fy": return build(kind, midnight(fyStart, 3, 1, tz), tomorrow, tz);
    case "last_fy": return build(kind, midnight(fyStart - 1, 3, 1, tz), midnight(fyStart, 3, 1, tz), tz);
    case "custom": {
      const a = parseDate(q.from), b = parseDate(q.to);
      if (a && b) {
        let from = midnight(a[0], a[1], a[2], tz);
        let to = midnight(b[0], b[1], b[2] + 1, tz);
        if (from > to) [from, to] = [midnight(b[0], b[1], b[2], tz), midnight(a[0], a[1], a[2] + 1, tz)];
        if (to > tomorrow) to = tomorrow;
        const earliest = midnight(b[0], b[1], b[2] + 1 - MAX_DAYS, tz);
        if (from < earliest) from = earliest;
        if (from < to) return build(kind, from, to, tz);
      }
      break;
    }
  }
  return build("this_month", midnight(y, m, 1, tz), tomorrow, tz);
}

/** Midnight starting the first of the last `days` days (today included), in `tz`. */
export function windowStart(now: Date, tz: string, days: number): Date {
  const t = new TZDate(now, safeZone(tz));
  return midnight(t.getFullYear(), t.getMonth(), t.getDate() - (days - 1), safeZone(tz));
}

/**
 * Cuts a period to the plan's window (the last `days` days, today included). A period entirely before the window
 * becomes the window itself.
 */
export function clampToWindow(p: Period, days: number, now: Date): Period {
  if (!Number.isFinite(days)) return p;
  const t = new TZDate(now, p.timezone);
  const earliest = windowStart(now, p.timezone, days);
  if (p.from >= earliest) return p;
  if (p.to <= earliest) return { ...build("last_30", earliest, midnight(t.getFullYear(), t.getMonth(), t.getDate() + 1, p.timezone), p.timezone), clamped: true };
  return { ...build(p.kind, earliest, p.to, p.timezone), clamped: true };
}

/** The months ("2026-04") a range touches in `tz`, oldest first. */
export function monthsBetween(from: Date, to: Date, tz: string): string[] {
  const out: string[] = [];
  const z = new TZDate(from, tz);
  for (let y = z.getFullYear(), m = z.getMonth(); ; m++) {
    const start = midnight(y, m, 1, tz);
    if (start >= to) break;
    out.push(localMonth(start, tz));
    if (out.length > 36) break;
  }
  return out;
}

/** The start of the month that is `back` months before the month `at` falls in. */
export function monthStart(at: Date, tz: string, back = 0): Date {
  const z = new TZDate(at, tz);
  return midnight(z.getFullYear(), z.getMonth() - back, 1, tz);
}
