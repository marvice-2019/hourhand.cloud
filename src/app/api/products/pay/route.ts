import { NextResponse, type NextRequest } from "next/server";
import { requestPaymentDeps } from "@/lib/payments/request-deps";
import { handleConfirmOrder } from "@/lib/products/handlers";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  const { status, body } = await handleConfirmOrder(requestPaymentDeps(), input, new Date(), { clientKey: clientIp(request.headers), limiter: rateLimiter });
  return NextResponse.json(body, { status });
}
