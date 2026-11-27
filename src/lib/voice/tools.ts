import { TZDate } from "@date-fns/tz";
import type pg from "pg";
import { freeSlots, type HandlerResult, type PaymentDeps } from "../booking";
import { isNamedError, type DataStore, type EventType, type User } from "../data/types";
import { formatDate, formatTime, zoneName } from "../format";
import { GUEST_LOCATION_LABELS } from "../location-labels";
import type { Mailer } from "../mail/mailer";
import { startPaidBooking } from "../payments/booking-payments";
import type { createRateLimiter } from "../rate-limit";
import { waNumber } from "../whatsapp";
import type { WhatsAppConfig } from "../whatsapp-cloud";
import { readToolKey } from "./auth";
import { MAX_FAILED_ATTEMPTS, SAY, screen, voiceLang, type VoiceLang } from "./guardrails";
import { emailHostMessage, emailPayLink, whatsappPayLink, type PayLinkContext } from "./notify";
import {
  addFailure, addMessage, getVoiceSettings, MESSAGE_REASONS, openCall, setOutcome, usedSecondsThisMonth,
  type MessageReason, type VoiceCall, type VoiceSettings,
} from "./store";

// The four server tools a host's voice agent calls (POST /api/voice/tools/<tool>). The host is never a parameter: it
// comes from the agent's key, so an agent can only ever see and book its own host. Answers are short JSON the agent
// reads; `say` is a line it should use as is, `handoff: true` means take a message now, `end_call: true` means end.

const MIN = 60_000;
const DAY = 86_400_000;
/** Plans the add-on is sold on. "clinic" is matched by name so this keeps working when that plan lands. */
export const VOICE_PLANS: readonly string[] = ["duo", "clinic"];
/** Free times read out per answer: more than this is hard to follow on a call. */
export const SLOTS_PER_ANSWER = 6;
const MAX_DAYS = 14;
/** Voice bookings per host per hour: far above a busy front desk, low enough to stop a runaway agent. */
export const VOICE_BOOKING_LIMIT = { max: 20, windowMs: 60 * MIN };

type Limiter = Pick<ReturnType<typeof createRateLimiter>, "take">;

export interface VoiceDeps {
  pool: pg.Pool;
  store: DataStore;
  key: Buffer;
  planFor(hostId: string): Promise<string>;
  /** Whether the host's receptionist add-on is paid up. Left out in tests of the tools alone. */
  hasAddon?(hostId: string): Promise<boolean>;
  payments: PaymentDeps | null;
  mailer: Mailer;
  whatsapp: WhatsAppConfig | null;
  limiter: Limiter;
  baseUrl: string;
  fetchFn?: typeof fetch;
}

export const TOOLS = ["get_services", "get_free_slots", "create_booking", "take_message"] as const;
export type ToolName = (typeof TOOLS)[number];
export const isTool = (t: string): t is ToolName => (TOOLS as readonly string[]).includes(t);

type Ctx = { deps: VoiceDeps; host: User; settings: VoiceSettings; call: VoiceCall; lang: VoiceLang; body: Record<string, unknown>; now: Date };

const CONVERSATION = /^[A-Za-z0-9_-]{1,100}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bad = (fields: Record<string, string>): HandlerResult => ({ status: 400, body: { error: "invalid_request", fields } });

/**
 * Checks the key, that voice is on for this host on an eligible plan and under its minute cap, and opens the call row.
 * Every refusal after the key check tells the agent to say one line and end the call.
 */
