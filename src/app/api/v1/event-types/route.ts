import type { NextRequest } from "next/server";
import { liveApiDeps } from "@/lib/api/deps";
import { handleApiRequest } from "@/lib/api/http";
import { listEventTypes } from "@/lib/api/v1";

export const dynamic = "force-dynamic";

/** B14: the key owner's event types, one-off meetings left out. */
export async function GET(request: NextRequest) {
  return handleApiRequest(request, liveApiDeps(request), listEventTypes);
}
