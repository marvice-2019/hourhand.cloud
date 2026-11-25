import type pg from "pg";
import webpush from "web-push";
import { formatTime, type HourCycle } from "../format";
import { intlTag } from "../i18n/guest";
import { ht, isHostLocale, type HostLocale } from "../i18n/host";

// Phone alerts (Web Push). A host turns them on per device in Settings; the browser gives a push address at its own
// push service and two keys. New, moved and cancelled bookings then go out on the notifications outbox's 'push'
// channel (src/lib/data/notifications.ts), sent by the job runner. Off until the three VAPID_* variables are set.

type Env = Record<string, string | undefined>;
type Db = Pick<pg.Pool, "query">;

export interface PushConfig { publicKey: string; privateKey: string; subject: string }

const PUBLIC_KEY = /^[A-Za-z0-9_-]{86,88}$/; // 65 bytes, base64url
const PRIVATE_KEY = /^[A-Za-z0-9_-]{42,44}$/; // 32 bytes, base64url
const SUBJECT = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/;

/** Null when phone alerts are off: none of the three variables set. */
export function pushConfig(env: Env = process.env): PushConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim(), privateKey = env.VAPID_PRIVATE_KEY?.trim(), subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject || pushConfigError(env)) return null;
  return { publicKey, privateKey, subject };
}

/** Why the VAPID_* variables can't be used, when some are set; null when all three are good or none is set. */
export function pushConfigError(env: Env = process.env): string | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim(), privateKey = env.VAPID_PRIVATE_KEY?.trim(), subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey && !privateKey && !subject) return null;
  if (!publicKey || !privateKey || !subject) return "Phone alerts need all three of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (see docs/deploy.md).";
  if (!PUBLIC_KEY.test(publicKey)) return "VAPID_PUBLIC_KEY doesn't look like a key from `npx web-push generate-vapid-keys`.";
  if (!PRIVATE_KEY.test(privateKey)) return "VAPID_PRIVATE_KEY doesn't look like a key from `npx web-push generate-vapid-keys`.";
  if (!SUBJECT.test(subject)) return "VAPID_SUBJECT must be mailto:you@example.com or an https:// address.";
  return null;
}

// The push services of Chrome and Android (and browsers built on them), Firefox, Safari and Edge. The server posts to
// whatever address the browser gave, so anything else is refused: an address someone made up could point inside our
// own network.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];

export function isPushEndpoint(raw: string): boolean {
  if (raw.length > 1000) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.port && !u.username && !u.password && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

export interface PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }

