import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, getAuth, publicUrl } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { clientIp, rateLimiter } from "@/lib/rate-limit";
import { DAY_MS, DEVICE_COOKIE, isDeviceId, newDeviceId, REFERRAL_COOKIE, REFERRAL_WINDOW_DAYS, referralCookieValue } from "@/lib/referrals/codes";
import { recordClick, referrerForCode, rememberDevice } from "@/lib/referrals/store";

export const dynamic = "force-dynamic";

/** Opening links is cheap to fake; this keeps one address from inflating a host's "invited" count or probing codes. */
const LINK_LIMIT = { max: 30, windowMs: 60_000 };

/**
 * hourhand.cloud/r/<code>: a host's referral link. A visitor without an account gets a 30-day referral cookie and goes
 * to sign-in; the host opening their own link is sent back to their referrals page (and this browser is remembered as
 * theirs); anyone already signed in is sent to their dashboard, since referrals are for new accounts only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = raw.toLowerCase();
  const go = (path: string) => NextResponse.redirect(publicUrl(path, request), 303);
  if (!rateLimiter.take(`referral:${clientIp(request.headers)}`, LINK_LIMIT)) return go("/");
  if (!authEnabled() || !process.env.DATABASE_URL) return go("/sign-in");

  const pool = getPool(process.env.DATABASE_URL);
  const referrer = await referrerForCode(pool, code);
  if (!referrer) return go("/");

  const existing = request.cookies.get(DEVICE_COOKIE)?.value;
  const deviceId = isDeviceId(existing) ? existing : newDeviceId();
  const now = new Date();
  const session = await getAuth().api.getSession({ headers: request.headers }).catch(() => null);
  const secure = publicUrl("/", request).protocol === "https:";

  let res: NextResponse;
  if (session?.user.id === referrer.id) {
    await rememberDevice(pool, referrer.id, deviceId, now);
    res = go("/dashboard/referrals?own=1");
  } else if (session) {
    res = go("/dashboard");
  } else {
    await recordClick(pool, referrer.id, deviceId, now);
    res = go("/sign-in?invited=1");
    res.cookies.set(REFERRAL_COOKIE, referralCookieValue(code, now), {
      httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: (REFERRAL_WINDOW_DAYS * DAY_MS) / 1000,
    });
  }
  if (deviceId !== existing) {
    res.cookies.set(DEVICE_COOKIE, deviceId, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 400 * 86_400 });
  }
  return res;
}