export async function authorize(deps: VoiceDeps, presented: string | null, input: unknown, now: Date): Promise<Ctx | HandlerResult> {
  const id = readToolKey(deps.key, presented);
  if (!id) return { status: 401, body: { error: "unauthorized" } };
  const settings = await getVoiceSettings(deps.pool, id.hostId);
  if (!settings || settings.keyVersion !== id.version) return { status: 401, body: { error: "unauthorized" } };
  const host = await deps.store.getUser(id.hostId);
  if (!host) return { status: 401, body: { error: "unauthorized" } };
  const body = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const lang = voiceLang(body.language);
  const stop = (error: string): HandlerResult => ({ status: 403, body: { error, say: SAY.capReached[lang], end_call: true } });
  if (!(await voiceEntitled(deps, settings, host.id))) return stop("voice_off");
  if (await usedSecondsThisMonth(deps.pool, host.id, host.timezone, now) >= settings.monthlyMinuteCap * 60) return stop("cap_reached");
  const conversationId = str(body.conversation_id, 100);
  if (!CONVERSATION.test(conversationId)) return bad({ conversation_id: "Pass {{system__conversation_id}}." });
  const call = await openCall(deps.pool, host.id, conversationId, waNumber(str(body.caller_phone, 20)) ? str(body.caller_phone, 20) : null, now);
  // The conversation id is another host's: never touch or reveal it.
  if (!call) return { status: 403, body: { error: "unauthorized" } };
  return { deps, host, settings, call, lang, body, now };
}

/** Voice runs only when the host switched it on, is on Duo or Clinic, and (where billing is wired) has the add-on. */
export async function voiceEntitled(
  deps: { planFor(hostId: string): Promise<string>; hasAddon?(hostId: string): Promise<boolean> }, settings: Pick<VoiceSettings, "enabled">, hostId: string,
): Promise<boolean> {
  if (!settings.enabled || !VOICE_PLANS.includes(await deps.planFor(hostId))) return false;
  return deps.hasAddon ? deps.hasAddon(hostId) : true;
}

/** Services callers may hear about and book: the host's active, listed event types (no one-off meetings). */
async function publicServices(store: DataStore, host: User): Promise<EventType[]> {
  return (await store.listEventTypes(host.id)).filter((e) => e.active && !e.hidden && e.kind !== "one_off").sort((a, b) => a.position - b.position);
}

const rupees = (minor: number | null) => (minor === null ? null : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(minor / 100));

function spoken(d: Date, tz: string, lang: VoiceLang): string {
  return `${formatDate(d, tz, lang)}, ${formatTime(d, tz, "12h", lang)}${tz === "Asia/Kolkata" ? "" : ` ${zoneName(tz)}`}`;
}

/** Counts a failure; on reaching the limit, leaves the host a handoff message (once) and tells the agent to take one. */
async function failed(c: Ctx, error: string, extra: Record<string, unknown> = {}): Promise<HandlerResult> {
  const n = await addFailure(c.deps.pool, c.call.id);
  if (n >= MAX_FAILED_ATTEMPTS) {
    if (n === MAX_FAILED_ATTEMPTS) await leaveMessage(c, "handoff", `Couldn't book on the phone (${error.replaceAll("_", " ")}). Please call back.`, null);
    return { status: 200, body: { error, ...extra, handoff: true, say: SAY.handoff[c.lang] } };
  }
  return { status: 200, body: { error, ...extra, attempts_left: MAX_FAILED_ATTEMPTS - n } };
}

async function leaveMessage(c: Ctx, reason: MessageReason, text: string, name: string | null, phone?: string, urgent = false): Promise<string> {
  const callerPhone = phone || c.call.callerPhone || "unknown";
  const callerName = name || "Caller";
  const m = await addMessage(c.deps.pool, { hostId: c.host.id, callId: c.call.id, callerName, callerPhone, body: text, reason });
  await setOutcome(c.deps.pool, c.call.id, reason === "handoff" || reason === "payment_issue" ? "handoff" : "message");
  try {
    await emailHostMessage(c.deps.mailer, c.host.email, { id: m.id, callerName, callerPhone, body: text, reason, urgent, dashboardUrl: `${c.deps.baseUrl}/dashboard/voice` });
  } catch (error) {
    // The message is saved and shows on the dashboard either way.
    console.error("[voice] host email failed", (error as Error).message);
  }
  return m.id;
}

