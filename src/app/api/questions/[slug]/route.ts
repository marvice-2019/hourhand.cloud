import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { requestPaymentDeps } from "@/lib/payments/request-deps";
import { handleStartQuestion } from "@/lib/questions/handlers";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Ask a question (B19): stores it, and opens a Razorpay order when the host charges for answers. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const { status, body } = await handleStartQuestion(pool, requestPaymentDeps(), slug, input, new Date(), { clientKey: clientIp(request.headers), limiter: rateLimiter });
  return NextResponse.json(body, { status });
}
