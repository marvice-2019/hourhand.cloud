import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { LIMITS, type Plan } from "../billing/plans";
import { queueBookingNotifications } from "../data/notifications";
import { oneOffSlug } from "../data/one-off";
import { LOCATION_KINDS, NotFoundError, type LocationKind } from "../data/types";
import { LOCATION_VALUE_LABEL } from "../event-types";
import { isLocale, type Locale } from "../i18n/guest";
import { fillTemplate } from "../i18n/host/lib-messages";
import { kickJobs } from "../jobs/kick";
import { classKeyOf, isSyncStale } from "../slots";

// Meeting polls. A host proposes 2 to 8 times for one meeting and shares one link (/v/<token>). Invitees vote yes,
// if-needed or no on each time, with no account: one vote set per email, changed later through a signed link that is
// emailed to them. While a poll is open its times are held (see holds.ts) unless the host chose not to. The host
// confirms one time with one click: it is re-checked against the calendar and bookings, then booked for everyone who
// said yes or if-needed, as seats of one meeting (shared class key), so each gets the usual emails, reminders and manage
// link, and the host's calendar gets one event. A poll still open at its deadline closes and the host is emailed to pick.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{48}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN = 60_000;
const DAY = 86_400_000;

export const POLL_LIMITS = { minTimes: 2, maxTimes: 8, defaultDeadlineDays: 7, maxDeadlineDays: 60, maxAheadDays: 365 } as const;

export type PollAnswer = "yes" | "if_needed" | "no";
export const POLL_ANSWERS: readonly PollAnswer[] = ["yes", "if_needed", "no"];
export type PollStatus = "open" | "closed" | "confirmed" | "cancelled";

export interface PollInput {
  title: string;
  description?: string | null;
  durationMinutes: number;
  location: { kind: LocationKind; value?: string | null };
  times: Date[];
  /** Block the proposed times from other bookings while the poll is open. */
  holdTimes: boolean;
  /** When votes close; null = the default (7 days, or the first proposed time if that is sooner). */
  deadline: Date | null;
}

export interface Poll {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  durationMinutes: number;
  locationKind: LocationKind;
  locationValue: string | null;
  token: string;
  holdTimes: boolean;
  deadline: Date;
  status: PollStatus;
  closedAt: Date | null;
  confirmedStart: Date | null;
  eventTypeId: string | null;
  createdAt: Date;
}

export interface PollOption { id: string; startAt: Date; endAt: Date }
export interface PollVoter {
  id: string; name: string; email: string; phone: string | null; timezone: string; locale: string; bookingId: string | null;
  votes: Record<string, PollAnswer>; updatedAt: Date;
}
export interface OptionTally extends PollOption { yes: number; ifNeeded: number; no: number; best: boolean }

/**
 * Every message checkPoll gives the host, as code -> English template. The dashboard shows each in the host's language
 * (src/app/dashboard/polls/actions.ts); the location lines keep the wording they always had.
 */
export const POLL_MESSAGES = {
  title: "Give the meeting a name (up to 100 characters).",
  description: "Keep the description under 2000 characters.",
  duration: "Duration must be 5 to 720 minutes.",
  location: "Pick where you'll meet.",
  locationAddress: "Add the address so people know where to go.",
  locationPhone: "Add your phone number so people know where to go.",
  locationDetails: "Add the location details so people know where to go.",
  timesAhead: "Propose times within the next {n} days.",
  timesCount: "Propose {min} to {max} times.",
  timesFuture: "Every time must be in the future.",
  timesOnce: "Each time can be proposed once.",
  deadlineFuture: "The voting deadline must be in the future.",
  deadlineFirst: "Voting must close by the first proposed time.",
  deadlineMax: "Voting can stay open up to {n} days.",
} as const;

const LOCATION_VALUE_CODE: Partial<Record<LocationKind, keyof typeof POLL_MESSAGES>> = {
  in_person: "locationAddress", phone_guest_calls: "locationPhone", custom: "locationDetails",
};

/** A poll the host can't make: `field` names what is wrong. */
export class InvalidPollError extends Error {
  constructor(readonly field: "title" | "description" | "durationMinutes" | "location" | "times" | "deadline", message: string) {
    super(message);
    this.name = "InvalidPollError";
  }
}

