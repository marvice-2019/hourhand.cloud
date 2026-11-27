import { TZDate } from "@date-fns/tz";
import type { AvailabilityRule, CalendarConnection, EventType, Interval } from "./data/types";

const MIN = 60_000;
const DAY = 86_400_000;
/** A calendar whose last good sync is older than this cannot be trusted to offer times. */
export const SYNC_STALE_AFTER_MINUTES = 15;

type Range = { start: Date; end: Date };
/** Busy time from a calendar (with its calendar's id when known), or, kind "poll", a time an open meeting poll holds. */
export type BusyRange = Range & { calendarId?: string; kind?: "poll" };

export interface SlotInput {
  eventType: Pick<
    EventType,
    | "id" | "durationMinutes" | "startIncrementMinutes" | "bufferBeforeMinutes" | "bufferAfterMinutes"
    | "minNoticeMinutes" | "bookingWindowDays" | "dailyLimit" | "weeklyLimit"
  > & Partial<Pick<EventType, "seatLimit">>;
  schedule: { timezone: string };
  rules: AvailabilityRule[];
  busyBlocks: BusyRange[];
  bookings: { id?: string; eventTypeId: string; status: "confirmed" | "cancelled" | "pending_payment" | "pending_approval"; holdExpiresAt: Date | null; startAt: Date; bufferedStart: Date; bufferedEnd: Date; classKey?: string | null }[];
  now: Date;
  rangeStart: Date;
  rangeEnd: Date;
  /** True when any conflict-checked calendar is out of date. Hourhand then offers no times at all. */
  syncStale: boolean;
}

/** Every seat of one group class shares this: the event type and the class's start. */
export const classKeyOf = (eventTypeId: string, startAt: Date) => `${eventTypeId}@${startAt.toISOString()}`;

/** Half-open [start, end) overlap: ranges that only touch do not overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function isSyncStale(connections: Pick<CalendarConnection, "status" | "lastSyncedAt">[], now: Date): boolean {
  return connections.some(
    (c) => c.status !== "ok" || !c.lastSyncedAt || now.getTime() - c.lastSyncedAt.getTime() > SYNC_STALE_AFTER_MINUTES * MIN,
  );
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** "YYYY-MM-DD" for a UTC-midnight timestamp that stands for a calendar date. */
function isoDate(dayMs: number): string {
  return new Date(dayMs).toISOString().slice(0, 10);
}

/** Calendar date (as a UTC-midnight timestamp) of an instant, seen in `tz`. */
export function localDay(instant: Date, tz: string): number {
  const d = new TZDate(instant.getTime(), tz);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The UTC instant of a wall-clock time on a calendar date in `tz`. */
function wallTime(dayMs: number, minutes: number, tz: string): number {
  const d = new Date(dayMs);
  return new TZDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(minutes / 60), minutes % 60, tz).getTime();
}

/** The Monday that starts a local day's week (Monday to Sunday, as the week reads in India). */
export const weekOf = (dayMs: number) => dayMs - ((new Date(dayMs).getUTCDay() + 6) % 7) * DAY;

function intervalsFor(dayMs: number, rules: AvailabilityRule[]): Interval[] {
  const date = isoDate(dayMs);
  const override = rules.find((r) => r.kind === "date" && r.onDate === date);
  if (override) return override.intervals; // replaces the weekly hours; [] means unavailable
  const weekday = new Date(dayMs).getUTCDay();
  return rules.find((r) => r.kind === "weekly" && r.weekday === weekday)?.intervals ?? [];
}

/**
 * Bookable slot starts (UTC) for one event type. Pure: same input, same output.
 * Availability is expanded per calendar date in the schedule's zone, so daylight-saving changes there
 * move the UTC times and never the host's wall-clock hours.
 */
export function computeSlots(input: SlotInput): Date[] {
  return computeSlotSeats(input).map((s) => s.start);
}

/**
 * computeSlots with each start's seats left: null for a one-on-one type. A group class time stays open while it has a
 * free seat: its own seats, and the host's calendar event for it (exactly the class's time), don't block it.
 */
