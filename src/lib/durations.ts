// Multiple lengths on one event type (e.g. 30, 45 or 60 minutes), each with an optional price of its own.
// An event type with no options offers exactly its own durationMinutes at its own price, as before.
import type { DurationOption, EventType } from "./data/types";

/** The most lengths one event type offers. */
export const MAX_DURATION_OPTIONS = 4;

type Priced = Pick<EventType, "durationMinutes" | "priceMinor"> & { durationOptions?: DurationOption[] };

/** The lengths a guest can pick, shortest first, each with what it costs (null = free). */
export function durationChoices(et: Priced): { minutes: number; priceMinor: number | null }[] {
  const options = et.durationOptions ?? [];
  if (options.length === 0) return [{ minutes: et.durationMinutes, priceMinor: et.priceMinor }];
  return [...options].sort((a, b) => a.minutes - b.minutes).map((o) => ({ minutes: o.minutes, priceMinor: o.priceMinor ?? et.priceMinor }));
}

/** True when the guest has a length to pick. */
export const hasDurationChoice = (et: Priced) => durationChoices(et).length > 1;

/**
 * The length a request books: the event type's own when none is asked for, the asked-for one when it is offered,
 * otherwise null (the request is refused).
 */
export function resolveDuration(et: Priced, requested: number | null | undefined): number | null {
  if (requested === null || requested === undefined) return et.durationMinutes;
  return durationChoices(et).some((c) => c.minutes === requested) ? requested : null;
}

/** What one session of `minutes` costs: its own price, or the event type's. */
export function priceFor(et: Priced, minutes: number): number | null {
  return durationChoices(et).find((c) => c.minutes === minutes)?.priceMinor ?? et.priceMinor;
}

/** The event type as the slot engine should see it for one chosen length: buffers, limits and the rest stay the same. */
export function withDuration<T extends Pick<EventType, "durationMinutes">>(et: T, minutes: number): T {
  return minutes === et.durationMinutes ? et : { ...et, durationMinutes: minutes };
}

/** A booking's own length in minutes. */
export const bookedMinutes = (b: { startAt: Date; endAt: Date }) => Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60_000);

/** The booking page's length choices with prices as shown, or undefined when there is only one length. */
export function guestDurations(et: Priced, formatPrice: (minor: number) => string, opts: { showPrice?: boolean } = {}): { minutes: number; price: string | null }[] | undefined {
  const choices = durationChoices(et);
  if (choices.length < 2) return undefined;
  return choices.map((c) => ({ minutes: c.minutes, price: opts.showPrice !== false && c.priceMinor !== null ? formatPrice(c.priceMinor) : null }));
}

/** "30 / 45 / 60 min" style summary: the lengths offered, shortest first. */
export const lengthsLabel = (et: Priced) => durationChoices(et).map((c) => c.minutes).join(" / ");

/** The price line for a listing: one price, or the lowest and highest ("₹499 – ₹899"); null when free. */
export function priceRange(et: Priced, formatPrice: (minor: number) => string): string | null {
  const prices = durationChoices(et).map((c) => c.priceMinor).filter((p): p is number => p !== null);
  if (prices.length === 0) return null;
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? formatPrice(lo) : `${formatPrice(lo)} – ${formatPrice(hi)}`;
}
