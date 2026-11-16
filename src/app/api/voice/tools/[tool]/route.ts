import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimiter } from "@/lib/rate-limit";
import { bearer } from "@/lib/voice/auth";
import { voiceToolDeps } from "@/lib/voice/request-deps";
import { handleVoiceTool } from "@/lib/voice/tools";

export const dynamic = "force-dynamic";

/** The voice agent's server tools: get_services, get_free_slots, create_booking, take_message. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  // Bad keys are refused cheaply, and one address can't grind through guesses.
  if (!rateLimiter.take(`voice-tools:${clientIp(request.headers)}`, { max: 600, windowMs: 60_000 })) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }
  const deps = voiceToolDeps();
  if (!deps) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  try {
    const { status, body } = await handleVoiceTool(deps, tool, bearer(request.headers.get("authorization")), input, new Date());
    return NextResponse.json(body, { status });
  } catch (error) {
    console.error(`[voice] tool ${tool} failed`, error);
    return NextResponse.json({ error: "failed", handoff: true }, { status: 500 });
  }
}
