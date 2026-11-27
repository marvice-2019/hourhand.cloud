import type { ConsentInput } from "../privacy/consent";
import type { NoteRevision } from "../privacy/note-history";

// Entities mirror docs/schema.sql (snake_case columns -> camelCase fields). Times are UTC Date objects.

export type Interval = { from: string; to: string }; // "HH:MM" wall time in the schedule's zone

export interface User {
  id: string;
  email: string;
  name: string;
  slug: string;
  timezone: string;
  timeFormat: "12h" | "24h";
  /** The language guests see on the booking pages unless they pick another: en, hi, ta, te or kn. */
  locale: string;
  /** The language of the host's own dashboard and the emails sent to the host: en, hi or ta. Missing means English. */
  hostLocale?: string;
}

export interface AvailabilitySchedule {
  id: string;
  userId: string;
  name: string;
  timezone: string;
  isDefault: boolean;
}

/** A schedule with the event types that use it (by id, or by falling back to the default when theirs is null). */
export type ScheduleSummary = AvailabilitySchedule & { eventTypes: { id: string; name: string }[] };

export type AvailabilityRule =
  | { id: string; scheduleId: string; kind: "weekly"; weekday: number; onDate: null; intervals: Interval[] }
  | { id: string; scheduleId: string; kind: "date"; weekday: null; onDate: string; intervals: Interval[] };

export interface EventType {
  id: string;
  userId: string;
  scheduleId: string | null;
  name: string;
  slug: string;
  description: string | null;
  durationMinutes: number;
  minNoticeMinutes: number;
  bookingWindowDays: number;
  startIncrementMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  dailyLimit: number | null;
  /** Guests can't cancel online once the start is closer than this. 0 = any time before the start. */
  cancelCutoffMinutes: number;
  /** What guests pay in minor units (paise, cents); null = free. */
  priceMinor: number | null;
  /** The currency of the price or deposit: INR on Razorpay, the Stripe account's currency otherwise. Null when nothing is charged. */
  currency: string | null;
  hidden: boolean;
  active: boolean;
  position: number;
  /** A one_off type is a one-off meeting: offered only at its own times, through its single-use link. */
  kind: "one_on_one" | "group" | "one_off";
  /** A group class: how many guests one session takes (2 to 500). null for one-on-one and one-off types. */
  seatLimit: number | null;
  /** Guests may book the same time weekly for up to this many weeks in one go; 1 = no repeats. A priced series is paid in one payment; not with a deposit. */
  maxRepeats: number;
  /** A refundable no-show deposit in paise, on a free event type; null = none. Refunded after the session unless marked a no-show. */
  depositMinor: number | null;
  /** Where guests go after booking (https), instead of staying on the confirmation page; null = stay. */
  redirectUrl: string | null;
  /** Most bookings of this type per week (Monday to Sunday, host's zone); null = no limit. */
  weeklyLimit: number | null;
  /** The host's own words on cancelling, shown before booking and next to Cancel; null = none. */
  cancelPolicy: string | null;
  /**
   * Lengths the guest picks from (durationMinutes is one of them, the one picked first). Empty = only durationMinutes.
   * Each may carry its own price; null uses priceMinor.
   */
  durationOptions: DurationOption[];
  /** Bookings wait for the host's approval, holding the slot meanwhile (B9). Only on a free one-on-one type with no repeats. */
  requiresApproval: boolean;
}

/** One length an event type offers, with its own price in paise (null = the event type's price). */
export interface DurationOption { minutes: number; priceMinor: number | null }

/** What the host enters for a one-off meeting. */
export interface OneOffInput {
  name: string;
  durationMinutes: number;
  location: { kind: LocationKind; value?: string | null };
  description?: string | null;
  times: Date[];
}

/** A one-off meeting the store refused: `field` names what is wrong. */
export class InvalidOneOffError extends Error {
  readonly code = "invalid_one_off";
  constructor(readonly field: "times" | "durationMinutes" | "name", message: string) {
    super(message);
    this.name = "InvalidOneOffError";
  }
}

