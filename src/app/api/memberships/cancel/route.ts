import { NextResponse, type NextRequest } from "next/server";
import { handleCancelMembership } from "@/lib/memberships/handlers";
import { requestMembershipDeps } from "@/lib/memberships/request-deps";
import { clientIp, CONFIRM_PAYMENT_LIMIT, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  if (!rateLimiter.take(`membership-cancel:${clientIp(request.headers)}`, CONFIRM_PAYMENT_LIMIT)) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const { status, body } = await handleCancelMembership(requestMembershipDeps(), input, new Date());
  return NextResponse.json(body, { status });
}
