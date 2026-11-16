import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { applyOptOut } from "@/lib/follow-ups/follow-ups";
import { linkKey } from "@/lib/follow-ups/tokens";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// RFC 8058 one-click unsubscribe, named in the follow-up email's List-Unsubscribe header. The mail client POSTs
// "List-Unsubscribe=One-Click" here with no cookies and expects it to work without a page or confirmation. Link
// scanners only ever GET, and GET changes nothing (it sends a person to the page with the button), so a scanner
// can't opt anyone out. The signed token names the host and the guest's email; nothing else is trusted.

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  if (!authEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Mail providers send these from shared addresses, so the limit is generous; it only stops someone hammering it.
  if (!rateLimiter.take(`one-click:${clientIp(request.headers)}`, { max: 120, windowMs: 10 * 60_000 })) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }
  let key: Buffer;
  try { key = linkKey(); } catch { return NextResponse.json({ error: "not_configured" }, { status: 503 }); }
  const { token } = await params;
  const ok = await applyOptOut(getPool(process.env.DATABASE_URL as string), key, decodeURIComponent(token), new Date());
  return ok ? NextResponse.json({ status: "stopped" }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}

/** A person (or a scanner) opening the URL: the confirmation page, which changes nothing until its button is pressed. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return NextResponse.redirect(new URL(`/b/stop/${encodeURIComponent(decodeURIComponent(token))}`, request.url), 303);
}
