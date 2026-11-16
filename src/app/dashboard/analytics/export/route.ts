import { NextResponse, type NextRequest } from "next/server";
import { analyticsCsv, analyticsReport } from "@/lib/analytics/store";
import { analyticsWindow } from "@/lib/analytics/window";
import { authEnabled } from "@/lib/auth/auth";
import { getSignedInUser } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";

export const dynamic = "force-dynamic";

/** GET ?days=7|30|90&event=<event type id>: the signed-in host's analytics as CSV. Solo and Duo only. */
export async function GET(request: NextRequest) {
  const user = await getSignedInUser();
  if (!user || !authEnabled()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const pool = getPool(process.env.DATABASE_URL as string);
  const win = analyticsWindow(await hostPlan(pool, user.id), request.nextUrl.searchParams.get("days"));
  if (!win.canExport) return NextResponse.json({ error: "plan_required" }, { status: 403 });
  const now = new Date();
  // The report only ever reads this host's rows; an event id that isn't theirs simply matches nothing.
  const r = await analyticsReport(pool, user.id, { days: win.days, eventTypeId: request.nextUrl.searchParams.get("event") }, now);
  return new NextResponse(analyticsCsv(r), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="analytics-${r.from}-to-${r.to}.csv"` } });
}
