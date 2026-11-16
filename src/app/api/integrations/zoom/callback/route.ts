import { NextResponse, type NextRequest } from "next/server";
import { publicUrl } from "@/lib/auth/auth";
import { getSignedInUser } from "@/lib/auth/session";
import { checkOAuthCallback, OAUTH_COOKIES } from "@/lib/calendar/oauth";
import { getPool } from "@/lib/data/pg-store";
import { saveZoomConnection, zoomDeps, zoomRedirectUri } from "@/lib/zoom/connection";

export const dynamic = "force-dynamic";

/** Zoom sends the host back here. Only the host who started the handshake, with its state, can finish it. */
export async function GET(request: NextRequest) {
  const user = await getSignedInUser();
  if (!user) return NextResponse.redirect(publicUrl("/sign-in", request));
  const done = (query: string) => {
    const res = NextResponse.redirect(publicUrl(`/dashboard/integrations?${query}`, request));
    res.cookies.set(OAUTH_COOKIES.zoom.name, "", { path: OAUTH_COOKIES.zoom.path, maxAge: 0 });
    return res;
  };
  const deps = zoomDeps();
  if (!deps) return done("zoom_error=not_configured");

  const params = request.nextUrl.searchParams;
  const check = checkOAuthCallback(deps.key, request.cookies.get(OAUTH_COOKIES.zoom.name)?.value, params.get("state"), user.id, new Date(), "zoom");
  if (!check.ok) return done(`zoom_error=${check.error}`);
  const code = params.get("code");
  if (params.get("error") || !code) return done("zoom_error=denied");

  try {
    const tokens = await deps.client.exchangeCode({ code, redirectUri: zoomRedirectUri(request.nextUrl.origin), codeVerifier: check.verifier });
    if (deps.client.missingScopes(tokens.scope).length > 0) {
      await deps.client.revoke(tokens.accessToken).catch(() => undefined);
      return done("zoom_error=missing_permissions");
    }
    const zoomUser = await deps.client.me(tokens.accessToken);
    await saveZoomConnection(getPool(process.env.DATABASE_URL as string), deps.key, user.id, zoomUser, tokens);
    return done("zoom_connected=1");
  } catch (error) {
    console.error("[zoom] connecting Zoom failed", (error as Error).message);
    return done("zoom_error=zoom");
  }
}
