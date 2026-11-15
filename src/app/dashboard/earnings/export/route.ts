import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { getSignedInUser } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";
import { earningsCsv, monthlyEarnings } from "@/lib/earnings";
import { reportAccess } from "@/lib/reports/access";
import { gstCsv, pnlCsv } from "@/lib/reports/csv";
import { gstDocuments } from "@/lib/reports/ledger";
import { businessReport } from "@/lib/reports/report";

export const dynamic = "force-dynamic";

/**
 * The signed-in host's figures as CSV (paid plans).
 * - ?type=gst&period=…: the GST register (invoices and credit notes) for the period, for their CA.
 * - ?type=pnl&period=…: a simple profit and loss for the period.
 * - ?month=YYYY-MM (no type): the monthly earnings summary, as before.
 * Periods take the same query as the earnings page (period, from, to), in the host's time zone.
 */
export async function GET(request: NextRequest) {
  const user = await getSignedInUser();
  if (!user || !authEnabled()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const pool = getPool(process.env.DATABASE_URL as string);
  const now = new Date();
  const q = request.nextUrl.searchParams;
  const access = reportAccess({ period: q.get("period") ?? undefined, from: q.get("from") ?? undefined, to: q.get("to") ?? undefined, month: q.get("month") ?? undefined },
    user.timezone, await hostPlan(pool, user.id), now);
  if (!access.canExport) return NextResponse.json({ error: "plan_required", message: "Exports are on the Solo and Duo plans." }, { status: 403 });
  const csv = (body: string, name: string) =>
    new NextResponse(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
  const { period } = access;
  const range = `${period.first}_to_${period.last}`;
  const label = `${period.first} to ${period.last} (${period.timezone})`;
  const type = q.get("type");
  if (type === "gst") return csv(gstCsv(await gstDocuments(pool, user.id, period.from, period.to), label), `gst-register-${range}-verify-before-filing.csv`);
  if (type === "pnl") {
    const report = await businessReport(pool, user.id, period, now);
    if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return csv(pnlCsv(report, label), `profit-and-loss-${range}.csv`);
  }
  if (type) return NextResponse.json({ error: "invalid_request", fields: { type: "Use gst or pnl." } }, { status: 400 });
  const month = q.get("month") ?? "";
  const e = await monthlyEarnings(pool, user.id, month, now);
  if (!e) return NextResponse.json({ error: "invalid_request", fields: { month: "Use YYYY-MM." } }, { status: 400 });
  return csv(earningsCsv(e), `earnings-${month}.csv`);
}
