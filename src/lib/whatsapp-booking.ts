import type pg from "pg";
import { hostPlan } from "./billing/account";
import { formatMoney, LIMITS } from "./billing/plans";
import { freeSlotSeats, isIanaTimeZone } from "./booking";
import { createPgStore } from "./data/pg-store";
import type { DataStore, EventType, User } from "./data/types";
import { formatDate, formatTime, zoneName } from "./format";
import { createRateLimiter, rateLimiter, type Limit } from "./rate-limit";
import { isStop, sendWhatsApp, textMessage, type WhatsAppConfig } from "./whatsapp-cloud";

// 3.4: book over WhatsApp. A client messages Hourhand's one number ("Book with priya", often pre-filled by the host's
// wa.me link), and gets back, as free-form replies inside the 24-hour service window: the host's event types as a list,
// then the next free times for the chosen one, then a link to the booking page with that time. The booking itself
// still happens on the page, so payment, questions, consent and the final slot check all work exactly as before.
// Only hosts who turned it on (and whose plan includes it) are ever offered; hosts are found by slug only.
// We keep where each phone's conversation is (host, event type, zone) and daily counts, never what anyone wrote.

const DAY = 86_400_000;
/** Meta allows free-form replies for 24 hours after the client's last message; a little margin for slow webhooks. */
export const SERVICE_WINDOW_MS = 24 * 3_600_000 - 5 * 60_000;
/** How far ahead to look for times (and never past the event type's own booking window). */
const LOOKAHEAD_DAYS = 30;
/** A list message holds 10 rows in all: up to 9 times plus "Change time zone". */
export const MAX_SLOTS = 9;
const MAX_ROWS = 10;
/** Messages one phone can send us before we stop answering for a while. */
export const WHATSAPP_BOOKING_LIMIT: Limit = { max: 20, windowMs: 10 * 60_000 };
const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;

type Db = Pick<pg.Pool, "query">;

export interface BookingBotDeps {
  pool: pg.Pool;
  cfg: WhatsAppConfig;
  fetchFn?: typeof fetch;
  now?: Date;
  /** Where booking links point; BETTER_AUTH_URL by default. */
  baseUrl?: string;
  limiter?: ReturnType<typeof createRateLimiter>;
  store?: DataStore;
}

// ---------- reading the webhook ----------

/** A message a client sent us: typed text, or the id of a list row / reply button they tapped. */
export interface Inbound { id: string; from: string; at: Date; text: string | null; replyId: string | null }

/** Text and interactive replies from a webhook payload. Messages without a phone number (username-only users) are left out. */
export function parseInbound(payload: unknown): Inbound[] {
  const out: Inbound[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    for (const change of (entry as { changes?: { value?: { messages?: unknown[] } }[] }).changes ?? []) {
      for (const raw of change.value?.messages ?? []) {
        const m = raw as {
          id?: unknown; from?: unknown; timestamp?: unknown; type?: unknown; text?: { body?: unknown };
          interactive?: { type?: unknown; list_reply?: { id?: unknown }; button_reply?: { id?: unknown } };
        };
        if (typeof m.id !== "string" || typeof m.from !== "string" || !/^\d{6,15}$/.test(m.from)) continue;
        const seconds = Number(m.timestamp);
        if (!Number.isFinite(seconds)) continue;
        const at = new Date(seconds * 1000);
        if (m.type === "text" && typeof m.text?.body === "string") out.push({ id: m.id, from: m.from, at, text: m.text.body, replyId: null });
        else if (m.type === "interactive") {
          const id = m.interactive?.list_reply?.id ?? m.interactive?.button_reply?.id;
          if (typeof id === "string") out.push({ id: m.id, from: m.from, at, text: null, replyId: id });
        }
      }
    }
  }
  return out;
}