async function getServices(c: Ctx): Promise<HandlerResult> {
  const services = await publicServices(c.deps.store, c.host);
  const withPlaces = await Promise.all(services.map(async (e) => ({ e, places: await c.deps.store.listEventLocations(c.host.id, e.id) })));
  await setOutcome(c.deps.pool, c.call.id, "info");
  return {
    status: 200,
    body: {
      host: { name: c.host.name, timezone: c.host.timezone },
      about: c.settings.publicNote || null,
      services: withPlaces.map(({ e, places }) => ({
        service: e.slug, name: e.name, minutes: e.durationMinutes, price: rupees(e.priceMinor), deposit: rupees(e.depositMinor),
        description: e.description?.slice(0, 300) ?? null, group_class: e.kind === "group",
        where: [...new Set(places.map((p) => GUEST_LOCATION_LABELS[p.kind]))],
        cancellation_policy: e.cancelPolicy, cancel_online_until_minutes_before: e.cancelCutoffMinutes,
      })),
    },
  };
}

async function findService(c: Ctx): Promise<EventType | null> {
  const slug = str(c.body.service, 100);
  return (await publicServices(c.deps.store, c.host)).find((e) => e.slug === slug) ?? null;
}

/** Midnight at the start of YYYY-MM-DD in `tz`. */
function dayStart(date: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new TZDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, tz);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime());
}

async function getFreeSlots(c: Ctx): Promise<HandlerResult> {
  const service = await findService(c);
  if (!service) return failed(c, "unknown_service");
  const tz = c.host.timezone;
  const fromRaw = str(c.body.from_date, 10);
  const from = fromRaw ? dayStart(fromRaw, tz) : c.now;
  const days = c.body.days === undefined ? 7 : Number(c.body.days);
  if (!from) return bad({ from_date: "Use YYYY-MM-DD." });
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return bad({ days: `1 to ${MAX_DAYS}.` });
  const start = from < c.now ? c.now : from;
  const end = new Date(from.getTime() + days * DAY);
  const slots = end > start ? await freeSlots(c.deps.store, c.host, service, start, end, c.now) : [];
  if (slots.length === 0) return failed(c, "no_free_times", { slots: [] });
  return {
    status: 200,
    body: { service: service.slug, timezone: tz, slots: slots.slice(0, SLOTS_PER_ANSWER).map((s) => ({ start: s.toISOString(), spoken: spoken(s, tz, c.lang) })), more: slots.length > SLOTS_PER_ANSWER },
  };
}

