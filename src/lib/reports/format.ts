// Display helpers for reports: money in its own currency (INR with Indian digit grouping), dates and rates.

/** "₹1,23,456.50" for INR, "$1,234" for USD; whole amounts drop the paise. */
export function money(minor: number, currency: string): string {
  const major = minor / 100;
  const digits = Number.isInteger(major) ? 0 : 2;
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

/** "12.5%", or "–" when there is nothing to divide. */
export const percent = (rate: number | null) => (rate === null ? "–" : `${Math.round(rate * 1000) / 10}%`);

/** "1 Apr 2026" for a "2026-04-01" calendar date. */
export const dayLabel = (date: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/** "Oct 2026" for "2026-10". */
export const monthLabel = (month: string) => new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
