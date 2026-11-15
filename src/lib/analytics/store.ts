import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { classify, inAppChannel, isBot, optedOut, CHANNEL_LABELS, type Channel, type SourceInput } from "./source";

// Booking analytics in Postgres: recording (never in a guest's way), the daily rollup, and the host's report.
// See db/migrations/0030_analytics.sql for what is stored and for how long.

type Db = Pick<pg.Pool, "query">;
const DAY = 86_400_000;

export type EventKind = "view" | "slot_click" | "booking_started" | "booking_created";

/** Raw rows are kept this many days; after that only the per-day totals, for two years. */
export const RAW_DAYS = 90;
export const DAILY_DAYS = 730;
/** Days stay raw at least this long, so a booking still waiting on payment has settled before its day is frozen. */
const SETTLE_DAYS = 2;

/** "YYYY-MM-DD" of an instant, in UTC (analytics days are UTC days). */
export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));

// --- the daily salt ---------------------------------------------------------------------------------------------

const saltCache = globalThis as typeof globalThis & { __hourhandAnalyticsSalt?: { day: string; salt: Buffer } };

/**
 * Today's salt: made on first use each day and shared by every server process through analytics_salts. Making it also
 * deletes every older salt, so a past day's visitor hashes can no longer be recomputed from anything.
 */
export async function saltFor(db: Db, day: string): Promise<Buffer> {
  const cached = saltCache.__hourhandAnalyticsSalt;
  if (cached?.day === day) return cached.salt;
  await db.query("insert into analytics_salts (day, salt) values ($1, $2) on conflict (day) do nothing", [day, randomBytes(32)]);
  await db.query("delete from analytics_salts where day < $1", [day]);
  const { rows } = await db.query<{ salt: Buffer }>("select salt from analytics_salts where day = $1", [day]);
  const salt = rows[0].salt;
  saltCache.__hourhandAnalyticsSalt = { day, salt };
  return salt;
}

/** Forget the cached salt (tests, or after the salt table was cleared). */
export function resetSaltCache(): void {
  delete saltCache.__hourhandAnalyticsSalt;
}

/** One visitor for one host for one day. Neither the address nor the browser string is kept, only this hash. */
export function visitorHash(salt: Buffer, clientKey: string, userAgent: string, hostId: string): string {
  return createHash("sha256").update(salt).update("\0").update(clientKey).update("\0").update(userAgent).update("\0").update(hostId).digest("hex").slice(0, 32);
}

// --- recording ----------------------------------------------------------------------------------------------------

export interface AnalyticsEvent {
  hostId: string;
  eventTypeId: string | null;
  kind: EventKind;
  /** Required for every kind but booking_created. */
  visitorHash: string | null;
  bookingId: string | null;
  source: SourceInput;
  channel: Channel;
  day: string;
}

/** Inserts one event; a repeat (same visitor, page, step and day, or the same booking) is dropped by the unique indexes. */
export async function insertEvent(db: Db, e: AnalyticsEvent): Promise<void> {
  await db.query(
    `insert into analytics_events (user_id, event_type_id, kind, day, visitor_hash, booking_id, channel, utm_source, utm_medium, utm_campaign, ref_domain, embed)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict do nothing`,
    [e.hostId, e.eventTypeId, e.kind, e.day, e.visitorHash, e.bookingId, e.channel, e.source.utmSource, e.source.utmMedium, e.source.utmCampaign, e.source.refDomain, e.source.embed]);
}

export interface RequestContext {
  headers: Pick<Headers, "get">;
  /** The client's address key (clientIp), hashed and then forgotten. */
  clientKey: string;
}

export interface TrackInput { hostId: string; eventTypeId: string | null; kind: EventKind; source: SourceInput; bookingId?: string | null }

/** Whether a request may be counted at all: not a bot, and the visitor hasn't asked not to be tracked. */
export function countable(headers: Pick<Headers, "get">): boolean {
  return !optedOut(headers) && !isBot(headers.get("user-agent"));
}

/**
 * Records one event for a request. Never throws and never rejects: an analytics failure is logged and the guest's
 * page or booking goes on as if nothing happened. Callers don't await it on the guest's path (use after()).
 */
