import { NextResponse } from "next/server";
import { voiceWebhookDeps } from "@/lib/voice/request-deps";
import { handlePostCall } from "@/lib/voice/webhooks";

export const dynamic = "force-dynamic";

/** ElevenLabs post-call webhook: each receptionist call's length and cost. */
export async function POST(request: Request) {
  const deps = voiceWebhookDeps();
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!deps || !secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  try {
    const { status, body } = await handlePostCall(deps, secret, await request.text(), request.headers.get("elevenlabs-signature"), new Date());
    return NextResponse.json(body, { status });
  } catch (error) {
    console.error("[voice] post-call webhook failed; ElevenLabs will retry", error);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
