import type { NextRequest } from "next/server";
import { liveApiDeps } from "@/lib/api/deps";
import { handleApiRequest } from "@/lib/api/http";
import { getBooking } from "@/lib/api/v1";

export const dynamic = "force-dynamic";

/** B14: one of the key owner's bookings; anyone else's is 404. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, liveApiDeps(request), (ctx) => getBooking(ctx, id));
}