export type LocationKind =
  | "google_meet" | "zoom" | "teams" | "phone_host_calls" | "phone_guest_calls" | "in_person" | "custom" | "ask_guest" | "hourhand_video";

export const LOCATION_KINDS: readonly LocationKind[] = [
  "google_meet", "zoom", "teams", "phone_host_calls", "phone_guest_calls", "in_person", "custom", "ask_guest", "hourhand_video",
];

export interface EventLocation {
  id: string;
  eventTypeId: string;
  kind: LocationKind;
  value: string | null;
  position: number;
}

export interface CustomQuestion {
  id: string;
  eventTypeId: string;
  label: string;
  kind: "short_text" | "long_text" | "phone" | "single_select" | "multi_select" | "consent" | QuestionKindIntake;
  required: boolean;
  choices: string[];
  position: number;
  /** Asked only when an earlier question's answer is one of `values` (see src/lib/intake). Absent or null: always asked. */
  showIf?: QuestionCondition | null;
  /** Asked only the first time a client email books with this host. */
  firstBookingOnly?: boolean;
  /** Bounds for a number question; null or absent means no bound. */
  minValue?: number | null;
  maxValue?: number | null;
  /** The host's intake template this question was copied from, if any. */
  templateId?: string | null;
}

/** Kinds added for intake forms (roadmap 2.5). */
export type QuestionKindIntake = "yes_no" | "date" | "number" | "email";

/** Show a question only when the answer to `questionId` (an earlier select or yes/no question) is one of `values`. */
export interface QuestionCondition { questionId: string; values: string[] }

export interface Booking {
  id: string;
  eventTypeId: string;
  hostId: string;
  startAt: Date;
  endAt: Date;
  bufferedStart: Date;
  bufferedEnd: Date;
  /**
   * pending_payment: a paid booking holding its slot until holdExpiresAt while the guest pays.
   * pending_approval: a request holding its slot until holdExpiresAt while the host decides (B9).
   */
  status: "confirmed" | "cancelled" | "pending_payment" | "pending_approval";
  holdExpiresAt: Date | null;
  locationKind: LocationKind | null;
  /** The video link from the host's calendar (Google Meet), once the calendar event exists. */
  joinUrl: string | null;
  idempotencyKey: string;
  cancelledAt: Date | null;
  cancelledBy: "host" | "guest" | "system" | null;
  cancelReason: string | null;
  /** The booking this one replaced when a guest rescheduled. */
  rescheduledFromId: string | null;
  /** A weekly series: the first week's booking id, and this week's place in it (1 = first). Both null otherwise. */
  seriesId: string | null;
  seriesIndex: number | null;
  /** A seat in a group class: shared by every seat of the same class (event type + start). null for other bookings. */
  classKey: string | null;
  createdAt: Date;
  /** B10: when the host asked the guest to pick a new time, and what they wrote. null until they ask. */
  rescheduleRequestedAt?: Date | null;
  rescheduleRequestNote?: string | null;
}

export interface Invitee {
  id: string;
  bookingId: string;
  hostId: string;
  name: string;
  email: string;
  timezone: string;
  phone: string | null;
  answers: InviteeAnswer[];
  manageToken: string;
  /** When the host marked the guest as not having turned up. */
  noShowAt: Date | null;
  /** The guest said they're running this many minutes late, and when they said it. */
  runningLateMinutes: number | null;
  runningLateAt: Date | null;
  /** Extra guests (emails) the person booking added; they hear about the booking but can't change it. */
  guests: string[];
  /** The language the guest booked in (en, hi, ta, te, kn): their emails and WhatsApp texts follow it. */
  locale: string;
  /** The guest ticked "updates on WhatsApp" for the phone they gave. */
  whatsappOptIn: boolean;
  /** Texts (SMS) to the phone are on: ticked when booking, or turned on on the manage page. */
  smsOptIn?: boolean;
}