/** The host slug a client's text names: "Book with priya", "book priya", or a pasted hourhand.cloud/priya link. */
export function slugFromText(text: string): string | null {
  const link = /hourhand\.cloud\/@?([a-z0-9][a-z0-9-]{2,39})\b/i.exec(text);
  if (link) return link[1].toLowerCase();
  const book = /(?:^|[\s,.!])book(?:ing)?\s+(?:with\s+)?@?([a-z0-9][a-z0-9-]{2,39})\b/i.exec(text);
  return book ? book[1].toLowerCase() : null;
}

// ---------- time zones ----------

/** Calling code -> the zone most of that country's people live in. Longest prefix wins. */
const ZONE_BY_CODE: Record<string, string> = {
  "91": "Asia/Kolkata", "971": "Asia/Dubai", "966": "Asia/Riyadh", "974": "Asia/Qatar", "965": "Asia/Kuwait", "968": "Asia/Muscat",
  "973": "Asia/Bahrain", "977": "Asia/Kathmandu", "94": "Asia/Colombo", "880": "Asia/Dhaka", "92": "Asia/Karachi", "65": "Asia/Singapore",
  "60": "Asia/Kuala_Lumpur", "62": "Asia/Jakarta", "66": "Asia/Bangkok", "63": "Asia/Manila", "852": "Asia/Hong_Kong", "86": "Asia/Shanghai",
  "81": "Asia/Tokyo", "82": "Asia/Seoul", "61": "Australia/Sydney", "64": "Pacific/Auckland", "44": "Europe/London", "353": "Europe/Dublin",
  "49": "Europe/Berlin", "33": "Europe/Paris", "31": "Europe/Amsterdam", "41": "Europe/Zurich", "34": "Europe/Madrid", "39": "Europe/Rome",
  "46": "Europe/Stockholm", "27": "Africa/Johannesburg", "254": "Africa/Nairobi", "234": "Africa/Lagos", "20": "Africa/Cairo",
  "1": "America/New_York", "55": "America/Sao_Paulo", "52": "America/Mexico_City",
};

/** A first guess at the client's zone from their number's country code; null when we can't tell. */
export function guessZone(phone: string): string | null {
  for (const len of [3, 2, 1]) {
    const zone = ZONE_BY_CODE[phone.slice(0, len)];
    if (zone) return zone;
  }
  return null;
}

/** The zones offered under "Change time zone" (a list holds 10). Anything else can be typed, like Asia/Tokyo. */
export const ZONE_CHOICES: { zone: string; title: string }[] = [
  { zone: "Asia/Kolkata", title: "India" }, { zone: "Asia/Dubai", title: "UAE" }, { zone: "Asia/Riyadh", title: "Saudi Arabia" },
  { zone: "Asia/Singapore", title: "Singapore" }, { zone: "Europe/London", title: "UK" }, { zone: "Europe/Berlin", title: "Central Europe" },
  { zone: "America/New_York", title: "US East" }, { zone: "America/Chicago", title: "US Central" },
  { zone: "America/Los_Angeles", title: "US West" }, { zone: "Australia/Sydney", title: "Australia East" },
];

/** "IST", "GST" or "GMT+4": short enough for a list row. */
function shortZone(tz: string, at: Date): string {
  if (tz === "Asia/Kolkata") return "IST";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? tz;
}

// ---------- building messages ----------

/** WhatsApp cuts nothing for us: titles over the limit are refused, so trim them ourselves. */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

type Row = { id: string; title: string; description?: string };

export function listMessage(to: string, body: string, button: string, sections: { title: string; rows: Row[] }[]) {
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
    interactive: {
      type: "list",
      body: { text: clip(body, 4096) },
      action: {
        button: clip(button, 20),
        sections: sections.filter((s) => s.rows.length > 0).map((s) => ({
          title: clip(s.title, 24),
          rows: s.rows.map((r) => ({ id: r.id.slice(0, 200), title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) })),
        })),
      },
    },
  };
}