/** The browser's PushSubscription.toJSON(), checked; null when it isn't one we can send to. */
export function checkSubscription(v: unknown): PushSubscriptionInput | null {
  if (!v || typeof v !== "object") return null;
  const { endpoint, keys } = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string" || !isPushEndpoint(endpoint) || !keys || typeof keys !== "object") return null;
  const { p256dh, auth } = keys;
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{40,200}$/.test(p256dh)) return null;
  if (typeof auth !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Each host keeps alerts on at most this many devices; turning them on for one more drops the oldest. */
export const MAX_DEVICES = 10;

export async function saveSubscription(db: Db, userId: string, sub: PushSubscriptionInput, device: string | null, now: Date): Promise<void> {
  await db.query(
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at) values ($1, $2, $3, $4, $5, $6)
     on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       device = excluded.device, created_at = excluded.created_at, last_sent_at = null`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, device ? device.slice(0, 120) : null, now]);
  await db.query(
    `delete from push_subscriptions where user_id = $1 and id not in
       (select id from push_subscriptions where user_id = $1 order by created_at desc, id limit $2)`, [userId, MAX_DEVICES]);
}

/** Turns alerts off for one device. Only the account that owns it can. */
export async function removeSubscription(db: Db, userId: string, endpoint: string): Promise<void> {
  await db.query("delete from push_subscriptions where user_id = $1 and endpoint = $2", [userId, endpoint]);
}

export async function countSubscriptions(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query("select count(*)::int as n from push_subscriptions where user_id = $1", [userId]);
  return rows[0].n as number;
}

/** Booking news a host can get as a phone alert. */
export type PushKind = "booked_host" | "rescheduled_host" | "cancelled_host";
export const PUSH_KINDS: readonly PushKind[] = ["booked_host", "rescheduled_host", "cancelled_host"];
export const isPushKind = (kind: string): kind is PushKind => (PUSH_KINDS as readonly string[]).includes(kind);

export interface PushMessage { title: string; body: string; url: string; tag: string }

export interface BookingPushContext {
  bookingId: string; guestName: string; eventName: string; startAt: Date;
  hostTimezone: string; hostTimeFormat: HourCycle; hostLocale: string | null;
}

const TITLE = { booked_host: "push.titleBooked", rescheduled_host: "push.titleMoved", cancelled_host: "push.titleCancelled" } as const;

/** "New booking" / "Asha · Intro call · Tue 1 Dec, 3:30 pm", in the host's dashboard language and time zone. */
export function bookingPushMessage(kind: PushKind, c: BookingPushContext): PushMessage {
  const l: HostLocale = isHostLocale(c.hostLocale) ? c.hostLocale : "en";
  const day = new Intl.DateTimeFormat(intlTag(l), { timeZone: c.hostTimezone, weekday: "short", day: "numeric", month: "short" }).format(c.startAt);
  const when = `${day}, ${formatTime(c.startAt, c.hostTimezone, c.hostTimeFormat, l)}`;
  return {
    title: ht(l, TITLE[kind]),
    body: ht(l, "push.body", { guest: c.guestName, event: c.eventName, when }),
    url: `/dashboard/bookings/${c.bookingId}`,
    // One booking's alerts replace each other on the phone instead of piling up.
    tag: `booking-${c.bookingId}`,
  };
}

export function testPushMessage(hostLocale: string | null): PushMessage {
  const l: HostLocale = isHostLocale(hostLocale) ? hostLocale : "en";
  return { title: ht(l, "push.testTitle"), body: ht(l, "push.testBody"), url: "/dashboard", tag: "hourhand-test" };
}

/** A failed send. `retryable` when the push service may take it later (it was down, busy or unreachable). */
export class PushError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = "PushError"; }
}

type Sender = (sub: PushSubscriptionInput, payload: string) => Promise<unknown>;
export interface PushDeps { config: PushConfig; send: Sender }

export function webPushDeps(config: PushConfig): PushDeps {
  return {
    config,
    send: (sub, payload) => webpush.sendNotification(sub, payload, {
      vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
      TTL: 12 * 60 * 60, urgency: "high", timeout: 10_000,
    }),
  };
}

/** The runner's push sender, or null while phone alerts are off. */
export function pushDeps(env: Env = process.env): PushDeps | null {
  const config = pushConfig(env);
  return config && webPushDeps(config);
}

const statusOf = (e: unknown): number | null => {
  const s = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : null;
};

/**
 * Sends one alert to every device the host turned alerts on for. A device whose push address is gone (404, 410) is
 * dropped. Throws when none took it and at least one failed; `sent: 0` with nothing thrown means no device has alerts on.
 */
export async function sendToHost(db: Db, deps: PushDeps, userId: string, message: PushMessage, now: Date): Promise<{ sent: number; removed: number }> {
  const { rows } = await db.query("select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1 order by created_at", [userId]);
  const payload = JSON.stringify(message);
  let sent = 0, removed = 0;
  let failure: PushError | null = null;
  for (const row of rows) {
    if (!isPushEndpoint(row.endpoint)) { await db.query("delete from push_subscriptions where id = $1", [row.id]); removed++; continue; }
    try {
      await deps.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload);
      await db.query("update push_subscriptions set last_sent_at = $2 where id = $1", [row.id, now]);
      sent++;
    } catch (e) {
      const status = statusOf(e);
      if (status === 404 || status === 410) { await db.query("delete from push_subscriptions where id = $1", [row.id]); removed++; continue; }
      const host = new URL(row.endpoint).hostname;
      failure = new PushError(`${host} answered ${status ?? (e as Error).message}`.slice(0, 300), status === null || status === 429 || status >= 500);
    }
  }
  if (sent === 0 && failure) throw failure;
  return { sent, removed };
}
