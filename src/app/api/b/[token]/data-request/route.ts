import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { clientIp, rateLimiter } from "@/lib/rate-limit";
import { requestFromGuest } from "@/lib/privacy/rights";

export const dynamic = "force-dynamic";

/**
 * POST { kind: "access" | "erasure" }: the guest holding this manage link asks their host for a copy or deletion of
 * their data. The host is emailed; asking again while a request is open returns the open one and sends nothing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!rateLimiter.take(`data-request:${clientIp(request.headers)}`, { max: 10, windowMs: 3_600_000 })) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }
  if (!authEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  let kind: unknown = null;
  try {
    kind = ((await request.json()) as { kind?: unknown })?.kind;
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  if (kind !== "access" && kind !== "erasure") return NextResponse.json({ error: "invalid_request", fields: { kind: "Use access or erasure." } }, { status: 400 });
  const result = await requestFromGuest(getPool(process.env.DATABASE_URL as string), token, kind, new Date());
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ kind, dueAt: result.request.dueAt.toISOString(), created: result.created }, { status: result.created ? 201 : 200 });
}
