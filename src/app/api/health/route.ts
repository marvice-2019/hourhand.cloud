import { getPool } from "@/lib/data/pg-store";

export const dynamic = "force-dynamic";

// Which build is running, so a deploy can be confirmed from outside. The repository is public, so the commit is no secret.
const version = { commit: process.env.HOURHAND_BUILD_COMMIT || null, builtAt: process.env.HOURHAND_BUILT_AT || null };

/** Liveness for Coolify's healthcheck and uptime monitors: 200 when the server can reach its database, 503 when it can't. */
export async function GET() {
  if (process.env.HOURHAND_DATA !== "postgres") return Response.json({ ok: true, data: "memory", ...version });
  try {
    await getPool(process.env.DATABASE_URL as string).query("select 1");
    return Response.json({ ok: true, ...version });
  } catch {
    return Response.json({ ok: false, error: "database_unreachable", ...version }, { status: 503 });
  }
}