export async function track(db: Db, ctx: RequestContext, input: TrackInput, now: Date = new Date()): Promise<void> {
  try {
    if (!countable(ctx.headers)) return;
    const day = dayOf(now);
    const ua = ctx.headers.get("user-agent") ?? "";
    const hash = input.kind === "booking_created" ? null : visitorHash(await saltFor(db, day), ctx.clientKey, ua, input.hostId);
    const { channel, ...source } = classify(input.source, inAppChannel(ua));
    await insertEvent(db, { hostId: input.hostId, eventTypeId: input.eventTypeId, kind: input.kind, visitorHash: hash, bookingId: input.bookingId ?? null, source, channel, day });
  } catch (error) {
    console.error("[analytics] event not recorded", error);
  }
}

// --- the daily rollup ---------------------------------------------------------------------------------------------

/** A booking counts as completed once it is confirmed, and stays counted if it is cancelled later; a lapsed payment hold never counts. */
const COMPLETED = `exists (select 1 from bookings b where b.id = e.booking_id and (b.status = 'confirmed' or (b.status = 'cancelled' and b.cancelled_by is distinct from 'system')))`;

const COUNTS = `
  count(*) filter (where e.kind = 'view')::int as views,
  count(*) filter (where e.kind = 'slot_click')::int as slot_clicks,
  count(*) filter (where e.kind = 'booking_started')::int as started,
  count(*) filter (where e.kind = 'booking_created' and ${COMPLETED})::int as completed`;

const DIMS = "e.user_id, e.event_type_id, e.channel, e.utm_source, e.utm_medium, e.utm_campaign, e.ref_domain, e.embed";

export interface RollupResult { rolledDays: string[]; prunedEvents: number; prunedDaily: number }

/**
 * Moves every finished day (older than SETTLE_DAYS) into analytics_daily, once, then deletes raw rows past RAW_DAYS
 * and daily totals past DAILY_DAYS. Each day is rolled in one transaction, so a crash leaves it raw (and still counted
 * from raw) rather than half-rolled. Safe to run on several servers at once: a day already rolled is skipped.
 */
