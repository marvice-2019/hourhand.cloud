import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { isIanaTimeZone } from "@/lib/booking";
import { getPool } from "@/lib/data/pg-store";
import { pollByToken, pollLinkKey, submitVotes, validateVote } from "@/lib/polls/polls";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Per client address and per email, so a stranger can't flood a poll or someone's inbox with change links. */
const VOTE_LIMITS = { perIp: { max: 30, windowMs: 60 * 60_000 }, perEmail: { max: 10, windowMs: 60 * 60_000 } };

/** POST { token, name, email, phone?, timezone, locale, votes: { [optionId]: "yes" | "if_needed" | "no" }, editToken? } */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const token = typeof body?.token === "string" ? body.token : "";
  if (!authEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const pool = getPool(process.env.DATABASE_URL as string);
  const now = new Date();
  const poll = await pollByToken(pool, token, now);
  if (!poll) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!poll.open) return NextResponse.json({ error: "closed" }, { status: 409 });
  const v = validateVote(body, poll.options.map((o) => o.id), isIanaTimeZone);
  if (!v.ok) return NextResponse.json({ error: "invalid_request", fields: v.fields }, { status: 400 });
  if (!rateLimiter.take(`poll-ip:${clientIp(request.headers)}`, VOTE_LIMITS.perIp) || !rateLimiter.take(`poll-email:${v.value.email.toLowerCase()}`, VOTE_LIMITS.perEmail)) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }
  const result = await submitVotes(pool, token, v.value, pollLinkKey(), now);
  switch (result.status) {
    case "saved": return NextResponse.json({ status: "saved", created: result.created });
    case "exists": return NextResponse.json({ status: "exists" });
    case "closed": return NextResponse.json({ error: "closed" }, { status: 409 });
    case "bad_edit_link": return NextResponse.json({ error: "bad_edit_link" }, { status: 400 });
    default: return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
