import { after, NextResponse, type NextRequest } from "next/server";
import { sourceFromBody } from "@/lib/analytics/source";
import { track } from "@/lib/analytics/store";
import { authEnabled } from "@/lib/auth/auth";
import { handleCreateBooking, type FunnelReporter } from "@/lib/booking";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { requestPaymentDeps } from "@/lib/payments/request-deps";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  const clientKey = clientIp(request.headers);
  // Only bookings made from a public booking page carry `src`; those steps go to the host's analytics, after the response.
  const src = typeof input === "object" && input !== null && "src" in input ? (input as { src: unknown }).src : undefined;
  const funnel: FunnelReporter | undefined = authEnabled() && src !== undefined
    ? (step) => { const now = new Date(); after(() => track(getPool(process.env.DATABASE_URL as string), { headers: request.headers, clientKey }, { ...step, source: sourceFromBody(src) }, now)); }
    : undefined;
  const { status, body } = await handleCreateBooking(store, input, new Date(), { clientKey, limiter: rateLimiter }, requestPaymentDeps(), funnel);
  return NextResponse.json(body, { status });
}
