import type { NextRequest } from "next/server";
import { liveApiDeps } from "@/lib/api/deps";
import { handleApiRequest } from "@/lib/api/http";
import { listBookings } from "@/lib/api/v1";

export const dynamic = "force-dynamic";

/** B14: the key owner's bookings, oldest start first, filtered by status, from and to, a page at a time. */
export async function GET(request: NextRequest) {
  return handleApiRequest(request, liveApiDeps(request), (ctx) => listBookings(ctx, request.nextUrl.searchParams));
}