async function createBooking(c: Ctx): Promise<HandlerResult> {
  const { deps, host, body, lang, now } = c;
  // Read-back first: the agent must have said name, service, date and time and heard a yes.
  if (body.confirmed_with_caller !== true) return { status: 200, body: { error: "confirm_first", say: SAY.confirmFirst[lang] } };
  const name = str(body.name, 100);
  const email = str(body.email, 254);
  const phone = str(body.phone, 20) || c.call.callerPhone || "";
  const start = typeof body.start === "string" ? new Date(body.start) : null;
  const fields: Record<string, string> = {};
  if (!name) fields.name = "Ask the caller's name.";
  if (!start || Number.isNaN(start.getTime())) fields.start = "Use a start from get_free_slots.";
  if (email && !EMAIL.test(email)) fields.email = "That email doesn't look right; spell it back.";
  if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) fields.phone = "Ask for a phone number with country code.";
  if (Object.keys(fields).length > 0 || !start) return bad(fields);

  // The guest must get their confirmation and manage link somewhere: email, or WhatsApp they agreed to on the call.
  const wa = body.whatsapp_ok === true && deps.whatsapp ? waNumber(phone) : null;
  if (!email && !wa) return { status: 200, body: { error: "need_contact", say: lang === "hi" ? "पुष्टि भेजने के लिए ईमेल पता बताइए, या क्या मैं इसे WhatsApp पर भेज दूँ?" : "Where should I send your confirmation? Your email, or may I send it on WhatsApp?" } };

  const service = await findService(c);
  if (!service) return failed(c, "unknown_service");
  const questions = await deps.store.listCustomQuestions(host.id, service.id);
  if (questions.some((q) => q.required)) return failed(c, "needs_online_booking", { booking_page: `${deps.baseUrl}/${host.slug}/${service.slug}` });

  // The same request on the same call (an agent retry) returns the same booking, before the slot re-check it would fail.
  const idempotencyKey = `voice:${c.call.conversationId}:${service.id}:${start.toISOString()}`;
  const existing = (await deps.store.listBookings(host.id)).find((b) => b.idempotencyKey === idempotencyKey);
  if (existing?.status === "confirmed") {
    return { status: 201, body: { status: "booked", when: spoken(existing.startAt, host.timezone, lang), service: service.name, confirmation_sent_by: [...(email ? ["email"] : []), ...(wa ? ["whatsapp"] : [])] } };
  }
  if (!existing) {
    const offered = await freeSlots(deps.store, host, service, start, new Date(start.getTime() + MIN), now);
    if (!offered.some((s) => s.getTime() === start.getTime())) return slotGone(c, service, start);
  }
  if (!deps.limiter.take(`voice-booking:${host.id}`, VOICE_BOOKING_LIMIT)) return { status: 429, body: { error: "too_many_requests", handoff: true, say: SAY.handoff[lang] } };

  const input = {
    eventTypeId: service.id, startAt: start, idempotencyKey,
    invitee: {
      name, timezone: host.timezone, phone: phone || null, answers: [], locale: lang, whatsappOptIn: wa !== null,
      // invitees.email is required. A caller without one gets a per-number address on the reserved .invalid domain,
      // which never sends (queueBookingNotifications skips it) and keeps each caller a separate client.
      email: email || `${(waNumber(phone) ?? "caller")}@voice.invalid`,
    },
  };
  const priceMinor = service.priceMinor ?? service.depositMinor;
  try {
    if (!priceMinor) {
      const booking = await deps.store.createBooking(input);
      await markVoice(deps.pool, booking.id);
      await setOutcome(deps.pool, c.call.id, "booked", booking.id);
      return { status: 201, body: { status: "booked", when: spoken(booking.startAt, host.timezone, lang), service: service.name, confirmation_sent_by: [...(email ? ["email"] : []), ...(wa ? ["whatsapp"] : [])] } };
    }
    // Paid: never booked unpaid. The time is held 15 minutes and the caller gets a link to pay.
    const auth = deps.payments && (await deps.payments.planFor(host.id)) !== "free" ? await (deps.payments.collectFor ?? deps.payments.authFor)(host.id) : null;
    if (!deps.payments || !auth) return paymentIssue(c, name, phone, "Payments aren't set up for this service.");
    const { booking, payment } = await startPaidBooking(
      { pool: deps.pool, store: deps.store, auth, orders: deps.payments.ordersFor(auth) },
      { ...input, priceMinor, kind: service.priceMinor === null ? "deposit" : "payment" }, now);
    if (booking.status === "confirmed") return { status: 200, body: { status: "booked", when: spoken(booking.startAt, host.timezone, lang), service: service.name } };
    if (!payment) return paymentIssue(c, name, phone, "The payment hold had already ended.");
    await markVoice(deps.pool, booking.id);
    const ctx: PayLinkContext = {
      bookingId: booking.id, guestName: name, hostName: host.name, eventName: service.name, startAt: booking.startAt, timezone: host.timezone,
      holdExpiresAt: payment.holdExpiresAt, amountMinor: payment.amount, url: `${deps.baseUrl}/v/pay/${booking.invitee.manageToken}`, locale: lang,
    };
    const sent: string[] = [];
    // A retry of a request whose link already went: say so again without sending a second one.
    if (existing) sent.push(...(email ? ["email"] : []), ...(wa ? ["whatsapp"] : []));
    else if (email) await emailPayLink(deps.mailer, email, ctx).then(() => sent.push("email"), (e) => console.error("[voice] pay link email failed", (e as Error).message));
    if (!existing && wa && deps.whatsapp) await whatsappPayLink(deps.whatsapp, wa, ctx, booking.invitee.manageToken, deps.fetchFn).then(() => sent.push("whatsapp"), (e) => console.error("[voice] pay link WhatsApp failed", (e as Error).message));
    if (sent.length === 0) {
      // Nobody can pay a link that never arrived: free the time now instead of holding it for 15 minutes.
      await deps.pool.query(
        `update bookings set status = 'cancelled', cancelled_at = $2, cancelled_by = 'system', cancel_reason = 'Payment could not start', hold_expires_at = null
         where id = $1 and status = 'pending_payment'`, [booking.id, now]);
      return paymentIssue(c, name, phone, "The payment link couldn't be sent.");
    }
    await setOutcome(deps.pool, c.call.id, "payment_link", booking.id);
    return {
      status: 201,
      body: { status: "payment_link_sent", sent_by: sent, amount: rupees(payment.amount), hold_minutes: Math.round((payment.holdExpiresAt.getTime() - now.getTime()) / MIN), when: spoken(booking.startAt, host.timezone, lang), service: service.name },
    };
  } catch (err) {
    if (isNamedError(err, "SlotTakenError")) return slotGone(c, service, start);
    if (isNamedError(err, "PaymentStartError")) return paymentIssue(c, name, phone, "The payment couldn't be started.");
    if (isNamedError(err, "RequestKeyConflictError")) return failed(c, "conflict");
    throw err;
  }
}