export function linkMessage(to: string, body: string, label: string, url: string) {
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
    interactive: { type: "cta_url", body: { text: clip(body, 1024) }, action: { name: "cta_url", parameters: { display_text: clip(label, 20), url } } },
  };
}

/** "Tue 18 Nov, 10:30 am": a slot as a list row title (at most 24 characters). */
export function slotTitle(start: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(start).replace(",", "");
  return `${day}, ${formatTime(start, tz)}`;
}

// Examples never use a real-looking slug: it could be someone's page.
export const ASK_HOST = "Hi! This is Hourhand's booking line. Who would you like to book with? Reply with the name at the end of their Hourhand link (hourhand.cloud/name), like this: book with name";
const unknownHost = (slug: string) =>
  `We couldn't find "${slug}" taking bookings on WhatsApp. Check the link your coach or tutor shared (hourhand.cloud/name) and reply with the name at the end of it, like this: book with name. You can also book straight on their page.`;

// ---------- state ----------

type Step = "ask_host" | "pick_event" | "pick_slot" | "pick_zone" | "sent_link";
interface Session { hostId: string | null; eventTypeId: string | null; timezone: string | null; step: Step; lastMessageId: string | null }

async function loadSession(db: Db, phone: string, now: Date): Promise<Session | null> {
  const { rows: [r] } = await db.query(
    "select host_id, event_type_id, timezone, step, last_message_id from whatsapp_booking_sessions where phone = $1 and updated_at > $2",
    [phone, new Date(now.getTime() - DAY)]);
  return r ? { hostId: r.host_id, eventTypeId: r.event_type_id, timezone: r.timezone, step: r.step, lastMessageId: r.last_message_id } : null;
}

async function saveSession(db: Db, phone: string, s: Session, now: Date): Promise<void> {
  await db.query(
    `insert into whatsapp_booking_sessions (phone, host_id, event_type_id, timezone, step, last_message_id, updated_at) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (phone) do update set host_id = $2, event_type_id = $3, timezone = $4, step = $5, last_message_id = $6, updated_at = $7`,
    [phone, s.hostId, s.eventTypeId, s.timezone, s.step, s.lastMessageId, now]);
}

/** Adds to today's (IST) counts for a host, or for messages that never reached one. */
async function count(db: Db, hostId: string | null, now: Date, c: { inbound: number; replies: number; links: number }): Promise<void> {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
  const target = hostId === null ? "(day) where host_id is null" : "(day, host_id) where host_id is not null";
  await db.query(
    `insert into whatsapp_booking_counts (day, host_id, inbound, replies, links) values ($1, $2, $3, $4, $5)
     on conflict ${target} do update set inbound = whatsapp_booking_counts.inbound + excluded.inbound,
       replies = whatsapp_booking_counts.replies + excluded.replies, links = whatsapp_booking_counts.links + excluded.links`,
    [day, hostId, c.inbound, c.replies, c.links]);
}

// ---------- hosts ----------

/** Whether a host is offered on WhatsApp: turned on by them, and their plan includes it. */
export async function whatsappBookingOn(db: Db, hostId: string): Promise<boolean> {
  const { rowCount } = await db.query("select 1 from whatsapp_booking_hosts where user_id = $1", [hostId]);
  return Boolean(rowCount) && LIMITS[await hostPlan(db, hostId)].whatsappBooking;
}

export async function setWhatsAppBooking(db: Db, hostId: string, on: boolean): Promise<void> {
  if (on) await db.query("insert into whatsapp_booking_hosts (user_id) values ($1) on conflict (user_id) do nothing", [hostId]);
  else await db.query("delete from whatsapp_booking_hosts where user_id = $1", [hostId]);
}

/** The event types a client can pick on WhatsApp: the ones on the host's public page, first 10. */
function offeredTypes(types: EventType[]): EventType[] {
  return types.filter((e) => e.active && !e.hidden && e.kind !== "one_off").slice(0, MAX_ROWS);
}

