import type pg from "pg";
import { cookieFrom, DEVICE_COOKIE, parseReferralCookie, REFERRAL_COOKIE } from "./codes";
import { attributeSignUp, rememberDevice } from "./store";

// The two sign-in hooks. Both read the browser's cookies from the request Better Auth is handling (the sign-in link
// click or the OAuth callback, both made by the person's own browser). A referral problem never blocks a sign-in.

type HookContext = { headers?: Headers; request?: Request } | null | undefined;

const cookieHeader = (ctx: HookContext) => ctx?.headers?.get("cookie") ?? ctx?.request?.headers.get("cookie") ?? null;

/** A new account: link it to the referral link opened in this browser, if any. */
export async function onUserCreated(pool: pg.Pool, user: { id: string; email: string }, ctx: unknown, now = new Date()): Promise<void> {
  const header = cookieHeader(ctx as HookContext);
  try {
    const result = await attributeSignUp(pool, user, {
      code: parseReferralCookie(cookieFrom(header, REFERRAL_COOKIE), now),
      deviceId: cookieFrom(header, DEVICE_COOKIE),
    }, now);
    if (!result.attributed && (result.reason === "same_email" || result.reason === "same_device")) {
      console.warn(`[referrals] sign-up ${user.id} not credited to a referral: ${result.reason}`);
    }
  } catch (error) {
    console.error("[referrals] attributing a sign-up failed", error);
  }
}

/** A sign-in: remember this browser for the host, so they can't refer themselves from it. */
export async function onSessionCreated(pool: pg.Pool, userId: string, ctx: unknown, now = new Date()): Promise<void> {
  try {
    await rememberDevice(pool, userId, cookieFrom(cookieHeader(ctx as HookContext), DEVICE_COOKIE), now);
  } catch (error) {
    console.error("[referrals] remembering a device failed", error);
  }
}
