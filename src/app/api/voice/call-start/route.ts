import { NextResponse, type NextRequest } from "next/server";
import { voiceWebhookDeps } from "@/lib/voice/request-deps";
import { handleCallStart } from "@/lib/voice/webhooks";

export const dynamic = "force-dynamic";

/** ElevenLabs' conversation-initiation webhook: the opening line, and whether the agent may take this call. */
export async function POST(request: NextRequest) {
  const deps = voiceWebhookDeps();
  const secret = process.env.VOICE_CALL_START_SECRET;
  if (!deps || !secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const { status, body } = await handleCallStart(deps, secret, request.headers.get("authorization"), input, new Date());
  return NextResponse.json(body, { status });
}
