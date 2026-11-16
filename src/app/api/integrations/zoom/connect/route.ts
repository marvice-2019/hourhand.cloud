import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, publicUrl } from "@/lib/auth/auth";
import { getSignedInUser } from "@/lib/auth/session";
import { OAUTH_COOKIES, startOAuth } from "@/lib/calendar/oauth";
import { zoomDeps, zoomRedirectUri } from "@/lib/zoom/connection";

export const dynamic = "force-dynamic";

/** Sends the signed-in host to Zoom to let Hourhand create meetings for their bookings. */
export async function GET(request: NextRequest) {
  const user = await getSignedInUser();
  if (!user) return NextResponse.redirect(publicUrl("/sign-in", request));
  const back = (error: string) => NextResponse.redirect(publicUrl(`/dashboard/integrations?zoom_error=${error}`, request));
  if (!authEnabled()) return back("demo");
  const deps = zoomDeps();
  if (!deps) return back("not_configured");
  const s = startOAuth(deps.key, user.id, new Date(), "zoom");
  const res = NextResponse.redirect(deps.client.authUrl({ redirectUri: zoomRedirectUri(request.nextUrl.origin), state: s.state, codeChallenge: s.codeChallenge }));
  res.cookies.set(OAUTH_COOKIES.zoom.name, s.cookie, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: OAUTH_COOKIES.zoom.path, maxAge: 600,
  });
  return res;
}
