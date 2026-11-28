import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { requestPaymentDeps } from "@/lib/payments/request-deps";
import { handleStartOrder } from "@/lib/products/handlers";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Buy a digital product (B20): free ones are given at once; paid ones get a Razorpay order. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string; product: string }> }) {
  const { slug, product } = await params;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const { status, body } = await handleStartOrder(pool, requestPaymentDeps(), slug, product, input, new Date(), { clientKey: clientIp(request.headers), limiter: rateLimiter });
  return NextResponse.json(body, { status });
}
