import type pg from "pg";
import { CODE_RE, DAY_MS, isDeviceId, newReferralCode, normaliseEmail, REFERRAL_WINDOW_DAYS } from "./codes";

// Referral links, clicks, devices and sign-up attribution.

type Db = Pick<pg.Pool, "query">;

/** The host's referral code, made on first use. */
export async function getOrCreateCode(db: Db, userId: string): Promise<string> {
  const existing = await db.query<{ code: string }>("select code from referral_codes where user_id = $1", [userId]);
  if (existing.rows[0]) return existing.rows[0].code;
  for (let i = 0; i < 5; i++) {
    const { rows } = await db.query<{ code: string }>(
      `insert into referral_codes (user_id, code) values ($1, $2)
       on conflict (user_id) do update set user_id = excluded.user_id returning code`, [userId, newReferralCode()])
      .catch((error: { code?: string; constraint?: string }) => {
        if (error.code === "23505") return { rows: [] as { code: string }[] }; // the random code was taken: try another
        throw error;
      });
    if (rows[0]) return rows[0].code;
  }
  throw new Error("could not allocate a referral code");
}

/** The live host a code belongs to, or null. */
export async function referrerForCode(db: Db, code: string): Promise<{ id: string; email: string } | null> {
  if (!CODE_RE.test(code)) return null;
  const { rows } = await db.query<{ id: string; email: string }>(
    "select u.id, u.email from referral_codes c join users u on u.id = c.user_id where c.code = $1 and u.deleted_at is null", [code]);
  return rows[0] ?? null;
}

/** Counts a browser that opened the link as "invited", once per browser. */
export async function recordClick(db: Db, referrerId: string, deviceId: string, now = new Date()): Promise<void> {
  if (!isDeviceId(deviceId)) return;
  await db.query("insert into referral_clicks (referrer_id, device_id, clicked_at) values ($1, $2, $3) on conflict do nothing", [referrerId, deviceId, now]);
}

/** Notes that this host used this browser, for the same-device rule. */
export async function rememberDevice(db: Db, userId: string, deviceId: string | null | undefined, now = new Date()): Promise<void> {
  if (!isDeviceId(deviceId)) return;
  await db.query(
    `insert into referral_devices (user_id, device_id, seen_at) values ($1, $2, $3)
     on conflict (user_id, device_id) do update set seen_at = greatest(referral_devices.seen_at, excluded.seen_at)`, [userId, deviceId, now]);
}

export type Attribution =
  | { attributed: true; referralId: string; referrerId: string }
  | { attributed: false; reason: "no_cookie" | "unknown_code" | "own_code" | "already_referred" | "same_email" | "same_device"; referralId?: string };

/**
 * Called once, when a new account is created. Links it to the host whose link was opened in this browser in the last
 * 30 days, unless it looks like that host signing up again: the same mailbox, or a browser that host used in the last
 * 30 days. A blocked attempt is kept (status blocked) so support can see it; it never earns anything.
 */
export async function attributeSignUp(
  db: Db, user: { id: string; email: string }, cookie: { code: string | null; deviceId: string | null }, now = new Date(),
): Promise<Attribution> {
  await rememberDevice(db, user.id, cookie.deviceId, now);
  if (!cookie.code) return { attributed: false, reason: "no_cookie" };
  const referrer = await referrerForCode(db, cookie.code);
  if (!referrer) return { attributed: false, reason: "unknown_code" };
  if (referrer.id === user.id) return { attributed: false, reason: "own_code" };

  let blocked: "same_email" | "same_device" | null = null;
  if (normaliseEmail(referrer.email) === normaliseEmail(user.email)) blocked = "same_email";
  else if (isDeviceId(cookie.deviceId)) {
    const { rowCount } = await db.query(
      "select 1 from referral_devices where user_id = $1 and device_id = $2 and seen_at >= $3",
      [referrer.id, cookie.deviceId, new Date(now.getTime() - REFERRAL_WINDOW_DAYS * DAY_MS)]);
    if (rowCount) blocked = "same_device";
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into referrals (referrer_id, referred_id, status, blocked_reason, signed_up_at) values ($1, $2, $3, $4, $5)
     on conflict (referred_id) do nothing returning id`,
    [referrer.id, user.id, blocked ? "blocked" : "signed_up", blocked, now]);
  if (!rows[0]) return { attributed: false, reason: "already_referred" };
  if (blocked) return { attributed: false, reason: blocked, referralId: rows[0].id };
  return { attributed: true, referralId: rows[0].id, referrerId: referrer.id };
}

export interface ReferralCounts {
  /** Browsers that opened the link. */
  invited: number;
  /** Accounts made through it (self-referrals excluded). */
  signedUp: number;
  /** Of those, how many have paid for Solo or Duo. */
  paid: number;
  /** Free months earned by the referrer (the yearly cap can make this lower than paid). */
  credited: number;
}

export interface CreditLine {
  role: "referrer" | "referred";
  status: "pending" | "scheduled" | "used" | "extension" | "failed";
  mechanism: string | null;
  accessUntil: Date | null;
  createdAt: Date;
}

/** What the dashboard shows a host about their referrals and their own free months. */
export async function referralSummary(db: Db, userId: string): Promise<{ counts: ReferralCounts; credits: CreditLine[]; rewardedLastYear: number }> {
  const { rows: [c] } = await db.query(
    `select (select count(*) from referral_clicks where referrer_id = $1)::int as invited,
            (select count(*) from referrals where referrer_id = $1 and status <> 'blocked')::int as signed_up,
            (select count(*) from referrals where referrer_id = $1 and status in ('rewarded', 'capped'))::int as paid,
            (select count(*) from referral_credits where user_id = $1 and role = 'referrer')::int as credited,
            (select count(*) from referrals where referrer_id = $1 and status = 'rewarded' and paid_at > now() - interval '365 days')::int as last_year`,
    [userId]);
  const { rows } = await db.query(
    "select role, status, mechanism, access_until, created_at from referral_credits where user_id = $1 order by created_at desc limit 50", [userId]);
  return {
    counts: { invited: c.invited, signedUp: c.signed_up, paid: c.paid, credited: c.credited },
    credits: rows.map((r) => ({ role: r.role, status: r.status, mechanism: r.mechanism, accessUntil: r.access_until, createdAt: r.created_at })),
    rewardedLastYear: c.last_year,
  };
}