/** One entry of invitees.answers (jsonb). The label is copied so later edits to the question don't rewrite history. */
export interface InviteeAnswer { questionId: string; label: string; answer: string }

export type BookingWithInvitee = Booking & { invitee: Invitee };

export type SyncStatus = "ok" | "degraded" | "disconnected";

export interface CalendarConnection {
  id: string;
  userId: string;
  provider: "google" | "microsoft" | "icloud";
  accountEmail: string;
  status: SyncStatus;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

export interface Calendar {
  id: string;
  connectionId: string;
  userId: string;
  name: string;
  checkConflicts: boolean;
  isAddTo: boolean;
  /** Whether booked events can go into it: only calendars the host owns. */
  canWrite: boolean;
}

export interface BusyBlock {
  id: string;
  calendarId: string;
  userId: string;
  start: Date;
  end: Date;
}

/** B9: what the host (approve, decline) or the guest (withdraw) does with a request. */
export type RequestDecision = "approve" | "decline" | "withdraw";
/** What became of a request: the decision applied, or why nothing changed. */
export type RequestOutcome = "approved" | "declined" | "withdrawn" | "already_confirmed" | "already_cancelled" | "lapsed";
/** B10: what came of the host asking the guest to pick a new time. */
export type RescheduleAskOutcome = "asked" | "already_asked" | "not_upcoming" | "not_confirmed" | "group_seat";
/** The longest note a host can send with that ask. */
export const RESCHEDULE_NOTE_MAX = 500;

export interface CreateBookingInput {
  eventTypeId: string;
  startAt: Date;
  idempotencyKey: string;
  /** Set for a paid booking: it starts as pending_payment holding the slot until then, with no emails yet. Postgres only. */
  holdUntil?: Date;
  /** Set for a request on an event type that needs approval: it starts as pending_approval holding the slot until then. */
  approvalUntil?: Date;
  /** Book through a single-use link: it must be open and for this event type, and is used up in the same transaction. */
  bookingLinkToken?: string;
  /** The request's clock, for checking the link above has not expired. Defaults to the real time. */
  now?: Date;
  /** Book the same time this many weeks running (2+), all or none. The returned booking is the first week. */
  weeks?: number;
  /** The length the guest picked (one of the event type's options); defaults to the event type's own. */
  durationMinutes?: number;
  /** Pay with a session package (its buyer's token): one credit per booking, checked and used in the same write. Postgres only. */
  packageToken?: string;
  invitee: { name: string; email: string; timezone: string; phone: string | null; answers: InviteeAnswer[]; guests?: string[]; locale?: string; whatsappOptIn?: boolean; smsOptIn?: boolean;
    /** The consent log lines to record with each booking this makes (see src/lib/privacy/consent.ts). Postgres only; a move records none. */
    consent?: ConsentInput[] };
}

export type BookingLinkState = "open" | "used" | "expired" | "revoked";

/**
 * A single-use booking link. `state` is derived: used when a booking made through it exists that the system didn't
 * cancel (a lapsed payment hold frees it); otherwise revoked, then expired, then open.
 */
export interface BookingLink {
  id: string;
  eventTypeId: string;
  label: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  state: BookingLinkState;
  usedBy: { bookingId: string; guestName: string; startAt: Date } | null;
}

export type ResolvedBookingLink =
  | { status: "open"; link: BookingLink; host: User; eventType: EventType }
  | { status: "used" | "expired" | "revoked" | "not_found" };

/** Someone already booked through this single-use link (or won the race to). */
/**
 * True when `err` is the error class named `name`. Matches the name each class sets, not instanceof: a Next production
 * build bundles a route and the data store separately, each with its own copy of these classes, so instanceof fails across
 * them (a booking race answered 500 instead of 409 because of it). Names are string literals, so minifying keeps them.
 */
export function isNamedError<T extends Error = Error>(err: unknown, name: string): err is T {
  return err instanceof Error && err.name === name;
}

export class LinkUsedError extends Error {
  readonly code = "link_used";
  constructor() {
    super("This link has already been used");
    this.name = "LinkUsedError";
  }
}

/** A booking link that can't be booked through: unknown (or for another event type), expired or revoked. */
export class LinkUnavailableError extends Error {
  readonly code = "link_unavailable";
  readonly status: "used" | "expired" | "revoked" | "not_found";
  constructor(status: "used" | "expired" | "revoked" | "not_found") {
    super(status === "not_found" ? "Booking link not found" : `This link is ${status}`);
    this.name = "LinkUnavailableError";
    this.status = status;
  }
}

/** Mirrors the bookings.no_double_booking exclusion constraint (Postgres 23P01). */
export class SlotTakenError extends Error {
  readonly code = "slot_taken";
  constructor() {
    super("That time was just taken.");
    this.name = "SlotTakenError";
  }
}

/** A request key that was already used for a different booking (another event type, host or reschedule). */
export class RequestKeyConflictError extends Error {
  readonly code = "key_conflict";
  constructor() {
    super("That request key was already used for a different booking");
    this.name = "RequestKeyConflictError";
  }
}

/** A record that doesn't exist, or belongs to someone else (the caller can't tell which, by design). */
export class NotFoundError extends Error {
  readonly code = "not_found";
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** The data layer every screen talks to. The Postgres version implements the same interface. */
export interface DataStore {
  /** Memory mode only: the seeded demo host. Postgres throws; screens use requireUser() from @/lib/auth/session. */
  getCurrentUser(): Promise<User>;
  getUserBySlug(slug: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  /** The host's default booking page language. */
  setUserLocale(userId: string, locale: string): Promise<void>;
  /** The host's own dashboard and email language. */
  setUserHostLocale(userId: string, locale: string): Promise<void>;
  listEventTypes(userId: string): Promise<EventType[]>;
  getEventType(userId: string, id: string): Promise<EventType | null>;
  getPublicEventType(hostSlug: string, eventSlug: string): Promise<{ host: User; eventType: EventType } | null>;
  /** Empty unless the event type belongs to `userId`. */
  listEventLocations(userId: string, eventTypeId: string): Promise<EventLocation[]>;
  listCustomQuestions(userId: string, eventTypeId: string): Promise<CustomQuestion[]>;
  getDefaultSchedule(userId: string): Promise<{ schedule: AvailabilitySchedule; rules: AvailabilityRule[] }>;
  /** Every schedule of the host, default first, then by name. Makes the default first if the host has none yet. */
  listSchedules(userId: string): Promise<ScheduleSummary[]>;
  /**
   * The schedule an event type books against: `scheduleId` when it is the host's, otherwise (null, or not theirs) the
   * host's default. Never throws for a missing schedule, so a guest always gets the host's default hours at worst.
   */
  getSchedule(userId: string, scheduleId: string | null): Promise<{ schedule: AvailabilitySchedule; rules: AvailabilityRule[] }>;
  /**
   * A new, non-default schedule: weekdays 09:00–17:00 in `timezone`, or with `copyFrom`, a copy of that schedule's weekly
   * hours and date overrides (its time zone too unless one is given). Throws ScheduleLimitError when the host already
   * has `limit` schedules, ScheduleNameTakenError for a name they already use (any case), NotFoundError for `copyFrom`
   * that isn't theirs.
   */
  createSchedule(userId: string, input: { name: string; timezone?: string; copyFrom?: string }, limit: number): Promise<AvailabilitySchedule>;
  /** Renames it and sets its time zone. Throws NotFoundError or ScheduleNameTakenError. */
  updateSchedule(userId: string, scheduleId: string, input: { name: string; timezone: string }): Promise<AvailabilitySchedule>;
  /** Makes it the host's one default: what new event types and event types with no schedule use. */
  setDefaultSchedule(userId: string, scheduleId: string): Promise<void>;
  /**
   * Deletes a schedule. Throws DefaultScheduleError for the default, and ScheduleInUseError (naming the event types)
   * while event types use it, unless `moveTo` names another of the host's schedules: those event types move there in
   * the same write.
   */
  deleteSchedule(userId: string, scheduleId: string, opts?: { moveTo?: string }): Promise<void>;
  /** Points the event type at one of the host's schedules. Throws NotFoundError unless both are theirs. */
  setEventTypeSchedule(userId: string, eventTypeId: string, scheduleId: string): Promise<EventType>;
  listCalendarConnections(userId: string): Promise<CalendarConnection[]>;
  listCalendars(userId: string): Promise<Calendar[]>;
  listBusyBlocks(userId: string, from: Date, to: Date): Promise<BusyBlock[]>;
  listBookings(userId: string): Promise<BookingWithInvitee[]>;
  getBooking(userId: string, id: string): Promise<BookingWithInvitee | null>;
  getBookingByManageToken(token: string): Promise<BookingWithInvitee | null>;
  createBooking(input: CreateBookingInput): Promise<BookingWithInvitee>;
  /**
   * Throws NotFoundError unless the booking belongs to `hostId`. With `laterWeeks`, a week of a series also cancels the
   * series' later upcoming weeks in the same write; one pair of cancellation emails covers them all.
   */
  cancelBooking(hostId: string, bookingId: string, by: "host" | "guest", reason?: string, opts?: { laterWeeks?: boolean }): Promise<BookingWithInvitee>;
  /**
   * B9: the host approves or declines a request, or the guest withdraws it. Only a request still holding its slot
   * changes; otherwise the result says what became of it. Throws NotFoundError unless the booking belongs to `hostId`.
   */
  decideRequest(hostId: string, bookingId: string, decision: RequestDecision, now: Date): Promise<RequestOutcome>;
  /** B10: the host asks the guest to pick a new time; the guest gets one email. The booking itself doesn't change. */
  askToReschedule(hostId: string, bookingId: string, note: string | null, now: Date): Promise<RescheduleAskOutcome>;
  /** Atomically books `startAt` for the same guest and cancels the old booking. The overlap check ignores the old booking. */
  /** `by` is recorded as who cancelled the old booking. */
  rescheduleBooking(hostId: string, bookingId: string, startAt: Date, idempotencyKey: string, by?: "host" | "guest"): Promise<BookingWithInvitee>;
  /** Marks (or clears) the guest as a no-show. Throws NotFoundError unless it is `hostId`'s confirmed booking that has started by `now`. */
  setNoShow(hostId: string, bookingId: string, on: boolean, now: Date): Promise<BookingWithInvitee>;
  /** Replaces the weekly rules: weekday (0 = Sunday) to its ranges. Days left out or empty are unavailable. */
  /** The four schedule writes throw NotFoundError unless the schedule belongs to `userId`. */
  saveWeeklyHours(userId: string, scheduleId: string, byWeekday: Record<number, Interval[]>): Promise<void>;
  /** Sets one date's hours, replacing any override for that date. Empty intervals = unavailable all day. */
  saveDateOverride(userId: string, scheduleId: string, date: string, intervals: Interval[]): Promise<void>;
  deleteDateOverride(userId: string, scheduleId: string, date: string): Promise<void>;
  /** Marks every date from `from` to `to` (both included, YYYY-MM-DD) unavailable. */
  blockDateRange(userId: string, scheduleId: string, from: string, to: string): Promise<void>;
  /** Throws SlugTakenError when the user already has an event type with that slug (unique (user_id, slug)). */
  createEventType(userId: string, draft: EventTypeDraft): Promise<EventType>;
  updateEventType(userId: string, id: string, draft: EventTypeDraft): Promise<EventType>;
  setEventTypeActive(userId: string, id: string, active: boolean): Promise<EventType>;
  /** Throws EventTypeInUseError while bookings still point at it (bookings.event_type_id is on delete restrict). */
  deleteEventType(userId: string, id: string, now?: Date): Promise<void>;
  /** Replaces the event type's questions; list order becomes position. */
  saveQuestions(userId: string, eventTypeId: string, questions: QuestionDraft[]): Promise<CustomQuestion[]>;
  /**
   * Closes the account now: marks it deleted, turns its links off, cancels upcoming bookings and ends every session.
   * Deleted hosts are invisible to getUser and getUserBySlug. Returns the cancelled bookings so guests can be told.
   */
  deleteAccount(userId: string, now?: Date): Promise<BookingWithInvitee[]>;
  /** Permanently removes accounts deleted more than 30 days before `now`, with everything they own. Returns how many. */
  purgeDeletedAccounts(now?: Date): Promise<number>;
  /** Throws NotFoundError unless the event type is `hostId`'s and active. The raw token is returned only here. */
  createBookingLink(hostId: string, eventTypeId: string, opts: { label?: string; expiresAt?: Date | null }, now: Date): Promise<{ link: BookingLink; token: string }>;
  /** Newest first. */
  listBookingLinks(hostId: string, now: Date): Promise<BookingLink[]>;
  /** Throws NotFoundError unless it is `hostId`'s link and open at `now`. */
  revokeBookingLink(hostId: string, linkId: string, now: Date): Promise<BookingLink>;
  /** Public: what `/l/{token}` shows. Only an open link reveals its host and event type. */
  /** `idempotencyKey`: a retried submit whose own booking is what uses the link gets it back as open. */
  resolveBookingLink(token: string, now: Date, opts?: { idempotencyKey?: string }): Promise<ResolvedBookingLink>;
  /** Records that the guest is running `minutes` late on a confirmed booking and emails the host. NotFoundError otherwise. */
  markRunningLate(manageToken: string, minutes: number, now: Date): Promise<BookingWithInvitee>;
  /** The host's private note about a client (by email, any case); "" when none. */
  getClientNote(hostId: string, email: string): Promise<string>;
  /**
   * Saves it; an empty note removes it. Postgres seals it (AES-256-GCM, TOKEN_ENCRYPTION_KEY) before it is stored. A
   * change records a history line (who: `actorId`, default the host; when); saving the same text records nothing.
   */
  saveClientNote(hostId: string, email: string, note: string, actorId?: string): Promise<void>;
  /** The host's private session note on one of their bookings; "" when none or not theirs. */
  getBookingNote(hostId: string, bookingId: string): Promise<string>;
  /** Session notes on several of the host's bookings, by booking id; bookings without one (or not theirs) are absent. */
  listBookingNotes(hostId: string, bookingIds: string[]): Promise<Record<string, string>>;
  /** Saves it, sealed like client notes, with a history line; an empty note removes it. Throws NotFoundError unless the booking is `hostId`'s. */
  saveBookingNote(hostId: string, bookingId: string, note: string, actorId?: string): Promise<void>;
  /** Edit history of the host's notes on a client (by email) or on some bookings, newest first (src/lib/privacy/note-history.ts). */
  listNoteRevisions(hostId: string, subject: { email: string } | { bookingIds: string[] }): Promise<NoteRevision[]>;
  /** Whether the host keeps the text of earlier note versions (off: only who/when). */
  getKeepNoteVersions(hostId: string): Promise<boolean>;
  /** Turns it on or off; off deletes the version texts already kept. */
  setKeepNoteVersions(hostId: string, on: boolean): Promise<void>;
  /**
   * A hidden one_off event type at the given times, with a single-use link to it that expires at the last time; all in one
   * write. Throws InvalidOneOffError unless there are 1–20 distinct future times and the duration is 5–720 minutes.
   */
  createOneOffMeeting(hostId: string, input: OneOffInput, now: Date): Promise<{ eventType: EventType; link: BookingLink; token: string }>;
  /** The offered start times of a one_off event type, earliest first. */
  listOneOffTimes(eventTypeId: string): Promise<Date[]>;
  /** Times the host's open meeting polls hold, overlapping [from, to): blocked from other bookings like busy time. */
  listPollHolds(userId: string, from: Date, to: Date, now: Date): Promise<{ start: Date; end: Date }[]>;
}

/** The editable fields of an event type, already validated. */
export type EventTypeDraft = Pick<EventType,
  "name" | "slug" | "description" | "durationMinutes" | "minNoticeMinutes" | "bookingWindowDays" | "startIncrementMinutes" |
  "bufferBeforeMinutes" | "bufferAfterMinutes" | "dailyLimit" | "cancelCutoffMinutes" | "priceMinor" | "currency" | "hidden" | "maxRepeats" | "depositMinor" | "redirectUrl" | "weeklyLimit" | "cancelPolicy" | "seatLimit"> & {
  /** Left out = false. */
  requiresApproval?: boolean;
  /** Left out = only durationMinutes (no choice). */
  durationOptions?: DurationOption[];
  location: { kind: LocationKind; value: string | null } | null;
};

/** A question as edited; `id` is null for a new one. A condition names its earlier question by list position, since new ones have no id yet. */
export type QuestionDraft = Pick<CustomQuestion, "label" | "kind" | "required" | "choices"> & {
  id: string | null;
  showIf?: DraftCondition | null;
} & Partial<Pick<CustomQuestion, "firstBookingOnly" | "minValue" | "maxValue" | "templateId">>;

/** A condition in a draft: `questionIndex` is the earlier question's place in the same list. */
export interface DraftCondition { questionIndex: number; values: string[] }

export class SlugTakenError extends Error {
  readonly code = "slug_taken";
  constructor() {
    super("That link is already used by another event type");
    this.name = "SlugTakenError";
  }
}

/** "upcoming": confirmed bookings still ahead. "history": only past or cancelled bookings, which must be kept. */
export class EventTypeInUseError extends Error {
  readonly code = "event_type_in_use";
  readonly reason: "upcoming" | "history";
  readonly upcomingCount: number;
  // Plain fields, not parameter properties: Node's built-in TypeScript stripping (used by scripts/) can't run those.
  constructor(reason: "upcoming" | "history", upcomingCount: number) {
    super(reason === "upcoming"
      ? `This event type has ${upcomingCount} upcoming ${upcomingCount === 1 ? "booking" : "bookings"}. Cancel or move ${upcomingCount === 1 ? "it" : "them"} first, or turn the link off to stop new bookings.`
      : "Past bookings were made with this event type, so it stays in your history. Turn the link off to stop new bookings.");
    this.name = "EventTypeInUseError";
    this.reason = reason;
    this.upcomingCount = upcomingCount;
  }
}

/** The host already has as many schedules as their plan allows. */
export class ScheduleLimitError extends Error {
  readonly code = "schedule_limit";
  readonly limit: number;
  constructor(limit: number) {
    super(limit === 1
      ? "Your plan includes one schedule. Upgrade to Solo or Duo to keep several, or change the hours of the one you have."
      : `Your plan includes ${limit} schedules.`);
    this.name = "ScheduleLimitError";
    this.limit = limit;
  }
}

export class ScheduleNameTakenError extends Error {
  readonly code = "schedule_name_taken";
  constructor() {
    super("You already have a schedule with that name.");
    this.name = "ScheduleNameTakenError";
  }
}

/** The default schedule is what event types fall back to, so it can't be deleted; make another one the default first. */
export class DefaultScheduleError extends Error {
  readonly code = "default_schedule";
  constructor() {
    super("This is your default schedule. Make another schedule the default before deleting this one.");
    this.name = "DefaultScheduleError";
  }
}

/** Event types still book against this schedule. */
export class ScheduleInUseError extends Error {
  readonly code = "schedule_in_use";
  readonly eventTypes: { id: string; name: string }[];
  constructor(eventTypes: { id: string; name: string }[]) {
    super(`${eventTypes.length === 1 ? "1 event type uses" : `${eventTypes.length} event types use`} this schedule: ${eventTypes.map((e) => e.name).join(", ")}. Move ${eventTypes.length === 1 ? "it" : "them"} to another schedule first.`);
    this.name = "ScheduleInUseError";
    this.eventTypes = eventTypes;
  }
}
