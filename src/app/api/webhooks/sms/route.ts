import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/data/pg-store";
import { smsConfig } from "@/lib/sms/config";
import { handleSmsWebhook } from "@/lib/sms/webhook";

export const dynamic = "force-dynamic";

/** MSG91 delivery reports. MSG91 doesn't sign them: the shared secret comes in a custom header (or ?secret=). */
export async function POST(request: NextRequest) {
  const cfg = smsConfig();
  if (!cfg || !process.env.DATABASE_URL) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const secret = request.headers.get("x-hourhand-secret") ?? request.nextUrl.searchParams.get("secret");
  try {
    const { status, body } = await handleSmsWebhook(getPool(process.env.DATABASE_URL), cfg, await request.text(), secret);
    return NextResponse.json(body, { status });
  } catch (error) {
    console.error("[sms] delivery report failed; MSG91 will retry", error);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
