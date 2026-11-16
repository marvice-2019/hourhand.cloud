import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext } from "@/lib/auth/session";
import { clientKey } from "@/lib/clients";
import { tokenKey } from "@/lib/crypto/seal";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { exportClient, exportHtml } from "@/lib/privacy/rights";

export const dynamic = "force-dynamic";

/**
 * GET ?format=json|html[&notes=1]: everything Hourhand holds about one of the signed-in owner's clients. Owner only:
 * a Duo second person managing the account gets 403, and the client must be in the owner's own bookings. Private notes
 * are included only when asked for, since the owner may pass this file on to the client.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const ctx = await getHostContext();
  if (!ctx || !authEnabled()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.acting) return NextResponse.json({ error: "owner_only" }, { status: 403 });
  const { key } = await params;
  const format = request.nextUrl.searchParams.get("format") === "html" ? "html" : "json";
  const includeNotes = request.nextUrl.searchParams.get("notes") === "1";
  const email = (await store.listBookings(ctx.actor.id)).map((b) => b.invitee.email).find((e) => clientKey(e) === key);
  const data = email ? await exportClient(getPool(process.env.DATABASE_URL as string), ctx.actor.id, email, { includeNotes, key: tokenKey, now: new Date() }) : null;
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const name = `client-${key}-${data.exportedAt.slice(0, 10)}`;
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex" };
  return format === "html"
    ? new NextResponse(exportHtml(data), { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-disposition": `inline; filename="${name}.html"` } })
    : new NextResponse(JSON.stringify(data, null, 2), { headers: { ...headers, "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}.json"` } });
}