/** The host's plan allows no more open polls. */
export class PollLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Your plan allows ${limit} open ${limit === 1 ? "poll" : "polls"} at a time.`);
    this.name = "PollLimitError";
  }
}

/** The poll isn't in a state that allows this (already confirmed or cancelled). */
export class PollStateError extends Error {
  constructor(readonly status: PollStatus) {
    super(`This poll is ${status}.`);
    this.name = "PollStateError";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pure rules

/** The rules for a new poll. Returns its times earliest first and its deadline. */
export function checkPoll(input: PollInput, now: Date): { times: Date[]; deadline: Date } {
  const title = input.title.trim();
  if (title.length < 1 || title.length > 100) throw new InvalidPollError("title", POLL_MESSAGES.title);
  if ((input.description ?? "").length > 2000) throw new InvalidPollError("description", POLL_MESSAGES.description);
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 720) {
    throw new InvalidPollError("durationMinutes", POLL_MESSAGES.duration);
  }
  if (!LOCATION_KINDS.includes(input.location.kind)) throw new InvalidPollError("location", POLL_MESSAGES.location);
  const valueLabel = LOCATION_VALUE_LABEL[input.location.kind];
  if (valueLabel && !input.location.value?.trim()) {
    const code = LOCATION_VALUE_CODE[input.location.kind];
    throw new InvalidPollError("location", code ? POLL_MESSAGES[code] : `Add the ${valueLabel.toLowerCase()} so people know where to go.`);
  }
  const { minTimes, maxTimes, defaultDeadlineDays, maxDeadlineDays, maxAheadDays } = POLL_LIMITS;
  const times = input.times;
  if (times.length < minTimes || times.length > maxTimes) throw new InvalidPollError("times", fillTemplate(POLL_MESSAGES.timesCount, { min: minTimes, max: maxTimes }));
  if (times.some((t) => Number.isNaN(t.getTime()) || t.getTime() <= now.getTime())) throw new InvalidPollError("times", POLL_MESSAGES.timesFuture);
  if (times.some((t) => t.getTime() > now.getTime() + maxAheadDays * DAY)) throw new InvalidPollError("times", fillTemplate(POLL_MESSAGES.timesAhead, { n: maxAheadDays }));
  if (new Set(times.map((t) => t.getTime())).size !== times.length) throw new InvalidPollError("times", POLL_MESSAGES.timesOnce);
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  const first = sorted[0];
  const deadline = input.deadline ?? new Date(Math.min(now.getTime() + defaultDeadlineDays * DAY, first.getTime()));
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime()) throw new InvalidPollError("deadline", POLL_MESSAGES.deadlineFuture);
  if (deadline.getTime() > first.getTime()) throw new InvalidPollError("deadline", POLL_MESSAGES.deadlineFirst);
  if (deadline.getTime() > now.getTime() + maxDeadlineDays * DAY) throw new InvalidPollError("deadline", fillTemplate(POLL_MESSAGES.deadlineMax, { n: maxDeadlineDays }));
  return { times: sorted, deadline };
}

/**
 * Yes, if-needed and no per time. The best times are those the most people can make (yes + if-needed), then the most
 * clear yeses; none is best while nobody can make any.
 */
export function tally(options: PollOption[], voters: Pick<PollVoter, "votes">[]): OptionTally[] {
  const rows = options.map((o) => {
    const answers = voters.map((v) => v.votes[o.id]);
    return { ...o, yes: answers.filter((a) => a === "yes").length, ifNeeded: answers.filter((a) => a === "if_needed").length, no: answers.filter((a) => a === "no").length, best: false };
  });
  const can = (r: OptionTally) => r.yes + r.ifNeeded;
  const top = Math.max(0, ...rows.map(can));
  const topYes = Math.max(0, ...rows.filter((r) => can(r) === top).map((r) => r.yes));
  return rows.map((r) => ({ ...r, best: top > 0 && can(r) === top && r.yes === topYes }));
}

/** What an invitee sends. Field errors name keys in the poll catalog (src/lib/i18n/poll.ts), so the page can show them in the invitee's language. */
export interface VoteRequest {
  name: string; email: string; phone: string | null; timezone: string; locale: Locale;
  votes: Record<string, PollAnswer>; editToken: string | null;
}

export function validateVote(body: unknown, optionIds: string[], isZone: (tz: unknown) => tz is string):
  { ok: true; value: VoteRequest } | { ok: false; fields: Record<string, string> } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const fields: Record<string, string> = {};
  const name = str("name"), email = str("email"), phone = str("phone"), editToken = str("editToken");
  if (name.length < 1 || name.length > 100) fields.name = "errName";
  if (!EMAIL.test(email) || email.length > 254) fields.email = "errEmail";
  if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) fields.phone = "errPhone";
  if (!isZone(b.timezone)) fields.timezone = "errTimezone";
  if (editToken.length > 200) fields.editToken = "errEditLink";
  const raw = (typeof b.votes === "object" && b.votes !== null && !Array.isArray(b.votes) ? b.votes : {}) as Record<string, unknown>;
  const votes: Record<string, PollAnswer> = {};
  for (const id of optionIds) {
    const a = raw[id];
    if (typeof a === "string" && (POLL_ANSWERS as readonly string[]).includes(a)) votes[id] = a as PollAnswer;
    else fields[`votes.${id}`] = "errAnswer";
  }
  if (Object.keys(raw).some((id) => !optionIds.includes(id))) fields.votes = "errStale";
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { name, email, phone: phone || null, timezone: b.timezone as string, locale: isLocale(b.locale) ? b.locale : "en", votes, editToken: editToken || null } };
}

// ---------------------------------------------------------------------------------------------------------------
// Signed edit links: `<voter id>.<expiry, unix seconds>.<HMAC-SHA256>`. Nothing is stored; the key never leaves the server.

/** The key for edit links, derived from POLL_LINK_SECRET or else BETTER_AUTH_SECRET (both server-only). */
export function pollLinkKey(env: Record<string, string | undefined> = process.env): Buffer {
  const secret = env.POLL_LINK_SECRET || env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET (or POLL_LINK_SECRET) must be set to sign poll edit links");
  return createHmac("sha256", secret).update("hourhand poll edit links v1").digest();
}

const mac = (key: Buffer, voterId: string, exp: number) => createHmac("sha256", key).update(`poll-edit:${voterId}:${exp}`).digest("base64url");

export function signEditToken(key: Buffer, voterId: string, expiresAt: Date): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${voterId}.${exp}.${mac(key, voterId, exp)}`;
}

