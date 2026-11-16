import { NextResponse } from "next/server";
import { requestMembershipDeps } from "@/lib/memberships/request-deps";
import { handleMembershipWebhook } from "@/lib/memberships/webhook";

export const dynamic = "force-dynamic";

/** Subscription events from a host's own Razorpay account, signed with that host's membership webhook secret. */
export async function POST(request: Request, { params }: { params: Promise<{ hostId: string }> }) {
  const { hostId } = await params;
  const deps = requestMembershipDeps();
  if (!deps) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const raw = await request.text();
  const { status, body } = await handleMembershipWebhook(deps.pool, deps.key, hostId, raw, request.headers, new Date());
  return NextResponse.json(body, { status });
}
