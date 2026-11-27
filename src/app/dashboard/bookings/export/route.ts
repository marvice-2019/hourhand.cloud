import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { bookingsCsv, parseBookingsQuery, searchBookings } from "@/lib/bookings-search";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { dayKey } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * B12: GET with the Bookings page's query (q, view, event, from, to): every matching booking as CSV. Paid plans, and
 * only the account's owner: a Duo second person managing someone's bookings can search them but not take them away.
 */
export async function GET(request: NextRequest) {
  const ctx = await getHostContext();
  if (!ctx || !authEnabled()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.acting) return NextResponse.json({ error: "owner_only", message: "Only the account's owner can download its bookings." }, { status: 403 });
  const user = ctx.host;
  const plan = await hostPlan(getPool(process.env.DATABASE_URL as string), user.id);
  if (!LIMITS[plan].reportExport) return NextResponse.json({ error: "plan_required", message: "Downloads are on the Solo and Duo plans." }, { status: 403 });
  const at = new Date();
  const query = parseBookingsQuery(Object.fromEntries(request.nextUrl.searchParams));
  const [all, eventTypes] = await Promise.all([store.listBookings(user.id), store.listEventTypes(user.id)]);
  const { bookings, now } = searchBookings(all, query, user.timezone, at);
  const body = bookingsCsv(bookings, new Map(eventTypes.map((e) => [e.id, e.name])), user.timezone, now);
  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="bookings-${dayKey(at, user.timezone)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
