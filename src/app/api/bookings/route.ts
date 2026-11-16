import { NextResponse, type NextRequest } from "next/server";
import { getHostContext } from "@/lib/auth/session";
import { handleCreateBooking } from "@/lib/booking";
import { store } from "@/lib/data";
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
  // "Book for them" from the host's dashboard: the account is taken from the session, never from the body.
  const onBehalf = typeof input === "object" && input !== null && (input as { onBehalf?: unknown }).onBehalf === true;
  const ctx = onBehalf ? await getHostContext() : null;
  const { status, body } = await handleCreateBooking(store, input, new Date(), { clientKey: clientIp(request.headers), limiter: rateLimiter }, requestPaymentDeps(),
    ctx ? { hostId: ctx.host.id } : null);
  return NextResponse.json(body, { status });
}
