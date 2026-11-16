import { after, type NextRequest } from "next/server";
import { handleBeacon } from "@/lib/analytics/beacon";
import { authEnabled } from "@/lib/auth/auth";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The booking page's own beacon (a guest picking a time). Always 204: a refused or ignored beacon looks the same. */
export async function POST(request: NextRequest) {
  if (!authEnabled()) return new Response(null, { status: 204 });
  const record = await handleBeacon({
    store, limiter: rateLimiter, headers: request.headers, clientKey: clientIp(request.headers), body: await request.text().catch(() => ""),
    db: getPool(process.env.DATABASE_URL as string),
  });
  if (record) after(record);
  return new Response(null, { status: 204 });
}