/** The voter an edit link is for, or null when it is malformed, forged, signed with another key, or past its expiry. */
export function verifyEditToken(key: Buffer, token: string, now: Date): string | null {
  const m = /^([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m || !UUID.test(m[1])) return null;
  const exp = Number(m[2]);
  const expected = Buffer.from(mac(key, m[1], exp));
  const given = Buffer.from(m[3]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return exp * 1000 > now.getTime() ? m[1] : null;
}

/** The page in the language they answered in, opened on their own answers. */
export const editUrl = (baseUrl: string, pollToken: string, editToken: string, locale: Locale) =>
  `${baseUrl}/v/${pollToken}?edit=${encodeURIComponent(editToken)}&lang=${locale}`;

// ---------------------------------------------------------------------------------------------------------------
// Reads

const POLL = `p.id, p.user_id, p.title, p.description, p.duration_minutes, p.location_kind, p.location_value, p.token, p.hold_times, p.deadline,
  p.status, p.closed_at, p.confirmed_start, p.event_type_id, p.created_at`;
const toPoll = (r: Record<string, unknown>): Poll => ({
  id: r.id as string, userId: r.user_id as string, title: r.title as string, description: (r.description as string | null) ?? null,
  durationMinutes: r.duration_minutes as number, locationKind: r.location_kind as LocationKind, locationValue: (r.location_value as string | null) ?? null,
  token: r.token as string, holdTimes: r.hold_times as boolean, deadline: r.deadline as Date, status: r.status as PollStatus,
  closedAt: (r.closed_at as Date | null) ?? null, confirmedStart: (r.confirmed_start as Date | null) ?? null,
  eventTypeId: (r.event_type_id as string | null) ?? null, createdAt: r.created_at as Date,
});

/** Votes are taken while the poll is open and before its deadline (the job runner may not have closed it yet). */
export const acceptsVotes = (p: Pick<Poll, "status" | "deadline">, now: Date) => p.status === "open" && p.deadline.getTime() > now.getTime();

async function optionsOf(db: Db, pollId: string): Promise<PollOption[]> {
  const { rows } = await db.query("select id, start_at, end_at from poll_options where poll_id = $1 order by start_at", [pollId]);
  return rows.map((r) => ({ id: r.id as string, startAt: r.start_at as Date, endAt: r.end_at as Date }));
}

async function votersOf(db: Db, pollId: string): Promise<PollVoter[]> {
  const { rows } = await db.query(
    `select v.id, v.name, v.email::text as email, v.phone, v.timezone, v.locale, v.booking_id, v.updated_at,
       coalesce(jsonb_object_agg(x.option_id, x.answer) filter (where x.option_id is not null), '{}') as votes
     from poll_voters v left join poll_votes x on x.voter_id = v.id where v.poll_id = $1 group by v.id order by v.created_at`, [pollId]);
  return rows.map((r) => ({
    id: r.id as string, name: r.name as string, email: r.email as string, phone: (r.phone as string | null) ?? null, timezone: r.timezone as string,
    locale: r.locale as string, bookingId: (r.booking_id as string | null) ?? null, votes: r.votes as Record<string, PollAnswer>, updatedAt: r.updated_at as Date,
  }));
}

export interface PollSummary extends Poll { times: number; voters: number }

/** The host's polls, newest first. */
export async function listPolls(db: Db, hostId: string): Promise<PollSummary[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(
    `select ${POLL}, (select count(*)::int from poll_options o where o.poll_id = p.id) as times,
       (select count(*)::int from poll_voters v where v.poll_id = p.id) as voters
     from polls p where p.user_id = $1 order by p.created_at desc`, [hostId]);
  return rows.map((r) => ({ ...toPoll(r), times: r.times as number, voters: r.voters as number }));
}

/** One of the host's polls with its times (tallied) and every voter's answers; null when it isn't theirs. */
export async function pollForHost(db: Db, hostId: string, pollId: string): Promise<{ poll: Poll; options: OptionTally[]; voters: PollVoter[] } | null> {
  if (!UUID.test(hostId) || !UUID.test(pollId)) return null;
  const { rows: [r] } = await db.query(`select ${POLL} from polls p where p.id = $1 and p.user_id = $2`, [pollId, hostId]);
  if (!r) return null;
  const [options, voters] = await Promise.all([optionsOf(db, pollId), votersOf(db, pollId)]);
  return { poll: toPoll(r), options: tally(options, voters), voters };
}

export interface PublicPoll {
  poll: Pick<Poll, "id" | "title" | "description" | "durationMinutes" | "locationKind" | "locationValue" | "deadline" | "status" | "confirmedStart">;
  host: { name: string; timezone: string; locale: string; timeFormat: "12h" | "24h" };
  /** Counts only: invitees see how each time is doing, never who answered or their emails. */
  options: OptionTally[];
  voterCount: number;
  open: boolean;
}

/** What /v/<token> shows. Null for an unknown link or a closed account. */
export async function pollByToken(db: Db, token: string, now: Date): Promise<PublicPoll | null> {
  if (!TOKEN.test(token)) return null;
  const { rows: [r] } = await db.query(
    `select ${POLL}, coalesce(u.name, '') as host_name, u.timezone as host_timezone, u.locale as host_locale, u.time_format as host_time_format
     from polls p join users u on u.id = p.user_id where p.token = $1 and u.deleted_at is null`, [token]);
  if (!r) return null;
  const poll = toPoll(r);
  const [options, voters] = await Promise.all([optionsOf(db, poll.id), votersOf(db, poll.id)]);
  const { id, title, description, durationMinutes, locationKind, locationValue, deadline, status, confirmedStart } = poll;
  return {
    poll: { id, title, description, durationMinutes, locationKind, locationValue, deadline, status, confirmedStart },
    host: { name: r.host_name as string, timezone: r.host_timezone as string, locale: r.host_locale as string, timeFormat: r.host_time_format as "12h" | "24h" },
    options: tally(options, voters), voterCount: voters.length, open: acceptsVotes(poll, now),
  };
}

/** The voter an edit link opens, with their answers, when the link is valid for this poll. */
export async function voterForEdit(db: Db, pollToken: string, editToken: string, key: Buffer, now: Date): Promise<Pick<PollVoter, "id" | "name" | "email" | "phone" | "votes"> | null> {
  const voterId = verifyEditToken(key, editToken, now);
  if (!voterId || !TOKEN.test(pollToken)) return null;
  const { rows: [r] } = await db.query("select p.id from poll_voters v join polls p on p.id = v.poll_id where v.id = $1 and p.token = $2", [voterId, pollToken]);
  if (!r) return null;
  const voter = (await votersOf(db, r.id as string)).find((v) => v.id === voterId);
  return voter ? { id: voter.id, name: voter.name, email: voter.email, phone: voter.phone, votes: voter.votes } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Writes

async function tx<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Creates a poll and its proposed times; returns the poll with its link token. On Free, one open poll at a time: the
 * host's row is locked first, so two creates at once can't both pass the count.
 */
export async function createPoll(pool: pg.Pool, hostId: string, input: PollInput, plan: Plan, now: Date): Promise<Poll> {
  if (!UUID.test(hostId)) throw new NotFoundError("User");
  const { times, deadline } = checkPoll(input, now);
  const token = randomBytes(24).toString("hex");
  return tx(pool, async (client) => {
    const { rowCount } = await client.query("select 1 from users where id = $1 and deleted_at is null for update", [hostId]);
    if (!rowCount) throw new NotFoundError("User");
    const limit = LIMITS[plan].openPolls;
    if (Number.isFinite(limit)) {
      const { rows: [{ open }] } = await client.query("select count(*)::int as open from polls where user_id = $1 and status = 'open' and deadline > $2", [hostId, now]);
      if (open >= limit) throw new PollLimitError(limit);
    }
    const { rows: [r] } = await client.query(
      `insert into polls as p (user_id, title, description, duration_minutes, location_kind, location_value, token, hold_times, deadline)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${POLL}`,
      [hostId, input.title.trim(), input.description?.trim() || null, input.durationMinutes, input.location.kind,
        LOCATION_VALUE_LABEL[input.location.kind] ? input.location.value!.trim() : null, token, input.holdTimes, deadline]);
    await client.query(
      "insert into poll_options (poll_id, start_at, end_at) select $1, t, t + make_interval(mins => $3) from unnest($2::timestamptz[]) t",
      [r.id, times, input.durationMinutes]);
    return toPoll(r);
  });
}

export type VoteResult =
  | { status: "saved"; voterId: string; created: boolean }
  /** That email already answered and no valid edit link came with this: nothing changed; their edit link is emailed again. */
  | { status: "exists" }
  | { status: "closed" | "not_found" | "bad_edit_link" };

/** One edit-link reminder per voter per hour, however often someone types their address. */
const resendBucket = (now: Date) => Math.floor(now.getTime() / 3_600_000);

/**
 * Records an invitee's answers. A new email adds a voter and emails them their edit link. With a valid edit link, that
 * voter's answers (and name, phone) are replaced: one vote set per email, editable until the poll closes. Without one,
 * an email that already answered changes nothing, so nobody can overwrite someone else's answers by typing their address.
 */
export async function submitVotes(pool: pg.Pool, pollToken: string, v: VoteRequest, key: Buffer, now: Date): Promise<VoteResult> {
  if (!TOKEN.test(pollToken)) return { status: "not_found" };
  const editVoterId = v.editToken ? verifyEditToken(key, v.editToken, now) : null;
  if (v.editToken && !editVoterId) return { status: "bad_edit_link" };
  const result = await tx(pool, async (client): Promise<VoteResult> => {
    // Locked so a confirm (which locks it too) sees every vote that got in before it, and none after.
    const { rows: [p] } = await client.query(
      "select p.id, p.user_id, p.status, p.deadline from polls p join users u on u.id = p.user_id where p.token = $1 and u.deleted_at is null for share of p", [pollToken]);
    if (!p) return { status: "not_found" };
    if (!acceptsVotes({ status: p.status, deadline: p.deadline }, now)) return { status: "closed" };
    const optionIds = (await client.query("select id from poll_options where poll_id = $1", [p.id])).rows.map((r) => r.id as string);
    if (Object.keys(v.votes).length !== optionIds.length || optionIds.some((id) => !v.votes[id])) return { status: "not_found" };

    let voterId: string;
    let created = false;
    if (editVoterId) {
      const { rows: [own] } = await client.query(
        "update poll_voters set name = $3, phone = $4, timezone = $5, locale = $6, updated_at = $7 where id = $1 and poll_id = $2 returning id",
        [editVoterId, p.id, v.name, v.phone, v.timezone, v.locale, now]);
      if (!own) return { status: "bad_edit_link" };
      voterId = own.id;
    } else {
      const { rows: [fresh] } = await client.query(
        `insert into poll_voters (poll_id, name, email, phone, timezone, locale, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$7)
         on conflict (poll_id, email) do nothing returning id`, [p.id, v.name, v.email, v.phone, v.timezone, v.locale, now]);
      if (!fresh) {
        // Sent to the address as they first gave it, whatever case it was typed in now.
        const { rows: [existing] } = await client.query("select id, email::text as email from poll_voters where poll_id = $1 and email = $2", [p.id, v.email]);
        await queueVoterLink(client, p.user_id, existing.id, existing.email, now, `resend:${resendBucket(now)}`);
        return { status: "exists" };
      }
      voterId = fresh.id;
      created = true;
      await queueVoterLink(client, p.user_id, voterId, v.email, now, "first");
    }
    await client.query("delete from poll_votes where voter_id = $1", [voterId]);
    await client.query(
      "insert into poll_votes (voter_id, option_id, answer) select $1, o, a from unnest($2::uuid[], $3::text[]) as x(o, a)",
      [voterId, optionIds, optionIds.map((id) => v.votes[id])]);
    return { status: "saved", voterId, created };
  });
  if (result.status === "saved" || result.status === "exists") kickJobs();
  return result;
}

async function queueVoterLink(db: Db, hostId: string, voterId: string, email: string, now: Date, suffix: string): Promise<void> {
  await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key) values (null, $1, 'email', 'poll_voter_link', $2, $3, $4)
     on conflict (dedupe_key) do nothing`, [hostId, email, now, `poll-voter:${voterId}:${suffix}`]);
}

/** Stops a poll that isn't decided yet: no more votes, its times are released. Nothing is booked. */
export async function cancelPoll(db: Db, hostId: string, pollId: string, now: Date): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(pollId)) throw new NotFoundError("Poll");
  const { rowCount } = await db.query(
    "update polls set status = 'cancelled', closed_at = coalesce(closed_at, $3) where id = $1 and user_id = $2 and status in ('open', 'closed')", [pollId, hostId, now]);
  if (!rowCount) throw new NotFoundError("Poll");
}

/**
 * Closes every open poll whose deadline has passed (its times stop being held) and emails each host to pick a time.
 * Safe to run on several servers at once: a poll is closed by one update, and the email has a dedupe key.
 */
export async function closeDuePolls(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query(
    `with closed as (update polls set status = 'closed', closed_at = $1 where status = 'open' and deadline <= $1 returning id, user_id),
     mailed as (
       insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
       select null, c.user_id, 'email', 'poll_host_closed', u.email, $1, 'poll:' || c.id || ':closed'
       from closed c join users u on u.id = c.user_id where u.deleted_at is null
       on conflict (dedupe_key) do nothing)
     select id from closed`, [now]);
  if (rows.length > 0) kickJobs();
  return rows.length;
}

/** Something on the host's side in the way of a time, shown to the host instead of booking over it. */
export type Clash =
  | { kind: "calendar"; start: Date; end: Date }
  | { kind: "booking"; start: Date; end: Date; guestName: string }
  | { kind: "calendar_stale" }
  | { kind: "past" };

export type ConfirmResult =
  | { status: "confirmed"; bookingIds: string[] }
  | { status: "clash"; clashes: Clash[] }
  | { status: "nobody" };

/**
 * Books the chosen time for everyone who said yes or if-needed, in one transaction: a hidden one-off event type for the
 * meeting, one booking per person sharing a class key (so the overlap guard lets them share the time, and the host's
 * calendar gets one event between them), each with the usual confirmation, reminders and manage link. The time is
 * checked again first against the host's calendar and bookings; a clash is returned, nothing is booked. The poll's own
 * hold doesn't count as a clash, and its other times are released by the status change.
 */
export async function confirmPoll(pool: pg.Pool, hostId: string, pollId: string, optionId: string, now: Date): Promise<ConfirmResult> {
  if (!UUID.test(hostId) || !UUID.test(pollId) || !UUID.test(optionId)) throw new NotFoundError("Poll");
  try {
    const result = await tx(pool, async (client): Promise<ConfirmResult> => {
      const { rows: [r] } = await client.query(`select ${POLL} from polls p where p.id = $1 and p.user_id = $2 for update of p`, [pollId, hostId]);
      if (!r) throw new NotFoundError("Poll");
      const poll = toPoll(r);
      if (poll.status === "confirmed" || poll.status === "cancelled") throw new PollStateError(poll.status);
      const { rows: [o] } = await client.query("select start_at, end_at from poll_options where id = $1 and poll_id = $2", [optionId, pollId]);
      if (!o) throw new NotFoundError("Poll time");
      const start = o.start_at as Date, end = o.end_at as Date;
      if (start.getTime() <= now.getTime()) return { status: "clash", clashes: [{ kind: "past" }] };

      const { rows: people } = await client.query(
        `select v.id, v.name, v.email, v.phone, v.timezone, v.locale from poll_voters v join poll_votes x on x.voter_id = v.id
         where v.poll_id = $1 and x.option_id = $2 and x.answer in ('yes', 'if_needed') order by v.created_at`, [pollId, optionId]);
      if (people.length === 0) return { status: "nobody" };

      const clashes = await clashesAt(client, hostId, start, end, now);
      if (clashes.length > 0) return { status: "clash", clashes };

      const { rows: [et] } = await client.query(
        `insert into event_types (user_id, schedule_id, name, slug, description, duration_minutes, min_notice_minutes, booking_window_days, buffer_before_minutes, buffer_after_minutes, kind, hidden)
         values ($1, (select id from availability_schedules where user_id = $1 and is_default), $2, $3, $4, $5, 0, 730, 0, 0, 'one_off', true) returning id`,
        [hostId, poll.title, oneOffSlug(), poll.description, poll.durationMinutes]);
      await client.query("insert into event_locations (event_type_id, kind, value, position) values ($1,$2,$3,0)", [et.id, poll.locationKind, poll.locationValue]);
      await client.query("insert into one_off_times (event_type_id, start_at) values ($1, $2)", [et.id, start]);

      const classKey = classKeyOf(et.id, start);
      const bookingIds: string[] = [];
      for (const p of people) {
        const { rows: [b] } = await client.query(
          `insert into bookings (event_type_id, host_id, start_at, end_at, buffered_start, buffered_end, status, location_kind, idempotency_key, class_key)
           values ($1, $2, $3, $4, $3, $4, 'confirmed', $5, $6, $7) returning id`,
          [et.id, hostId, start, end, poll.locationKind, `poll:${pollId}:${p.id}`, classKey]);
        await client.query(
          `insert into invitees (booking_id, host_id, name, email, timezone, phone, answers, guests, locale) values ($1,$2,$3,$4,$5,$6,'[]','{}',$7)`,
          [b.id, hostId, p.name, p.email, p.timezone, p.phone, isLocale(p.locale) ? p.locale : "en"]);
        await client.query("update poll_voters set booking_id = $2 where id = $1", [p.id, b.id]);
        // The host clicked confirm and sees the list: no booked_host email per person.
        await queueBookingNotifications(client, b.id, "booked", now, { notifyHost: false });
        bookingIds.push(b.id);
      }
      await client.query(
        "update polls set status = 'confirmed', confirmed_start = $2, event_type_id = $3, closed_at = coalesce(closed_at, $4) where id = $1",
        [pollId, start, et.id, now]);
      return { status: "confirmed", bookingIds };
    });
    if (result.status === "confirmed") kickJobs();
    return result;
  } catch (error) {
    // A booking that landed between the check and the insert: the overlap guard (23P01) refuses ours. Show it as a clash.
    if ((error as { code?: string }).code === "23P01") {
      const o = await pool.query("select start_at, end_at from poll_options where id = $1", [optionId]);
      const clashes = o.rows[0] ? await clashesAt(pool, hostId, o.rows[0].start_at, o.rows[0].end_at, now) : [];
      return { status: "clash", clashes: clashes.length > 0 ? clashes : [{ kind: "booking", start: now, end: now, guestName: "" }] };
    }
    throw error;
  }
}

/** What is in the way of [start, end) on the host's side: a calendar that can't be trusted, busy calendar time, or a live booking. */
export async function clashesAt(db: Db, hostId: string, start: Date, end: Date, now: Date): Promise<Clash[]> {
  const { rows: connections } = await db.query("select status, last_synced_at from calendar_connections where user_id = $1", [hostId]);
  if (isSyncStale(connections.map((c) => ({ status: c.status, lastSyncedAt: c.last_synced_at })), now)) return [{ kind: "calendar_stale" }];
  const { rows: busy } = await db.query(
    "select lower(busy) as start, upper(busy) as end from busy_blocks where user_id = $1 and busy && tstzrange($2, $3, '[)') order by lower(busy)", [hostId, start, end]);
  const { rows: booked } = await db.query(
    `select b.start_at, b.end_at, i.name from bookings b join invitees i on i.booking_id = b.id
     where b.host_id = $1 and b.busy && tstzrange($2, $3, '[)')
       and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > $4)) order by b.start_at`, [hostId, start, end, now]);
  return [
    ...busy.map((b): Clash => ({ kind: "calendar", start: b.start, end: b.end })),
    ...booked.map((b): Clash => ({ kind: "booking", start: b.start_at, end: b.end_at, guestName: b.name })),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Emails (rendered by the job worker)

export interface PollVoterMailData { kind: "poll_voter_link"; locale: Locale; voterName: string; hostName: string; title: string; deadline: Date; timezone: string; url: string }
export interface PollHostMailData { kind: "poll_host_closed"; title: string; hostTimezone: string; hostTimeFormat: "12h" | "24h"; hostLocale?: string; voters: number; options: OptionTally[]; url: string }

/** What a poll email needs, from its queue row; a skip reason once it no longer applies. */
export async function pollMailData(db: Db, kind: string, dedupeKey: string, baseUrl: string, now: Date, key: () => Buffer = pollLinkKey):
  Promise<PollVoterMailData | PollHostMailData | { skip: string }> {
  if (kind === "poll_voter_link") {
    const m = /^poll-voter:([0-9a-f-]{36}):/.exec(dedupeKey);
    const { rows: [r] } = m ? await db.query(
      `select v.id, v.name, v.timezone, v.locale, p.token, p.title, p.status, p.deadline, coalesce(u.name, '') as host_name, u.deleted_at
       from poll_voters v join polls p on p.id = v.poll_id join users u on u.id = p.user_id where v.id = $1`, [m[1]]) : { rows: [] };
    if (!r || r.deleted_at) return { skip: "poll gone" };
    if (!acceptsVotes({ status: r.status, deadline: r.deadline }, now)) return { skip: "poll closed" };
    return {
      kind, locale: isLocale(r.locale) ? r.locale : "en", voterName: r.name, hostName: r.host_name, title: r.title, deadline: r.deadline, timezone: r.timezone,
      url: editUrl(baseUrl, r.token, signEditToken(key(), r.id, r.deadline), isLocale(r.locale) ? r.locale : "en"),
    };
  }
  if (kind === "poll_host_closed") {
    const m = /^poll:([0-9a-f-]{36}):closed$/.exec(dedupeKey);
    const { rows: [r] } = m ? await db.query(
      `select p.id, p.user_id, p.title, p.status, u.timezone, u.time_format, u.host_locale from polls p join users u on u.id = p.user_id where p.id = $1 and u.deleted_at is null`, [m[1]]) : { rows: [] };
    if (!r) return { skip: "poll gone" };
    if (r.status !== "closed") return { skip: `poll already ${r.status}` };
    const [options, voters] = await Promise.all([optionsOf(db, r.id), votersOf(db, r.id)]);
    return { kind, title: r.title, hostTimezone: r.timezone, hostTimeFormat: r.time_format, hostLocale: r.host_locale ?? "en", voters: voters.length,
      options: tally(options, voters).filter((o) => o.startAt.getTime() > now.getTime()), url: `${baseUrl}/dashboard/polls/${r.id}` };
  }
  return { skip: "not a poll email" };
}

/** Minutes, for display. */
export const durationOf = (o: PollOption) => Math.round((o.endAt.getTime() - o.startAt.getTime()) / MIN);