/** The time went between offering and booking: count it, and offer the next ones. */
async function slotGone(c: Ctx, service: EventType, after: Date): Promise<HandlerResult> {
  const slots = await freeSlots(c.deps.store, c.host, service, c.now, new Date(c.now.getTime() + Math.min(service.bookingWindowDays, MAX_DAYS) * DAY), c.now);
  const next = slots.filter((s) => s >= after).slice(0, 3);
  return failed(c, "slot_taken", { slots: next.map((s) => ({ start: s.toISOString(), spoken: spoken(s, c.host.timezone, c.lang) })) });
}

async function paymentIssue(c: Ctx, name: string, phone: string, why: string): Promise<HandlerResult> {
  await leaveMessage(c, "payment_issue", `${why} The caller wanted to book and pay; please call them back.`, name, phone);
  return { status: 200, body: { error: "payment_issue", handoff: true, message_taken: true, say: SAY.handoff[c.lang] } };
}

async function markVoice(pool: pg.Pool, bookingId: string): Promise<void> {
  await pool.query("update bookings set source = 'voice' where id = $1", [bookingId]);
}

async function takeMessage(c: Ctx): Promise<HandlerResult> {
  const name = str(c.body.name, 100);
  const text = str(c.body.message, 2000);
  const phone = str(c.body.phone, 20) || c.call.callerPhone || "";
  const asked = str(c.body.reason, 30) as MessageReason;
  const fields: Record<string, string> = {};
  if (!name) fields.name = "Ask the caller's name.";
  if (!text) fields.message = "What should the host know?";
  if (!phone) fields.phone = "Ask for a number to call back on.";
  if (Object.keys(fields).length > 0) return bad(fields);
  const s = screen(text);
  const reason: MessageReason = s.kind !== "ok" ? "out_of_scope" : MESSAGE_REASONS.includes(asked) ? asked : "other";
  await leaveMessage(c, reason, text, name, phone, s.kind === "crisis");
  const say = s.kind === "crisis" ? SAY.crisis[c.lang] : s.kind === "advice" ? SAY.advice[c.lang] : undefined;
  return { status: 201, body: { status: "message_taken", ...(say ? { say } : {}), ...(s.kind === "crisis" ? { urgent: true } : {}) } };
}

const HANDLERS: Record<ToolName, (c: Ctx) => Promise<HandlerResult>> = {
  get_services: getServices, get_free_slots: getFreeSlots, create_booking: createBooking, take_message: takeMessage,
};

/** POST /api/voice/tools/<tool>. */
export async function handleVoiceTool(deps: VoiceDeps, tool: string, presentedKey: string | null, input: unknown, now: Date): Promise<HandlerResult> {
  if (!isTool(tool)) return { status: 404, body: { error: "not_found" } };
  const c = await authorize(deps, presentedKey, input, now);
  if ("status" in c) return c;
  return HANDLERS[tool](c);
}