/** The host's wa.me link and its pre-filled text, or null when Hourhand's number isn't set (WHATSAPP_DISPLAY_NUMBER). */
export function hostWaLink(slug: string, env: Record<string, string | undefined> = process.env): string | null {
  const number = (env.WHATSAPP_DISPLAY_NUMBER ?? "").replace(/\D/g, "");
  if (number.length < 8 || number.length > 15) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(`Book with ${slug}`)}`;
}

// ---------- the conversation ----------

interface Turn { bodies: object[]; session: Session; hostId: string | null; links: number }

class Conversation {
  constructor(private readonly db: Db, private readonly store: DataStore, private readonly to: string, private readonly now: Date, private readonly baseUrl: string) {}

  private pageUrl(host: User, et?: EventType) {
    return et ? `${this.baseUrl}/${host.slug}/${et.slug}` : `${this.baseUrl}/${host.slug}`;
  }

  async offeredHost(slug: string): Promise<User | null> {
    if (!SLUG.test(slug)) return null;
    const host = await this.store.getUserBySlug(slug);
    return host && (await whatsappBookingOn(this.db, host.id)) ? host : null;
  }

  async offeredHostById(id: string | null): Promise<User | null> {
    const host = id ? await this.store.getUser(id) : null;
    return host && (await whatsappBookingOn(this.db, host.id)) ? host : null;
  }

  async types(host: User) {
    return offeredTypes(await this.store.listEventTypes(host.id));
  }

  /** Step 1: the host's event types; with only one, straight to its times. */
  async eventList(host: User, zone: string | null): Promise<Turn> {
    const types = await this.types(host);
    if (types.length === 0) {
      return this.turn([textMessage(this.to, `${host.name} has no sessions open to book right now. Their page: ${this.pageUrl(host)}`)],
        { hostId: host.id, eventTypeId: null, timezone: zone, step: "pick_event" }, host.id);
    }
    if (types.length === 1) return this.slotList(host, types[0], zone ?? this.zoneFor(host));
    const rows = types.map((e) => ({ id: `et:${e.id}`, title: e.name, description: this.describe(e) }));
    return this.turn([listMessage(this.to, `Book with ${host.name}. Pick a session to see the next free times.`, "Choose session", [{ title: "Sessions", rows }])],
      { hostId: host.id, eventTypeId: null, timezone: zone, step: "pick_event" }, host.id);
  }

  private describe(e: EventType): string {
    const price = e.priceMinor !== null ? formatMoney(e.priceMinor, "INR") : e.depositMinor !== null ? `${formatMoney(e.depositMinor, "INR")} deposit` : "Free";
    return [`${e.durationMinutes} min`, e.kind === "group" ? "group class" : null, price].filter(Boolean).join(" · ");
  }

  zoneFor(host: User): string {
    return guessZone(this.to) ?? host.timezone;
  }

  private async free(host: User, et: EventType, from: Date, to: Date) {
    return freeSlotSeats(this.store, host, et, from, to, this.now);
  }

  /** Step 2: the next free times of one event type, in the client's zone, plus "Change time zone". */
  async slotList(host: User, et: EventType, zone: string, lead?: string): Promise<Turn> {
    const days = Math.min(LOOKAHEAD_DAYS, et.bookingWindowDays);
    const slots = (await this.free(host, et, this.now, new Date(this.now.getTime() + days * DAY))).slice(0, MAX_SLOTS);
    const session: Session = { hostId: host.id, eventTypeId: et.id, timezone: zone, step: "pick_slot", lastMessageId: null };
    const before = lead ? [textMessage(this.to, lead)] : [];
    if (slots.length === 0) {
      return this.turn([...before, textMessage(this.to, `${host.name} has no free times for ${et.name} in the next ${days} days. Their page may have other sessions or a waitlist: ${this.pageUrl(host, et)}`)], session, host.id);
    }
    const rows = slots.map((s) => ({
      id: `slot:${et.id}:${s.start.getTime()}`, title: slotTitle(s.start, zone),
      ...(s.seatsLeft !== null ? { description: `${s.seatsLeft} ${s.seatsLeft === 1 ? "seat" : "seats"} left` } : {}),
    }));
    const body = `${et.name} with ${host.name}. The next free times, in ${zoneName(zone)} time. Pick one to get your booking link, or see every time here: ${this.pageUrl(host, et)}`;
    return this.turn([...before, listMessage(this.to, body, "See times", [
      { title: `Times (${shortZone(zone, this.now)})`, rows },
      { title: "Not your time zone?", rows: [{ id: "zone", title: "Change time zone", description: `Now showing ${zoneName(zone)}` }] },
    ])], session, host.id);
  }

  zoneList(session: Session, note?: string): Turn {
    const rows = ZONE_CHOICES.map((z) => ({ id: `tz:${z.zone}`, title: z.title, description: `${z.zone.replaceAll("_", " ")} (${shortZone(z.zone, this.now)})` }));
    const body = `${note ? `${note} ` : ""}Which time zone should we show times in? Pick one, or type it like Asia/Tokyo.`;
    return this.turn([listMessage(this.to, body, "Choose time zone", [{ title: "Time zones", rows }])], { ...session, step: "pick_zone" }, session.hostId);
  }

  /** Step 3: a link to the booking page with the chosen time, after checking it is still free. */
  async bookingLink(host: User, et: EventType, start: Date, zone: string): Promise<Turn> {
    const still = await this.free(host, et, start, new Date(start.getTime() + 60_000));
    if (!still.some((s) => s.start.getTime() === start.getTime())) return this.slotList(host, et, zone, "That time has just gone. Here are the next free times.");
    const url = `${this.pageUrl(host, et)}?at=${encodeURIComponent(start.toISOString())}`;
    const when = `${formatDate(start, zone)}, ${formatTime(start, zone)} ${zoneName(zone)}`;
    const pays = et.priceMinor !== null || et.depositMinor !== null ? ", pay" : "";
    const body = `${et.name} with ${host.name}\n${when}\n\nTap below to finish on Hourhand: add your details${pays} and confirm. The time is yours only once you confirm.`;
    const t = this.turn([linkMessage(this.to, body, "Book this time", url)], { hostId: host.id, eventTypeId: et.id, timezone: zone, step: "sent_link" }, host.id);
    return { ...t, links: 1 };
  }

  turn(bodies: object[], s: Omit<Session, "lastMessageId"> & { lastMessageId?: string | null }, hostId: string | null): Turn {
    return { bodies, session: { ...s, lastMessageId: null }, hostId, links: 0 };
  }

  /** Works out the reply to one message. */
  async reply(m: Inbound, session: Session | null): Promise<Turn> {
    const s: Session = session ?? { hostId: null, eventTypeId: null, timezone: null, step: "ask_host", lastMessageId: null };
    const ask = (): Turn => this.turn([textMessage(this.to, ASK_HOST)], { ...s, step: "ask_host" }, null);

    if (m.text !== null) {
      const named = slugFromText(m.text) ?? (s.step === "ask_host" && session ? bareSlug(m.text) : null);
      if (named) {
        const host = await this.offeredHost(named);
        if (!host) return this.turn([textMessage(this.to, unknownHost(named))], { hostId: null, eventTypeId: null, timezone: s.timezone, step: "ask_host" }, null);
        return this.eventList(host, s.timezone);
      }
    }

    const host = await this.offeredHostById(s.hostId);
    if (!host) return ask(); // no host yet, or they've stopped taking WhatsApp bookings
    const types = await this.types(host);
    const typeById = (id: string | null) => types.find((e) => e.id === id) ?? null;
    const zone = s.timezone ?? this.zoneFor(host);

    if (m.replyId !== null) {
      const id = m.replyId;
      if (id.startsWith("et:")) {
        const et = typeById(id.slice(3));
        return et ? this.slotList(host, et, zone) : this.eventList(host, s.timezone);
      }
      if (id === "zone") return this.zoneList({ ...s, timezone: zone });
      if (id.startsWith("tz:")) {
        const chosen = id.slice(3);
        const et = typeById(s.eventTypeId);
        if (!isIanaTimeZone(chosen)) return this.zoneList(s);
        return et ? this.slotList(host, et, chosen) : this.eventList(host, chosen);
      }
      const slot = /^slot:([^:]+):(\d{10,15})$/.exec(id);
      if (slot) {
        const et = typeById(slot[1]);
        return et ? this.bookingLink(host, et, new Date(Number(slot[2])), zone) : this.eventList(host, s.timezone);
      }
      return this.eventList(host, s.timezone);
    }

    // Typed text that names no host: a zone when we asked for one, otherwise show where they are again.
    const text = (m.text ?? "").trim();
    const et = typeById(s.eventTypeId);
    if (s.step === "pick_zone") {
      if (!isIanaTimeZone(text)) return this.zoneList(s, "We didn't recognise that time zone.");
      return et ? this.slotList(host, et, text) : this.eventList(host, text);
    }
    if (s.step === "pick_slot" && et && /time\s*zone|timezone|\bzone\b/i.test(text)) return this.zoneList({ ...s, timezone: zone });
    if (s.step === "pick_slot" && et) return this.slotList(host, et, zone);
    return this.eventList(host, s.timezone);
  }
}

/** A reply that is just a name, after we asked for one: "priya" or "@priya". */
function bareSlug(text: string): string | null {
  const t = text.trim().replace(/^@/, "").toLowerCase();
  return SLUG.test(t) ? t : null;
}

/**
 * Answers clients' booking messages in a webhook payload. STOP replies are left to the webhook's own STOP handling;
 * a number that opted out gets nothing; anything older than the service window gets nothing; a phone sending too
 * much is ignored for a while. Never books anything: the last reply is a link to the booking page.
 */
export async function handleWhatsAppBooking(deps: BookingBotDeps, payload: unknown): Promise<void> {
  const messages = parseInbound(payload);
  if (messages.length === 0) return;
  const { pool, cfg } = deps;
  const now = deps.now ?? new Date();
  const fetchFn = deps.fetchFn ?? fetch;
  const limiter = deps.limiter ?? rateLimiter;
  const store = deps.store ?? createPgStore(pool);
  const baseUrl = (deps.baseUrl ?? process.env.BETTER_AUTH_URL ?? "https://hourhand.cloud").replace(/\/+$/, "");
  await pool.query("delete from whatsapp_booking_sessions where updated_at < $1", [new Date(now.getTime() - DAY)]);

  for (const m of messages) {
    if (m.text !== null && isStop(m.text)) continue;
    if (now.getTime() - m.at.getTime() > SERVICE_WINDOW_MS) continue; // the window has closed: only templates could go now
    const { rowCount: optedOut } = await pool.query("select 1 from whatsapp_opt_outs where phone = $1", [m.from]);
    if (optedOut) continue;
    if (!limiter.take(`wa-booking:${m.from}`, WHATSAPP_BOOKING_LIMIT)) continue;
    const session = await loadSession(pool, m.from, now);
    if (session?.lastMessageId === m.id) continue; // Meta delivered this one twice

    const turn = await new Conversation(pool, store, m.from, now, baseUrl).reply(m, session);
    await saveSession(pool, m.from, { ...turn.session, lastMessageId: m.id }, now);
    let replies = 0;
    for (const body of turn.bodies) {
      try {
        await sendWhatsApp(cfg, body, fetchFn);
        replies++;
      } catch (error) {
        console.warn(`[whatsapp-booking] reply failed: ${(error as Error).message}`);
        break;
      }
    }
    await count(pool, turn.hostId, now, { inbound: 1, replies, links: replies === turn.bodies.length ? turn.links : 0 });
  }
}
