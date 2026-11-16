import { NextResponse } from "next/server";
import { getPool } from "@/lib/data/pg-store";
import { handleZoomWebhook } from "@/lib/zoom/webhook";

export const dynamic = "force-dynamic";

/** Zoom's event notifications: the endpoint check, and a host removing Hourhand from their Zoom account. */
export async function POST(request: Request) {
  const secret = process.env.ZOOM_WEBHOOK_SECRET;
  if (!secret || !process.env.DATABASE_URL) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  try {
    const reply = await handleZoomWebhook(getPool(process.env.DATABASE_URL), secret, await request.text(), {
      timestamp: request.headers.get("x-zm-request-timestamp"), signature: request.headers.get("x-zm-signature"),
    });
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (error) {
    console.error("[zoom] webhook failed; Zoom will retry", error);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
