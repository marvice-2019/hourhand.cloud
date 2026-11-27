// B14: the live server's database and public address for /api/v1 routes.
import type { NextRequest } from "next/server";
import { authEnabled, resolveBaseUrl } from "../auth/auth";
import { getPool } from "../data/pg-store";
import type { ApiDeps } from "./http";

export function liveApiDeps(request: NextRequest): ApiDeps {
  return { db: authEnabled() ? getPool(process.env.DATABASE_URL as string) : null, base: resolveBaseUrl() ?? request.nextUrl.origin };
}
