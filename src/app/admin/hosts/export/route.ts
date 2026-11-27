import { connection } from "next/server";
import { listHosts } from "@/lib/admin/queries";
import { audit } from "@/lib/admin/roles";
import { requireStaff } from "@/lib/admin/session";
import { csvRow } from "@/lib/admin/signups";
import { getPool } from "@/lib/data/pg-store";

/** B17: every host as a CSV, for super admins. Logged, since it carries every host's email. */
export async function GET(): Promise<Response> {
  await connection();
  const staff = await requireStaff("view_customer_data");
  const db = getPool(process.env.DATABASE_URL as string);
  const lines = [csvRow(["Name", "Email", "Page", "Status", "Plan", "Plan status", "Bookings", "Joined", "Closed"])];
  let total = 0;
  for (let page = 1; ; page++) {
    const { hosts, total: all } = await listHosts(db, { page });
    total = all;
    for (const h of hosts) lines.push(csvRow([h.name, h.email, `/${h.slug}`, h.review, h.plan, h.planStatus, h.bookings, h.createdAt, h.closedAt]));
    if (hosts.length === 0 || lines.length - 1 >= all) break;
  }
  await audit(db, staff, "host.export", null, null, { rows: total });
  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="hourhand-hosts-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
