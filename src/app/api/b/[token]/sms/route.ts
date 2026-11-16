import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/data/pg-store";
import { clientIp, rateLimiter } from "@/lib/rate-limit";
import { smsConfig } from "@/lib/sms/config";
import { handleSmsToggle } from "@/lib/sms/manage";

export const dynamic = "force-dynamic";

/** The guest's on/off switch for this booking's texts. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!smsConfig() || !process.env.DATABASE_URL) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (!rateLimiter.take(`sms-toggle:${clientIp(request.headers)}`, { max: 20, windowMs: 3_600_000 })) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }
  let input: unknown = null;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  const { status, body } = await handleSmsToggle(getPool(process.env.DATABASE_URL), token, input, new Date());
  return NextResponse.json(body, { status });
}