export async function rollupAnalytics(pool: pg.Pool, now: Date): Promise<RollupResult> {
  const today = dayOf(now);
  const before = addDays(today, -SETTLE_DAYS + 1);
  const { rows } = await pool.query<{ day: string }>(
    `select distinct to_char(day, 'YYYY-MM-DD') as day from analytics_events e
     where day < $1 and not exists (select 1 from analytics_rollups r where r.day = e.day) order by 1`, [before]);
  const rolledDays: string[] = [];
  for (const { day } of rows) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // The lock row first: a second server rolling the same day waits here, then finds it done and inserts nothing.
      const claim = await client.query("insert into analytics_rollups (day) values ($1) on conflict (day) do nothing", [day]);
      if (claim.rowCount === 1) {
        await client.query(
          `insert into analytics_daily (user_id, day, event_type_id, channel, utm_source, utm_medium, utm_campaign, ref_domain, embed, views, slot_clicks, started, completed)
           select ${DIMS.replace("e.event_type_id", "$1::date, e.event_type_id")}, ${COUNTS}
           from analytics_events e where e.day = $1 group by ${DIMS}`, [day]);
        rolledDays.push(day);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  const rawCutoff = addDays(today, -RAW_DAYS);
  const prunedEvents = (await pool.query(
    "delete from analytics_events e where e.day < $1 and exists (select 1 from analytics_rollups r where r.day = e.day)", [rawCutoff])).rowCount ?? 0;
  const dailyCutoff = addDays(today, -DAILY_DAYS);
  const prunedDaily = (await pool.query("delete from analytics_daily where day < $1", [dailyCutoff])).rowCount ?? 0;
  await pool.query("delete from analytics_rollups where day < $1", [dailyCutoff]);
  await pool.query("delete from analytics_salts where day < $1", [today]);
  return { rolledDays, prunedEvents, prunedDaily };
}

// --- the host's report ---------------------------------------------------------------------------------------------

export interface Counts { views: number; slotClicks: number; started: number; completed: number }

export interface SourceRow extends Counts {
  channel: Channel;
  channelLabel: string;
  /** utm_source, else the referrer's domain, else "". */
  source: string;
  medium: string;
  campaign: string;
  embed: boolean;
}

export interface EventTypeRow extends Counts { eventTypeId: string; name: string }

export interface AnalyticsReport {
  days: number;
  from: string;
  to: string;
  eventTypeId: string | null;
  /** Booking pages only (an event type's page); profile views are counted apart. */
  funnel: Counts;
  profileViews: number;
  sources: SourceRow[];
  byEventType: EventTypeRow[];
}

interface Row { event_type_id: string | null; channel: Channel; utm_source: string; utm_medium: string; utm_campaign: string; ref_domain: string; embed: boolean; views: number; slot_clicks: number; started: number; completed: number }

const zero = (): Counts => ({ views: 0, slotClicks: 0, started: 0, completed: 0 });
const add = (c: Counts, r: Row) => { c.views += r.views; c.slotClicks += r.slot_clicks; c.started += r.started; c.completed += r.completed; };

/** completed ÷ views as a percentage with one decimal, or null when nothing was viewed. */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The host's last `days` days (today included), optionally for one event type. Finished days come from
 * analytics_daily, the rest straight from the raw rows, so the numbers are the same before and after a rollup.
 */
export async function analyticsReport(db: Db, hostId: string, opts: { days: number; eventTypeId?: string | null }, now: Date): Promise<AnalyticsReport> {
  const to = dayOf(now);
  const from = addDays(to, -(opts.days - 1));
  const eventTypeId = opts.eventTypeId && UUID.test(opts.eventTypeId) ? opts.eventTypeId : null;
  const { rows } = await db.query<Row>(
    `select event_type_id, channel, utm_source, utm_medium, utm_campaign, ref_domain, embed, views, slot_clicks, started, completed
       from analytics_daily e where e.user_id = $1 and e.day between $2 and $3 and ($4::uuid is null or e.event_type_id = $4)
     union all
     select ${DIMS.replace("e.user_id, ", "")}, ${COUNTS}
       from analytics_events e where e.user_id = $1 and e.day between $2 and $3 and ($4::uuid is null or e.event_type_id = $4)
        and not exists (select 1 from analytics_rollups r where r.day = e.day)
       group by ${DIMS}`, [hostId, from, to, eventTypeId]);
  const names = new Map((await db.query<{ id: string; name: string }>("select id, name from event_types where user_id = $1", [hostId])).rows.map((r) => [r.id, r.name]));

  const funnel = zero();
  let profileViews = 0;
  const sources = new Map<string, SourceRow>();
  const types = new Map<string, EventTypeRow>();
  for (const r of rows) {
    if (r.event_type_id === null) { profileViews += r.views; continue; }
    add(funnel, r);
    const source = r.utm_source || r.ref_domain;
    const key = JSON.stringify([r.channel, source, r.utm_medium, r.utm_campaign, r.embed]);
    const s = sources.get(key) ?? { channel: r.channel, channelLabel: CHANNEL_LABELS[r.channel] ?? r.channel, source, medium: r.utm_medium, campaign: r.utm_campaign, embed: r.embed, ...zero() };
    add(s, r);
    sources.set(key, s);
    const t = types.get(r.event_type_id) ?? { eventTypeId: r.event_type_id, name: names.get(r.event_type_id) ?? "Deleted event type", ...zero() };
    add(t, r);
    types.set(r.event_type_id, t);
  }
  const byBookings = (a: Counts, b: Counts) => b.completed - a.completed || b.views - a.views;
  return {
    days: opts.days, from, to, eventTypeId, funnel, profileViews,
    sources: [...sources.values()].sort((a, b) => byBookings(a, b) || a.channelLabel.localeCompare(b.channelLabel) || a.source.localeCompare(b.source)),
    byEventType: [...types.values()].sort((a, b) => byBookings(a, b) || a.name.localeCompare(b.name)),
  };
}

// --- CSV ----------------------------------------------------------------------------------------------------------

/**
 * One CSV cell. UTM values and referrers come from links anyone can make, so a cell that a spreadsheet would read as
 * a formula (=, +, -, @, tab, carriage return) is prefixed with ' and quoted; quotes, commas and newlines are quoted.
 */
export function csvCell(v: string | number | boolean | null): string {
  if (v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(guarded) || guarded !== v ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** The report's sources as CSV: one line per channel, source, medium, campaign and embed, with the funnel and its rates. */
export function analyticsCsv(r: AnalyticsReport): string {
  const head = ["Channel", "Source", "Medium", "Campaign", "Embedded", "Views", "Slot clicks", "Started", "Completed", "View to booking %", "Started to booking %"];
  const lines = r.sources.map((s) => [s.channelLabel, s.source, s.medium, s.campaign, s.embed ? "yes" : "no", s.views, s.slotClicks, s.started, s.completed, rate(s.completed, s.views), rate(s.completed, s.started)]);
  const total = ["Total", "", "", "", "", r.funnel.views, r.funnel.slotClicks, r.funnel.started, r.funnel.completed, rate(r.funnel.completed, r.funnel.views), rate(r.funnel.completed, r.funnel.started)];
  return [head, ...lines, total].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
