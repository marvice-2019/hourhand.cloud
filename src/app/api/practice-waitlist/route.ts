import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { isIanaTimeZone } from "@/lib/booking";
import { handleJoinPracticeWaitlist } from "@/lib/clinic/waitlist";
import { getPool } from "@/lib/data/pg-store";
import { BOOKING_LIMITS, clientIp, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** A guest waits for a Clinic practice's service on a day, with any practitioner who offers it. */
export async function POST(request: NextRequest) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL!) : null;
  const { status, body } = await handleJoinPracticeWaitlist(pool, input, new Date(), isIanaTimeZone,
    { clientKey: clientIp(request.headers), limiter: rateLimiter, perIp: BOOKING_LIMITS.perIp, perEmail: BOOKING_LIMITS.perEmail });
  return NextResponse.json(body, { status });
}
