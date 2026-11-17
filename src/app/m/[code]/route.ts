import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/data/pg-store";
import { clientIp, rateLimiter } from "@/lib/rate-limit";
import { manageTokenForCode } from "@/lib/sms/manage";

export const dynamic = "force-dynamic";

/** A booking text's short link: /m/<code> opens the booking's manage page. Host slugs are 3+ characters, so "m" is free. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // Codes are far too many to guess, and the limit keeps anyone from trying.
  if (!rateLimiter.take(`sms-link:${clientIp(request.headers)}`, { max: 60, windowMs: 3_600_000 })) {
    return new NextResponse("Too many requests", { status: 429 });
  }
  const token = process.env.DATABASE_URL ? await manageTokenForCode(getPool(process.env.DATABASE_URL), code) : null;
  if (!token) return new NextResponse("This link isn't valid.", { status: 404, headers: { "content-type": "text/plain" } });
  // Relative, not built from request.url: behind the proxy that is the container's own address (https://0.0.0.0:3000).
  return new NextResponse(null, { status: 303, headers: { Location: `/b/${encodeURIComponent(token)}` } });
}