export function computeSlotSeats(input: SlotInput): { start: Date; seatsLeft: number | null }[] {
  if (input.syncStale) return [];
  const s = prepare(input);
  const earliest = Math.max(s.rangeStart, s.now + s.notice);
  const latest = Math.min(s.rangeEnd, s.now + s.window);
  if (earliest >= latest) return [];

  const slots: { start: Date; seatsLeft: number | null }[] = [];
  const lastDay = localDay(new Date(latest), s.tz);
  for (let day = localDay(new Date(earliest), s.tz); day <= lastDay; day += DAY) {
    // A full day or week takes no new session; a group class already on it still takes guests.
    if (s.seatLimit === null && fullOn(s, day)) continue;
    for (const v of dayStarts(s, day, input.rules)) {
      if (v.reason === null) slots.push({ start: v.start, seatsLeft: v.seatsLeft });
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** B15: why a start the host's hours offer isn't open to guests, in the order a host would look. null means open. */
export type SlotReason =
  | "sync_stale" | "past" | "notice" | "window" | "class_full" | "day_full" | "week_full" | "booking" | "calendar" | "poll";

/** What a start clashed with: a booking (its start) or a busy time from a calendar or a meeting poll. */
export interface SlotBlocker {
  start: Date;
  end: Date;
  bookingId: string | null;
  calendarId: string | null;
}

export interface SlotVerdict {
  start: Date;
  seatsLeft: number | null;
  reason: SlotReason | null;
  blocker: SlotBlocker | null;
}

export interface DayCheck {
  /** The day checked, "YYYY-MM-DD" in the schedule's zone. */
  date: string;
  /** The hours that day: a date override's when there is one (empty = day off), else the weekday's. */
  hours: Interval[];
  hoursFrom: "date" | "weekly";
  syncStale: boolean;
  /** Every start the hours offer that day, open or not. computeSlots offers exactly the open ones. */
  starts: SlotVerdict[];
}

/**
 * B15: every start one day's hours offer for an event type, each with the reason guests can't book it. It runs the same
 * checks as computeSlotSeats, so the open starts here are the times the booking page shows for that day.
 */
export function explainDay(input: Omit<SlotInput, "rangeStart" | "rangeEnd">, date: string): DayCheck {
  const day = Date.parse(`${date}T00:00:00Z`);
  const tz = input.schedule.timezone;
  const s = prepare({ ...input, rangeStart: new Date(wallTime(day, 0, tz)), rangeEnd: new Date(wallTime(day + DAY, 0, tz)) });
  const override = input.rules.find((r) => r.kind === "date" && r.onDate === date);
  return {
    date,
    hours: intervalsFor(day, input.rules),
    hoursFrom: override ? "date" : "weekly",
    syncStale: input.syncStale,
    starts: [...dayStarts(s, day, input.rules)].sort((a, b) => a.start.getTime() - b.start.getTime()),
  };
}

type Busy = { start: number; end: number; startAt: number; bookingId: string | null; calendarId: string | null; poll: boolean };

interface Scan {
  tz: string;
  now: number;
  rangeStart: number;
  rangeEnd: number;
  notice: number;
  window: number;
  duration: number;
  step: number;
  before: number;
  after: number;
  syncStale: boolean;
  dailyLimit: number | null;
  weeklyLimit: number | null;
  seatLimit: number | null;
  booked: Busy[];
  busy: Busy[];
  ownSeat: Set<string>;
  seatsTaken: Map<number, number>; // class start -> seats taken, for this group type
  bookedPerDay: Map<number, number>;
  bookedPerWeek: Map<number, number>;
}

function prepare(input: SlotInput): Scan {
  const { eventType: et, schedule, busyBlocks, bookings, now, rangeStart, rangeEnd, syncStale } = input;
  const tz = schedule.timezone;
  // A hold the guest is still paying for blocks like a confirmed booking; a lapsed one is about to be expired and doesn't.
  const confirmed = bookings.filter((b) => b.status === "confirmed" || ((b.status === "pending_payment" || b.status === "pending_approval") && b.holdExpiresAt !== null && b.holdExpiresAt > now));
  const seatsTaken = new Map<number, number>();
  const counted = new Set<string>();
  const bookedPerDay = new Map<number, number>();
  const bookedPerWeek = new Map<number, number>();
  for (const b of confirmed) {
    if (b.eventTypeId !== et.id) continue;
    if (b.classKey) {
      seatsTaken.set(b.startAt.getTime(), (seatsTaken.get(b.startAt.getTime()) ?? 0) + 1);
      if (counted.has(b.classKey)) continue; // a class counts once towards the limits
      counted.add(b.classKey);
    }
    const day = localDay(b.startAt, tz);
    bookedPerDay.set(day, (bookedPerDay.get(day) ?? 0) + 1);
    bookedPerWeek.set(weekOf(day), (bookedPerWeek.get(weekOf(day)) ?? 0) + 1);
  }
  return {
    tz,
    now: now.getTime(),
    rangeStart: rangeStart.getTime(),
    rangeEnd: rangeEnd.getTime(),
    notice: et.minNoticeMinutes * MIN,
    window: et.bookingWindowDays * DAY,
    duration: et.durationMinutes * MIN,
    step: et.startIncrementMinutes * MIN,
    before: et.bufferBeforeMinutes * MIN,
    after: et.bufferAfterMinutes * MIN,
    syncStale,
    dailyLimit: et.dailyLimit ?? null,
    weeklyLimit: et.weeklyLimit ?? null,
    seatLimit: et.seatLimit ?? null,
    booked: confirmed.map((b) => ({
      start: b.bufferedStart.getTime(), end: b.bufferedEnd.getTime(), startAt: b.startAt.getTime(), bookingId: b.id ?? null, calendarId: null, poll: false,
    })),
    busy: busyBlocks.map((b) => ({
      start: b.start.getTime(), end: b.end.getTime(), startAt: b.start.getTime(), bookingId: null, calendarId: b.calendarId ?? null, poll: b.kind === "poll",
    })),
    ownSeat: new Set(confirmed.filter((b) => b.eventTypeId === et.id && b.classKey).map((b) => `${b.bufferedStart.getTime()}:${b.bufferedEnd.getTime()}`)),
    seatsTaken,
    bookedPerDay,
    bookedPerWeek,
  };
}

function dayFull(s: Scan, day: number): boolean {
  return s.dailyLimit !== null && (s.bookedPerDay.get(day) ?? 0) >= s.dailyLimit;
}

function weekFull(s: Scan, day: number): boolean {
  return s.weeklyLimit !== null && (s.bookedPerWeek.get(weekOf(day)) ?? 0) >= s.weeklyLimit;
}

const fullOn = (s: Scan, day: number) => dayFull(s, day) || weekFull(s, day);

/** Every start one local day's hours offer inside the scan's range, each with the first reason it can't be booked. */
function* dayStarts(s: Scan, day: number, rules: AvailabilityRule[]): Generator<SlotVerdict> {
  for (const { from, to } of intervalsFor(day, rules)) {
    const open = wallTime(day, minutesOf(from), s.tz);
    const close = wallTime(day, minutesOf(to), s.tz);
    for (let start = open; start + s.duration <= close; start += s.step) {
      if (start < s.rangeStart || start >= s.rangeEnd) continue;
      const taken = s.seatLimit === null ? 0 : s.seatsTaken.get(start) ?? 0;
      const seatsLeft = s.seatLimit === null ? null : s.seatLimit - taken;
      const verdict = (reason: SlotReason | null, hit: Busy | null = null): SlotVerdict => ({
        start: new Date(start), seatsLeft, reason,
        blocker: hit && { start: new Date(hit.startAt), end: new Date(hit.end), bookingId: hit.bookingId, calendarId: hit.calendarId },
      });
      if (s.syncStale) { yield verdict("sync_stale"); continue; }
      if (start < s.now) { yield verdict("past"); continue; }
      if (start < s.now + s.notice) { yield verdict("notice"); continue; }
      if (start >= s.now + s.window) { yield verdict("window"); continue; }
      if (s.seatLimit !== null && taken >= s.seatLimit) { yield verdict("class_full"); continue; }
      // A full day or week takes no new session; a group class already on it still takes guests.
      if (taken === 0 && dayFull(s, day)) { yield verdict("day_full"); continue; }
      if (taken === 0 && weekFull(s, day)) { yield verdict("week_full"); continue; }
      const bufStart = start - s.before;
      const bufEnd = start + s.duration + s.after;
      // A class already running at this start: its seats and its calendar event are this class, not a clash.
      const clashes = (b: Busy) => !(taken > 0 && ((b.start === start && b.end === start + s.duration) || s.ownSeat.has(`${b.start}:${b.end}`)))
        && overlaps(bufStart, bufEnd, b.start, b.end);
      const booking = s.booked.find(clashes);
      if (booking) { yield verdict("booking", booking); continue; }
      const busy = s.busy.find(clashes);
      if (busy) { yield verdict(busy.poll ? "poll" : "calendar", busy); continue; }
      yield verdict(null);
    }
  }
}

export interface OneOffSlotInput {
  /** The start times the host offered. */
  times: Date[];
  durationMinutes: number;
  busyBlocks: Range[];
  bookings: SlotInput["bookings"];
  now: Date;
  rangeStart: Date;
  rangeEnd: Date;
  syncStale: boolean;
}

/**
 * Free times for a one-off meeting: the offered times still in the future and inside the range that clash with nothing
 * (busy calendar time, a confirmed booking, or a payment hold still running). No buffers, notice or working hours: the
 * host picked these times by hand. A stale calendar offers nothing, as for every other event type.
 */
export function computeOneOffSlots(input: OneOffSlotInput): Date[] {
  const { times, durationMinutes, busyBlocks, bookings, now, rangeStart, rangeEnd, syncStale } = input;
  if (syncStale) return [];
  const duration = durationMinutes * MIN;
  const live = bookings.filter((b) => b.status === "confirmed" || ((b.status === "pending_payment" || b.status === "pending_approval") && b.holdExpiresAt !== null && b.holdExpiresAt > now));
  const blocked: [number, number][] = [
    ...live.map((b): [number, number] => [b.bufferedStart.getTime(), b.bufferedEnd.getTime()]),
    ...busyBlocks.map((b): [number, number] => [b.start.getTime(), b.end.getTime()]),
  ];
  return times
    .filter((t) => t.getTime() > now.getTime() && t >= rangeStart && t < rangeEnd)
    .filter((t) => !blocked.some(([s, e]) => overlaps(t.getTime(), t.getTime() + duration, s, e)))
    .sort((a, b) => a.getTime() - b.getTime());
}
